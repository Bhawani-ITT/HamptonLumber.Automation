import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { expectNoReloadSinceLogin, loginInNewSession, saveChangesButton } from '../concurrent/twoUserEditFlow';
import {
  editCategory,
  enterNumber,
  expectLineOnHome,
  ExpectedLine,
  fillNewLine,
  NEW_LINE,
  noteInput,
  numberInput,
  openCategoriesPage,
  pickShipWeekInNextMonth,
  randomTextNote,
  saveNewLine,
  shipWeekInput,
  startAddLine,
} from '../concurrent/categoryLineFlow';

const NOTE_MAX_LENGTH = 256;

test.describe('Category lines', () => {
  test('Admin adds a new category line with validation; the creator and 2 viewers see it on the home page', async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(300000);
    const users = await leaseUsers(3);

    let pages: Page[] = [];
    const line = { quantity: NEW_LINE.quantity, note: randomTextNote() } as ExpectedLine;
    const note = line.note;

    try {
      await test.step('Log in 3 users with valid credentials, each in a separate session', async () => {
        pages = await Promise.all(users.map(user => loginInNewSession(browser, user)));
      });
      const [creator, ...viewers] = pages;

      await test.step('Click the gear (settings) icon and edit a category', async () => {
        await openCategoriesPage(creator);
        [line.category] = await leases.categories(creator, 1);
        line.categoryLineNumbers = await editCategory(creator, line.category);
      });

      await test.step('Click Add to add a new category line', async () => {
        line.lineNumber = await startAddLine(creator);
        leases.claimLine(line.lineNumber);
        test.info().annotations.push({ type: 'new line', description: `${line.lineNumber} in ${line.category}` });
        await expect(saveChangesButton(creator)).toBeDisabled();
      });

      await test.step('Fill the required fields and a plain text note', async () => {
        Object.assign(line, await fillNewLine(creator, note));
      });

      await test.step('Invalid input keeps Save Changes disabled', async () => {
        const invalidNumbers: ['Quantity' | 'Unit Size' | '$ / MBF', string[], string][] = [
          ['Quantity', ['0', '-5', '100000', ''], NEW_LINE.quantity],
          ['Unit Size', ['0', '-1', ''], NEW_LINE.unitSize],
          ['$ / MBF', ['0', '-1', ''], NEW_LINE.pricePerMbf],
        ];
        for (const [label, invalidValues, validValue] of invalidNumbers) {
          const input = numberInput(creator, label);
          for (const value of invalidValues) {
            await input.fill(value);
            await input.press('Tab');
            await expect.soft(saveChangesButton(creator), `Save should be disabled when ${label} is "${value}"`).toBeDisabled();
          }
          await enterNumber(input, validValue);
          await expect(saveChangesButton(creator)).toBeEnabled();
        }

        const quantity = numberInput(creator, 'Quantity');
        await quantity.fill('');
        await quantity.pressSequentially('abc');
        await quantity.press('Tab');
        await expect.soft(quantity, 'Letters are not accepted in Quantity').not.toHaveValue(/[a-z]/i);
        await expect.soft(creator.getByText('Quantity is required.').filter({ visible: true })).toBeVisible();
        await expect.soft(saveChangesButton(creator), 'Save should be disabled when Quantity has letters').toBeDisabled();
        await enterNumber(quantity, NEW_LINE.quantity);

        await shipWeekInput(creator).click();
        await creator.keyboard.press('Control+A');
        await creator.keyboard.press('Delete');
        await shipWeekInput(creator).press('Tab');
        await expect.soft(creator.getByText('Ship Week is required.').filter({ visible: true })).toBeVisible();
        await expect.soft(saveChangesButton(creator), 'Save should be disabled without a ship week').toBeDisabled();
        line.shipWeek = await pickShipWeekInNextMonth(creator);

        await noteInput(creator).fill('x'.repeat(NOTE_MAX_LENGTH + 44));
        await expect.soft(noteInput(creator), `Note is limited to ${NOTE_MAX_LENGTH} characters`).toHaveValue('x'.repeat(NOTE_MAX_LENGTH));
        await noteInput(creator).fill(note);
        await noteInput(creator).press('Tab');

        await expect(saveChangesButton(creator)).toBeEnabled();
      });

      await test.step('Click Save Changes', async () => {
        await saveNewLine(creator, line.lineNumber, note);
      });

      await test.step('The creator sees the new line under its category on the home page', async () => {
        await creator.goto('/');
        await expectLineOnHome(creator, line);
      });

      await test.step('Both viewers see the new line under its category on the home page without reloading', async () => {
        const results = await Promise.allSettled(
          viewers.map(async (page, i) => {
            await expectLineOnHome(page, line);
            await expectNoReloadSinceLogin(page, `Viewer ${i + 1}`);
          }),
        );
        const failures: string[] = [];
        for (const [i, result] of results.entries()) {
          if (result.status === 'fulfilled') continue;
          await test.info().attach(`viewer-${i + 1}-${users[i + 1].username}`, {
            body: await viewers[i].screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
          failures.push(`${users[i + 1].username}: ${String(result.reason).split('\n')[0]}`);
        }
        expect(failures, `Expected ${line.lineNumber} on every viewer's home page`).toEqual([]);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
