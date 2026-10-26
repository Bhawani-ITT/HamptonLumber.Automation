import { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { openDropdownOptions } from './categoryLineFlow';
import {
  expectNoReloadSinceLogin,
  lineRow,
  loginInNewSession,
  openLineForEdit,
  quantityInput,
  randomQuantity,
  saveAndExpectSuccess,
} from './twoUserEditFlow';

const USER_COUNT = 10;
const QTY_COLUMN = 1;
const SHIP_WEEK_COLUMN = 8;
const STATUS_COLUMN = 11;
// The last viewers are on a very slow network.
const SLOW_VIEWER_COUNT = 2;
const SLOW_NETWORK = { latencyMs: 2000, downloadBytesPerSec: 25 * 1024, uploadBytesPerSec: 10 * 1024 };
const SETTLE_BEFORE_EDIT_MS = 5000;

const lineStatusDropdown = (page: Page) =>
  page.locator('label:has-text("Line Status") + span[role="combobox"] >> visible=true');
const shipWeekPicker = (page: Page) => page.locator('label:has-text("Ship Week") + span.k-datepicker >> visible=true');
const cell = (page: Page, lineNumber: string, column: number) => lineRow(page, lineNumber).getByRole('gridcell').nth(column);

/** Delays every SignalR (WebSocket) message both ways; Chrome's network throttling doesn't reliably cover WebSockets. */
async function delayWebSocketMessages(context: BrowserContext): Promise<void> {
  const oneWayDelay = SLOW_NETWORK.latencyMs / 2;
  await context.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => setTimeout(() => server.send(message), oneWayDelay));
    server.onMessage(message => setTimeout(() => ws.send(message), oneWayDelay));
  });
}

async function throttleNetwork(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: SLOW_NETWORK.latencyMs,
    downloadThroughput: SLOW_NETWORK.downloadBytesPerSec,
    uploadThroughput: SLOW_NETWORK.uploadBytesPerSec,
  });
}

/** Picks a random selectable day in next month's calendar and returns it as the home grid shows it (M/D). */
async function pickNewShipWeek(page: Page): Promise<string> {
  const current = await shipWeekPicker(page).locator('input').inputValue();
  await shipWeekPicker(page).getByRole('button', { name: 'Open' }).click();
  const calendar = page.locator('.k-calendar');
  await expect(calendar).toBeVisible();
  const monthTitle = calendar.locator('.k-calendar-title');
  const shownMonth = (await monthTitle.innerText()).trim();
  await calendar.getByRole('button', { name: 'Go to the next period' }).click();
  await expect(monthTitle).not.toHaveText(shownMonth);
  const nextMonth = (await monthTitle.innerText()).trim();

  const days = calendar.getByRole('grid', { name: nextMonth }).locator('td[role="gridcell"]:not(.k-disabled):not(.k-other-month)');
  await expect(days.first()).toBeVisible();
  const labels = (await days.evaluateAll(cells => cells.map(c => c.getAttribute('aria-label') ?? ''))).filter(l =>
    l.endsWith(nextMonth),
  );
  expect(labels.length, `No selectable ship week days in ${nextMonth}`).toBeGreaterThan(0);
  const label = labels[Math.floor(Math.random() * labels.length)];
  const date = new Date(label.replace(/^\w+, /, ''));
  await calendar.getByRole('gridcell', { name: label, exact: true }).click();

  const shipWeek = `${date.getMonth() + 1}/${date.getDate()}`;
  const inputValue = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
  expect(inputValue, 'Picked ship week should differ from the current one').not.toBe(current);
  await expect(shipWeekPicker(page).locator('input')).toHaveValue(inputValue);
  return shipWeek;
}

