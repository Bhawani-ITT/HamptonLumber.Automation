import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import {
  enterQuantity,
  expectNoReloadSinceLogin,
  lineQuantityCell,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveChangesButton,
} from './twoUserEditFlow';

test.describe('Concurrent users', () => {
  test('two user cred: two users update different records simultaneously', async ({ browser, users, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(240000);
    const [testUserA, testUserB] = await users(2);

    let userA!: Page;
    let userB!: Page;
    let lineA = '';
    let lineB = '';
    let quantityA = '';
    let quantityB = '';

    try {
      await test.step('User A and User B log in, each in a separate session', async () => {
        [userA, userB] = await Promise.all([loginInNewSession(browser, testUserA), loginInNewSession(browser, testUserB)]);
      });

      await test.step('Pick two different line items', async () => {
        [lineA, lineB] = await leases.lines(userA, 2);
      });

      await test.step('User A opens line item A and User B opens line item B', async () => {
        await Promise.all([openLineForEdit(userA, lineA), openLineForEdit(userB, lineB)]);
        await expect(userA.getByRole('main').getByRole('textbox').first()).toHaveValue(lineA);
        await expect(userB.getByRole('main').getByRole('textbox').first()).toHaveValue(lineB);
      });

      await test.step('Both users enter unique quantities', async () => {
        const originalA = Number(await quantityInput(userA).inputValue());
        const originalB = Number(await quantityInput(userB).inputValue());
        quantityA = randomQuantity(originalA, originalB);
        quantityB = randomQuantity(originalA, originalB, Number(quantityA));
        await Promise.all([enterQuantity(userA, quantityA), enterQuantity(userB, quantityB)]);
      });

      await test.step('Both users click Save Changes at the same time', async () => {
        await Promise.all([saveChangesButton(userA).click(), saveChangesButton(userB).click()]);
        await Promise.all(
          [userA, userB].map(page =>
            expect(page.getByText(/line detail updated successfully/i).first()).toBeVisible({ timeout: 15000 }),
          ),
        );
      });

      await test.step("Each user sees both saved quantities on the home page without reloading", async () => {
        for (const page of [userA, userB]) {
          await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
          await expect(lineQuantityCell(page, lineA)).toHaveText(quantityA, { timeout: 30000 });
          await expect(lineQuantityCell(page, lineB)).toHaveText(quantityB, { timeout: 30000 });
        }
        await expectNoReloadSinceLogin(userA, 'User A');
        await expectNoReloadSinceLogin(userB, 'User B');
      });
    } finally {
      await userA?.context().close();
      await userB?.context().close();
    }
  });
});
