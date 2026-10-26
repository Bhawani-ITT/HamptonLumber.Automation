import { Page, Locator } from '@playwright/test';

export class LineItemPage {
  readonly page: Page;
  readonly addLineItemButton: Locator;
  readonly itemCodeInput: Locator;
  readonly descriptionInput: Locator;
  readonly quantityInput: Locator;
  readonly unitPriceInput: Locator;
  readonly saveButton: Locator;
  readonly lineItemTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addLineItemButton = page.getByRole('button', { name: 'Add Line Item' });
    this.itemCodeInput = page.getByLabel('Item Code');
    this.descriptionInput = page.getByLabel('Description');
    this.quantityInput = page.getByLabel('Quantity');
    this.unitPriceInput = page.getByLabel('Unit Price');
    this.saveButton = page.getByRole('button', { name: 'Save' });
    this.lineItemTable = page.getByRole('table');
  }

  async goto(): Promise<void> {
    await this.page.goto('/line-items');
  }

  async addLineItem(itemCode: string, description: string, quantity: number, unitPrice: number): Promise<void> {
    await this.addLineItemButton.click();
    await this.itemCodeInput.fill(itemCode);
    await this.descriptionInput.fill(description);
    await this.quantityInput.fill(String(quantity));
    await this.unitPriceInput.fill(String(unitPrice));
    await this.saveButton.click();
  }

  // Assumes a per-row Delete action with a confirmation dialog; adjust selectors to match actual UI.
  async deleteLineItem(itemCode: string): Promise<void> {
    await this.lineItemTable.getByRole('row', { name: itemCode }).getByRole('button', { name: 'Delete' }).click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
  }
}
