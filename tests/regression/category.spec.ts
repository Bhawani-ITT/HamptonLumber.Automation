import { test, expect } from '../../fixtures/testFixtures';
import { loadTestData } from '../../utils/testData';
import { randomString } from '../../utils/helpers';

type Category = { name: string; description: string };

test.describe('Category management', () => {
  let categoryName: string;

  test.afterEach(async ({ categoryPage }) => {
    if (categoryName) {
      await categoryPage.deleteCategory(categoryName);
    }
  });

  test('user can add a new category', async ({ categoryPage }) => {
    const categories = loadTestData<Category[]>('categories.json');
    const category = categories[0];
    categoryName = randomString(category.name);

    await categoryPage.goto();
    await categoryPage.addCategory(categoryName, category.description);

    await expect(categoryPage.categoryTable).toContainText(categoryName);
  });
});
