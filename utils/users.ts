import { leaseFrom, releaseLeases } from './leases';

export type TestUser = { username: string; password: string };

/** All pooled test users loaded from Key Vault by global setup. */
export function loadUserPool(): TestUser[] {
  const raw = process.env.TEST_USER_POOL;
  if (!raw) {
    throw new Error('TEST_USER_POOL is not set. Set TEST_USER_POOL_PREFIX in .env so global setup loads users from Key Vault.');
  }
  return JSON.parse(raw) as TestUser[];
}

export function releaseUsers(users: TestUser[]): void {
  releaseLeases(
    'user',
    users.map(u => u.username),
  );
}

/**
 * Reserves `count` users that no other running test holds. Waits for users to be released when the pool is busy.
 * Call releaseUsers() when done; the `users` fixture does this automatically.
 */
export async function leaseUsers(count: number, timeoutMs = 300_000): Promise<TestUser[]> {
  const pool = loadUserPool();
  if (count > pool.length) {
    throw new Error(`Requested ${count} users but only ${pool.length} are available in Key Vault.`);
  }
  const names = await leaseFrom(
    'user',
    pool.map(u => u.username),
    count,
    timeoutMs,
  );
  return names.map(name => pool.find(u => u.username === name)!);
}
