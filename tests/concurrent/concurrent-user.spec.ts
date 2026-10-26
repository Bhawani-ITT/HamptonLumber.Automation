import { test, expect } from '../../fixtures/testFixtures';
import { LoginPage } from '../../pages/LoginPage';
const CONCURRENT_USERS = 5;

test.describe('Concurrent users', () => {
  test(`${CONCURRENT_USERS} users can log in simultaneously`, async ({ browser, users }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(300000);

    await Promise.all(
      (await users(CONCURRENT_USERS)).map(async user => {
        const context = await browser.newContext({
          baseURL: process.env.BASE_URL,
          storageState: { cookies: [], origins: [] },
        });
        try {
          const page = await context.newPage();
          const loginPage = new LoginPage(page);
          await loginPage.goto();
          await loginPage.login(user.username, user.password);
          await expect(page.getByRole('img', { name: 'Logo' })).toBeVisible({ timeout: 120000 });
          await expect(page.getByRole('grid', { name: 'Data table' }).first()).toBeVisible({ timeout: 120000 });
        } finally {
          await context.close();
        }
      }),
    );
  });
});
