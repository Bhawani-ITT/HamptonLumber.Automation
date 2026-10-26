import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { backToList, dataTables, enterQuantity, expectNoReloadSinceLogin, lineQuantityCell, lineRow, openLineForEdit, quantityInput, randomQuantity } from './twoUserEditFlow';
import { editCategory, expectLineOnHome, ExpectedLine, fillNewLine, NEW_LINE, noteInput, openCategoriesPage, randomTextNote, startAddLine } from './categoryLineFlow';
import { fetchAzureSqlLines, IntegrityApi, runCheckDataMismatch } from '../../utils/dataIntegrity';
import {
  addLineToCategory,
  goHome,
  LOGIN_BATCH_SIZE,
  loginInBatches,
  mismatchCount,
  range,
  reportTimes,
  SAVE_TIMEOUT_MS,
  startDeleteCategoryLine,
  timedConfirmDelete,
  timedEditSave,
  timedNewLineSave,
  userChecker,
} from './loadFlow';

// Roles by position in the leased user list. One user edits an existing line, so most of the load is the viewers'
// live updates rather than edits; this keeps 40 browsers within what a 4-core test machine can render. Each creator and each deleter works in its own category and location:
// a delete also updates the other lines of its category, which must not collide with the edits of the new lines.
const CREATORS = 4;
const DELETERS = CREATORS;
const EXISTING_LINE_EDITORS = 1;
const NEW_LINE_EDITORS = CREATORS;
const VIEWERS = 27;
const USER_COUNT = CREATORS + DELETERS + EXISTING_LINE_EDITORS + NEW_LINE_EDITORS + VIEWERS;
const FIRST_DELETER = CREATORS;
const FIRST_EXISTING_EDITOR = FIRST_DELETER + DELETERS;
const FIRST_NEW_LINE_EDITOR = FIRST_EXISTING_EDITOR + EXISTING_LINE_EDITORS;
const FIRST_VIEWER = FIRST_NEW_LINE_EDITOR + NEW_LINE_EDITORS;

const creatorIndexes = range(0, CREATORS);
const deleterIndexes = range(FIRST_DELETER, DELETERS);
const existingEditorIndexes = range(FIRST_EXISTING_EDITOR, EXISTING_LINE_EDITORS);
const newLineEditorIndexes = range(FIRST_NEW_LINE_EDITOR, NEW_LINE_EDITORS);
const viewerIndexes = range(FIRST_VIEWER, VIEWERS);
const everyone = range(0, USER_COUNT);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function roleOf(i: number): string {
  if (i < FIRST_DELETER) return `creator ${i + 1}`;
  if (i < FIRST_EXISTING_EDITOR) return `deleter ${i - FIRST_DELETER + 1}`;
  if (i < FIRST_NEW_LINE_EDITOR) return `editor ${i - FIRST_EXISTING_EDITOR + 1} of an existing line`;
  if (i < FIRST_VIEWER) return `editor ${i - FIRST_NEW_LINE_EDITOR + 1} of a new line`;
  return 'viewer';
}

