import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import {
  dataTables,
  enterQuantity,
  expectNoReloadSinceLogin,
  lineQuantityCell,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveAndExpectSuccess,
} from '../concurrent/twoUserEditFlow';
import { compareHomeGridLines, readHomeGridLines } from '../../utils/dataIntegrity';

const USER_COUNT = 6;
const EDITOR_COUNT = 2;
const UPDATES_PER_EDITOR = 3;

test.describe('Data integrity', () => {
  test(`Every user's home page shows the same line data after rapid quantity updates, live and after a reload`, async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    const lineNumbers: string[] = [];
    const finalQuantities: string[] = [];

    const checkAllUsers = async (when: string) => {
      try {
        await expect(async () => {
          const grids = await Promise.all(pages.map(page => readHomeGridLines(page)));
          for (const [userIndex, grid] of grids.entries()) {
            expect(compareHomeGridLines(grids[0], grid), `${when}: ${users[userIndex].username}`).toEqual([]);
            for (const [editorIndex, lineNumber] of lineNumbers.entries()) {
              const line = grid.find(candidate => candidate.lineNumber === lineNumber);
              expect(line, `${when}: ${users[userIndex].username} sees ${lineNumber}`).toBeDefined();
              expect(line?.quantity, `${when}: ${users[userIndex].username}, ${lineNumber}`).toBe(finalQuantities[editorIndex]);
            }
          }
        }).toPass({ timeout: 30000 });
      } catch (error) {
        for (const [userIndex, page] of pages.entries()) {
          await test.info().attach(`${when}-${users[userIndex].username}`, {
            body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
          });
        }
        throw error;
      }
      test.info().annotations.push({ type: when, description: `${users.length} users show matching home-page line data` });
    };

    try {
      await test.step(`Log in ${USER_COUNT} users in separate sessions`, async () => {
        pages = await Promise.all(users.map(user => loginInNewSession(browser, user)));
      });

      await test.step('Before any edit: line data matches across all home pages', async () => {
        await checkAllUsers('before edits');
      });

      await test.step(`${EDITOR_COUNT} editors each update the quantity of their own line ${UPDATES_PER_EDITOR} times in quick succession`, async () => {
        lineNumbers.push(...(await leases.lines(pages[0], EDITOR_COUNT)));
        test.info().annotations.push({ type: 'edited lines', description: lineNumbers.join(', ') });

        await Promise.all(
          lineNumbers.map(async (lineNumber, e) => {
            const editor = pages[e];
            let quantity = '';
            for (let n = 0; n < UPDATES_PER_EDITOR; n++) {
              await test.step(`Editor ${e + 1}: update ${n + 1} of ${lineNumber}`, async () => {
                try {
                  await openLineForEdit(editor, lineNumber);
                  quantity = randomQuantity(Number(await quantityInput(editor).inputValue()));
                  await enterQuantity(editor, quantity);
                  await saveAndExpectSuccess(editor);
                  await expect(lineQuantityCell(editor, lineNumber), 'Saved quantity is visible before reopening the line').toHaveText(quantity, { timeout: 30000 });
                } catch (error) {
                  test.info().annotations.push({ type: 'failed edit', description: `${users[e].username}: ${lineNumber}, update ${n + 1}, URL=${editor.url()}` });
                  const screenshot = await editor.screenshot({ fullPage: true }).catch(() => null);
                  if (screenshot) await test.info().attach(`editor-${e + 1}-update-${n + 1}`, { body: screenshot, contentType: 'image/png' });
                  await test.info().attach(`editor-${e + 1}-page-state`, {
                    body: await editor.locator('body').innerText().catch(() => 'Page unavailable'), contentType: 'text/plain',
                  });
                  throw error;
                }
              });
            }
            finalQuantities[e] = quantity;
          }),
        );
        test.info().annotations.push({
          type: 'final quantities saved',
          description: lineNumbers.map((l, e) => `${l}=${finalQuantities[e]}`).join(', '),
        });
      });

      await test.step('Live: every home page shows the saved quantities and matching line data without reloading', async () => {
        await checkAllUsers('live after edits');
        await Promise.all(pages.map((page, userIndex) => expectNoReloadSinceLogin(page, users[userIndex].username)));
      });

      await test.step('After every user reloads, the saved quantities and line data still match across home pages', async () => {
        await Promise.all(pages.map(page => page.reload()));
        await Promise.all(pages.map(page => expect(dataTables(page).first()).toBeVisible({ timeout: 60000 })));
        await checkAllUsers('after reload');
      });

    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
