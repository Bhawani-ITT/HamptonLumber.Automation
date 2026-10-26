import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { backToList, dataTables, enterQuantity, expectNoReloadSinceLogin, lineQuantityCell, openLineForEdit, quantityInput, randomQuantity } from './twoUserEditFlow';
import { editCategory, expectLineOnHome, ExpectedLine, fillNewLine, NEW_LINE, openCategoriesPage, randomTextNote, startAddLine } from './categoryLineFlow';
import { expectHomeGridMatches, readSettledHomeLine } from '../../utils/dataIntegrity';
import { LOGIN_BATCH_SIZE, loginInBatches, range, SAVE_TIMEOUT_MS, seconds, timedEditSave, timedNewLineSave, userChecker } from './loadFlow';

// Roles by position in the leased user list.
const SAME_LINE_EDITORS = 2;
const UNIQUE_LINE_EDITORS = 8;
const CREATORS = 4;
const WATCHERS = 6;
const VIEWERS = 10;
const EDITORS = SAME_LINE_EDITORS + UNIQUE_LINE_EDITORS;
const USER_COUNT = EDITORS + CREATORS + WATCHERS + VIEWERS;
const FIRST_CREATOR = EDITORS;
const FIRST_WATCHER = FIRST_CREATOR + CREATORS;
const FIRST_VIEWER = FIRST_WATCHER + WATCHERS;

const editorIndexes = range(0, EDITORS);
const creatorIndexes = range(FIRST_CREATOR, CREATORS);
const watcherIndexes = range(FIRST_WATCHER, WATCHERS);
const everyone = range(0, USER_COUNT);

function roleOf(i: number): string {
  if (i < SAME_LINE_EDITORS) return `editor ${i + 1}, same line as the other`;
  if (i < EDITORS) return `editor ${i + 1}, own line`;
  if (i < FIRST_WATCHER) return `creator ${i - FIRST_CREATOR + 1}`;
  if (i < FIRST_VIEWER) return `watcher ${i - FIRST_WATCHER + 1}`;
  return 'viewer';
}

