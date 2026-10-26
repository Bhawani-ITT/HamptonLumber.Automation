import { Page, Locator } from '@playwright/test';

export class LocationPage {
  readonly page: Page;
  readonly addLocationButton: Locator;
  readonly nameInput: Locator;
  readonly addressInput: Locator;
  readonly codeInput: Locator;
  readonly saveButton: Locator;
  readonly locationTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addLocationButton = page.getByRole('button', { name: 'Add Location' });
    this.nameInput = page.getByLabel('Name');
    this.addressInput = page.getByLabel('Address');
    this.codeInput = page.getByLabel('Code');
    this.saveButton = page.getByRole('button', { name: 'Save' });
    this.locationTable = page.getByRole('table');
  }

  async goto(): Promise<void> {
    await this.page.goto('/locations');
  }

  async addLocation(name: string, address: string, code: string): Promise<void> {
    await this.addLocationButton.click();
    await this.nameInput.fill(name);
    await this.addressInput.fill(address);
    await this.codeInput.fill(code);
    await this.saveButton.click();
  }

  // Assumes a per-row Delete action with a confirmation dialog; adjust selectors to match actual UI.
  async deleteLocation(name: string): Promise<void> {
    await this.locationTable.getByRole('row', { name }).getByRole('button', { name: 'Delete' }).click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
  }
}
