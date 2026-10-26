import { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { lineRow, loginInNewSession, saveChangesButton } from '../concurrent/twoUserEditFlow';
import {
  categoryLineRow,
  deleteCategoryLine,
  editCategory,
  enterNumber,
  ExpectedLine,
  field,
  fillNewLine,
  HOME_COLUMNS,
  homeShipWeek,
  NEW_LINE,
  noteInput,
  numberInput,
  openCategoriesPage,
  openDropdownOptions,
  pickShipWeekInNextMonth,
  randomTextNote,
  saveNewLine,
  lineSequence,
  shipWeekInput,
  startAddLine,
  tallyInputs,
} from '../concurrent/categoryLineFlow';
import { fetchAzureSqlLines, IntegrityApi, MISMATCH_TOAST, runCheckDataMismatch } from '../../utils/dataIntegrity';

const REQUIRED_LINE_FIELDS = ['Line Number', 'Line Status', 'Location', 'Species', 'Size', 'Grade', 'Quantity', 'Load', 'Ship Week', 'Unit Size', '$ / MBF'];
const TALLY_LENGTHS = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];
const NOTE_MAX_LENGTH = 256;
const EDITED = { quantity: '40', tally8ft: '4' };

type Line = ExpectedLine & { load: string; tally: string; boardFeet: number };

const main = (page: Page) => page.getByRole('main');
const discardButton = (page: Page) => page.getByRole('button', { name: 'Discard', exact: true });
const noteCounter = (page: Page, length: number) => main(page).getByText(`${length}/${NOTE_MAX_LENGTH}`, { exact: true }).locator('visible=true');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactText = (text: string) => new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
const mismatchCount = (message: string | null) => Number(message?.match(MISMATCH_TOAST)?.[1] ?? 0);
const today = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};

async function openDropdown(page: Page, dropdown: Locator): Promise<void> {
  await expect(async () => {
    if (!(await openDropdownOptions(page).first().isVisible())) await dropdown.click({ timeout: 5000 });
    await expect(openDropdownOptions(page).first()).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 30000 });
}

/** Opens a dropdown, returns its options and closes it again. */
async function dropdownOptions(page: Page, dropdown: Locator): Promise<string[]> {
  await openDropdown(page, dropdown);
  const options = (await openDropdownOptions(page).allInnerTexts()).map(o => o.trim());
  await page.keyboard.press('Escape');
  await expect(openDropdownOptions(page)).toHaveCount(0);
  return options;
}

async function selectOption(page: Page, dropdown: Locator, option: string): Promise<void> {
  await openDropdown(page, dropdown);
  await openDropdownOptions(page).filter({ hasText: exactText(option) }).click();
  await expect(openDropdownOptions(page)).toHaveCount(0);
  await expect(dropdown).toContainText(option);
}

/** Picks any option other than the current one and returns it. */
async function selectOtherOption(page: Page, label: string): Promise<string> {
  const current = (await field(page, label).innerText()).trim();
  const other = (await dropdownOptions(page, field(page, label))).find(o => o && o !== current);
  expect(other, `${label} has no option other than "${current}"`).toBeTruthy();
  await selectOption(page, field(page, label), other!);
  return other!;
}

