import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import {
  expectNoReloadSinceLogin,
  lineQuantityCell,
  lineRow,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveChangesButton,
} from './twoUserEditFlow';

const USER_COUNT = 10;
const NOTES_COLUMN = 10;

const noteInput = (page: Page) => page.locator('label:text-is("Note") + span textarea >> visible=true');
const unitSizeInput = (page: Page) =>
  page.locator('label:has-text("Unit Size") + span input[role="spinbutton"] >> visible=true');

test.describe('Concurrent users', () => {
  test(`${USER_COUNT} users: one user edits a line item and the other ${USER_COUNT - 1} see the changes live`, async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    let lineNumber = '';
    let newQuantity = '';
    let newUnitSize = '';
    const newNote = `Live update check ${Date.now()}`;

    try {
      await test.step(`Log in ${USER_COUNT} unique users, each in a separate session`, async () => {
        pages = await Promise.all(users.map(user => loginInNewSession(browser, user)));
      });
      const [editor, ...viewers] = pages;

      await test.step('Pick a line item', async () => {
        [lineNumber] = await leases.lines(editor, 1);
      });

      await test.step(`All ${USER_COUNT} users open the same line item`, async () => {
        await Promise.all(pages.map(page => openLineForEdit(page, lineNumber)));
        await expect(unitSizeInput(editor)).not.toHaveValue('');
      });

      await test.step('User A changes the quantity, note and unit size and saves', async () => {
        const currentQuantity = Number(await quantityInput(editor).inputValue());
        const currentUnitSize = Number(await unitSizeInput(editor).inputValue());
        newQuantity = randomQuantity(currentQuantity);
        do {
          newUnitSize = String(Math.floor(Math.random() * 99) + 1);
        } while (Number(newUnitSize) === currentUnitSize);

        await quantityInput(editor).fill(newQuantity);
        await quantityInput(editor).press('Tab');
        await noteInput(editor).fill(newNote);
        await noteInput(editor).press('Tab');
        await unitSizeInput(editor).fill(newUnitSize);
        await unitSizeInput(editor).press('Tab');

        // The app has been seen to put the previously saved note back after the Note box loses focus.
        const revertedBeforeSave = 'was reverted by the app before Save was clicked';
        await expect(quantityInput(editor), `Quantity ${revertedBeforeSave}`).toHaveValue(newQuantity);
        await expect(noteInput(editor), `Note ${revertedBeforeSave}`).toHaveValue(newNote);
        await expect(unitSizeInput(editor), `Unit Size ${revertedBeforeSave}`).toHaveValue(newUnitSize);

        await saveChangesButton(editor).scrollIntoViewIfNeeded();
        await expect(saveChangesButton(editor)).toBeEnabled();
        await saveChangesButton(editor).click();
        await expect(editor.getByText(/line detail updated successfully/i).first()).toBeVisible({ timeout: 15000 });
      });

      // Checked before the viewers so a failure shows whether the change was saved at all or only not pushed live.
      await test.step("User A's home page shows the saved quantity and note", async () => {
        await expect(editor).not.toHaveURL(/\/edit\//, { timeout: 30000 });
        await expect.soft(lineQuantityCell(editor, lineNumber)).toHaveText(newQuantity, { timeout: 30000 });
        await expect.soft(lineRow(editor, lineNumber).getByRole('gridcell').nth(NOTES_COLUMN)).toHaveText(newNote);
        await expectNoReloadSinceLogin(editor, 'User A');
      });

      await test.step(`The other ${USER_COUNT - 1} users see the new quantity, note and unit size without reloading`, async () => {
        const results = await Promise.allSettled(
          viewers.map(async page => {
            await expect(quantityInput(page)).toHaveValue(newQuantity, { timeout: 30000 });
            await expect(noteInput(page)).toHaveValue(newNote, { timeout: 30000 });
            await expect(unitSizeInput(page)).toHaveValue(newUnitSize, { timeout: 30000 });
            await expectNoReloadSinceLogin(page, 'Viewer');
          }),
        );
        const failedViewers = results.flatMap((result, i) => (result.status === 'rejected' ? [i] : []));
        const failures: string[] = [];
        for (const i of failedViewers) {
          const page = viewers[i];
          await test.info().attach(`viewer-${i + 1}-${users[i + 1].username}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
          failures.push(
            `${users[i + 1].username} sees quantity="${await quantityInput(page).inputValue()}", ` +
              `note="${await noteInput(page).inputValue()}", unit size="${await unitSizeInput(page).inputValue()}", ` +
              `reloaded=${!(await page.evaluate(() => (window as any).__loadedOnceMarker === true))}`,
          );
        }
        expect(
          failures,
          `Expected quantity="${newQuantity}", note="${newNote}", unit size="${newUnitSize}" on ${lineNumber} for every viewer`,
        ).toEqual([]);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
