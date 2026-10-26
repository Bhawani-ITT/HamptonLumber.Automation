import { test, expect } from '../../fixtures/testFixtures';

test.describe('Dashboard', () => {
  test('dashboard loads with navigation links', async ({ dashboardPage }) => {
    await dashboardPage.goto();

    await expect(dashboardPage.welcomeHeading).toBeVisible();
    await expect(dashboardPage.navLocations).toBeVisible();
    await expect(dashboardPage.navCategories).toBeVisible();
    await expect(dashboardPage.navSizes).toBeVisible();
    await expect(dashboardPage.navLineItems).toBeVisible();
  });
});
