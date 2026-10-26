import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { expectNoReloadSinceLogin, lineRow, loginInNewSession } from './twoUserEditFlow';
import {
  deleteCategoryLine,
  editCategory,
  expectLineOnHome,
  ExpectedLine,
  fillNewLine,
  lineSequence,
  NEW_LINE,
  openCategoriesPage,
  randomTextNote,
  saveNewLine,
  startAddLine,
} from './categoryLineFlow';
import { expectHomeGridMatches, readSettledHomeLine } from '../../utils/dataIntegrity';

const USER_COUNT = 10;
// Roles by position in the leased user list.
const CREATORS = [0, 1, 2];
const DELETER = 0;
const RECREATOR = 3;
const FIRST_VIEWER = 4;

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const everyone = range(0, USER_COUNT);
const viewers = range(FIRST_VIEWER, USER_COUNT - FIRST_VIEWER);
const roleOf = (i: number) =>
  i === RECREATOR ? 'user 4, re-creates the deleted line' : i < CREATORS.length ? `creator ${i + 1}${i === DELETER ? ' and deleter' : ''}` : 'viewer';
const homeGuid = async (page: Page, lineNumber: string) =>
  (await lineRow(page, lineNumber).locator('[data-testid^="sales-line-"]').getAttribute('data-testid'))?.replace('sales-line-', '');

