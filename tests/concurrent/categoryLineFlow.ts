import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/testFixtures';
import { dataTables, lineButtonName, lineRow, saveChangesButton } from './twoUserEditFlow';

/** Values typed into a new line; dropdown values are picked from whatever the app offers. */
export const NEW_LINE = { quantity: '25', unitSize: '5', pricePerMbf: '400', tally8ft: '3' };
export const HOME_COLUMNS = { quantity: 1, load: 2, species: 3, size: 4, grade: 5, tally: 6, price: 7, shipWeek: 8, mbf: 9, notes: 10, status: 11, lastEdited: 12 };

export const field = (page: Page, label: string) => page.locator(`label:text-matches("^${label}\\\\*?$") + span >> visible=true`);
export const numberInput = (page: Page, label: 'Quantity' | 'Unit Size' | '$ / MBF') =>
  label === '$ / MBF' ? page.locator('label:has-text("MBF") + span input >> visible=true') : field(page, label).locator('input');
export const noteInput = (page: Page) => page.locator('label:text-is("Note") + span textarea >> visible=true');
export const shipWeekInput = (page: Page) => field(page, 'Ship Week').locator('input');
/** "# Units" inputs of the tally grid, one per length (8' to 32'). */
export const tallyInputs = (page: Page) => page.locator('table:visible input[role="spinbutton"]');
export const openDropdownOptions = (page: Page) => page.locator('.k-animation-container:visible [role="option"]');

export function randomTextNote(): string {
  const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `New line note ${letters}`;
}

/** Opens the dropdown, picks its first option and returns that option's text. */
async function pickFirstOption(page: Page, label: string): Promise<string> {
  let text = '';
  // Under load the app can be slow to apply a pick and close the list, or ignore the click; pick again until it sticks.
  await expect(async () => {
    if (!(await openDropdownOptions(page).first().isVisible())) await field(page, label).click({ timeout: 10000 });
    const option = openDropdownOptions(page).first();
    await expect(option, `The ${label} dropdown has no options`).toBeVisible({ timeout: 10000 });
    text = (await option.innerText()).trim();
    await option.click({ timeout: 10000 });
    await expect(openDropdownOptions(page)).toHaveCount(0, { timeout: 15000 });
    await expect(field(page, label)).toContainText(text, { timeout: 10000 });
  }, `Pick the first ${label}`).toPass({ timeout: 90000 });
  return text;
}

export async function enterNumber(input: Locator, value: string): Promise<void> {
  await input.fill(value);
  await input.press('Tab');
  await expect(input).toHaveValue(value);
}

export async function pickShipWeekInNextMonth(page: Page): Promise<string> {
  await field(page, 'Ship Week').getByRole('button', { name: 'Open' }).click();
  const calendar = page.locator('.k-calendar');
  const monthTitle = calendar.locator('.k-calendar-title');
  const shownMonth = (await monthTitle.innerText()).trim();
  await calendar.getByRole('button', { name: 'Go to the next period' }).click();
  await expect(monthTitle).not.toHaveText(shownMonth);
  const nextMonth = (await monthTitle.innerText()).trim();
  const day = calendar
    .getByRole('grid', { name: nextMonth })
    .locator('td[role="gridcell"]:not(.k-disabled):not(.k-other-month)')
    .first();
  const date = new Date((await day.getAttribute('aria-label'))!.replace(/^\w+, /, ''));
  await day.click();
  const value = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
  await expect(shipWeekInput(page)).toHaveValue(value);
  return value;
}

/** The home grid shows the ship week as M/D. */
export const homeShipWeek = (shipWeek: string) => shipWeek.replace(/^0?(\d+)\/0?(\d+)\/\d{4}$/, '$1/$2');

/** Gear (settings) icon: opens the admin Categories page. */
export async function openCategoriesPage(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Categories' });
  // Right after the home page appears, the app can ignore a click until it has finished starting up.
  await expect(async () => {
    if (!(await heading.isVisible())) await page.getByTestId('header-admin').getByRole('button').click({ timeout: 5000 });
    await expect(heading).toBeVisible({ timeout: 10000 });
  }).toPass({ timeout: 60000 });
}

/** Clicks Edit on the category (Categories page must be open). Returns its existing line numbers. */
export async function editCategory(page: Page, category: string): Promise<string[]> {
  await page.getByRole('row', { name: `Drag row ${category}`, exact: true }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: 'Category Lines' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  const texts = await page
    .getByRole('grid', { name: 'Data table' })
    .getByRole('row')
    .evaluateAll(rows => rows.map(row => (row.querySelectorAll('td')[1] as HTMLElement | undefined)?.innerText ?? ''));
  return texts.map(text => text.trim().split(/\s+/)[0]).filter(Boolean);
}

/** A line in the Category Lines list (category edit page). */
export const categoryLineRow = (page: Page, lineNumber: string) => page.getByRole('row', { name: new RegExp(`^Drag row ${lineNumber}\\b`) });

/** Deletes a line from the Category Lines list (category edit page must be open) and confirms the dialog. */
export async function deleteCategoryLine(page: Page, lineNumber: string): Promise<void> {
  const row = categoryLineRow(page, lineNumber);
  await row.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Category Line' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Yes' }).click();
  await expect(row).toHaveCount(0, { timeout: 30000 });
}

/** Clicks Add on the category page and returns the line number the app assigns to the new line. */
/**
 * Running number at the end of a line number, e.g. 161 for TLC161. New line numbers only go up: the app never hands
 * out a deleted line's number again.
 */
export const lineSequence = (lineNumber: string) => Number(lineNumber.match(/(\d+)$/)?.[1] ?? NaN);

