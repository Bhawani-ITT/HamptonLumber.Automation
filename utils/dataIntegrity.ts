import { expect, Page, Request, Response, test } from '@playwright/test';

/** Line values as stored in Azure SQL, read through the app's integrity API. */
export type AzureSqlLine = { guid: string; lineNumber: string; quantity: string; shipWeek: string; note: string };
/** Line values as one user's home page shows them. */
export type HomeGridLine = { guid: string; lineNumber: string; quantity: string; shipWeek: string; note: string };
export type IntegrityApi = { url: string; authorization: string };

export const MISMATCH_TOAST = /(\d+) line item\(s\) are mismatched/;
const checkDataMismatchButton = (page: Page) => page.getByTestId('header-check-mismatch').getByRole('button');
/** Covers the page while the app is busy (loading data for a fresh session, or a check still running). */
const busyOverlay = (page: Page) => page.locator('.overlay-backdrop').filter({ visible: true });

/** Blazor's "Attempting to reconnect to the server" text, if the page lost its server connection. */
async function connectionNote(page: Page): Promise<string> {
  const banner = await page.getByText(/reconnect to the server/i).first().innerText({ timeout: 1000 }).catch(() => '');
  return banner ? ` (page lost its server connection: "${banner.replace(/\s+/g, ' ').trim()}")` : '';
}

/**
 * Clicks "Check Data Mismatch" and returns the toast message if the app reports a mismatch, or null if it reports none.
 * The app only shows a toast (for a few seconds) when it finds a mismatch.
 */
export async function runCheckDataMismatch(page: Page): Promise<{ message: string | null; api: IntegrityApi }> {
  const isIntegrityCall = (url: string) => url.includes('/api/Integrity/LineDetailHashes');
  let requested = false;
  let response: Response | undefined;
  const onRequest = (r: Request) => void (isIntegrityCall(r.url()) && (requested = true));
  const onResponse = (r: Response) => void (isIntegrityCall(r.url()) && (response ??= r));
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    // Right after the home page appears the app can ignore a click until it has finished starting up, and under load
    // (e.g. many users just logged in) its busy overlay can cover the button, or a started check, for over a minute.
    // So click again only once the overlay is gone and no check was started.
    for (let attempt = 1; !requested; attempt++) {
      await expect(busyOverlay(page), 'The app stayed busy (overlay over the page)').toHaveCount(0, { timeout: 120000 });
      if (requested) break;
      if (attempt > 4) throw new Error(`Check Data Mismatch did not start a check after 4 clicks${await connectionNote(page)}`);
      await checkDataMismatchButton(page).click();
      await expect.poll(() => requested, { timeout: 15000 }).toBe(true).catch(() => {});
    }
    await expect.poll(() => response !== undefined, { message: 'Integrity API response', timeout: 120000 }).toBe(true);
  } catch (error) {
    const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
    if (screenshot) await test.info().attach('check-data-mismatch-failed', { body: screenshot, contentType: 'image/png' });
    throw error;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
  expect(response!.status(), 'Integrity API status').toBe(200);
  const api = { url: response!.url(), authorization: response!.request().headers()['authorization'] };

  const toast = page.getByText(MISMATCH_TOAST).filter({ visible: true }).first();
  const shown = await toast.waitFor({ timeout: 6000 }).then(
    () => true,
    () => false,
  );
  return { message: shown ? (await toast.innerText()).trim() : null, api };
}

export async function fetchAzureSqlLines(page: Page, api: IntegrityApi): Promise<Map<string, AzureSqlLine>> {
  const response = await page.request.post(api.url, {
    headers: { authorization: api.authorization, 'content-type': 'application/json' },
    data: { guids: [], includeDeleted: false, compareAll: true, includeFieldValues: true },
  });
  expect(response.status(), 'Integrity API status').toBe(200);
  const body = await response.json();
  const lines = new Map<string, AzureSqlLine>();
  for (const { guid, lineNumber, fieldValues: f } of body.hashes) {
    lines.set(guid, {
      guid,
      lineNumber,
      quantity: String(f.Quantity ?? ''),
      shipWeek: f.ShipWeek ? String(f.ShipWeek).replace(/^\d{4}-0?(\d+)-0?(\d+).*$/, '$1/$2') : '',
      note: collapseWhitespace(String(f.Note ?? '')),
    });
  }
  return lines;
}

/** The home page shows line breaks and repeated spaces in notes as single spaces. */
const collapseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();

export async function readHomeGridLines(page: Page): Promise<HomeGridLine[]> {
  const lines = await page.locator('tr [data-testid^="sales-line-"]').evaluateAll(cells =>
    cells.map(cell => {
      const tds = [...cell.closest('tr')!.querySelectorAll('td')].map(td => (td as HTMLElement).innerText.trim());
      return {
        guid: cell.getAttribute('data-testid')!.replace('sales-line-', ''),
        lineNumber: tds[0].replace(/\*$/, ''),
        quantity: tds[1],
        shipWeek: tds[8],
        note: tds[10],
      };
    }),
  );
  return lines.map(line => ({ ...line, note: collapseWhitespace(line.note) }));
}

/** Lists every field where the home page differs from Azure SQL, e.g. `JSM101 quantity: screen="25" azure sql="362"`. */
export function compareWithAzureSql(grid: HomeGridLine[], sql: Map<string, AzureSqlLine>): string[] {
  const differences: string[] = [];
  for (const line of grid) {
    const stored = sql.get(line.guid);
    if (!stored) {
      differences.push(`${line.lineNumber} is on screen but not in Azure SQL (deleted?)`);
      continue;
    }
    for (const field of ['quantity', 'shipWeek', 'note'] as const) {
      if (line[field] !== stored[field]) {
        differences.push(`${line.lineNumber} ${field}: screen="${line[field]}" azure sql="${stored[field]}"`);
      }
    }
  }
  return differences;
}

/**
 * Waits until the page matches Azure SQL (re-reading both, so in-flight live updates can land) and
 * returns the differences that are still there after the timeout.
 */
export async function differencesAfterSettling(page: Page, api: IntegrityApi, timeoutMs = 30000): Promise<string[]> {
  let differences: string[] = [];
  const deadline = Date.now() + timeoutMs;
  do {
    differences = compareWithAzureSql(await readHomeGridLines(page), await fetchAzureSqlLines(page, api));
    if (differences.length === 0) return [];
    await page.waitForTimeout(2000);
  } while (Date.now() < deadline);
  return differences;
}
