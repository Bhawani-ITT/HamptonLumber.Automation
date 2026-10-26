import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { backToList, enterQuantity, expectNoReloadSinceLogin, lineQuantityCell, lineRow, openLineForEdit, quantityInput, randomQuantity } from './twoUserEditFlow';
import { HOME_COLUMNS, noteInput, randomTextNote } from './categoryLineFlow';
import { AzureSqlLine, compareWithAzureSql, fetchAzureSqlLines, IntegrityApi, readHomeGridLines, runCheckDataMismatch } from '../../utils/dataIntegrity';
import { LOGIN_BATCH_SIZE, loginInBatches, mismatchCount, range, reportTimes, SAVE_TIMEOUT_MS, timedEditSave, userChecker } from './loadFlow';

const USER_COUNT = 50;
const FIRST_WAVE = 25;
const EDITORS = 2;
// Roles by position in the leased user list: the editors are part of the first wave.
const editorIndexes = range(0, EDITORS);
const firstWave = range(0, FIRST_WAVE);
const secondWave = range(FIRST_WAVE, USER_COUNT - FIRST_WAVE);
const everyone = range(0, USER_COUNT);
/** How long a user's home page may take to catch up with Azure SQL before it counts as a mismatch. */
const SETTLE_TIMEOUT_MS = 30000;

const roleOf = (i: number) =>
  i < EDITORS ? `editor ${i + 1}` : i < FIRST_WAVE ? 'viewer logged in before the edits' : 'viewer logged in after the edits';

test.describe('Concurrent users', () => {
  test(
    `${USER_COUNT} users: ${FIRST_WAVE} on the home page while ${EDITORS} of them edit existing line items, then ${USER_COUNT - FIRST_WAVE} more log in; ` +
      'every user sees the edits and no screen differs from Azure SQL',
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
      let api!: IntegrityApi;
      let mismatchesBefore = 0;
      let editedLines: string[] = [];
      const edits: { quantity: string; note: string }[] = [];

      /** Azure SQL lines, fetched at most every 10 s however many users ask, so 50 users don't flood the API. */
      let snapshot: { at: number; lines: Promise<Map<string, AzureSqlLine>> } | undefined;
      const azureSqlLines = () => {
        if (!snapshot || Date.now() - snapshot.at > 10000) snapshot = { at: Date.now(), lines: fetchAzureSqlLines(pages[FIRST_WAVE - 1], api) };
        return snapshot.lines;
      };

      /** Both edited lines show the saved quantity and note on the user's home page. */
      const expectEditsVisible = async (page: Page) => {
        for (const [e, lineNumber] of editedLines.entries()) {
          await expect(lineQuantityCell(page, lineNumber), `${lineNumber} Qty`).toHaveText(edits[e].quantity, { timeout: 30000 });
          await expect(lineRow(page, lineNumber).getByRole('gridcell').nth(HOME_COLUMNS.notes), `${lineNumber} Notes`).toHaveText(edits[e].note);
        }
      };

      /** Every line on the user's home page matches Azure SQL (quantity, ship week and note). */
      const expectGridMatchesAzureSql = async (page: Page) => {
        let differences: string[] = [];
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        do {
          differences = compareWithAzureSql(await readHomeGridLines(page), await azureSqlLines());
          if (differences.length === 0) return;
          await page.waitForTimeout(2000);
        } while (Date.now() < deadline);
        throw new Error(`${differences.length} difference(s) between the home page and Azure SQL: ${differences.slice(0, 10).join('; ')}`);
      };

      try {
        test.info().annotations.push({ type: 'roles', description: users.map((u, i) => `${u.username}: ${roleOf(i)}`).join('; ') });

        await test.step(`Log in the first ${FIRST_WAVE} users in batches of ${LOGIN_BATCH_SIZE}; they stay on the home page`, async () => {
          await logIn(firstWave);
        });

        await test.step('Before any change: record what Check Data Mismatch reports, and pick 2 existing line items', async () => {
          const { message, api: integrityApi } = await runCheckDataMismatch(pages[FIRST_WAVE - 1]);
          api = integrityApi;
          mismatchesBefore = mismatchCount(message);
          test.info().annotations.push({ type: 'mismatches before', description: message ?? 'none' });
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

        await test.step('Azure SQL holds both edits', async () => {
          const stored = [...(await fetchAzureSqlLines(pages[FIRST_WAVE - 1], api)).values()];
          for (const [e, lineNumber] of editedLines.entries()) {
            const row = stored.find(s => s.lineNumber === lineNumber);
            expect(row?.quantity, `${lineNumber} quantity in Azure SQL`).toBe(edits[e].quantity);
            expect(row?.note, `${lineNumber} note in Azure SQL`).toBe(edits[e].note);
          }
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

        await test.step(`All ${USER_COUNT} users see both edits, and every line on every home page matches Azure SQL`, async () => {
          await checkUsers(everyone, 'everyone sees the edits and matches Azure SQL', async page => {
            await expectEditsVisible(page);
            await expectGridMatchesAzureSql(page);
          });
        });

        await test.step('Check Data Mismatch reports no new mismatch', async () => {
          const { message } = await runCheckDataMismatch(pages[USER_COUNT - 1]);
          test.info().annotations.push({ type: 'mismatches after', description: message ?? 'none' });
          expect(mismatchCount(message), `Check Data Mismatch after the edits: ${message ?? 'none'}`).toBeLessThanOrEqual(mismatchesBefore);
        });
      } finally {
        await Promise.all(pages.filter(Boolean).map(page => page.context().close()));
      }
    },
  );
});
