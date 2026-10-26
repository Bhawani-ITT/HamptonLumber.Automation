import { expect, Page } from '@playwright/test';

/** Line numbers shown on the home page, in page order, without the "*" the app may append (e.g. "FSJ101*"). */
export async function homeLineNumbers(page: Page): Promise<string[]> {
  const lineCells = page.locator('tr [data-testid^="sales-line-"]');
  await expect(lineCells.first()).toBeVisible({ timeout: 60000 });
  return [...new Set((await lineCells.allInnerTexts()).map(text => text.trim().replace(/\*$/, '')).filter(Boolean))];
}

/** Title above each visible home page table: "<location> <category name>", e.g. "Jaisalmer Roopsi". */
export async function homeTableTitles(page: Page): Promise<string[]> {
  return page.getByRole('grid', { name: 'Data table' }).evaluateAll(grids =>
    grids.filter(grid => (grid as HTMLElement).offsetParent !== null).map(grid => {
      for (let el: Element | null = grid; el; el = el.parentElement) {
        const title = (el.previousElementSibling as HTMLElement | null)?.innerText?.trim();
        if (title) return title;
      }
      return '';
    }),
  );
}

/** Location filter links at the top of the home page. */
export async function homeLocationNames(page: Page): Promise<string[]> {
  const links = page.getByRole('main').getByRole('link');
  await expect(links.first()).toBeVisible({ timeout: 60000 });
  return (await links.allInnerTexts()).map(text => text.trim()).filter(Boolean);
}

/**
 * Mill categories on the admin Categories page (the page must be open), in page order.
 * `name` is the row's name, e.g. "Jaisalmer Roopsi Mill"; `location` is the location it belongs to, e.g. "Jaisalmer".
 */
export async function millCategories(page: Page): Promise<{ name: string; location: string }[]> {
  const rows = page.getByRole('grid', { name: 'Data table' }).getByRole('row');
  await expect(rows.locator('[data-testid^="category-edit-"]').first()).toBeVisible({ timeout: 30000 });
  const categories = await rows.evaluateAll(all =>
    all.map(row => {
      // <span>location + category</span><span>Mill | Wholesale</span><span data-testid="category-edit-…">Edit, Delete</span>
      const labels = row.querySelector('[data-testid^="category-edit-"]')?.parentElement?.children ?? [];
      const [title, type] = [...labels].filter(el => !el.hasAttribute('data-testid')).map(el => (el as HTMLElement).innerText.trim());
      // The drag handle carries the category name without the location.
      const categoryOnly = row.querySelector('[data-drag-clue-text]')?.getAttribute('data-drag-clue-text')?.trim() ?? '';
      const location = categoryOnly && title?.endsWith(` ${categoryOnly}`) ? title.slice(0, -categoryOnly.length).trim() : title;
      return { name: title && type ? `${title} ${type}` : '', type, location };
    }),
  );
  return categories.filter(c => c.name && c.type === 'Mill').map(({ name, location }) => ({ name, location }));
}
