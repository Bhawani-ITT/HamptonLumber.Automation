import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/testFixtures';
import { TestUser } from '../../utils/users';
import { dataTables, loginInNewSession, saveChangesButton } from './twoUserEditFlow';
import {
  categoryLineRow,
  editCategory,
  ExpectedLine,
  fillNewLine,
  NEW_LINE,
  openCategoriesPage,
  saveNewLine,
  startAddLine,
} from './categoryLineFlow';
import { MISMATCH_TOAST } from '../../utils/dataIntegrity';

// Logging everyone in at once can trip Microsoft sign-in throttling.
export const LOGIN_BATCH_SIZE = 10;
export const SAVE_TIMEOUT_MS = 60000;
/** Blazor tries to reconnect 8 times; past this the page is reloaded instead. */
const RECONNECT_TIMEOUT_MS = 120000;
/** Longest one user's check may take, reconnecting and reloading included, so a stuck page fails the check instead of the whole test. */
const USER_CHECK_LIMIT_MS = 360000;
/** Blazor shows its "Attempting to reconnect to the server" banner in this element. */
const reconnectBanner = (page: Page) =>
  page.locator('#components-reconnect-modal').or(page.getByText(/reconnect to the server/i)).filter({ visible: true }).first();

/** Remembers in the page whether the reconnect banner has shown up, so a short disconnect between checks is not missed. */
async function trackReconnects(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    setInterval(() => {
      const banner = document.getElementById('components-reconnect-modal');
      if (banner && banner.getClientRects().length > 0) (window as any).__reconnectSeen = true;
    }, 500);
  });
}

const homeLoaded = (page: Page) => expect(dataTables(page).first()).toBeVisible({ timeout: 60000 }).then(() => true, () => false);

/**
 * Brings a page that could not reconnect back to the home page: reloads it a few times and, if the tab itself stays
 * unable to load (e.g. net::ERR_NETWORK_IO_SUSPENDED), opens a fresh tab in the same signed-in session instead.
 */
async function reopen(page: Page): Promise<{ page: Page; how: string }> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const loaded = await page.reload({ timeout: 60000 }).then(
      () => homeLoaded(page),
      error => (errors.push(String(error).split('\n')[0]), false),
    );
    if (loaded) return { page, how: `reloaded${attempt > 1 ? ` (attempt ${attempt})` : ''}` };
    await page.waitForTimeout(5000);
  }
  const fresh = await page.context().newPage();
  await fresh.goto('/', { timeout: 60000 });
  if (!(await homeLoaded(fresh))) throw new Error(`Could not reopen the home page after losing the server connection: ${errors.join(' | ')}`);
  await page.close().catch(() => {});
  return { page: fresh, how: `opened in a new tab because the old tab could not load (${errors.at(-1) ?? 'home page did not appear'})` };
}

/**
 * If the page lost its server connection, waits for the app to reconnect, or brings the page back when the app gives up.
 * Returns what happened (null when the connection was never lost) and the page to use from now on.
 */
export async function settleConnection(page: Page): Promise<{ event: string | null; page: Page }> {
  const start = Date.now();
  let banner = '';
  while (await reconnectBanner(page).isVisible().catch(() => false)) {
    banner = (await reconnectBanner(page).innerText({ timeout: 5000 }).catch(() => '')).replace(/\s+/g, ' ').trim() || banner;
    if (/failed|could not reconnect|reload/i.test(banner) || Date.now() - start > RECONNECT_TIMEOUT_MS) {
      const reopened = await reopen(page);
      // The reload is reported here, so later "not reloaded since login" checks shouldn't fail on it again.
      await reopened.page.evaluate(() => ((window as any).__loadedOnceMarker = true));
      return {
        page: reopened.page,
        event: `connection lost ("${banner}"); the app could not reconnect, so the page was ${reopened.how} after ${seconds(Date.now() - start)}`,
      };
    }
    await page.waitForTimeout(1000);
  }
  const seen = await page
    .evaluate(() => {
      const seen = (window as any).__reconnectSeen === true;
      (window as any).__reconnectSeen = false;
      return seen;
    })
    .catch(() => false);
  if (banner) return { page, event: `connection lost ("${banner}"), reconnected after ${seconds(Date.now() - start)}` };
  return { page, event: seen ? 'connection lost and regained between checks' : null };
}

/** Opens the home page with a full page load, loading it again if the line tables don't appear under load. */
export async function goHome(page: Page): Promise<void> {
  await expect(async () => {
    await page.goto('/', { timeout: 60000 });
    await expect(dataTables(page).first(), 'home page line tables').toBeVisible({ timeout: 60000 });
  }, 'Open the home page').toPass({ timeout: 200000 });
}

