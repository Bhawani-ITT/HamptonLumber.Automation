import { Page } from '@playwright/test';

export async function waitForPageLoad(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

export function randomString(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}