test.describe('Concurrent users', () => {
  test(
    `${USER_COUNT} users: ${count(CREATORS, 'new line')}, ${count(EXISTING_LINE_EDITORS, 'existing-line edit')} and ${count(DELETERS, 'delete')} ` +
      `at the same time, then ${NEW_LINE_EDITORS} edits of the new lines; ${VIEWERS} viewers and everyone else see the same final data`,
    async ({ browser, users: leaseUsers, leases }) => {
      test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
      test.setTimeout(1_500_000);
      const users = await leaseUsers(USER_COUNT);

      /** Each user's page, filled in as their group logs in. */
      const pages: Page[] = new Array(USER_COUNT);
      /** Logs a group in just before its step, so stage isn't carrying all 40 sessions through the whole setup. */
      const logIn = async (indexes: number[]) => {
        const loggedIn = await loginInBatches(browser, indexes.map(i => users[i]));
        indexes.forEach((i, n) => (pages[i] = loggedIn[n]));
      };
      let api!: IntegrityApi;
      let mismatchesBefore = 0;
      /** The creators' categories, then the deleters'. */
      let categories: string[] = [];
      const deleterCategory = (d: number) => categories[CREATORS + d];
      let existingLines: string[] = [];
      const lineOfExistingEditor = (i: number) => existingLines[i - FIRST_EXISTING_EDITOR];
      const expectedQuantity = new Map<string, string>();
      /** One line per deleter, added before the concurrent round so it is an existing line when deleted. */
      let doomedLines: ExpectedLine[] = [];
      const newLines = Array.from({ length: CREATORS }, () => ({ quantity: NEW_LINE.quantity, note: randomTextNote() }) as ExpectedLine);
      const checkUsers = userChecker(() => pages, users, roleOf);
      const usedQuantities = () => [...expectedQuantity.values()].map(Number);

      try {
        test.info().annotations.push({ type: 'roles', description: users.map((u, i) => `${u.username}: ${roleOf(i)}`).join('; ') });

        await test.step(`Log in the ${CREATORS} creators and ${DELETERS} deleters, each in a separate session`, async () => {
          await logIn([...creatorIndexes, ...deleterIndexes]);
        });

        await test.step('Before any change: record what Check Data Mismatch reports', async () => {
          const { message, api: integrityApi } = await runCheckDataMismatch(pages[0]);
          api = integrityApi;
          mismatchesBefore = mismatchCount(message);
          test.info().annotations.push({ type: 'mismatches before', description: message ?? 'none' });
        });

        await test.step(`Reserve ${count(EXISTING_LINE_EDITORS, 'existing line item')} and ${CREATORS + DELETERS} categories in different locations`, async () => {
          existingLines = await leases.lines(pages[0], EXISTING_LINE_EDITORS);
          await openCategoriesPage(pages[0]);
          categories = await leases.categories(pages[0], CREATORS + DELETERS);
          test.info().annotations.push({
            type: 'categories',
            description: [...creatorIndexes.map(c => `creator ${c + 1}: ${categories[c]}`), ...deleterIndexes.map((_, d) => `deleter ${d + 1}: ${deleterCategory(d)}`)].join('; '),
          });
          await pages[0].goto('/');
        });

        await test.step('Each deleter adds the line item it will delete later (one per category)', async () => {
          doomedLines = await Promise.all(deleterIndexes.map((i, d) => addLineToCategory(pages[i], deleterCategory(d), randomTextNote(), leases.claimLine)));
          test.info().annotations.push({
            type: 'lines to delete',
            description: doomedLines.map((l, d) => `deleter ${d + 1}: ${l.lineNumber} in ${l.category}`).join('; '),
          });
        });

        await test.step(`Log in the ${VIEWERS} viewers in batches of ${LOGIN_BATCH_SIZE}; they see the lines to delete`, async () => {
          await logIn(viewerIndexes);
          await checkUsers(viewerIndexes, 'viewers see the lines to delete', async page => {
            for (const line of doomedLines) await expectLineOnHome(page, line);
          });
        });

        await test.step(`Log in ${count(EXISTING_LINE_EDITORS, 'editor')} of existing line items, who open one each and enter a new quantity`, async () => {
          await logIn(existingEditorIndexes);
          await Promise.all(existingEditorIndexes.map(i => openLineForEdit(pages[i], lineOfExistingEditor(i))));
          const originals = await Promise.all(existingEditorIndexes.map(async i => Number(await quantityInput(pages[i]).inputValue())));
          for (const i of existingEditorIndexes) expectedQuantity.set(lineOfExistingEditor(i), randomQuantity(...originals, ...usedQuantities()));
          await Promise.all(existingEditorIndexes.map(i => enterQuantity(pages[i], expectedQuantity.get(lineOfExistingEditor(i))!)));
          test.info().annotations.push({
            type: 'existing lines: entered quantities',
            description: existingEditorIndexes.map(i => `${roleOf(i)}: ${lineOfExistingEditor(i)}=${expectedQuantity.get(lineOfExistingEditor(i))}`).join('; '),
          });
        });

        await test.step(`Log in the ${NEW_LINE_EDITORS} editors of new lines; they wait on the home page for the new lines to appear`, async () => {
          await logIn(newLineEditorIndexes);
        });

        await test.step(`${CREATORS} creators open their category and fill in a new line item`, async () => {
          await Promise.all(
            creatorIndexes.map(async c => {
              const page = pages[c];
              const line = newLines[c];
              await openCategoriesPage(page);
              line.category = categories[c];
              line.categoryLineNumbers = await editCategory(page, line.category);
              line.lineNumber = await startAddLine(page);
              leases.claimLine(line.lineNumber);
              Object.assign(line, await fillNewLine(page, line.note));
            }),
          );
          expect(new Set(newLines.map(l => l.lineNumber)).size, 'Every new line should get its own line number').toBe(CREATORS);
          test.info().annotations.push({ type: 'new lines', description: newLines.map((l, c) => `creator ${c + 1}: ${l.lineNumber} in ${l.category}`).join('; ') });
        });

        await test.step(`${DELETERS} deleters open their category and click Delete, leaving the confirmation open`, async () => {
          await Promise.all(
            deleterIndexes.map(async (i, d) => {
              await openCategoriesPage(pages[i]);
              await editCategory(pages[i], deleterCategory(d));
              await startDeleteCategoryLine(pages[i], doomedLines[d].lineNumber);
            }),
          );
        });

        await test.step(`At the same moment: ${count(EXISTING_LINE_EDITORS, 'existing-line edit')}, ${count(CREATORS, 'new line')} and ${count(DELETERS, 'delete')} are saved`, async () => {
          const [edits, creates, deletes] = await Promise.all([
            Promise.all(existingEditorIndexes.map(i => timedEditSave(pages[i]))),
            Promise.all(creatorIndexes.map(c => timedNewLineSave(pages[c], newLines[c]))),
            Promise.all(deleterIndexes.map((i, d) => timedConfirmDelete(pages[i], doomedLines[d].lineNumber))),
          ]);
          reportTimes('edit existing lines', edits, n => `${lineOfExistingEditor(FIRST_EXISTING_EDITOR + n)}=${expectedQuantity.get(lineOfExistingEditor(FIRST_EXISTING_EDITOR + n))}`);
          reportTimes('create lines', creates, n => newLines[n].lineNumber);
          reportTimes('delete lines', deletes, n => doomedLines[n].lineNumber);
          const unconfirmed = [
            ...edits.flatMap((r, n) => (r.saved ? [] : [{ i: existingEditorIndexes[n], what: `edit of ${lineOfExistingEditor(existingEditorIndexes[n])}`, detail: r.detail }])),
            ...creates.flatMap((r, n) => (r.saved ? [] : [{ i: creatorIndexes[n], what: `create of ${newLines[n].lineNumber}`, detail: r.detail }])),
            ...deletes.flatMap((r, n) => (r.saved ? [] : [{ i: deleterIndexes[n], what: `delete of ${doomedLines[n].lineNumber}`, detail: r.detail }])),
          ];
          for (const { i, what } of unconfirmed) {
            const screenshot = await pages[i].screenshot({ fullPage: true }).catch(() => null);
            if (screenshot) await test.info().attach(`unconfirmed ${what} (${roleOf(i)})`, { body: screenshot, contentType: 'image/png' });
          }
          // Whether the change really happened is checked in Azure SQL next; here only the on-screen confirmation is judged.
          expect
            .soft(unconfirmed.map(u => `${u.what}: ${u.detail}`), `The app should confirm every edit, create and delete within ${SAVE_TIMEOUT_MS / 1000}s`)
            .toEqual([]);
        });

        await test.step('Azure SQL holds the result of every edit, create and delete from that moment', async () => {
          const stored = [...(await fetchAzureSqlLines(pages[FIRST_VIEWER], api)).values()];
          const storedLine = (lineNumber: string) => stored.find(s => s.lineNumber === lineNumber);
          const wrong = [
            ...existingLines.flatMap(l => (storedLine(l)?.quantity === expectedQuantity.get(l) ? [] : [`${l} quantity is ${storedLine(l)?.quantity}, expected ${expectedQuantity.get(l)}`])),
            ...newLines.flatMap(l => (storedLine(l.lineNumber) ? [] : [`new line ${l.lineNumber} is missing`])),
            ...doomedLines.flatMap(l => (storedLine(l.lineNumber) ? [`deleted line ${l.lineNumber} is still there`] : [])),
          ];
          expect(wrong, 'Azure SQL after the concurrent edits, creates and deletes').toEqual([]);
        });

        await test.step('Editors, creators and deleters go back to the home page', async () => {
          await Promise.all([
            ...existingEditorIndexes.map(i => backToList(pages[i])),
            ...[...creatorIndexes, ...deleterIndexes].map(i => goHome(pages[i])),
          ]);
        });

        await test.step(`${NEW_LINE_EDITORS} editors see a new line item appear live, open it, change its note and quantity, and all save at once`, async () => {
          await checkUsers(newLineEditorIndexes, 'new lines appear live for their editors', async (page, i) => {
            const line = newLines[i - FIRST_NEW_LINE_EDITOR];
            await expect(lineRow(page, line.lineNumber), `${line.lineNumber} on the home page`).toBeVisible({ timeout: SAVE_TIMEOUT_MS });
            await expectNoReloadSinceLogin(page, roleOf(i));
            await openLineForEdit(page, line.lineNumber);
            line.note = randomTextNote();
            // The note goes in before the quantity: a note typed right after a quantity change used to be reverted.
            await noteInput(page).fill(line.note);
            await noteInput(page).press('Tab');
            line.quantity = randomQuantity(Number(NEW_LINE.quantity), ...usedQuantities());
            expectedQuantity.set(line.lineNumber, line.quantity);
            await enterQuantity(page, line.quantity);
            await expect(noteInput(page), 'Note was changed by the app before Save').toHaveValue(line.note);
          });
          const saves = await Promise.all(newLineEditorIndexes.map(i => timedEditSave(pages[i])));
          reportTimes('edit new lines', saves, n => `${newLines[n].lineNumber}=${newLines[n].quantity}`);
          expect(saves.flatMap((r, n) => (r.saved ? [] : [`${newLines[n].lineNumber}: ${r.detail}`])), 'Every edit of a new line should go through').toEqual([]);
          await Promise.all(newLineEditorIndexes.map(i => backToList(pages[i])));
        });

        await test.step('Azure SQL holds every edit and new line, no deleted line, and Check Data Mismatch finds nothing new', async () => {
          const stored = [...(await fetchAzureSqlLines(pages[FIRST_VIEWER], api)).values()];
          const storedLine = (lineNumber: string) => stored.find(s => s.lineNumber === lineNumber);
          for (const lineNumber of existingLines) {
            expect.soft(storedLine(lineNumber)?.quantity, `${lineNumber} quantity in Azure SQL`).toBe(expectedQuantity.get(lineNumber));
          }
          for (const line of newLines) {
            const row = storedLine(line.lineNumber);
            expect.soft(row, `${line.lineNumber} should be in Azure SQL`).toBeTruthy();
            expect.soft(row?.quantity, `${line.lineNumber} quantity in Azure SQL`).toBe(line.quantity);
            expect.soft(row?.note, `${line.lineNumber} note in Azure SQL`).toBe(line.note);
          }
          for (const line of doomedLines) expect.soft(storedLine(line.lineNumber), `${line.lineNumber} should be gone from Azure SQL`).toBeUndefined();

          const { message } = await runCheckDataMismatch(pages[FIRST_VIEWER]);
          test.info().annotations.push({ type: 'mismatches after', description: message ?? 'none' });
          expect.soft(mismatchCount(message), `Check Data Mismatch after the changes: ${message ?? 'none'}`).toBeLessThanOrEqual(mismatchesBefore);
        });

        await test.step(`All ${USER_COUNT} users see every edit and new line item, and none of the deleted ones`, async () => {
          await checkUsers(everyone, 'everyone sees the final data', async (page, i) => {
            await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
            await expect(dataTables(page).first(), 'home page line tables').toBeVisible({ timeout: 60000 });
            for (const lineNumber of existingLines) {
              await expect(lineQuantityCell(page, lineNumber), `${lineNumber} Qty`).toHaveText(expectedQuantity.get(lineNumber)!, { timeout: 30000 });
            }
            for (const line of newLines) await expectLineOnHome(page, line);
            for (const line of doomedLines) await expect(lineRow(page, line.lineNumber), `${line.lineNumber} should be gone`).toHaveCount(0, { timeout: 30000 });
            // Creators and deleters returned to the home page with a full page load.
            if (!creatorIndexes.includes(i) && !deleterIndexes.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
          });
        });
      } finally {
        await Promise.all(pages.filter(Boolean).map(page => page.context().close()));
      }
    },
  );
});
