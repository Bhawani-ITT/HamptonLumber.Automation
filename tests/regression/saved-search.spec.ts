import { test, expect } from '../../fixtures/testFixtures';
import { homeLocationNames, homeTableTitles } from '../../utils/appData';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Saved search regression', () => {
  test('TC-01: user can select a saved search and apply its filter', async ({ page, loginPage, users }) => {
    test.setTimeout(180000);
    const [user] = await users(1);

    await loginPage.goto();
    await loginPage.login(user.username, user.password);

    await expect(page.getByText('Select a saved search', { exact: true })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Data table' }).first()).toBeVisible({ timeout: 60000 });

    // A location that has tables on the home page, and whose name isn't the start of another location's name.
    const locations = await homeLocationNames(page);
    const titles = await homeTableTitles(page);
    const location = locations.find(
      l => titles.some(t => t.startsWith(`${l} `)) && !locations.some(other => other !== l && other.startsWith(`${l} `)),
    );
    expect(location, `No location with tables on the home page among: ${locations.join(', ')}`).toBeTruthy();
    const locationName = location!;
    test.info().annotations.push({ type: 'location', description: locationName });

    const filterBy = page.getByText('Filter By', { exact: true });
    const filterPanel = filterBy.locator('..');
    await filterPanel.getByRole('button').click();

    const locationCheckbox = page.getByRole('checkbox', { name: locationName, exact: true });
    await page.locator('label').filter({ hasText: new RegExp(`^${locationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
    await expect(locationCheckbox).toBeChecked();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    const filterControl = filterBy.locator('..').locator('..');
    await expect(filterControl).toContainText(locationName);
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeHidden();

    const saveButton = page.getByTitle('Save', { exact: true });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.locator('.k-loading-mask, [role="progressbar"]')).toBeHidden();

    const saveSuccess = page.getByText(/saved search.*(added|saved|updated).*success/i).last();
    const duplicateDialog = page.getByRole('dialog', { name: /Duplicate Saved Search/i });
    await expect(saveSuccess.or(duplicateDialog)).toBeVisible({ timeout: 15000 });
    if (await duplicateDialog.isVisible()) {
      await expect(duplicateDialog).toContainText('This search is already in your list');
      await duplicateDialog.getByRole('button', { name: 'Back' }).click();
    } else {
      await expect(saveSuccess).toBeVisible();
    }

    const savedSearchSelector = page.getByRole('combobox').first();
    await savedSearchSelector.getByRole('button', { name: 'Open' }).click();
    const savedSearch = page.getByRole('option', { name: locationName, exact: true });
    await expect(savedSearch).toBeVisible();
    await savedSearch.click();

    await expect(savedSearchSelector).toContainText(locationName);
    await expect(savedSearch).toBeHidden();
    await expect(filterControl).toContainText(locationName);
    await expect
      .poll(async () => {
        const shown = await homeTableTitles(page);
        return shown.length > 0 && shown.every(t => t.startsWith(`${locationName} `)) ? 'only that location' : shown.join(' | ');
      }, { message: `Only ${locationName} tables are shown`, timeout: 30000 })
      .toBe('only that location');
  });
});
