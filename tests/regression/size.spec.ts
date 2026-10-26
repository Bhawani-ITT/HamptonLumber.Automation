import { test, expect } from '../../fixtures/testFixtures';
import { randomString } from '../../utils/helpers';

test.describe('Size management', () => {
  let sizeName: string;

  test.afterEach(async ({ sizePage }) => {
    if (sizeName) {
      await sizePage.deleteSize(sizeName);
    }
  });

  test('user can add a new size', async ({ sizePage }) => {
    sizeName = randomString('2x4');

    await sizePage.goto();
    await sizePage.addSize(sizeName, '2in x 4in');

    await expect(sizePage.sizeTable).toContainText(sizeName);
  });
});
