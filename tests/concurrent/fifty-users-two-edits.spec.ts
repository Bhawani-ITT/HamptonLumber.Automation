import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { backToList, enterQuantity, expectNoReloadSinceLogin, lineQuantityCell, lineRow, openLineForEdit, quantityInput, randomQuantity } from './twoUserEditFlow';
import { HOME_COLUMNS, noteInput, randomTextNote } from './categoryLineFlow';
import { expectHomeGridMatches } from '../../utils/dataIntegrity';
import { LOGIN_BATCH_SIZE, loginInBatches, range, reportTimes, SAVE_TIMEOUT_MS, timedEditSave, userChecker } from './loadFlow';

const USER_COUNT = 50;
const FIRST_WAVE = 25;
const EDITORS = 2;
// Roles by position in the leased user list: the editors are part of the first wave.
const editorIndexes = range(0, EDITORS);
const firstWave = range(0, FIRST_WAVE);
const secondWave = range(FIRST_WAVE, USER_COUNT - FIRST_WAVE);
const everyone = range(0, USER_COUNT);

const roleOf = (i: number) =>
  i < EDITORS ? `editor ${i + 1}` : i < FIRST_WAVE ? 'viewer logged in before the edits' : 'viewer logged in after the edits';

test.describe('Concurrent users', () => {
  test(
    `${USER_COUNT} users: ${FIRST_WAVE} on the home page while ${EDITORS} of them edit existing line items, then ${USER_COUNT - FIRST_WAVE} more log in; ` +
      'every user sees the edits and matching home-page line data',
    async ({ browser, users: leaseUsers, leases }) => {
      test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
      test.setTimeout(1_500_000);
      const users = await leaseUsers(USER_COUNT);

      /** Each user's page, filled in as their wave logs in. */
      const pages: Page[] = new Array(USER_COUNT);
      const logIn = async (indexes: number[]) => {
        const loggedIn = await loginInBatches(browser, indexes.map(i => users[i]));
        indexes.forEach((i, n) => (pages[i] = loggedIn[n]));
      };
      const checkUsers = userChecker(() => pages, users, roleOf);
      let editedLines: string[] = [];
      const edits: { quantity: string; note: string }[] = [];

      /** Both edited lines show the saved quantity and note on the user's home page. */
      const expectEditsVisible = async (page: Page) => {
        for (const [e, lineNumber] of editedLines.entries()) {
          await expect(lineQuantityCell(page, lineNumber), `${lineNumber} Qty`).toHaveText(edits[e].quantity, { timeout: 30000 });
          await expect(lineRow(page, lineNumber).getByRole('gridcell').nth(HOME_COLUMNS.notes), `${lineNumber} Notes`).toHaveText(edits[e].note);
        }
      };

      try {
        test.info().annotations.push({ type: 'roles', description: users.map((u, i) => `${u.username}: ${roleOf(i)}`).join('; ') });

        await test.step(`Log in the first ${FIRST_WAVE} users in batches of ${LOGIN_BATCH_SIZE}; they stay on the home page`, async () => {
          await logIn(firstWave);
        });

        await test.step('Before any change: compare home-page line data and pick 2 existing line items', async () => {
          await checkUsers(firstWave, 'initial home-page line data matches', page => expectHomeGridMatches(page, pages[FIRST_WAVE - 1]));
          editedLines = await leases.lines(pages[FIRST_WAVE - 1], EDITORS);
        });

        await test.step(`${EDITORS} users open one existing line item each and change its note and quantity`, async () => {
          await Promise.all(editorIndexes.map(e => openLineForEdit(pages[e], editedLines[e])));
          const originals = await Promise.all(editorIndexes.map(async e => Number(await quantityInput(pages[e]).inputValue())));
          for (const e of editorIndexes) {
            edits[e] = { quantity: randomQuantity(...originals, ...edits.map(x => Number(x.quantity))), note: randomTextNote() };
          }
          await Promise.all(
            editorIndexes.map(async e => {
              const page = pages[e];
              // The note goes in before the quantity: a note typed right after a quantity change used to be reverted.
              await noteInput(page).fill(edits[e].note);
              await noteInput(page).press('Tab');
              await enterQuantity(page, edits[e].quantity);
              await expect(noteInput(page), 'Note was changed by the app before Save').toHaveValue(edits[e].note);
            }),
          );
          test.info().annotations.push({
            type: 'edits',
            description: editorIndexes.map(e => `${roleOf(e)}: ${editedLines[e]} quantity=${edits[e].quantity}, note="${edits[e].note}"`).join('; '),
          });
        });

        await test.step(`Both editors click Save Changes at the same time`, async () => {
          const saves = await Promise.all(editorIndexes.map(e => timedEditSave(pages[e])));
          reportTimes('saves', saves, n => editedLines[n]);
          expect(saves.flatMap((s, n) => (s.saved ? [] : [`${editedLines[n]}: ${s.detail}`])), `Both saves should go through within ${SAVE_TIMEOUT_MS / 1000}s`).toEqual([]);
          await Promise.all(editorIndexes.map(e => backToList(pages[e])));
        });

        await test.step('A viewer sees both saved edits on the home page', async () => {
          await expectEditsVisible(pages[FIRST_WAVE - 1]);
        });

        await test.step(`All ${FIRST_WAVE} first-wave users see both edits live, without reloading`, async () => {
          await checkUsers(firstWave, 'first wave sees the edits live', async (page, i) => {
            await expectEditsVisible(page);
            await expectNoReloadSinceLogin(page, roleOf(i));
          });
        });

        await test.step(`Log in the remaining ${USER_COUNT - FIRST_WAVE} users in batches of ${LOGIN_BATCH_SIZE}`, async () => {
          await logIn(secondWave);
        });

        await test.step(`All ${USER_COUNT} users see both edits and matching home-page line data`, async () => {
          await checkUsers(everyone, 'everyone sees the edits and matching line data', async page => {
            await expectEditsVisible(page);
            await expectHomeGridMatches(page, pages[FIRST_WAVE - 1]);
          });
        });
      } finally {
        await Promise.all(pages.filter(Boolean).map(page => page.context().close()));
      }
    },
  );
});
