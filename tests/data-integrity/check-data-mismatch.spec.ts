import { test, expect } from '../../fixtures/testFixtures';
import { Page } from '@playwright/test';
import { dataTables, loginInNewSession } from '../concurrent/twoUserEditFlow';
import { compareHomeGridLines, readHomeGridLines } from '../../utils/dataIntegrity';

test.describe('Cross-user home-page line data', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(180000);
  });

  test('shows matching line data for two users, initially and after reload', async ({ browser, users }) => {
    const testUsers = await users(2);
    const pages: Page[] = [];
    try {
      for (const user of testUsers) pages.push(await loginInNewSession(browser, user));
      for (const phase of ['initial', 'after reload']) {
        await test.step(`Compare home-page line data: ${phase}`, async () => {
          if (phase === 'after reload') {
            await Promise.all(pages.map(page => page.reload()));
            await Promise.all(pages.map(page => expect(dataTables(page).first()).toBeVisible({ timeout: 60000 })));
          }
          await expect(async () => {
            const [reference, actual] = await Promise.all(pages.map(page => readHomeGridLines(page)));
            expect(compareHomeGridLines(reference, actual), 'Home-page line data differs across users').toEqual([]);
          }).toPass({ timeout: 30000 });
        });
      }
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