test.describe('Concurrent users', () => {
  test(
    `${USER_COUNT} users: ${EDITORS} edit (${SAME_LINE_EDITORS} on the same line), ${CREATORS} add lines, ` +
      `${WATCHERS} watch lines being edited, ${VIEWERS} view; every user sees the same final data`,
    async ({ browser, users: leaseUsers, leases }) => {
      test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
      test.setTimeout(1_200_000);
      const users = await leaseUsers(USER_COUNT);

      let pages: Page[] = [];
      /** Line each editor edits: both same-line editors share the first one. */
      let editedLines: string[] = [];
      const lineOfEditor = (e: number) => editedLines[Math.max(0, e - SAME_LINE_EDITORS + 1)];
      /** Line each watcher has open: the shared line first, then lines of other editors. */
      const lineOfWatcher = (w: number) => editedLines[w];
      const enteredQuantity: string[] = [];
      const expectedQuantity = new Map<string, string>();
      const newLines = Array.from({ length: CREATORS }, () => ({ quantity: NEW_LINE.quantity, note: randomTextNote() }) as ExpectedLine);

      const checkUsers = userChecker(() => pages, users, roleOf);

      try {
        await test.step(`Log in ${USER_COUNT} unique users in batches of ${LOGIN_BATCH_SIZE}, each in a separate session`, async () => {
          pages = await loginInBatches(browser, users);
          test.info().annotations.push({ type: 'roles', description: users.map((u, i) => `${u.username}: ${roleOf(i)}`).join('; ') });
        });

        await test.step('Before any change: home-page line data matches across users', async () => {
          await checkUsers(everyone, 'initial home-page data matches', page => expectHomeGridMatches(page, pages[FIRST_VIEWER]));
        });

        await test.step(`Pick ${UNIQUE_LINE_EDITORS + 1} line items: one shared by ${SAME_LINE_EDITORS} editors, one for each other editor`, async () => {
          editedLines = await leases.lines(pages[0], UNIQUE_LINE_EDITORS + 1);
          test.info().annotations.push({
            type: 'edited lines',
            description: editorIndexes.map(e => `editor ${e + 1}: ${lineOfEditor(e)}`).join('; '),
          });
        });

        await test.step(`${WATCHERS} watchers open line items that editors are about to change and stay on the edit page`, async () => {
          await Promise.all(watcherIndexes.map((i, w) => openLineForEdit(pages[i], lineOfWatcher(w))));
          test.info().annotations.push({
            type: 'watched lines',
            description: watcherIndexes.map((_, w) => `watcher ${w + 1}: ${lineOfWatcher(w)}`).join('; '),
          });
        });

        await test.step(`${EDITORS} editors open their line items and enter new quantities`, async () => {
          await Promise.all(editorIndexes.map(e => openLineForEdit(pages[e], lineOfEditor(e))));
          const originals = await Promise.all(editorIndexes.map(async e => Number(await quantityInput(pages[e]).inputValue())));
          for (const e of editorIndexes) enteredQuantity[e] = randomQuantity(...originals, ...enteredQuantity.map(Number));
          await Promise.all(editorIndexes.map(e => enterQuantity(pages[e], enteredQuantity[e])));
          for (const e of range(SAME_LINE_EDITORS, UNIQUE_LINE_EDITORS)) expectedQuantity.set(lineOfEditor(e), enteredQuantity[e]);
          test.info().annotations.push({
            type: 'entered quantities',
            description: editorIndexes.map(e => `editor ${e + 1}: ${lineOfEditor(e)}=${enteredQuantity[e]}`).join('; '),
          });
        });

        await test.step(`${CREATORS} creators open a category each (all in different locations) and fill in a new line item`, async () => {
          const creators = creatorIndexes.map(i => pages[i]);
          await Promise.all(creators.map(openCategoriesPage));
          const categories = await leases.categories(creators[0], CREATORS);
          await Promise.all(
            creators.map(async (creator, c) => {
              const line = newLines[c];
              line.category = categories[c];
              line.categoryLineNumbers = await editCategory(creator, line.category);
              line.lineNumber = await startAddLine(creator);
              leases.claimLine(line.lineNumber);
              Object.assign(line, await fillNewLine(creator, line.note));
            }),
          );
          test.info().annotations.push({
            type: 'new lines',
            description: newLines.map((l, c) => `creator ${c + 1}: ${l.lineNumber} in ${l.category}`).join('; '),
          });
        });

        const sameLine = editedLines[0];

        await test.step(`All ${EDITORS} editors and ${CREATORS} creators click Save Changes at the same time`, async () => {
          const saves = await Promise.all([
            ...editorIndexes.map(e => timedEditSave(pages[e])),
            ...creatorIndexes.map((i, c) => timedNewLineSave(pages[i], newLines[c])),
          ]);
          const who = (n: number) => (n < EDITORS ? `editor ${n + 1} (${lineOfEditor(n)}=${enteredQuantity[n]})` : `creator ${n - EDITORS + 1} (${newLines[n - EDITORS].lineNumber})`);
          test.info().annotations.push({
            type: 'save results',
            description: saves.map((s, n) => `${who(n)}: ${s.saved ? 'saved' : 'NOT saved'} in ${seconds(s.ms)}, ${s.detail}`).join('; '),
          });
          const times = saves.filter(s => s.saved).map(s => s.ms).sort((a, b) => a - b);
          test.info().annotations.push({
            type: 'save times',
            description: `fastest ${seconds(times[0] ?? 0)}, median ${seconds(times[Math.floor(times.length / 2)] ?? 0)}, slowest ${seconds(times.at(-1) ?? 0)}`,
          });
          // One of the two same-line saves may be refused; every other save must go through.
          const notSaved = saves.flatMap((s, n) => (!s.saved && n >= SAME_LINE_EDITORS ? [`${who(n)}: ${s.detail}`] : []));
          expect(notSaved, `Every save should go through within ${SAVE_TIMEOUT_MS / 1000}s`).toEqual([]);
          expect(saves.slice(0, SAME_LINE_EDITORS).some(s => s.saved), `At least one save on ${sameLine} should go through`).toBe(true);
          expect(new Set(newLines.map(l => l.lineNumber)).size, 'Every new line should get its own line number').toBe(CREATORS);
        });

        await test.step(`A viewer sees one of the two saved quantities for ${sameLine} on the home page`, async () => {
          const sameLineQuantities = range(0, SAME_LINE_EDITORS).map(e => enteredQuantity[e]);
          const { quantity: finalQuantity } = await readSettledHomeLine(pages[FIRST_VIEWER], sameLine, sameLineQuantities);
          expectedQuantity.set(sameLine, finalQuantity);
          test.info().annotations.push({ type: `same line ${sameLine} result`, description: `Home page shows ${finalQuantity} (entered: ${sameLineQuantities.join(' and ')})` });
        });

        await test.step(`The ${WATCHERS} watchers see the saved quantity on their open edit page without reloading`, async () => {
          await checkUsers(watcherIndexes, 'watchers see live quantity', async (page, i) => {
            const line = lineOfWatcher(i - FIRST_WATCHER);
            await expect(quantityInput(page), `${line} on the open edit page`).toHaveValue(expectedQuantity.get(line)!, { timeout: 30000 });
            await expectNoReloadSinceLogin(page, roleOf(i));
          });
        });

        await test.step('Everyone still on an edit or admin page goes back to the home page', async () => {
          await Promise.all([...watcherIndexes, ...range(0, SAME_LINE_EDITORS)].map(i => backToList(pages[i])));
          await Promise.all(creatorIndexes.map(i => pages[i].goto('/')));
        });

        await test.step(`All ${USER_COUNT} users see every final quantity and every new line item on the home page`, async () => {
          await checkUsers(everyone, 'everyone sees all changes', async (page, i) => {
            await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
            // A freshly loaded home page (creators) can take a while to render its grids under load.
            await expect(dataTables(page).first(), 'home page line tables').toBeVisible({ timeout: 60000 });
            for (const [lineNumber, quantity] of expectedQuantity) {
              await expect(lineQuantityCell(page, lineNumber), `${lineNumber} Qty`).toHaveText(quantity, { timeout: 30000 });
            }
            for (const line of newLines) await expectLineOnHome(page, line);
            await expectHomeGridMatches(page, pages[FIRST_VIEWER]);
            // Creators returned to the home page with a full page load.
            if (!creatorIndexes.includes(i)) await expectNoReloadSinceLogin(page, roleOf(i));
          });
        });
      } finally {
        await Promise.all(pages.map(page => page.context().close()));
      }
    },
  );
});
