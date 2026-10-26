import { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import {
  lineRow,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveChangesButton,
} from '../concurrent/twoUserEditFlow';

// Reproduces: on Edit Line Detail, a note typed right after changing Quantity is replaced by the previously
// saved note when the Note box loses focus, so Save stores the new quantity but not the new note.
// Expected behaviour is asserted, so this test fails while the bug exists and passes once it is fixed.

const ATTEMPTS = 5;
const NOTES_COLUMN = 10;

const noteInput = (page: Page) => page.locator('label:text-is("Note") + span textarea >> visible=true');

/** Unique plain-text note with letters only, so the result doesn't depend on numbers in the note. */
const randomTextNote = () =>
  `Note repro ${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;

test.describe('Edit Line Detail', () => {
  test('note typed right after changing quantity is kept and saved', async ({ browser, users, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const [user] = await users(1);
    const page = await loginInNewSession(browser, user);

    try {
      const [lineNumber] = await leases.lines(page, 1);
      const results: string[] = [];

      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        await test.step(`Attempt ${attempt}: open ${lineNumber}, change quantity, type a note at once, save`, async () => {
          await openLineForEdit(page, lineNumber);
          const newQuantity = randomQuantity(Number(await quantityInput(page).inputValue()));
          const newNote = randomTextNote();

          // Same order and speed as a quick user: quantity, Tab, then straight into the note.
          await quantityInput(page).fill(newQuantity);
          await quantityInput(page).press('Tab');
          await noteInput(page).fill(newNote);
          await noteInput(page).press('Tab');
          await page.waitForTimeout(1500);
          const noteBeforeSave = await noteInput(page).inputValue();

          await saveChangesButton(page).scrollIntoViewIfNeeded();
          await saveChangesButton(page).click();
          await expect(page.getByText(/line detail updated successfully/i).first()).toBeVisible({ timeout: 15000 });
          await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
          await expect(lineRow(page, lineNumber).getByRole('gridcell').nth(1)).toHaveText(newQuantity, { timeout: 30000 });
          const savedNote = (await lineRow(page, lineNumber).getByRole('gridcell').nth(NOTES_COLUMN).innerText()).trim();

          const keptInBox = noteBeforeSave === newNote;
          const saved = savedNote === newNote;
          results.push(
            `Attempt ${attempt}: quantity ${newQuantity} saved; note typed "${newNote}"; ` +
              `in Note box before Save: ${keptInBox ? 'kept' : `REVERTED to "${noteBeforeSave}"`}; ` +
              `saved note: ${saved ? 'correct' : `WRONG ("${savedNote}")`}`,
          );
          expect.soft(noteBeforeSave, `Attempt ${attempt}: Note box was reverted before Save`).toBe(newNote);
          expect.soft(savedNote, `Attempt ${attempt}: saved note is not the one typed`).toBe(newNote);
        });
      }

      console.log(`Note repro on ${lineNumber}:\n${results.join('\n')}`);
      test.info().annotations.push({ type: 'note repro results', description: results.join(' | ') });
    } finally {
      await page.context().close();
    }
  });
});