export type TimedResult = { saved: boolean; ms: number; detail: string };

export const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export const mismatchCount = (message: string | null) => Number(message?.match(MISMATCH_TOAST)?.[1] ?? 0);

/** First line of an error plus Playwright's Expected/Received lines, so a failure says what was actually on screen. */
function describeError(error: unknown): string {
  const lines = String(error)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map(line => line.trim());
  const details = lines.filter(line => /^(Expected|Received)\b|element\(s\) not found|strict mode violation/.test(line));
  return [lines[0], ...new Set(details)].join(' | ');
}

function withinLimit<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Logs users in batch by batch; a login that fails (e.g. a page load timing out under load) is retried once and reported. */
export async function loginInBatches(browser: Browser, users: TestUser[]): Promise<Page[]> {
  const retried: string[] = [];
  const signIn = async (user: TestUser) => {
    const page = await loginInNewSession(browser, user, trackReconnects);
    // Without these, a click or page load on a page that lost the server can wait until the whole test times out.
    page.context().setDefaultTimeout(30000);
    page.context().setDefaultNavigationTimeout(60000);
    return page;
  };
  const login = (user: TestUser) =>
    signIn(user).catch(error => {
      retried.push(`${user.username}: ${String(error).split('\n')[0]}`);
      return signIn(user);
    });
  const pages: Page[] = [];
  try {
    for (let i = 0; i < users.length; i += LOGIN_BATCH_SIZE) {
      const batch = await Promise.allSettled(users.slice(i, i + LOGIN_BATCH_SIZE).map(login));
      pages.push(...batch.flatMap(r => (r.status === 'fulfilled' ? [r.value] : [])));
      const failed = batch.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
  } catch (error) {
    await Promise.all(pages.map(page => page.context().close()));
    throw error;
  } finally {
    if (retried.length) test.info().annotations.push({ type: 'login retried', description: retried.join('; ') });
  }
  return pages;
}

/** Clicks Save Changes on Edit Line Detail and reports whether (and how fast) the save went through. */
export async function timedEditSave(page: Page): Promise<TimedResult> {
  const start = Date.now();
  await saveChangesButton(page).scrollIntoViewIfNeeded();
  await saveChangesButton(page).click();
  const toast = page.getByText(/line detail updated successfully/i).filter({ visible: true }).first();
  const detail = await Promise.race([
    toast.waitFor({ timeout: SAVE_TIMEOUT_MS }).then(() => 'success message'),
    page.waitForURL(url => !url.pathname.includes('/edit/'), { timeout: SAVE_TIMEOUT_MS }).then(() => 'back on the home page'),
  ]).catch(() => null);
  if (detail) return { saved: true, ms: Date.now() - start, detail };
  const alerts = await page.getByRole('alert').allInnerTexts().catch(() => []);
  return { saved: false, ms: Date.now() - start, detail: `stayed on the edit page${alerts.length ? `: ${alerts.join(' | ')}` : ''}` };
}

export async function timedNewLineSave(page: Page, line: ExpectedLine): Promise<TimedResult> {
  const start = Date.now();
  return saveNewLine(page, line.lineNumber, line.note, SAVE_TIMEOUT_MS).then(
    () => ({ saved: true, ms: Date.now() - start, detail: 'listed under its category' }),
    async error => {
      const alerts = await page.getByRole('alert').allInnerTexts().catch(() => []);
      const where = new URL(page.url()).pathname.includes('/add/') ? 'stayed on the Add Line page' : String(error).split('\n')[0];
      return { saved: false, ms: Date.now() - start, detail: `${where}${alerts.length ? `: ${alerts.join(' | ')}` : ''}` };
    },
  );
}

/** Opens the "Delete Category Line" confirmation for the line (category edit page must be open), without answering it. */
export async function startDeleteCategoryLine(page: Page, lineNumber: string): Promise<void> {
  await categoryLineRow(page, lineNumber).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete Category Line' })).toBeVisible();
}

/** How much longer a late delete is watched, to tell a slow screen update from one that never comes. */
const LATE_DELETE_WATCH_MS = 180000;

/**
 * Answers Yes on the open "Delete Category Line" confirmation and reports whether the line went away within
 * SAVE_TIMEOUT_MS; a line still listed by then is watched a while longer to report when (or whether) it disappeared.
 */
export async function timedConfirmDelete(page: Page, lineNumber: string): Promise<TimedResult> {
  const start = Date.now();
  await page.getByRole('dialog', { name: 'Delete Category Line' }).getByRole('button', { name: 'Yes' }).click();
  const gone = (timeout: number) =>
    expect(categoryLineRow(page, lineNumber))
      .toHaveCount(0, { timeout })
      .then(() => true, () => false);
  if (await gone(SAVE_TIMEOUT_MS)) return { saved: true, ms: Date.now() - start, detail: 'removed from the category' };
  const late = await gone(LATE_DELETE_WATCH_MS);
  const ms = Date.now() - start;
  return {
    saved: false,
    ms,
    detail: late ? `removed from the category only after ${seconds(ms)}` : `still listed in the category after ${seconds(ms)} without a reload`,
  };
}

/** Adds a line with the given note to the category and returns its values; leaves the user on the home page. */
export async function addLineToCategory(page: Page, category: string, note: string, claimLine: (lineNumber: string) => void): Promise<ExpectedLine> {
  await openCategoriesPage(page);
  const line = { category, quantity: NEW_LINE.quantity, note } as ExpectedLine;
  line.categoryLineNumbers = await editCategory(page, category);
  line.lineNumber = await startAddLine(page);
  claimLine(line.lineNumber);
  Object.assign(line, await fillNewLine(page, note));
  // Setup, not a measured save: stage can take minutes while it is still busy with earlier work.
  await saveNewLine(page, line.lineNumber, note, 180000);
  await goHome(page);
  return line;
}

/**
 * Returns a checker that runs a check for many users at once and fails with one readable line (and a screenshot)
 * per user that failed. A page that lost its server connection is given time to reconnect (or reloaded if the app
 * gives up) and checked again; each such reconnect is reported as a finding rather than a failure.
 */
export function userChecker(pages: () => Page[], users: TestUser[], roleOf: (i: number) => string) {
  return async (indexes: number[], what: string, check: (page: Page, i: number) => Promise<void>): Promise<void> => {
    const start = Date.now();
    const reconnects: string[] = [];
    const results = await Promise.allSettled(
      indexes.map(i => {
        const all = pages();
        /** Settles the connection; a page reopened in a new tab replaces the old one for the rest of the test. */
        const settle = async () => {
          const { event, page } = await settleConnection(all[i]);
          all[i] = page;
          if (event) reconnects.push(`${users[i].username} (${roleOf(i)}): ${event}`);
          return event;
        };
        const run = async () => {
          await settle();
          try {
            await check(all[i], i);
          } catch (error) {
            if (!(await settle())) throw error;
            await check(all[i], i);
          }
          return Date.now() - start;
        };
        return withinLimit(run(), USER_CHECK_LIMIT_MS, `still not done after ${USER_CHECK_LIMIT_MS / 60000} min (page stuck reconnecting or loading)`);
      }),
    );
    if (reconnects.length) test.info().annotations.push({ type: `${what}: server connection lost`, description: reconnects.join('; ') });
    const failures: string[] = [];
    for (const [n, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const i = indexes[n];
      const page = pages()[i];
      const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (screenshot) await test.info().attach(`user-${i + 1}-${roleOf(i)}-${users[i].username}`, { body: screenshot, contentType: 'image/png' });
      const reconnecting = await page.getByText(/reconnect to the server/i).first().innerText({ timeout: 1000 }).catch(() => '');
      failures.push(
        `${users[i].username} (${roleOf(i)}): ${describeError(result.reason)}` +
          (reconnecting ? ` (page lost its server connection: "${reconnecting.trim()}")` : ''),
      );
    }
    const slowest = Math.max(0, ...results.map(r => (r.status === 'fulfilled' ? r.value : 0)));
    test.info().annotations.push({ type: what, description: `${indexes.length - failures.length}/${indexes.length} users OK, slowest ${seconds(slowest)}` });
    expect(failures, what).toEqual([]);
  };
}

/** Annotates each timed action and the fastest/median/slowest time. */
export function reportTimes(type: string, results: TimedResult[], who: (n: number) => string): void {
  test.info().annotations.push({
    type,
    description: results.map((r, n) => `${who(n)}: ${r.saved ? 'done' : 'NOT done'} in ${seconds(r.ms)}, ${r.detail}`).join('; '),
  });
  const times = results.filter(r => r.saved).map(r => r.ms).sort((a, b) => a - b);
  test.info().annotations.push({
    type: `${type} times`,
    description: `fastest ${seconds(times[0] ?? 0)}, median ${seconds(times[Math.floor(times.length / 2)] ?? 0)}, slowest ${seconds(times.at(-1) ?? 0)}`,
  });
}
