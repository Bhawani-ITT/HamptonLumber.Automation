import { test as base, Page } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { LocationPage } from '../pages/LocationPage';
import { CategoryPage } from '../pages/CategoryPage';
import { SizePage } from '../pages/SizePage';
import { LineItemPage } from '../pages/LineItemPage';
import { leaseUsers, releaseUsers, TestUser } from '../utils/users';
import { LeaseKind, leaseFrom, releaseLeases, tryLease } from '../utils/leases';
import { homeLineNumbers, millCategories } from '../utils/appData';

/** Line items and categories reserved for this test only; released when the test ends. */
export type DataLeases = {
  /** Reserves `count` line items from those on the page's home screen. */
  lines: (page: Page, count: number) => Promise<string[]>;
  /**
   * Reserves `count` Mill categories, each in a different location, and holds the whole location: new line numbers
   * are suggested per location, so two tests adding lines in one location at the same time would get the same number.
   * The page must be on the admin Categories page.
   */
  categories: (page: Page, count: number) => Promise<string[]>;
  /** Reserves `count` of the given locations, e.g. for a new category, so no other test adds lines there meanwhile. */
  locations: (candidates: string[], count: number) => Promise<string[]>;
  /** Reserves a line item this test is about to create, so no other test picks it up once it exists. */
  claimLine: (lineNumber: string) => void;
};

type Fixtures = {
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  locationPage: LocationPage;
  categoryPage: CategoryPage;
  sizePage: SizePage;
  lineItemPage: LineItemPage;
  /** Reserves `count` free test users for this test; they are released when the test ends. */
  users: (count: number) => Promise<TestUser[]>;
  leases: DataLeases;
};

export const test = base.extend<Fixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  locationPage: async ({ page }, use) => {
    await use(new LocationPage(page));
  },
  categoryPage: async ({ page }, use) => {
    await use(new CategoryPage(page));
  },
  sizePage: async ({ page }, use) => {
    await use(new SizePage(page));
  },
  lineItemPage: async ({ page }, use) => {
    await use(new LineItemPage(page));
  },
  users: async ({}, use) => {
    const leased: TestUser[] = [];
    try {
      await use(async count => {
        const users = await leaseUsers(count);
        leased.push(...users);
        test.info().annotations.push({ type: 'test users', description: users.map(u => u.username).join(', ') });
        return users;
      });
    } finally {
      releaseUsers(leased);
    }
  },
  leases: async ({}, use) => {
    const held: [LeaseKind, string][] = [];
    const lease = async (kind: LeaseKind, candidates: string[], count: number) => {
      const names = await leaseFrom(kind, candidates, count);
      held.push(...names.map(name => [kind, name] as [LeaseKind, string]));
      test.info().annotations.push({ type: `leased ${kind}s`, description: names.join(', ') });
      return names;
    };
    try {
      await use({
        lines: async (page, count) => lease('line', await homeLineNumbers(page), count),
        categories: async (page, count) => {
          const categories = await millCategories(page);
          const locations = await lease('location', categories.map(c => c.location), count);
          const names = locations.map(location => categories.find(c => c.location === location)!.name);
          test.info().annotations.push({ type: 'leased categories', description: names.join(', ') });
          return names;
        },
        locations: (candidates, count) => lease('location', candidates, count),
        claimLine: lineNumber => {
          if (held.some(([kind, name]) => kind === 'line' && name === lineNumber)) {
            return;
          }
          if (!tryLease('line', lineNumber)) throw new Error(`Line ${lineNumber} is already held by another test`);
          held.push(['line', lineNumber]);
        },
      });
    } finally {
      for (const [kind, name] of held) releaseLeases(kind, [name]);
    }
  },
});

export { expect } from '@playwright/test';
