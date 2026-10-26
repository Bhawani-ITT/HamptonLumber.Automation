import { Page, Locator } from '@playwright/test';

export class DashboardPage {
  readonly page: Page;
  readonly welcomeHeading: Locator;
  readonly navLocations: Locator;
  readonly navCategories: Locator;
  readonly navSizes: Locator;
  readonly navLineItems: Locator;

  constructor(page: Page) {
    this.page = page;
    this.welcomeHeading = page.getByRole('heading', { name: /dashboard/i });
    this.navLocations = page.getByRole('link', { name: 'Locations' });
    this.navCategories = page.getByRole('link', { name: 'Categories' });
    this.navSizes = page.getByRole('link', { name: 'Sizes' });
    this.navLineItems = page.getByRole('link', { name: 'Line Items' });
  }

  async goto(): Promise<void> {
    await this.page.goto('/dashboard');
  }
}
