import { firefox } from '@playwright/test';
import { test } from '../../fixtures/testFixtures';
import { runTwoUserEdit } from './twoUserEditFlow';

test.describe('Concurrent users', () => {
  test('two user cred: different browsers, different sessions, edit the same line item', async ({ browser, headless, users, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'User A runs on Google Chrome and User B on Firefox');
    test.setTimeout(240000);

    // The google-chrome project's channel is applied to every launch unless overridden.
    const firefoxBrowser = await firefox.launch({ headless, channel: undefined });
    try {
      await runTwoUserEdit({
        browserA: browser,
        browserB: firefoxBrowser,
        browserNameA: 'Google Chrome',
        browserNameB: 'Firefox',
        users: await users(2),
        leases,
      });
    } finally {
      await firefoxBrowser.close();
    }
  });
});