export async function startAddLine(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Line Detail/ })).toBeVisible({ timeout: 30000 });
  const lineNumberBox = field(page, 'Line Number').locator('input');
  await expect(lineNumberBox).not.toHaveValue('', { timeout: 30000 });
  return lineNumberBox.inputValue();
}

export type NewLineValues = { species: string; size: string; grade: string; status: string; shipWeek: string };

/** Fills every required field of the new line plus the note, and returns the values the line got. */
export async function fillNewLine(page: Page, note: string): Promise<NewLineValues> {
  const species = await pickFirstOption(page, 'Species');
  const size = await pickFirstOption(page, 'Size');
  const grade = await pickFirstOption(page, 'Grade');
  const status = (await field(page, 'Line Status').innerText()).trim();
  expect(status, 'Line Status should have a default value').not.toBe('');
  // The note goes in before the numbers: a note typed right after a quantity change can be reverted by the app.
  await noteInput(page).fill(note);
  await noteInput(page).press('Tab');
  await enterNumber(numberInput(page, 'Quantity'), NEW_LINE.quantity);
  await enterNumber(numberInput(page, 'Unit Size'), NEW_LINE.unitSize);
  await enterNumber(numberInput(page, '$ / MBF'), NEW_LINE.pricePerMbf);
  await enterNumber(tallyInputs(page).first(), NEW_LINE.tally8ft);
  // Under load the app can take well over 5 s to validate the last entry and enable Save.
  await expect(saveChangesButton(page))
    .toBeEnabled({ timeout: 30000 })
    .catch(async () => {
      const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (screenshot) await test.info().attach('new line: Save Changes stayed disabled', { body: screenshot, contentType: 'image/png' });
      throw new Error(`Save Changes stayed disabled for 30s after filling the new line. The form now holds: ${await describeNewLineForm(page)}`);
    });
  return { species, size, grade, status, shipWeek: await shipWeekInput(page).inputValue() };
}

/** What the Add Line form currently holds, for failure messages. */
async function describeNewLineForm(page: Page): Promise<string> {
  const read = (locator: Locator, kind: 'text' | 'value') =>
    (kind === 'text' ? locator.innerText({ timeout: 2000 }) : locator.inputValue({ timeout: 2000 })).then(v => v.trim() || '(empty)', () => '(not found)');
  const values: [string, Promise<string>][] = [
    ['Line Status', read(field(page, 'Line Status'), 'text')],
    ['Species', read(field(page, 'Species'), 'text')],
    ['Size', read(field(page, 'Size'), 'text')],
    ['Grade', read(field(page, 'Grade'), 'text')],
    ['Quantity', read(numberInput(page, 'Quantity'), 'value')],
    ['Load', read(field(page, 'Load'), 'text')],
    ['Ship Week', read(shipWeekInput(page), 'value')],
    ['Note', read(noteInput(page), 'value')],
    ['Unit Size', read(numberInput(page, 'Unit Size'), 'value')],
    ['$ / MBF', read(numberInput(page, '$ / MBF'), 'value')],
    ["8' units", read(tallyInputs(page).first(), 'value')],
  ];
  const reconnecting = await page.getByText(/reconnect to the server/i).first().innerText({ timeout: 1000 }).catch(() => '');
  const parts = await Promise.all(values.map(async ([name, value]) => `${name}=${await value}`));
  return parts.join(', ') + (reconnecting ? `; page lost its server connection: "${reconnecting.trim()}"` : '');
}

export async function saveNewLine(page: Page, lineNumber: string, note: string, timeout = 30000): Promise<void> {
  const changedBeforeSave = 'was changed by the app before Save was clicked';
  await expect(noteInput(page), `Note ${changedBeforeSave}`).toHaveValue(note);
  await expect(numberInput(page, 'Quantity'), `Quantity ${changedBeforeSave}`).toHaveValue(NEW_LINE.quantity);
  await saveChangesButton(page).scrollIntoViewIfNeeded();
  await saveChangesButton(page).click();
  await expect(page).not.toHaveURL(/\/add\//, { timeout });
  await expect(categoryLineRow(page, lineNumber)).toBeVisible({ timeout });
}

export type ExpectedLine = NewLineValues & {
  lineNumber: string;
  category: string;
  /** The category's other lines; the home table holding the new line must show at least one of them. */
  categoryLineNumbers: string[];
  quantity: string;
  note: string;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Checks the line is under its category on the home page and shows the expected values. */
export async function expectLineOnHome(page: Page, line: ExpectedLine, timeout = 30000): Promise<void> {
  const row = lineRow(page, line.lineNumber);
  await expect(row).toBeVisible({ timeout });
  const table = dataTables(page).filter({ has: page.getByRole('button', { name: lineButtonName(line.lineNumber) }) });
  const otherLines = line.categoryLineNumbers.filter(l => l !== line.lineNumber).map(escapeRegExp);
  if (otherLines.length) {
    await expect(
      table.getByRole('button', { name: new RegExp(`^(${otherLines.join('|')})\\*?$`) }).first(),
      `${line.lineNumber} is under ${line.category}`,
    ).toBeVisible();
  }
  const cells: [string, number, string][] = [
    ['Qty', HOME_COLUMNS.quantity, line.quantity],
    ['Species', HOME_COLUMNS.species, line.species],
    ['Size', HOME_COLUMNS.size, line.size],
    ['Grade', HOME_COLUMNS.grade, line.grade],
    ['Ship Wk', HOME_COLUMNS.shipWeek, homeShipWeek(line.shipWeek)],
    ['Notes', HOME_COLUMNS.notes, line.note],
    ['Status', HOME_COLUMNS.status, line.status],
  ];
  for (const [name, column, value] of cells) {
    await expect(row.getByRole('gridcell').nth(column), `${line.lineNumber} ${name}`).toHaveText(value, { timeout });
  }
}
