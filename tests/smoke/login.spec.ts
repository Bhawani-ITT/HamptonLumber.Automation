import { test, expect } from '../../fixtures/testFixtures';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login', () => {
  test('user can log in with valid credentials', async ({ page, loginPage, users }) => {
    test.setTimeout(120000);
    const [user] = await users(1);
    const appOrigin = new URL(process.env.BASE_URL!).origin;

    await test.step('Open the application base URL', async () => {
      await loginPage.goto();
    });

    await test.step('Enter valid credentials from Key Vault', async () => {
      await loginPage.usernameInput.fill(user.username);
      await loginPage.nextButton.click();
      await loginPage.passwordInput.fill(user.password);
    });

    await test.step('Log in to the application', async () => {
      await loginPage.signInButton.click();
    });

    await test.step('Verify the user is logged in and sees the home page', async () => {
      await expect(page).toHaveURL(url => url.origin === appOrigin, { timeout: 30000 });
      await expect(page.getByText('Select a saved search', { exact: true })).toBeVisible({ timeout: 30000 });
    });
  });

  test('shows error with invalid credentials', async ({ loginPage }) => {
    await loginPage.goto();
    await loginPage.usernameInput.fill('invalid@user.com');
    await loginPage.nextButton.click();

    await expect(loginPage.errorMessage).toContainText('This username may be incorrect');
  });
});
