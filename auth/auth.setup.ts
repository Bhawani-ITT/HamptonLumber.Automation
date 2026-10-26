import { test as setup } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { leaseUsers, releaseUsers } from '../utils/users';
import { STORAGE_STATE_PATH } from '../utils/constants';

// Saves a signed-in session for tests that use the shared storage state.
setup('authenticate', async ({ page }) => {
  setup.setTimeout(120000);
  const users = await leaseUsers(1);
  try {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(users[0].username, users[0].password);
    await page.getByText('Select a saved search', { exact: true }).waitFor({ state: 'attached', timeout: 60000 });
    await page.context().storageState({ path: STORAGE_STATE_PATH });
  } finally {
    releaseUsers(users);
  }
});
