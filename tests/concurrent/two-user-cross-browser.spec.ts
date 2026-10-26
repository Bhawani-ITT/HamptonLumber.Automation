import { chromium } from '@playwright/test';
import { test } from '../../fixtures/testFixtures';
import { runTwoUserEdit } from './twoUserEditFlow';

test.describe('Concurrent users', () => {
  test('two user cred: different browsers, different sessions, edit the same line item', async ({ browser, headless, users, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'User A runs on Google Chrome and User B on Microsoft Edge');
    test.setTimeout(240000);

    const edgeBrowser = await chromium.launch({ headless, channel: 'msedge' });
    try {
      await runTwoUserEdit({
        browserA: browser,
        browserB: edgeBrowser,
        browserNameA: 'Google Chrome',
        browserNameB: 'Microsoft Edge',
        users: await users(2),
        leases,
      });
    } finally {
      await edgeBrowser.close();
    }
  });
});
