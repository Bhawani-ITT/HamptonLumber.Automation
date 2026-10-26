import { Browser, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { TestUser } from '../../utils/users';
import {
  enterQuantity,
  expectNoReloadSinceLogin,
  lineQuantityCell,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveAndExpectSuccess,
} from './twoUserEditFlow';

const USER_COUNT = 20;
const EDITOR_COUNT = 5;
const VIEWER_COUNT = USER_COUNT - EDITOR_COUNT;
// The other viewers log in only after the editors have saved.
const EARLY_VIEWER_COUNT = Math.ceil(VIEWER_COUNT / 2);
const LATE_VIEWER_COUNT = VIEWER_COUNT - EARLY_VIEWER_COUNT;
// Logging everyone in at once can trip Microsoft sign-in throttling.
const LOGIN_BATCH_SIZE = 10;

async function loginInBatches(browser: Browser, users: TestUser[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < users.length; i += LOGIN_BATCH_SIZE) {
    pages.push(...(await Promise.all(users.slice(i, i + LOGIN_BATCH_SIZE).map(user => loginInNewSession(browser, user)))));
  }
  return pages;
}

test.describe('Concurrent users', () => {
  test(`${USER_COUNT} users: ${EDITOR_COUNT} editors change the quantity of different line items; all ${USER_COUNT} users see every new quantity`, async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(900000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    let lineNumbers: string[] = [];
    const newQuantities: string[] = [];
    const lateViewersFrom = EDITOR_COUNT + EARLY_VIEWER_COUNT;
    const roleOf = (i: number) =>
      i < EDITOR_COUNT ? `editor ${i + 1}` : i < lateViewersFrom ? 'viewer logged in before edit' : 'viewer logged in after edit';

    try {
      await test.step(`Log in the ${EDITOR_COUNT} editors and ${EARLY_VIEWER_COUNT} viewers, each in a separate session`, async () => {
        pages = await loginInBatches(browser, users.slice(0, lateViewersFrom));
      });
      const editors = pages.slice(0, EDITOR_COUNT);

      await test.step(`Pick ${EDITOR_COUNT} different line items`, async () => {
        lineNumbers = await leases.lines(pages[0], EDITOR_COUNT);
        test.info().annotations.push({ type: 'line items', description: lineNumbers.map((l, e) => `editor ${e + 1}: ${l}`).join(', ') });
      });

      await test.step(`Each of the ${EDITOR_COUNT} editors opens their own line item and enters a new quantity`, async () => {
        await Promise.all(editors.map((editor, e) => openLineForEdit(editor, lineNumbers[e])));
        for (const [e, editor] of editors.entries()) {
          newQuantities[e] = randomQuantity(Number(await quantityInput(editor).inputValue()), ...newQuantities.map(Number));
        }
        await Promise.all(editors.map((editor, e) => enterQuantity(editor, newQuantities[e])));
        test.info().annotations.push({ type: 'new quantities', description: lineNumbers.map((l, e) => `${l}=${newQuantities[e]}`).join(', ') });
      });

      await test.step(`All ${EDITOR_COUNT} editors save at the same time`, async () => {
        await Promise.all(editors.map(saveAndExpectSuccess));
      });

      await test.step(`The other ${LATE_VIEWER_COUNT} viewers log in after the edits are saved`, async () => {
        pages.push(...(await loginInBatches(browser, users.slice(lateViewersFrom))));
      });

      await test.step(`All ${USER_COUNT} users, including the editors, see every new quantity on the home page without reloading`, async () => {
        const start = Date.now();
        const results = await Promise.allSettled(
          pages.map(async (page, i) => {
            await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
            for (const [e, lineNumber] of lineNumbers.entries()) {
              await expect(lineQuantityCell(page, lineNumber)).toHaveText(newQuantities[e], { timeout: 30000 });
            }
            await expectNoReloadSinceLogin(page, `User ${i + 1}`);
            return Date.now() - start;
          }),
        );
        test.info().annotations.push({
          type: 'time to see all quantities',
          description: results
            .map((r, i) => `user ${i + 1} (${roleOf(i)}): ${r.status === 'fulfilled' ? `${(r.value / 1000).toFixed(1)}s` : 'not seen'}`)
            .join('; '),
        });

        const failures: string[] = [];
        for (const [i, result] of results.entries()) {
          if (result.status === 'fulfilled') continue;
          const page = pages[i];
          await test.info().attach(`user-${i + 1}-${roleOf(i)}-${users[i].username}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
          const seen = await Promise.all(
            lineNumbers.map(async l => `${l}="${(await lineQuantityCell(page, l).innerText().catch(() => '?')).trim()}"`),
          );
          const reloaded = !(await page.evaluate(() => (window as any).__loadedOnceMarker === true));
          failures.push(`${users[i].username} (${roleOf(i)}) sees ${seen.join(', ')}, reloaded=${reloaded}`);
        }
        expect(
          failures,
          `Expected ${lineNumbers.map((l, e) => `${l}="${newQuantities[e]}"`).join(', ')} for every user`,
        ).toEqual([]);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
