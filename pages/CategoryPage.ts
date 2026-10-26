import { Page, Locator } from '@playwright/test';

export class CategoryPage {
  readonly page: Page;
  readonly addCategoryButton: Locator;
  readonly nameInput: Locator;
  readonly descriptionInput: Locator;
  readonly saveButton: Locator;
  readonly categoryTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addCategoryButton = page.getByRole('button', { name: 'Add Category' });
    this.nameInput = page.getByLabel('Name');
    this.descriptionInput = page.getByLabel('Description');
    this.saveButton = page.getByRole('button', { name: 'Save' });
    this.categoryTable = page.getByRole('table');
  }

  async goto(): Promise<void> {
    await this.page.goto('/categories');
  }

  async addCategory(name: string, description: string): Promise<void> {
    await this.addCategoryButton.click();
    await this.nameInput.fill(name);
    await this.descriptionInput.fill(description);
    await this.saveButton.click();
  }

  // Assumes a per-row Delete action with a confirmation dialog; adjust selectors to match actual UI.
  async deleteCategory(name: string): Promise<void> {
    await this.categoryTable.getByRole('row', { name }).getByRole('button', { name: 'Delete' }).click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
  }
}
