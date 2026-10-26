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
import { fetchAzureSqlLines, IntegrityApi, MISMATCH_TOAST, runCheckDataMismatch } from '../../utils/dataIntegrity';

const USER_COUNT = 10;
// Roles by position in the leased user list.
const CREATORS = [0, 1, 2];
const DELETER = 0;
const RECREATOR = 3;
const FIRST_VIEWER = 4;
/** The deleter removes the newest line; the next new line must still get a higher number, never the deleted one. */
const DELETED = CREATORS.length - 1;

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const everyone = range(0, USER_COUNT);
const viewers = range(FIRST_VIEWER, USER_COUNT - FIRST_VIEWER);
const roleOf = (i: number) =>
  i === RECREATOR ? 'user 4, re-creates the deleted line' : i < CREATORS.length ? `creator ${i + 1}${i === DELETER ? ' and deleter' : ''}` : 'viewer';
const mismatchCount = (message: string | null) => Number(message?.match(MISMATCH_TOAST)?.[1] ?? 0);
const homeGuid = async (page: Page, lineNumber: string) =>
  (await lineRow(page, lineNumber).locator('[data-testid^="sales-line-"]').getAttribute('data-testid'))?.replace('sales-line-', '');

test.describe('Concurrent users', () => {
  test(`${USER_COUNT} users: 3 users create line items one after another, one is deleted and re-created by a 4th user; everyone sees each change`, async ({
    browser,
    users: leaseUsers,
    leases,
  }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(900000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    let api!: IntegrityApi;
    let mismatchesBefore = 0;
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

    /** Azure SQL guid of the (not deleted) line with this line number. */
    const azureGuid = async (lineNumber: string) =>
      [...(await fetchAzureSqlLines(pages[FIRST_VIEWER], api)).values()].find(l => l.lineNumber === lineNumber)?.guid ?? '';

    /** Opens the category, adds a line with the given note and returns its values; leaves the user on the home page. */
    const addLine = async (page: Page, note: string): Promise<ExpectedLine> => {
      await openCategoriesPage(page);
      const line = { category, quantity: NEW_LINE.quantity, note } as ExpectedLine;
      line.categoryLineNumbers = await editCategory(page, category);
      line.lineNumber = await startAddLine(page);
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

      await test.step('Before any change: record what Check Data Mismatch reports, and reserve a category', async () => {
        const { message, api: integrityApi } = await runCheckDataMismatch(pages[FIRST_VIEWER]);
        api = integrityApi;
        mismatchesBefore = mismatchCount(message);
        test.info().annotations.push({ type: 'mismatches before', description: message ?? 'none' });
        await openCategoriesPage(pages[CREATORS[0]]);
        [category] = await leases.categories(pages[CREATORS[0]], 1);
        await pages[CREATORS[0]].goto('/');
      });

      for (const [c, creator] of CREATORS.entries()) {
        await test.step(`Creator ${c + 1} adds a new line item to "${category}"`, async () => {
          const line = await addLine(pages[creator], randomTextNote());
          created.push({ ...line, guid: await azureGuid(line.lineNumber) });
          expect(created[c].guid, `${line.lineNumber} should be in Azure SQL`).toBeTruthy();
          if (c > 0) {
            const previous = created[c - 1].lineNumber;
            expect.soft(lineSequence(line.lineNumber), `${line.lineNumber} should come after ${previous}`).toBeGreaterThan(lineSequence(previous));
          }
          test.info().annotations.push({ type: `created by creator ${c + 1}`, description: line.lineNumber });
        });

        await test.step(`Every other user sees ${created[c].lineNumber} on the home page`, async () => {
          await checkUsers(
            everyone.filter(i => i !== creator),
            `Expected ${created[c].lineNumber} on every home page`,
            async (page, i) => {
              await expectLineOnHome(page, created[c]);
              if (viewers.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
            },
          );
        });
      }

      const deleted = created[DELETED];

      await test.step(`Creator ${DELETER + 1} deletes ${deleted.lineNumber} (added by creator ${DELETED + 1})`, async () => {
        const page = pages[DELETER];
        await openCategoriesPage(page);
        await editCategory(page, category);
        await deleteCategoryLine(page, deleted.lineNumber);
        await page.goto('/');
        expect(await azureGuid(deleted.lineNumber), `${deleted.lineNumber} should be gone from Azure SQL`).toBe('');
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
        const line = await addLine(pages[RECREATOR], deleted.note);
        recreated = { ...line, guid: await azureGuid(line.lineNumber) };
        test.info().annotations.push({ type: 're-created', description: `${line.lineNumber} (deleted line was ${deleted.lineNumber})` });
        for (const field of ['species', 'size', 'grade', 'quantity', 'note', 'shipWeek'] as const) {
          expect.soft(recreated[field], `Re-created line ${field}`).toBe(deleted[field]);
        }
        const highest = Math.max(...created.map(l => lineSequence(l.lineNumber)));
        expect
          .soft(lineSequence(recreated.lineNumber), `${recreated.lineNumber} should come after every earlier line, the deleted ${deleted.lineNumber} included`)
          .toBeGreaterThan(highest);
        expect(recreated.guid, `${recreated.lineNumber} should be in Azure SQL`).toBeTruthy();
        expect(recreated.guid, 'The re-created line should be a new record').not.toBe(deleted.guid);
      });

      await test.step(`Every user sees the re-created ${recreated.lineNumber} once, as the new record, and nothing else changed`, async () => {
        await checkUsers(everyone, `Expected the re-created ${recreated.lineNumber} on every home page`, async (page, i) => {
          await expectLineOnHome(page, recreated);
          await expect(lineRow(page, recreated.lineNumber), `${recreated.lineNumber} should be listed once`).toHaveCount(1);
          expect(await homeGuid(page, recreated.lineNumber), `${recreated.lineNumber} should be the new record, not the deleted one`).toBe(recreated.guid);
          await expect(lineRow(page, deleted.lineNumber), `${deleted.lineNumber} should stay gone`).toHaveCount(0);
          for (const line of created.filter(l => l !== deleted)) await expectLineOnHome(page, line);
          if (viewers.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
        });
      });

      await test.step('Check Data Mismatch reports no new mismatch', async () => {
        const { message } = await runCheckDataMismatch(pages[FIRST_VIEWER]);
        test.info().annotations.push({ type: 'mismatches after', description: message ?? 'none' });
        expect(mismatchCount(message), `Check Data Mismatch after the changes: ${message ?? 'none'}`).toBeLessThanOrEqual(mismatchesBefore);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
