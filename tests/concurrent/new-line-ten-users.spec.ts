import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import {
  expectNoReloadSinceLogin,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveAndExpectSuccess,
  enterQuantity,
} from './twoUserEditFlow';
import {
  editCategory,
  expectLineOnHome,
  ExpectedLine,
  fillNewLine,
  NEW_LINE,
  noteInput,
  openCategoriesPage,
  randomTextNote,
  saveNewLine,
  startAddLine,
} from './categoryLineFlow';

const USER_COUNT = 10;
// Positions in the leased user list.
const CREATOR = 0;
const LATE_LOGIN = 1;
const WATCHER = 2;
const EDITOR = 3;

const roleOf = (i: number) =>
  ({ [CREATOR]: 'user 1, created the line', [LATE_LOGIN]: 'user 2, logged in after creation', [WATCHER]: 'user 3, on the edit page', [EDITOR]: 'user 4, changed the quantity' })[i] ??
  `user ${i + 1}, viewer`;

test.describe('Concurrent users', () => {
  test(`${USER_COUNT} users: a new line item is created, then edited while another user has it open; every user sees every change`, async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(900000);
    const users = await leaseUsers(USER_COUNT);

    const pages: Page[] = [];
    const line = { quantity: NEW_LINE.quantity, note: randomTextNote() } as ExpectedLine;
    let newQuantity = '';
    const expected = (quantity: string): ExpectedLine => ({ ...line, quantity });

    /** Runs the check for every given user and fails with one readable line (and a screenshot) per user that failed. */
    const checkUsers = async (indexes: number[], what: string, check: (page: Page, i: number) => Promise<void>) => {
      const results = await Promise.allSettled(indexes.map(i => check(pages[i], i)));
      const failures: string[] = [];
      for (const [n, result] of results.entries()) {
        if (result.status === 'fulfilled') continue;
        const i = indexes[n];
        await test.info().attach(`${roleOf(i)}-${users[i].username}`, { body: await pages[i].screenshot({ fullPage: true }), contentType: 'image/png' });
        failures.push(`${users[i].username} (${roleOf(i)}): ${String(result.reason).split('\n')[0]}`);
      }
      expect(failures, what).toEqual([]);
    };
    const everyoneExcept = (...skip: number[]) => [...Array(USER_COUNT).keys()].filter(i => !skip.includes(i));

    try {
      await test.step(`Log in ${USER_COUNT - 1} users in separate sessions (user 2 logs in later)`, async () => {
        const early = everyoneExcept(LATE_LOGIN);
        const loggedIn = await Promise.all(early.map(i => loginInNewSession(browser, users[i])));
        early.forEach((i, n) => (pages[i] = loggedIn[n]));
      });

      await test.step('User 1 adds a new line item to a category', async () => {
        const creator = pages[CREATOR];
        await openCategoriesPage(creator);
        [line.category] = await leases.categories(creator, 1);
        line.categoryLineNumbers = await editCategory(creator, line.category);
        line.lineNumber = await startAddLine(creator);
        leases.claimLine(line.lineNumber);
        Object.assign(line, await fillNewLine(creator, line.note));
        await saveNewLine(creator, line.lineNumber, line.note);
        test.info().annotations.push({ type: 'new line', description: `${line.lineNumber} in ${line.category}` });
      });
      const { lineNumber, note } = line;

      await test.step('Users already logged in see the new line item on the home page without reloading', async () => {
        await pages[CREATOR].goto('/');
        await checkUsers(everyoneExcept(LATE_LOGIN), `Expected the new line ${lineNumber} on every home page`, async (page, i) => {
          await expectLineOnHome(page, expected(NEW_LINE.quantity));
          if (i !== CREATOR) await expectNoReloadSinceLogin(page, roleOf(i));
        });
      });

      await test.step('User 2 logs in after the line item was created and sees it', async () => {
        pages[LATE_LOGIN] = await loginInNewSession(browser, users[LATE_LOGIN]);
        await checkUsers([LATE_LOGIN], `Expected the new line ${lineNumber} for the late login`, page => expectLineOnHome(page, expected(NEW_LINE.quantity)));
      });

      await test.step('User 3 opens the new line item and stays on the edit page', async () => {
        await openLineForEdit(pages[WATCHER], lineNumber);
        await expect(quantityInput(pages[WATCHER])).toHaveValue(NEW_LINE.quantity);
        await expect(noteInput(pages[WATCHER])).toHaveValue(note);
      });

      await test.step('User 4 opens the same line item, changes the quantity and saves', async () => {
        const editor = pages[EDITOR];
        await openLineForEdit(editor, lineNumber);
        newQuantity = randomQuantity(Number(NEW_LINE.quantity));
        await enterQuantity(editor, newQuantity);
        await saveAndExpectSuccess(editor);
        test.info().annotations.push({ type: 'quantity change', description: `${lineNumber}: ${NEW_LINE.quantity} -> ${newQuantity}` });
      });

      await test.step("User 3 sees user 4's quantity on the open edit page without reloading", async () => {
        await checkUsers([WATCHER], `Expected quantity ${newQuantity} on user 3's edit page`, async page => {
          await expect(quantityInput(page)).toHaveValue(newQuantity, { timeout: 30000 });
          await expectNoReloadSinceLogin(page, roleOf(WATCHER));
        });
        await pages[WATCHER].getByRole('button', { name: /Back to list/ }).click();
      });

      await test.step(`All ${USER_COUNT} users see the new line item with the new quantity on the home page`, async () => {
        await checkUsers(everyoneExcept(), `Expected ${lineNumber} with quantity ${newQuantity} on every home page`, async (page, i) => {
          await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
          await expectLineOnHome(page, expected(newQuantity));
          if (i !== CREATOR) await expectNoReloadSinceLogin(page, roleOf(i));
        });
      });
    } finally {
      await Promise.all(pages.filter(Boolean).map(page => page.context().close()));
    }
  });
});