test.describe('Concurrent users', () => {
  test('3 users edit quantity, line status and ship week on separate lines; all 10 users see every change on the home page', async ({ browser, users: leaseUsers, leases }) => {
    test.skip(test.info().project.name !== 'google-chrome', 'Runs on Google Chrome only');
    test.setTimeout(600000);
    const users = await leaseUsers(USER_COUNT);

    let pages: Page[] = [];
    const lines = { quantity: '', status: '', shipWeek: '' };
    const expected = { quantity: '', status: '', shipWeek: '' };
    const isSlow = (i: number) => i >= USER_COUNT - SLOW_VIEWER_COUNT;
    const roleOf = (i: number) => (i < 3 ? `editor ${i + 1}` : isSlow(i) ? 'viewer on slow network' : 'viewer');

    try {
      await test.step(`Log in ${USER_COUNT} unique users, each in a separate session`, async () => {
        pages = await Promise.all(
          users.map((user, i) => loginInNewSession(browser, user, isSlow(i) ? delayWebSocketMessages : undefined)),
        );
      });

      await test.step(
        `Put ${SLOW_VIEWER_COUNT} viewers on a very slow network (${SLOW_NETWORK.latencyMs} ms latency, ` +
          `${SLOW_NETWORK.downloadBytesPerSec / 1024} KB/s down, ${SLOW_NETWORK.uploadBytesPerSec / 1024} KB/s up)`,
        async () => {
          await Promise.all(pages.filter((_, i) => isSlow(i)).map(throttleNetwork));
          test.info().annotations.push({
            type: 'slow network viewers',
            description: users.filter((_, i) => isSlow(i)).map(u => u.username).join(', '),
          });
        },
      );

      await test.step(`Wait ${SETTLE_BEFORE_EDIT_MS / 1000} seconds after every user has logged in before any edit`, async () => {
        await pages[0].waitForTimeout(SETTLE_BEFORE_EDIT_MS);
      });
      const [quantityEditor, statusEditor, shipWeekEditor] = pages;

      await test.step('Pick three different line items', async () => {
        [lines.quantity, lines.status, lines.shipWeek] = await leases.lines(quantityEditor, 3);
        test.info().annotations.push({
          type: 'line items',
          description: `quantity: ${lines.quantity}, line status: ${lines.status}, ship week: ${lines.shipWeek}`,
        });
      });

      await test.step('Each editor opens their own line item; the other 7 users stay on the home page', async () => {
        await Promise.all([
          openLineForEdit(quantityEditor, lines.quantity),
          openLineForEdit(statusEditor, lines.status),
          openLineForEdit(shipWeekEditor, lines.shipWeek),
        ]);
      });

      await test.step(`Editor 1 changes the quantity of ${lines.quantity}`, async () => {
        expected.quantity = randomQuantity(Number(await quantityInput(quantityEditor).inputValue()));
        await quantityInput(quantityEditor).fill(expected.quantity);
        await quantityInput(quantityEditor).press('Tab');
        await expect(quantityInput(quantityEditor)).toHaveValue(expected.quantity);
      });

      await test.step(`Editor 2 changes the line status of ${lines.status}`, async () => {
        const current = (await lineStatusDropdown(statusEditor).locator('.k-input-value-text').innerText()).trim();
        await lineStatusDropdown(statusEditor).click();
        const options = openDropdownOptions(statusEditor);
        await expect(options.first()).toBeVisible();
        const others = (await options.allInnerTexts()).map(o => o.trim()).filter(o => o && o !== current);
        expect(others.length, `No line status other than "${current}" to switch to`).toBeGreaterThan(0);
        expected.status = others[0];
        await options.filter({ hasText: new RegExp(`^\\s*${expected.status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).click();
        await expect(lineStatusDropdown(statusEditor)).toContainText(expected.status);
      });

      await test.step(`Editor 3 changes the ship week of ${lines.shipWeek}`, async () => {
        expected.shipWeek = await pickNewShipWeek(shipWeekEditor);
      });

      await test.step('All three editors save at the same time', async () => {
        await Promise.all([quantityEditor, statusEditor, shipWeekEditor].map(saveAndExpectSuccess));
      });

      await test.step(`All ${USER_COUNT} users see every change on the home page without reloading`, async () => {
        const checks = [
          { what: `${lines.quantity} Qty`, line: lines.quantity, column: QTY_COLUMN, value: expected.quantity },
          { what: `${lines.status} Status`, line: lines.status, column: STATUS_COLUMN, value: expected.status },
          { what: `${lines.shipWeek} Ship Wk`, line: lines.shipWeek, column: SHIP_WEEK_COLUMN, value: expected.shipWeek },
        ];
        const start = Date.now();
        const results = await Promise.allSettled(
          pages.map(async (page, i) => {
            const timeout = isSlow(i) ? 90000 : 30000;
            await expect(page).not.toHaveURL(/\/edit\//, { timeout });
            for (const { line, column, value } of checks) {
              await expect(cell(page, line, column)).toHaveText(value, { timeout });
            }
            await expectNoReloadSinceLogin(page, `User ${i + 1}`);
            return Date.now() - start;
          }),
        );
        test.info().annotations.push({
          type: 'time to see all changes',
          description: results
            .map((r, i) => `user ${i + 1} (${roleOf(i)}): ${r.status === 'fulfilled' ? `${(r.value / 1000).toFixed(1)}s` : 'not seen'}`)
            .join('; '),
        });

        const failures: string[] = [];
        for (const [i, result] of results.entries()) {
          if (result.status === 'fulfilled') continue;
          const page = pages[i];
          const role = roleOf(i);
          await test.info().attach(`user-${i + 1}-${role}-${users[i].username}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
          const seen = await Promise.all(
            checks.map(async ({ what, line, column }) => `${what}="${(await cell(page, line, column).innerText().catch(() => '?')).trim()}"`),
          );
          const reloaded = !(await page.evaluate(() => (window as any).__loadedOnceMarker === true));
          failures.push(`${users[i].username} (${role}) sees ${seen.join(', ')}, reloaded=${reloaded}`);
        }
        expect(
          failures,
          `Expected ${checks.map(({ what, value }) => `${what}="${value}"`).join(', ')} for every user`,
        ).toEqual([]);
      });
    } finally {
      await Promise.all(pages.map(page => page.context().close()));
    }
  });
});
