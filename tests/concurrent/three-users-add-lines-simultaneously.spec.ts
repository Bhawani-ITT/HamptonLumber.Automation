import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { expectNoReloadSinceLogin, loginInNewSession } from './twoUserEditFlow';
import {
  editCategory,
  expectLineOnHome,
  ExpectedLine,
  fillNewLine,
  NEW_LINE,
  openCategoriesPage,
  randomTextNote,
  saveNewLine,
  startAddLine,
} from './categoryLineFlow';
import { expectHomeGridMatches } from '../../utils/dataIntegrity';

const USER_COUNT = 10;
// Each creator adds a line to a different category.
const CREATOR_COUNT = 3;

const roleOf = (i: number) => (i < CREATOR_COUNT ? `creator ${i + 1}` : 'viewer');

test.describe('Concurrent users', () => {
  test(`${USER_COUNT} users: ${CREATOR_COUNT} users add a line item to different categories at the same time; every user sees all new lines`, async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(900000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    const newLines = Array.from({ length: CREATOR_COUNT }, () => ({ quantity: NEW_LINE.quantity, note: randomTextNote() }) as ExpectedLine);

    try {
      await test.step(`Log in ${USER_COUNT} unique users, each in a separate session`, async () => {
        pages = await Promise.all(users.map(user => loginInNewSession(browser, user)));
      });
      const creators = pages.slice(0, CREATOR_COUNT);

      await test.step(`Each of the ${CREATOR_COUNT} creators opens a category in a different location and fills in a new line item`, async () => {
        await Promise.all(creators.map(openCategoriesPage));
        const categories = await leases.categories(creators[0], CREATOR_COUNT);
        await Promise.all(
          creators.map(async (creator, c) => {
            const line = newLines[c];
            line.category = categories[c];
            line.categoryLineNumbers = await editCategory(creator, line.category);
            line.lineNumber = await startAddLine(creator);
            leases.claimLine(line.lineNumber);
            Object.assign(line, await fillNewLine(creator, line.note));
          }),
        );
        test.info().annotations.push({
          type: 'new lines',
          description: newLines.map((l, c) => `creator ${c + 1}: ${l.lineNumber} in ${l.category}`).join('; '),
        });
      });

      await test.step(`All ${CREATOR_COUNT} creators click Save Changes at the same time`, async () => {
        await Promise.all(creators.map((creator, c) => saveNewLine(creator, newLines[c].lineNumber, newLines[c].note)));
        expect(new Set(newLines.map(l => l.lineNumber)).size, 'Every new line should get its own line number').toBe(CREATOR_COUNT);
      });

      await test.step('A viewer sees all new line items on the home page', async () => {
        for (const line of newLines) await expectLineOnHome(pages[CREATOR_COUNT], line);
      });

      await test.step(`All ${USER_COUNT} users see every new line item under its category on the home page`, async () => {
        await Promise.all(creators.map(creator => creator.goto('/')));
        const results = await Promise.allSettled(
          pages.map(async (page, i) => {
            for (const line of newLines) await expectLineOnHome(page, line);
            await expectHomeGridMatches(page, pages[CREATOR_COUNT]);
            if (i >= CREATOR_COUNT) await expectNoReloadSinceLogin(page, `User ${i + 1}`);
          }),
        );
        const failures: string[] = [];
        for (const [i, result] of results.entries()) {
          if (result.status === 'fulfilled') continue;
          await test.info().attach(`user-${i + 1}-${roleOf(i)}-${users[i].username}`, {
            body: await pages[i].screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
          failures.push(`${users[i].username} (${roleOf(i)}): ${String(result.reason).split('\n')[0]}`);
        }
        expect(failures, `Expected ${newLines.map(l => l.lineNumber).join(', ')} on every home page`).toEqual([]);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