/** Clicks Discard and answers the "discard changes?" confirmation, e.g. titled "Discard Category" or "Discard Line". */
async function discardChanges(page: Page, title: string, answer: 'No' | 'Yes'): Promise<void> {
  await discardButton(page).click();
  const dialog = page.getByRole('dialog', { name: title }).filter({ hasText: /Are you sure you want to discard (these )?changes\?/ });
  await expect(dialog, 'Discard asks for confirmation').toBeVisible();
  await expect(dialog.getByRole('button', { name: 'No', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: answer, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Lineal Feet and Board Feet shown under Board Foot Calculations. */
async function footage(page: Page): Promise<{ lineal: number; board: number }> {
  const text = await main(page).innerText();
  const read = (name: string) => Number(text.match(new RegExp(`${name}:\\s*([\\d,.]+)`))?.[1].replace(/,/g, '') ?? NaN);
  return { lineal: read('Lineal Feet'), board: read('Board Feet') };
}

/** Title above the home page table holding the line, e.g. "guru Regression ab12". */
const tableTitleOf = (page: Page, lineNumber: string) =>
  lineRow(page, lineNumber).evaluate(row => {
    for (let el: Element | null = row.closest('[role="grid"]'); el; el = el.parentElement) {
      const title = (el.previousElementSibling as HTMLElement | null)?.innerText?.trim();
      if (title) return title;
    }
    return '';
  });

async function goHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('grid', { name: 'Data table' }).first()).toBeVisible({ timeout: 60000 });
}

/** Checks every column of the line on the home page. */
async function expectLineRowOnHome(page: Page, line: Line, tableTitle: string): Promise<void> {
  const row = lineRow(page, line.lineNumber);
  await expect(row, `${line.lineNumber} on the home page`).toBeVisible({ timeout: 30000 });
  expect.soft(await tableTitleOf(page, line.lineNumber), `${line.lineNumber} is under its category`).toBe(tableTitle);
  const cell = (column: number) => row.getByRole('gridcell').nth(column);
  const columns: [string, number, string | RegExp][] = [
    ['Qty', HOME_COLUMNS.quantity, line.quantity],
    ['Load', HOME_COLUMNS.load, line.load],
    ['Species', HOME_COLUMNS.species, line.species],
    ['Size', HOME_COLUMNS.size, line.size],
    ['Grade', HOME_COLUMNS.grade, line.grade],
    ['Tally', HOME_COLUMNS.tally, line.tally],
    ['Price', HOME_COLUMNS.price, new RegExp(`^US: \\$${NEW_LINE.pricePerMbf}, CAD: \\$[\\d,.]+$`)],
    ['Ship Wk', HOME_COLUMNS.shipWeek, homeShipWeek(line.shipWeek)],
    ['Notes', HOME_COLUMNS.notes, line.note],
    ['Status', HOME_COLUMNS.status, line.status],
    ['Last Edited', HOME_COLUMNS.lastEdited, new RegExp(`^${escapeRegExp(today())}`)],
  ];
  for (const [name, column, value] of columns) {
    await expect.soft(cell(column), `${line.lineNumber} ${name}`).toHaveText(value, { timeout: 30000 });
  }
  expect.soft(Number(await cell(HOME_COLUMNS.mbf).innerText()), `${line.lineNumber} MBF = Board Feet / 1000`).toBeCloseTo(line.boardFeet / 1000, 2);
}

test.describe('Category lifecycle', () => {
  test('Create a category with 2 line items, check every element, edit a line item and delete a line item', async ({ browser, users, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const [user] = await users(1);
    const page = await loginInNewSession(browser, user);
    page.setDefaultTimeout(30000);

    const categoryName = `Regression ${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')} ${Math.random().toString(36).slice(2, 6)}`;
    let location = '';
    let api!: IntegrityApi;
    let mismatchesBefore = 0;
    const lines: Line[] = [];
    const categoryRow = () => page.getByRole('row', { name: `Drag row ${location} ${categoryName} Mill`, exact: true });
    const homeTitle = () => `${location} ${categoryName}`;

    try {
      await test.step('Record what Check Data Mismatch reports before any change', async () => {
        const result = await runCheckDataMismatch(page);
        api = result.api;
        mismatchesBefore = mismatchCount(result.message);
      });

      await test.step('Categories page: heading, Add button and the category list', async () => {
        await openCategoriesPage(page);
        await expect(page.getByRole('heading', { name: 'Categories', level: 2 })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
        const rows = page.getByRole('grid', { name: 'Data table' }).getByRole('row');
        await expect(rows.first()).toBeVisible();
        await expect(rows.first().getByRole('button', { name: 'Edit' })).toBeVisible();
        await expect(rows.first().getByRole('button', { name: 'Delete' })).toBeVisible();
      });

      await test.step('New Category form: every element and its validation', async () => {
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'New Category' })).toBeVisible({ timeout: 30000 });
        await expect(page).toHaveURL(/\/admin\/categories\/add$/);
        const labels = (await main(page).locator('label:visible').allInnerTexts()).map(l => l.trim());
        expect.soft(labels, 'New Category labels').toEqual(['Category Name', 'Category Type', 'Mill Location']);

        const nameInput = main(page).getByRole('textbox');
        const typeDropdown = main(page).getByRole('combobox').nth(0);
        const locationDropdown = main(page).getByRole('combobox').nth(1);
        await expect(nameInput).toHaveValue('');
        await expect(typeDropdown, 'Category Type defaults to Mill').toContainText('Mill');
        expect.soft(await dropdownOptions(page, typeDropdown), 'Category Type options').toEqual(['Mill', 'Wholesale']);
        await expect(locationDropdown).toHaveText(/^\s*$/);
        const locations = await dropdownOptions(page, locationDropdown);
        expect(locations.length, 'Mill Location has options').toBeGreaterThan(0);
        await expect(discardButton(page)).toBeDisabled();
        await expect(saveChangesButton(page)).toBeDisabled();

        await nameInput.fill(categoryName);
        await expect(discardButton(page), 'Discard is enabled once something is typed').toBeEnabled();
        await expect(saveChangesButton(page), 'Save needs a Mill Location').toBeDisabled();
        await discardChanges(page, 'Discard Category', 'No');
        await expect.soft(nameInput, 'Answering No to "discard these changes?" keeps the typed Category Name').toHaveValue(categoryName, { timeout: 5000 });
        if ((await nameInput.inputValue()) !== categoryName) await nameInput.fill(categoryName);
        await expect(discardButton(page)).toBeEnabled();
        await discardChanges(page, 'Discard Category', 'Yes');
        await expect(nameInput, 'Yes clears the typed Category Name').toHaveValue('');
        await expect(discardButton(page)).toBeDisabled();
        await expect(saveChangesButton(page)).toBeDisabled();
        await nameInput.fill(categoryName);

        [location] = await leases.locations(locations, 1);
        await selectOption(page, locationDropdown, location);
        await expect(saveChangesButton(page), 'Save is enabled with name, type and location').toBeEnabled();
        test.info().annotations.push({ type: 'new category', description: `${location} ${categoryName} Mill` });
      });

      await test.step('Save the category: success message, and it is listed with Edit and Delete', async () => {
        await saveChangesButton(page).click();
        await expect(page.getByRole('alert').filter({ hasText: 'Category added successfully!' })).toBeVisible({ timeout: 30000 });
        await expect(page).toHaveURL(/\/admin\/categories$/);
        await expect(categoryRow()).toBeVisible();
        await expect(categoryRow().getByRole('button', { name: 'Edit' })).toBeVisible();
        await expect(categoryRow().getByRole('button', { name: 'Delete' })).toBeVisible();
      });

      await test.step('Category Detail page: name, locked type, and an empty Category Lines list', async () => {
        expect(await editCategory(page, `${location} ${categoryName} Mill`)).toEqual([]);
        await expect(page.getByRole('heading', { name: 'Category Detail' })).toBeVisible();
        await expect.soft(main(page).getByRole('textbox').first(), 'Category Detail shows the category name').toHaveValue(categoryName, { timeout: 10000 });
        const typeDropdown = main(page).getByRole('combobox').first();
        await expect(typeDropdown).toContainText('Mill');
        await expect(typeDropdown).toHaveAttribute('aria-disabled', 'true');
        await expect(discardButton(page)).toBeDisabled();
        await expect(saveChangesButton(page)).toBeDisabled();
        await expect(page.getByRole('heading', { name: 'Category Lines' })).toBeVisible();
        await expect(page.getByRole('grid', { name: 'Data table' }).getByText('No records available.')).toBeVisible();
      });

      for (const n of [1, 2]) {
        await test.step(`Add line item ${n}: ${n === 1 ? 'check every element of the empty form, then ' : ''}fill and save`, async () => {
          const lineNumber = await startAddLine(page);
          leases.claimLine(lineNumber);
          if (n === 2) {
            expect.soft(lineSequence(lineNumber), `${lineNumber} should come after ${lines[0].lineNumber}`).toBeGreaterThan(lineSequence(lines[0].lineNumber));
          }
          await expect(page.getByRole('heading', { name: 'Line Detail (Mill)' })).toBeVisible();

          if (n === 1) {
            const labels = (await main(page).locator('label:visible').allInnerTexts()).map(l => l.replace(/\s+/g, '').trim());
            for (const name of REQUIRED_LINE_FIELDS) expect.soft(labels, `${name} is marked required (*)`).toContain(`${name.replace(/\s+/g, '')}*`);
            expect.soft(labels, 'Note is optional').toContain('Note');

            await expect(field(page, 'Line Number').locator('input')).toBeDisabled();
            expect(lineNumber, 'Line Number is assigned automatically').toMatch(/^[A-Z]{3}\d{3}$/);
            await expect(field(page, 'Line Status')).toContainText('Available');
            expect.soft(await dropdownOptions(page, field(page, 'Line Status')), 'Line Status options').toEqual(expect.arrayContaining(['Available', 'Sold']));
            await expect(field(page, 'Location')).toHaveAttribute('aria-disabled', 'true');
            await expect(field(page, 'Location')).toContainText(location);
            for (const name of ['Species', 'Size', 'Grade']) {
              await expect.soft(field(page, name), `${name} starts empty`).toHaveText(/^\s*$/);
              await expect.soft(field(page, name), `${name} is enabled`).not.toHaveAttribute('aria-disabled', 'true');
            }
            await expect(numberInput(page, 'Quantity')).toHaveValue('');
            await expect(field(page, 'Load')).toContainText('Car');
            expect.soft(await dropdownOptions(page, field(page, 'Load')), 'Load options').toEqual(expect.arrayContaining(['Car', 'Truck']));
            const shipWeek = await shipWeekInput(page).inputValue();
            expect(shipWeek, 'Ship Week is filled in with a date').toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
            expect(new Date(shipWeek).getTime(), 'Default Ship Week is not in the past').toBeGreaterThanOrEqual(new Date(today()).getTime());
            await expect(noteInput(page)).toHaveValue('');
            await expect(noteInput(page)).toHaveAttribute('maxlength', String(NOTE_MAX_LENGTH));
            await expect(noteCounter(page, 0)).toBeVisible();
            await expect(page.getByRole('heading', { name: 'Board Foot Calculations' })).toBeVisible();
            await expect(numberInput(page, 'Unit Size')).toHaveValue('');
            await expect(numberInput(page, '$ / MBF')).toHaveValue('');
            expect(await footage(page), 'Lineal and Board Feet start at 0').toEqual({ lineal: 0, board: 0 });
            const headers = (await main(page).getByRole('table').first().getByRole('columnheader').allInnerTexts()).map(h => h.trim());
            expect.soft(headers.slice(1), 'Tally lengths').toEqual(TALLY_LENGTHS.map(l => `${l}'`));
            await expect(tallyInputs(page)).toHaveCount(TALLY_LENGTHS.length);
            for (const input of await tallyInputs(page).all()) await expect.soft(input, 'Tally is locked until a size is picked').toBeDisabled();
            const checkboxes = main(page).getByRole('checkbox');
            await expect(checkboxes, 'Stud, Manual Price Override and Hide this line').toHaveCount(3);
            for (const box of await checkboxes.all()) await expect.soft(box).not.toBeChecked();
            await expect(main(page).getByText('Manual Price Override').locator('visible=true')).toBeVisible();
            await expect(main(page).getByText('Hide this line').locator('visible=true')).toBeVisible();
            await expect(discardButton(page)).toBeDisabled();
            await expect(saveChangesButton(page)).toBeDisabled();
          }

          const note = randomTextNote();
          const values = await fillNewLine(page, note);
          const line = { ...values, lineNumber, category: '', categoryLineNumbers: [], quantity: NEW_LINE.quantity, note, load: 'Car', tally: '', boardFeet: 0 } as Line;
          if (n === 2) {
            line.status = await selectOtherOption(page, 'Line Status');
            line.load = await selectOtherOption(page, 'Load');
          }
          await expect.soft(noteCounter(page, note.length), 'Note counter').toBeVisible();
          await expect.soft(main(page).getByRole('table').first().getByRole('columnheader').first(), 'Tally shows the picked size').toHaveText(line.size);
          await expect(tallyInputs(page).first()).toBeEnabled();
          const { lineal, board } = await footage(page);
          expect.soft(lineal, `Lineal Feet = ${NEW_LINE.tally8ft} units x 8'`).toBe(Number(NEW_LINE.tally8ft) * 8);
          expect(board, 'Board Feet is calculated').toBeGreaterThan(0);
          line.boardFeet = board;
          line.tally = `${NEW_LINE.tally8ft}/8`;
          await expect(discardButton(page)).toBeEnabled();
          await saveNewLine(page, lineNumber, note);
          lines.push(line);
          test.info().annotations.push({ type: `line item ${n}`, description: `${lineNumber}: ${line.species} ${line.size} ${line.grade}, ${line.status}, ${line.load}` });

          const row = categoryLineRow(page, lineNumber);
          await expect(row).toContainText(`${line.species} ${line.size} ${line.grade}`);
          for (const action of ['Edit', 'Copy', 'Delete']) await expect.soft(row.getByRole('button', { name: action }), `${action} button`).toBeVisible();
        });
      }

      await test.step('Home page: both line items are under the new category with every column filled in correctly', async () => {
        await goHome(page);
        for (const line of lines) await expectLineRowOnHome(page, line, homeTitle());
      });

      const [edited, deleted] = lines;

      await test.step(`Edit Line Detail for ${edited.lineNumber}: locked and editable fields, buttons and empty history`, async () => {
        await openCategoriesPage(page);
        await editCategory(page, `${location} ${categoryName} Mill`);
        await categoryLineRow(page, edited.lineNumber).getByRole('button', { name: 'Edit' }).click();
        await expect(page.getByRole('heading', { name: 'Edit Line Detail (Mill)' })).toBeVisible({ timeout: 30000 });
        await expect(numberInput(page, 'Quantity')).toHaveValue(edited.quantity, { timeout: 30000 });

        await expect(field(page, 'Line Number').locator('input')).toBeDisabled();
        await expect(field(page, 'Line Number').locator('input')).toHaveValue(edited.lineNumber);
        for (const [name, value] of [['Location', location], ['Species', edited.species], ['Size', edited.size], ['Grade', edited.grade], ['Load', edited.load]]) {
          await expect.soft(field(page, name), `${name} shows the saved value`).toContainText(value);
          await expect.soft(field(page, name), `${name} cannot be changed`).toHaveAttribute('aria-disabled', 'true');
        }
        await expect(field(page, 'Line Status')).toContainText(edited.status);
        await expect(field(page, 'Line Status')).not.toHaveAttribute('aria-disabled', 'true');
        for (const input of [numberInput(page, 'Quantity'), shipWeekInput(page), noteInput(page), numberInput(page, 'Unit Size'), numberInput(page, '$ / MBF')]) {
          await expect.soft(input).toBeEditable();
        }
        await expect(noteInput(page)).toHaveValue(edited.note);
        await expect(numberInput(page, 'Unit Size')).toHaveValue(NEW_LINE.unitSize);
        await expect(numberInput(page, '$ / MBF')).toHaveValue(NEW_LINE.pricePerMbf);
        await expect(tallyInputs(page).first()).toHaveValue(NEW_LINE.tally8ft);
        expect.soft((await footage(page)).board, 'Board Feet matches the saved line').toBe(edited.boardFeet);
        await expect(discardButton(page)).toBeDisabled();
        await expect(saveChangesButton(page)).toBeDisabled();
        await expect(page.getByRole('heading', { name: 'Line History' })).toBeVisible();
        await expect(page.getByText('No edit history available')).toBeVisible();
      });

      await test.step('Discard throws away an unsaved change', async () => {
        await enterNumber(numberInput(page, 'Quantity'), '999');
        await expect(discardButton(page)).toBeEnabled();
        await expect(saveChangesButton(page)).toBeEnabled();
        await discardChanges(page, 'Discard Line', 'No');
        await expect.soft(numberInput(page, 'Quantity'), 'Answering No keeps the unsaved Quantity').toHaveValue('999', { timeout: 5000 });
        if ((await numberInput(page, 'Quantity').inputValue()) !== '999') await enterNumber(numberInput(page, 'Quantity'), '999');
        await discardChanges(page, 'Discard Line', 'Yes');
        await expect.soft(numberInput(page, 'Quantity'), 'Yes restores the saved Quantity').toHaveValue(edited.quantity, { timeout: 10000 });
        await expect.soft(saveChangesButton(page), 'Nothing left to save after Discard').toBeDisabled();
        if (!page.url().includes('/millLineDetail/edit/')) {
          await categoryLineRow(page, edited.lineNumber).getByRole('button', { name: 'Edit' }).click();
          await expect(page.getByRole('heading', { name: 'Edit Line Detail (Mill)' })).toBeVisible({ timeout: 30000 });
        }
        if ((await numberInput(page, 'Quantity').inputValue()) !== edited.quantity) {
          await page.reload();
          await expect(numberInput(page, 'Quantity')).toHaveValue(edited.quantity, { timeout: 30000 });
        }
      });

      await test.step(`Edit ${edited.lineNumber}: note, line status, quantity, ship week and tally, then save`, async () => {
        edited.note = randomTextNote();
        await noteInput(page).fill(edited.note);
        await noteInput(page).press('Tab');
        edited.status = await selectOtherOption(page, 'Line Status');
        await enterNumber(numberInput(page, 'Quantity'), EDITED.quantity);
        edited.quantity = EDITED.quantity;
        edited.shipWeek = await pickShipWeekInNextMonth(page);
        await enterNumber(tallyInputs(page).first(), EDITED.tally8ft);
        edited.tally = `${EDITED.tally8ft}/8`;
        const boardFeet = Math.round((edited.boardFeet * Number(EDITED.tally8ft)) / Number(NEW_LINE.tally8ft));
        await expect
          .configure({ soft: true })
          .poll(() => footage(page), { message: 'Lineal and Board Feet are recalculated', timeout: 15000 })
          .toEqual({ lineal: Number(EDITED.tally8ft) * 8, board: boardFeet });
        edited.boardFeet = boardFeet;
        await expect(noteInput(page), 'Note was changed by the app before Save').toHaveValue(edited.note);
        await saveChangesButton(page).click();
        await expect(page).not.toHaveURL(/\/millLineDetail\/edit\//, { timeout: 30000 });
        await expect(categoryLineRow(page, edited.lineNumber)).toBeVisible({ timeout: 30000 });
      });

      await test.step(`Line History of ${edited.lineNumber} lists the changes`, async () => {
        await categoryLineRow(page, edited.lineNumber).getByRole('button', { name: 'Edit' }).click();
        await expect(page.getByRole('heading', { name: 'Edit Line Detail (Mill)' })).toBeVisible({ timeout: 30000 });
        await expect(numberInput(page, 'Quantity')).toHaveValue(edited.quantity, { timeout: 30000 });
        const history = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Activity' }) });
        await expect(history.getByText(new RegExp(`updated quantity to ${edited.quantity}`))).toBeVisible({ timeout: 30000 });
        await expect.soft(history.getByText(new RegExp(`updated note to ${escapeRegExp(edited.note)}`))).toBeVisible();
        test.info().annotations.push({ type: 'line history', description: (await history.getByRole('row').allInnerTexts()).slice(1).map(r => r.replace(/\s+/g, ' ')).join('; ') });
      });

      await test.step(`Home page shows the edited ${edited.lineNumber}`, async () => {
        await goHome(page);
        await expectLineRowOnHome(page, edited, homeTitle());
      });

      await test.step(`Delete ${deleted.lineNumber}: the confirmation names the line, No keeps it, Yes removes it`, async () => {
        await openCategoriesPage(page);
        await editCategory(page, `${location} ${categoryName} Mill`);
        await categoryLineRow(page, deleted.lineNumber).getByRole('button', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog', { name: 'Delete Category Line' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(`Are you sure you want to delete '${deleted.species} ${deleted.size} ${deleted.grade} from ${categoryName} - Mill'?`);
        await expect(dialog.getByRole('button', { name: 'No' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Yes' })).toBeVisible();
        await dialog.getByRole('button', { name: 'No' }).click();
        await expect(dialog).toBeHidden();
        await expect(categoryLineRow(page, deleted.lineNumber), 'No keeps the line').toBeVisible();

        await deleteCategoryLine(page, deleted.lineNumber);
        await expect(categoryLineRow(page, edited.lineNumber), 'The other line stays').toBeVisible();
        test.info().annotations.push({ type: 'deleted', description: deleted.lineNumber });
      });

      await test.step(`Home page and Azure SQL: ${deleted.lineNumber} is gone, ${edited.lineNumber} is saved as edited`, async () => {
        await goHome(page);
        await expect(lineRow(page, deleted.lineNumber), `${deleted.lineNumber} should be gone from the home page`).toHaveCount(0, { timeout: 30000 });
        await expectLineRowOnHome(page, edited, homeTitle());

        const stored = [...(await fetchAzureSqlLines(page, api)).values()];
        expect(stored.find(l => l.lineNumber === deleted.lineNumber), `${deleted.lineNumber} should be gone from Azure SQL`).toBeUndefined();
        const row = stored.find(l => l.lineNumber === edited.lineNumber);
        expect(row, `${edited.lineNumber} in Azure SQL`).toBeTruthy();
        expect.soft(row?.quantity, 'Quantity in Azure SQL').toBe(edited.quantity);
        expect.soft(row?.note, 'Note in Azure SQL').toBe(edited.note);
        expect.soft(row?.shipWeek, 'Ship Week in Azure SQL').toBe(homeShipWeek(edited.shipWeek));

        const { message } = await runCheckDataMismatch(page);
        expect.soft(mismatchCount(message), `Check Data Mismatch after the changes: ${message ?? 'none'}`).toBeLessThanOrEqual(mismatchesBefore);
      });
    } catch (error) {
      const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (screenshot) await test.info().attach('page at failure', { body: screenshot, contentType: 'image/png' });
      throw error;
    } finally {
      await page.context().close();
    }
  });
});
