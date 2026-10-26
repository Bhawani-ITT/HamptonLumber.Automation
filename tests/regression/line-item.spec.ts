import { test, expect } from '../../fixtures/testFixtures';
import { loadTestData } from '../../utils/testData';
import { randomString } from '../../utils/helpers';

type LineItem = { itemCode: string; description: string; quantity: number; unitPrice: number };

test.describe('Line item management', () => {
  let itemCode: string;

  test.afterEach(async ({ lineItemPage }) => {
    if (itemCode) {
      await lineItemPage.deleteLineItem(itemCode);
    }
  });

  test('user can add a new line item', async ({ lineItemPage }) => {
    const lineItems = loadTestData<LineItem[]>('lineItems.json');
    const item = lineItems[0];
    itemCode = randomString(item.itemCode);

    await lineItemPage.goto();
    await lineItemPage.addLineItem(itemCode, item.description, item.quantity, item.unitPrice);

    await expect(lineItemPage.lineItemTable).toContainText(itemCode);
  });
});
