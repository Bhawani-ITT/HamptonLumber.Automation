import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import {
  dataTables,
  enterQuantity,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveChangesButton,
} from '../concurrent/twoUserEditFlow';
import { TestUser } from '../../utils/users';
import { differencesAfterSettling, IntegrityApi, runCheckDataMismatch } from '../../utils/dataIntegrity';

const USER_COUNT = 6;
const EDITOR_COUNT = 2;
const UPDATES_PER_EDITOR = 3;

test.describe('Data integrity', () => {
  test(`Every user's home page matches Azure SQL after rapid quantity updates, live and after a reload`, async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    let api!: IntegrityApi;
    const lineNumbers: string[] = [];
    const finalQuantities: string[] = [];
    const findings: string[] = [];

    /** Compares every user's home page with Azure SQL; the app's own Check Data Mismatch result is recorded too. */
    const checkAllUsers = async (when: string) => {
      const results = await Promise.all(
        pages.map(async (page, i) => ({
          user: users[i],
          differences: await differencesAfterSettling(page, api),
          mismatchToast: (await runCheckDataMismatch(page)).message,
        })),
      );
      const failed = results.filter(r => r.differences.length > 0 || r.mismatchToast);
      for (const { user, differences, mismatchToast } of failed) {
        const page = pages[users.indexOf(user)];
        await test.info().attach(`${when}-${user.username}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
        findings.push(describe(when, user, differences, mismatchToast));
      }
      test.info().annotations.push({ type: when, description: `${results.length - failed.length}/${results.length} users match Azure SQL` });
      return failed.length;
    };

    try {
      await test.step(`Log in ${USER_COUNT} users in separate sessions`, async () => {
        pages = await Promise.all(users.map(user => loginInNewSession(browser, user)));
        api = (await runCheckDataMismatch(pages[0])).api;
      });

      await test.step('Before any edit: every home page matches Azure SQL', async () => {
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
              await openLineForEdit(editor, lineNumber);
              quantity = randomQuantity(Number(await quantityInput(editor).inputValue()));
              await enterQuantity(editor, quantity);
              await saveChangesButton(editor).click();
              await expect(editor).not.toHaveURL(/\/edit\//, { timeout: 30000 });
            }
            finalQuantities[e] = quantity;
          }),
        );
        test.info().annotations.push({
          type: 'final quantities saved',
          description: lineNumbers.map((l, e) => `${l}=${finalQuantities[e]}`).join(', '),
        });
      });

      await test.step('Live: every home page matches Azure SQL without reloading', async () => {
        await checkAllUsers('live after edits');
      });

      await test.step('After every user reloads the page, every home page still matches Azure SQL', async () => {
        await Promise.all(pages.map(page => page.reload()));
        await Promise.all(pages.map(page => expect(dataTables(page).first()).toBeVisible({ timeout: 60000 })));
        await checkAllUsers('after reload');
      });

      expect(findings, 'Home page data that differs from Azure SQL (see screenshots)').toEqual([]);
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});

function describe(when: string, user: TestUser, differences: string[], mismatchToast: string | null): string {
  const parts = [`[${when}] ${user.username}:`];
  if (differences.length) parts.push(differences.join('; '));
  parts.push(`Check Data Mismatch: ${mismatchToast ?? 'no mismatch reported'}`);
  return parts.join(' ');
}
