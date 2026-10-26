import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, type DataLeases } from '../../fixtures/testFixtures';
import { LoginPage } from '../../pages/LoginPage';
import { TestUser } from '../../utils/users';

export const dataTables = (page: Page) => page.getByRole('grid', { name: 'Data table' });
export const quantityInput = (page: Page) =>
  page.locator('label:has-text("Quantity") + span input[role="spinbutton"] >> visible=true');
export const saveChangesButton = (page: Page) => page.getByRole('button', { name: 'Save Changes', exact: true });
/** Accessible name of the Line # button; the app may append "*" to the line number. */
export const lineButtonName = (lineNumber: string) => new RegExp(`^${lineNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*?$`);
export const lineRow = (page: Page, lineNumber: string) =>
  dataTables(page).getByRole('row').filter({ has: page.getByRole('button', { name: lineButtonName(lineNumber) }) });
export const lineQuantityCell = (page: Page, lineNumber: string) => lineRow(page, lineNumber).getByRole('gridcell').nth(1);

export async function loginInNewSession(
  browser: Browser,
  user: TestUser,
  prepareContext?: (context: BrowserContext) => Promise<void>,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: process.env.BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    await prepareContext?.(context);
    const page = await context.newPage();
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(user.username, user.password);
    await expect(page.getByRole('img', { name: 'Logo' })).toBeVisible({ timeout: 60000 });
    await expect(dataTables(page).first()).toBeVisible({ timeout: 60000 });
    await page.evaluate(() => ((window as any).__loadedOnceMarker = true));
    return page;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/** Fails if the page was reloaded or fully navigated since login; in-app (client-side) navigation keeps the marker. */
export async function expectNoReloadSinceLogin(page: Page, who: string): Promise<void> {
  const markerKept = await page.evaluate(() => (window as any).__loadedOnceMarker === true);
  expect(markerKept, `${who}'s page was reloaded or fully re-loaded since login`).toBe(true);
}

export async function openLineForEdit(page: Page, lineNumber: string): Promise<void> {
  const heading = page.getByRole('heading', { name: /Edit Line Detail/ });
  // Right after the home page appears, the app can ignore a click until it has finished starting up.
  await expect(async () => {
    if (!(await heading.isVisible())) await lineRow(page, lineNumber).getByRole('button', { name: lineButtonName(lineNumber) }).click({ timeout: 5000 });
    await expect(heading).toBeVisible({ timeout: 10000 });
  }).toPass({ timeout: 60000 });
  await expect(quantityInput(page)).not.toHaveValue('', { timeout: 30000 });
}

/** Leaves Edit Line Detail with "Back to list"; a click while a live update re-renders the page can be lost. */
export async function backToList(page: Page): Promise<void> {
  await expect(async () => {
    if (new URL(page.url()).pathname.includes('/edit/')) await page.getByRole('button', { name: /Back to list/ }).click({ timeout: 5000 });
    await expect(page).not.toHaveURL(/\/edit\//, { timeout: 10000 });
  }).toPass({ timeout: 60000 });
}

/** Enters the quantity and scrolls to an enabled Save Changes button, without clicking it. */
export async function enterQuantity(page: Page, quantity: string): Promise<void> {
  await quantityInput(page).fill(quantity);
  await quantityInput(page).press('Tab');
  await expect(quantityInput(page)).toHaveValue(quantity);
  await saveChangesButton(page).scrollIntoViewIfNeeded();
  await expect(saveChangesButton(page)).toBeEnabled();
}

/** Clicks Save Changes and waits for the success toast or the redirect back to the home page. */
export async function saveAndExpectSuccess(page: Page): Promise<void> {
  await saveChangesButton(page).scrollIntoViewIfNeeded();
  await expect(saveChangesButton(page)).toBeEnabled();
  await saveChangesButton(page).click();
  // Another editor's "Mill line number X has been updated" alert can replace the success toast straight away,
  // so the redirect back to the home page also counts as a successful save.
  await expect(
    page.getByText(/line detail updated successfully/i).filter({ visible: true }).or(dataTables(page).first()).first(),
  ).toBeVisible({ timeout: 15000 });
}

export function randomQuantity(...exclude: number[]): string {
  let quantity: number;
  do {
    quantity = Math.floor(Math.random() * 999) + 1;
  } while (exclude.includes(quantity));
  return String(quantity);
}

export type TwoUserEditOptions = {
  browserA: Browser;
  browserB: Browser;
  browserNameA: string;
  browserNameB: string;
  /** Two leased test users: User A and User B. */
  users: TestUser[];
  /** The `leases` fixture, to reserve the line item both users edit. */
  leases: DataLeases;
};

export async function runTwoUserEdit({ browserA, browserB, browserNameA, browserNameB, users, leases }: TwoUserEditOptions) {
  const [testUserA, testUserB] = users;
  let userA!: Page;
  let userB!: Page;
  let lineNumber = '';
  let quantityA = '';
  let quantityB = '';

  try {
    await test.step(`User A logs in on ${browserNameA} and User B logs in on ${browserNameB}, in separate sessions`, async () => {
      [userA, userB] = await Promise.all([loginInNewSession(browserA, testUserA), loginInNewSession(browserB, testUserB)]);
    });

    await test.step('Pick a line item and open it for edit as both users', async () => {
      [lineNumber] = await leases.lines(userA, 1);
      await Promise.all([openLineForEdit(userA, lineNumber), openLineForEdit(userB, lineNumber)]);
      const originalQuantity = Number(await quantityInput(userA).inputValue());
      await expect(quantityInput(userB)).toHaveValue(String(originalQuantity));
      quantityA = randomQuantity(originalQuantity);
      quantityB = randomQuantity(originalQuantity, Number(quantityA));
    });

    await test.step('User A changes the quantity and saves first', async () => {
      await enterQuantity(userA, quantityA);
      await saveAndExpectSuccess(userA);
    });

    await test.step("User B sees User A's change on the open edit page without reloading", async () => {
      try {
        await expect(quantityInput(userB)).toHaveValue(quantityA, { timeout: 30000 });
        await expectNoReloadSinceLogin(userB, 'User B');
      } finally {
        await test.info().attach('user-b-edit-page-after-user-a-save', {
          body: await userB.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      }
    });

    await test.step('User B changes the quantity and saves', async () => {
      await enterQuantity(userB, quantityB);
      await saveAndExpectSuccess(userB);
    });

    await test.step('Both users see the final quantity on the home page without reloading', async () => {
      for (const page of [userA, userB]) {
        await expect(page).not.toHaveURL(/\/edit\//, { timeout: 30000 });
        await expect(lineRow(page, lineNumber).getByRole('gridcell').nth(1)).toHaveText(quantityB, { timeout: 30000 });
      }
      await expectNoReloadSinceLogin(userA, 'User A');
      await expectNoReloadSinceLogin(userB, 'User B');
    });
  } finally {
    await userA?.context().close();
    await userB?.context().close();
  }
}
