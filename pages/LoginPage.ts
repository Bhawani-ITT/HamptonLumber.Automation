import { Page, Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly nextButton: Locator;
  readonly signInButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByPlaceholder('someone@example.com');
    this.passwordInput = page.getByPlaceholder('Password');
    this.nextButton = page.getByRole('button', { name: 'Next' });
    this.signInButton = page.getByRole('button', { name: 'Sign in' });
    this.errorMessage = page.getByRole('alert');
  }

  async goto(): Promise<void> {
    // The app can hand off to the sign-in page by script while the first load is still in flight.
    await this.page.goto('/').catch(async error => {
      if (!String(error).includes('net::ERR_ABORTED')) throw error;
      await this.page.waitForLoadState();
    });
  }

  async login(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.nextButton.click();
    await this.passwordInput.fill(password);
    await this.signInButton.click();
  }
}
