import { test, expect } from '../../fixtures/testFixtures';
import { lineRow, openLineForEdit } from '../concurrent/twoUserEditFlow';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Single user CRUD', () => {
  test('TC-02: user can edit a line item quantity and see it on the home page', async ({ page, loginPage, users, leases }) => {
    test.setTimeout(180000);
    const [user] = await users(1);
    const grid = page.getByRole('grid', { name: 'Data table' }).first();
    const locationFilters = page.getByRole('main').getByRole('link');
    let lineNumber = '';
    let newQuantity = '';

    await test.step('Log in with valid credentials', async () => {
      await loginPage.goto();
      await loginPage.login(user.username, user.password);
    });

    await test.step('Verify the home page shows the logo, Sync Data button and location filters', async () => {
      await expect(page.getByRole('img', { name: 'Logo' })).toBeVisible({ timeout: 60000 });
      await expect(page.getByRole('button', { name: 'Sync Data', exact: true })).toBeVisible();
      await expect(locationFilters.first()).toBeVisible({ timeout: 60000 });
      await expect(grid).toBeVisible({ timeout: 30000 });
    });

    await test.step('Open a line item from the Line # column', async () => {
      [lineNumber] = await leases.lines(page, 1);
      await openLineForEdit(page, lineNumber);
    });

    const quantityInput = page.locator('label:has-text("Quantity") + span input[role="spinbutton"] >> visible=true');
    const saveChangesButton = page.getByRole('button', { name: 'Save Changes', exact: true });

    await test.step('Verify the Edit Line Detail page opens', async () => {
      await expect(page.getByRole('heading', { name: /Edit Line Detail/ })).toBeVisible({ timeout: 30000 });
      await expect(page.getByRole('main').getByRole('textbox').first()).toHaveValue(lineNumber);
    });

    await test.step('Replace the quantity with a random number between 1 and 999', async () => {
      const currentQuantity = Number(await quantityInput.inputValue());
      let quantity: number;
      do {
        quantity = Math.floor(Math.random() * 999) + 1;
      } while (quantity === currentQuantity);
      newQuantity = String(quantity);

      await quantityInput.fill(newQuantity);
      await quantityInput.press('Tab');
      await expect(quantityInput).toHaveValue(newQuantity);
    });

    await test.step('Scroll to Save Changes, verify it is enabled and click it', async () => {
      await saveChangesButton.scrollIntoViewIfNeeded();
      await expect(saveChangesButton).toBeEnabled();
      await saveChangesButton.click();
    });

    await test.step('Verify the "line detail updated successfully" notification', async () => {
      await expect(page.getByText(/line detail updated successfully/i).first()).toBeVisible({ timeout: 15000 });
    });

    await test.step('Verify the user is redirected to the home page', async () => {
      await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
      await expect(grid).toBeVisible({ timeout: 30000 });
    });

    await test.step('Verify the same line item shows the updated quantity', async () => {
      await expect(lineRow(page, lineNumber).getByRole('gridcell').nth(1)).toHaveText(newQuantity, { timeout: 30000 });
    });
  });
});
