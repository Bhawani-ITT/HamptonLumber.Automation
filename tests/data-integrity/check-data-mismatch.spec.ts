import { test, expect } from '../../fixtures/testFixtures';
import { loginInNewSession } from '../concurrent/twoUserEditFlow';
import { runCheckDataMismatch } from '../../utils/dataIntegrity';

test.describe('Check Data Mismatch (admin tool)', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(180000);
  });

  test('reports no mismatch when the app data matches Azure SQL', async ({ browser, users }) => {
    const [user] = await users(1);
    const page = await loginInNewSession(browser, user);
    try {
      const { message } = await runCheckDataMismatch(page);
      expect(message, 'The app reported a mismatch between its local data (SQLite) and Azure SQL').toBeNull();
    } finally {
      await page.context().close();
    }
  });

  test('flags the number of lines whose Azure SQL data differs from the app data', async ({ browser, users }) => {
    const [user] = await users(1);
    const page = await loginInNewSession(browser, user);
    let linesToCorrupt = 0;
    const corrupted: string[] = [];
    try {
      // Changes the fingerprint (hash) of some lines in the API reply, as if Azure SQL held different data for them.
      await page.route('**/api/Integrity/LineDetailHashes', async route => {
        const response = await route.fetch();
        const json = await response.json();
        corrupted.length = 0;
        for (const line of json.hashes.slice(0, linesToCorrupt)) {
          line.hash = '0'.repeat(64);
          corrupted.push(line.lineNumber);
        }
        await route.fulfill({ response, json });
      });

      for (const count of [1, 3]) {
        await test.step(`Fake a mismatch on ${count} line(s)`, async () => {
          linesToCorrupt = count;
          const { message } = await runCheckDataMismatch(page);
          test.info().annotations.push({ type: `faked mismatch (${count})`, description: corrupted.join(', ') });
          expect(message, `Mismatch on ${corrupted.join(', ')} was not reported`).toContain(`${count} line item(s) are mismatched`);
          await expect(page.getByText(/line item\(s\) are mismatched/).filter({ visible: true })).toHaveCount(0, { timeout: 15000 });
        });
      }
    } finally {
      await page.context().close();
    }
  });
});
