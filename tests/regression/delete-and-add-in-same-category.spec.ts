import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { lineRow, loginInNewSession } from '../concurrent/twoUserEditFlow';
import {
  categoryLineRow,
  editCategory,
  expectLineOnHome,
  ExpectedLine,
  fillNewLine,
  lineSequence,
  NEW_LINE,
  openCategoriesPage,
  randomTextNote,
  startAddLine,
} from '../concurrent/categoryLineFlow';
import { addLineToCategory, mismatchCount, seconds, startDeleteCategoryLine, timedConfirmDelete, timedNewLineSave } from '../concurrent/loadFlow';
import { fetchAzureSqlLines, IntegrityApi, runCheckDataMismatch } from '../../utils/dataIntegrity';

const DELETER = 0;
const ADDER = 1;
const roleOf = (i: number) => (i === DELETER ? 'user 1 (deletes)' : 'user 2 (adds)');

test.describe('Category lines', () => {
  test('one user deletes a line while another adds a line to the same category at the same moment; both users see the same result', async ({
    browser,
    users,
    leases,
  }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const leased = await users(2);
    const pages: Page[] = [];
    let api!: IntegrityApi;
    let mismatchesBefore = 0;
    let category = '';
    let deleted!: ExpectedLine;
    const added = { quantity: NEW_LINE.quantity, note: randomTextNote() } as ExpectedLine;

    try {
      await test.step('Log in 2 users, each in a separate session', async () => {
        pages.push(...(await Promise.all(leased.map(user => loginInNewSession(browser, user)))));
        for (const page of pages) page.setDefaultTimeout(30000);
        test.info().annotations.push({ type: 'roles', description: leased.map((u, i) => `${u.username}: ${roleOf(i)}`).join('; ') });
      });

      await test.step('Before any change: record what Check Data Mismatch reports, and reserve a category', async () => {
        const result = await runCheckDataMismatch(pages[ADDER]);
        api = result.api;
        mismatchesBefore = mismatchCount(result.message);
        test.info().annotations.push({ type: 'mismatches before', description: result.message ?? 'none' });
        await openCategoriesPage(pages[DELETER]);
        [category] = await leases.categories(pages[DELETER], 1);
        await pages[DELETER].goto('/');
      });

      await test.step(`User 1 adds the line item that will be deleted, and both users see it`, async () => {
        deleted = await addLineToCategory(pages[DELETER], category, randomTextNote(), leases.claimLine);
        test.info().annotations.push({ type: 'line to delete', description: `${deleted.lineNumber} in ${category}` });
        for (const page of pages) await expectLineOnHome(page, deleted);
      });

      await test.step(`User 1 clicks Delete on ${deleted.lineNumber}; user 2 fills in a new line item in the same category`, async () => {
        await Promise.all([
          (async () => {
            await openCategoriesPage(pages[DELETER]);
            await editCategory(pages[DELETER], category);
            await startDeleteCategoryLine(pages[DELETER], deleted.lineNumber);
          })(),
          (async () => {
            const page = pages[ADDER];
            await openCategoriesPage(page);
            added.category = category;
            added.categoryLineNumbers = (await editCategory(page, category)).filter(n => n !== deleted.lineNumber);
            added.lineNumber = await startAddLine(page);
            leases.claimLine(added.lineNumber);
            Object.assign(added, await fillNewLine(page, added.note));
          })(),
        ]);
        expect(added.lineNumber, 'The new line should get a number of its own').not.toBe(deleted.lineNumber);
        expect(lineSequence(added.lineNumber), `${added.lineNumber} should come after ${deleted.lineNumber}`).toBeGreaterThan(lineSequence(deleted.lineNumber));
        test.info().annotations.push({ type: 'line to add', description: `${added.lineNumber} in ${category}` });
      });

      await test.step(`At the same moment: user 1 confirms the delete and user 2 saves the new line`, async () => {
        const [deletion, creation] = await Promise.all([timedConfirmDelete(pages[DELETER], deleted.lineNumber), timedNewLineSave(pages[ADDER], added)]);
        test.info().annotations.push({
          type: 'results',
          description:
            `delete of ${deleted.lineNumber}: ${deletion.saved ? 'confirmed' : 'NOT confirmed'} in ${seconds(deletion.ms)}, ${deletion.detail}; ` +
            `add of ${added.lineNumber}: ${creation.saved ? 'confirmed' : 'NOT confirmed'} in ${seconds(creation.ms)}, ${creation.detail}`,
        });
        for (const [i, result] of [[DELETER, deletion], [ADDER, creation]] as const) {
          if (result.saved) continue;
          const screenshot = await pages[i].screenshot({ fullPage: true }).catch(() => null);
          if (screenshot) await test.info().attach(`not confirmed on screen - ${roleOf(i)}`, { body: screenshot, contentType: 'image/png' });
        }
        expect.soft(deletion.saved, `User 1's screen should show ${deleted.lineNumber} removed: ${deletion.detail}`).toBe(true);
        expect.soft(creation.saved, `User 2's screen should show ${added.lineNumber} added: ${creation.detail}`).toBe(true);
      });

      await test.step(`Azure SQL: ${deleted.lineNumber} is gone and ${added.lineNumber} is saved`, async () => {
        const stored = [...(await fetchAzureSqlLines(pages[ADDER], api)).values()];
        expect(stored.find(l => l.lineNumber === deleted.lineNumber), `${deleted.lineNumber} should be gone from Azure SQL`).toBeUndefined();
        const row = stored.find(l => l.lineNumber === added.lineNumber);
        expect(row, `${added.lineNumber} should be in Azure SQL`).toBeTruthy();
        expect.soft(row?.quantity, `${added.lineNumber} quantity in Azure SQL`).toBe(added.quantity);
        expect.soft(row?.note, `${added.lineNumber} note in Azure SQL`).toBe(added.note);
      });

      for (const i of [DELETER, ADDER]) {
        await test.step(`${roleOf(i)} sees the same result on the home page and in the category`, async () => {
          const page = pages[i];
          await page.goto('/');
          await expectLineOnHome(page, added);
          await expect(lineRow(page, deleted.lineNumber), `${deleted.lineNumber} should be gone from the home page`).toHaveCount(0, { timeout: 30000 });
          await openCategoriesPage(page);
          const lines = await editCategory(page, category);
          expect(lines, `${category} should list ${added.lineNumber}`).toContain(added.lineNumber);
          expect(lines, `${category} should no longer list ${deleted.lineNumber}`).not.toContain(deleted.lineNumber);
          await expect(categoryLineRow(page, added.lineNumber)).toBeVisible();
          await page.goto('/');
        });
      }

      await test.step('Check Data Mismatch reports no new mismatch', async () => {
        const { message } = await runCheckDataMismatch(pages[ADDER]);
        test.info().annotations.push({ type: 'mismatches after', description: message ?? 'none' });
        expect(mismatchCount(message), `Check Data Mismatch after the changes: ${message ?? 'none'}`).toBeLessThanOrEqual(mismatchesBefore);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
