import { Page, Locator } from '@playwright/test';

export class SizePage {
  readonly page: Page;
  readonly addSizeButton: Locator;
  readonly nameInput: Locator;
  readonly dimensionsInput: Locator;
  readonly saveButton: Locator;
  readonly sizeTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addSizeButton = page.getByRole('button', { name: 'Add Size' });
    this.nameInput = page.getByLabel('Name');
    this.dimensionsInput = page.getByLabel('Dimensions');
    this.saveButton = page.getByRole('button', { name: 'Save' });
    this.sizeTable = page.getByRole('table');
  }

  async goto(): Promise<void> {
    await this.page.goto('/sizes');
  }

  async addSize(name: string, dimensions: string): Promise<void> {
    await this.addSizeButton.click();
    await this.nameInput.fill(name);
    await this.dimensionsInput.fill(dimensions);
    await this.saveButton.click();
  }

  // Assumes a per-row Delete action with a confirmation dialog; adjust selectors to match actual UI.
  async deleteSize(name: string): Promise<void> {
    await this.sizeTable.getByRole('row', { name }).getByRole('button', { name: 'Delete' }).click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
  }
}