test.describe('Concurrent users', () => {
  for (const deletion of [{ label: 'latest', index: CREATORS.length - 1 }, { label: 'earlier', index: 1 }]) {
  test(`${USER_COUNT} users: 3 users create line items one after another, the ${deletion.label} item is deleted and re-created by a 4th user; everyone sees each change`, async ({
    browser,
    users: leaseUsers,
    leases,
  }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(900000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    let category = '';
    const created: (ExpectedLine & { guid: string })[] = [];
    let recreated!: ExpectedLine & { guid: string };

    /** Runs the check for every given user and fails with one readable line (and a screenshot) per user that failed. */
    const checkUsers = async (indexes: number[], what: string, check: (page: Page, i: number) => Promise<void>) => {
      const results = await Promise.allSettled(indexes.map(i => check(pages[i], i)));
      const failures: string[] = [];
      for (const [n, result] of results.entries()) {
        if (result.status === 'fulfilled') continue;
        const i = indexes[n];
        await test.info().attach(`user-${i + 1}-${roleOf(i)}-${users[i].username}`, { body: await pages[i].screenshot({ fullPage: true }), contentType: 'image/png' });
        const reconnecting = await pages[i].getByText(/reconnect to the server/i).first().innerText({ timeout: 1000 }).catch(() => '');
        failures.push(
          `${users[i].username} (${roleOf(i)}): ${String(result.reason).split('\n')[0]}` +
            (reconnecting ? ` (page lost its server connection: "${reconnecting.trim()}")` : ''),
        );
      }
      expect(failures, what).toEqual([]);
    };

    /** Opens the category, adds a line with the given note and returns its values; leaves the user on the home page. */
    const addLine = async (page: Page, note: string, expectedLineNumber?: string): Promise<ExpectedLine> => {
      await openCategoriesPage(page);
      const line = { category, quantity: NEW_LINE.quantity, note } as ExpectedLine;
      line.categoryLineNumbers = await editCategory(page, category);
      line.lineNumber = await startAddLine(page);
      if (expectedLineNumber !== undefined) {
        expect(line.lineNumber, `Suggested number after deleting the ${deletion.label} item`).toBe(expectedLineNumber);
      }
      leases.claimLine(line.lineNumber);
      Object.assign(line, await fillNewLine(page, note));
      await saveNewLine(page, line.lineNumber, note);
      await page.goto('/');
      return line;
    };

    try {
      await test.step(`Log in ${USER_COUNT} unique users, each in a separate session`, async () => {
        pages = await Promise.all(users.map(user => loginInNewSession(browser, user)));
        test.info().annotations.push({ type: 'roles', description: users.map((u, i) => `${u.username}: ${roleOf(i)}`).join('; ') });
      });

      await test.step('Before any change: compare home-page line data and reserve a category', async () => {
        await checkUsers(everyone, 'initial home-page data matches', page => expectHomeGridMatches(page, pages[FIRST_VIEWER]));
        await openCategoriesPage(pages[CREATORS[0]]);
        [category] = await leases.categories(pages[CREATORS[0]], 1);
        await pages[CREATORS[0]].goto('/');
      });

      for (const [c, creator] of CREATORS.entries()) {
        await test.step(`Creator ${c + 1} adds a new line item to "${category}"`, async () => {
          const line = await addLine(pages[creator], randomTextNote());
          const { guid } = await readSettledHomeLine(pages[FIRST_VIEWER], line.lineNumber, [line.quantity]);
          created.push({ ...line, guid });
          expect(created[c].guid, `${line.lineNumber} should have a home-grid record ID`).toBeTruthy();
          expect(created.slice(0, c).map(previous => previous.lineNumber), 'Active lines must have distinct numbers').not.toContain(line.lineNumber);
          if (c > 0) {
            expect(lineSequence(line.lineNumber), 'New line number is the highest active number plus one').toBe(lineSequence(created[c - 1].lineNumber) + 1);
          }
          test.info().annotations.push({ type: `created by creator ${c + 1}`, description: line.lineNumber });
        });

        await test.step(`Every other user sees ${created[c].lineNumber} on the home page`, async () => {
          await checkUsers(
            everyone.filter(i => i !== creator),
            `Expected ${created[c].lineNumber} on every home page`,
            async (page, i) => {
              await expectLineOnHome(page, created[c]);
              await expect(lineRow(page, created[c].lineNumber)).toHaveCount(1);
              if (viewers.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
            },
          );
        });
      }

      const deleted = created[deletion.index];
      const highestSequence = Math.max(...created.map(line => lineSequence(line.lineNumber)));
      const expectedSequence = deletion.label === 'latest' ? lineSequence(deleted.lineNumber) : highestSequence + 1;
      const expectedLineNumber = deleted.lineNumber.replace(/\d+$/, String(expectedSequence));

      await test.step(`Creator ${DELETER + 1} deletes the ${deletion.label} item ${deleted.lineNumber} (added by creator ${deletion.index + 1})`, async () => {
        const page = pages[DELETER];
        await openCategoriesPage(page);
        await editCategory(page, category);
        await deleteCategoryLine(page, deleted.lineNumber);
        await page.goto('/');
        await expect(lineRow(pages[FIRST_VIEWER], deleted.lineNumber), `${deleted.lineNumber} should be gone from the viewer's home page`).toHaveCount(0, { timeout: 30000 });
        test.info().annotations.push({ type: 'deleted', description: `${deleted.lineNumber} by creator ${DELETER + 1}` });
      });

      await test.step(`Every user sees ${deleted.lineNumber} disappear from the home page, and the other new lines stay`, async () => {
        await checkUsers(everyone, `Expected ${deleted.lineNumber} to be gone from every home page`, async (page, i) => {
          await expect(lineRow(page, deleted.lineNumber), `${deleted.lineNumber} should be gone`).toHaveCount(0, { timeout: 30000 });
          for (const line of created.filter(l => l !== deleted)) await expectLineOnHome(page, line);
          if (viewers.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
        });
      });

      await test.step(`User 4 adds the same line item again to "${category}"`, async () => {
        const replacementNote = `Recreated by user 4: ${randomTextNote()}`;
        expect(replacementNote).not.toBe(deleted.note);
        const line = await addLine(pages[RECREATOR], replacementNote, expectedLineNumber);
        const { guid } = await readSettledHomeLine(pages[FIRST_VIEWER], line.lineNumber, [line.quantity]);
        recreated = { ...line, guid };
        test.info().annotations.push({ type: 're-created', description: `${line.lineNumber} (deleted line was ${deleted.lineNumber})` });
        for (const field of ['species', 'size', 'grade', 'quantity', 'shipWeek'] as const) {
          expect.soft(recreated[field], `Re-created line ${field}`).toBe(deleted[field]);
        }
        expect(recreated.note, 'Re-created line uses the newly entered note').toBe(replacementNote);
        expect(created.filter(line => line !== deleted).map(line => line.lineNumber), 'Re-created line must not overwrite a surviving line').not.toContain(recreated.lineNumber);
        expect(recreated.guid, `${recreated.lineNumber} should have a home-grid record ID`).toBeTruthy();
      });

      await test.step(`Every user sees the re-created ${recreated.lineNumber} once with the new values, and the surviving lines stay unchanged`, async () => {
        await checkUsers(everyone, `Expected the re-created ${recreated.lineNumber} on every home page`, async (page, i) => {
          await expectLineOnHome(page, recreated);
          await expect(lineRow(page, recreated.lineNumber), `${recreated.lineNumber} should be listed once`).toHaveCount(1);
          expect(await homeGuid(page, recreated.lineNumber), `${recreated.lineNumber} record ID should match across users`).toBe(recreated.guid);
          await expect(lineRow(page, recreated.lineNumber)).not.toContainText(deleted.note);
          if (recreated.lineNumber !== deleted.lineNumber) {
            await expect(lineRow(page, deleted.lineNumber), `${deleted.lineNumber} should stay gone`).toHaveCount(0);
          }
          for (const line of created.filter(l => l !== deleted)) {
            await expectLineOnHome(page, line);
            await expect(lineRow(page, line.lineNumber)).toHaveCount(1);
            expect(await homeGuid(page, line.lineNumber), `${line.lineNumber} surviving record ID`).toBe(line.guid);
          }
          await expectHomeGridMatches(page, pages[FIRST_VIEWER]);
          if (viewers.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
        });
      });

    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
  }
});
