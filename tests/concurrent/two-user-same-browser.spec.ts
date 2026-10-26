import { test } from '../../fixtures/testFixtures';
import { runTwoUserEdit } from './twoUserEditFlow';

test.describe('Concurrent users', () => {
  test('two user cred: same browser, different sessions, edit the same line item', async ({ browser, users, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Both users run on Google Chrome');
    test.setTimeout(240000);

    await runTwoUserEdit({
      browserA: browser,
      browserB: browser,
      browserNameA: 'Google Chrome',
      browserNameB: 'Google Chrome',
      users: await users(2),
      leases,
    });
  });
});
