import fs from 'fs';
import path from 'path';

/**
 * Lock files live here while a test holds a shared resource (a test user, a line item, a location),
 * so tests running in parallel never use the same one.
 */
export const LEASE_DIR = path.resolve(__dirname, '..', '.leases');
/** Holds the process id of the test run that owns the leases. */
export const RUN_LOCK = path.join(LEASE_DIR, 'run.pid');

export const runLockOwner = (): number => Number(fs.existsSync(RUN_LOCK) ? fs.readFileSync(RUN_LOCK, 'utf8') : 0);

export type LeaseKind = 'user' | 'line' | 'location';

const leaseFile = (kind: LeaseKind, name: string) =>
  path.join(LEASE_DIR, kind, `${name.replace(/[^\w.@-]/g, c => `_${c.charCodeAt(0)}`)}.lock`);

/** Takes the lease if nobody holds it. */
export function tryLease(kind: LeaseKind, name: string): boolean {
  fs.mkdirSync(path.join(LEASE_DIR, kind), { recursive: true });
  try {
    fs.writeFileSync(leaseFile(kind, name), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function releaseLeases(kind: LeaseKind, names: string[]): void {
  for (const name of names) fs.rmSync(leaseFile(kind, name), { force: true });
}

/**
 * Reserves `count` of the candidates that no other running test holds, in candidate order.
 * Waits for leases to be released when too few are free.
 */
export async function leaseFrom(kind: LeaseKind, candidates: string[], count: number, timeoutMs = 300_000): Promise<string[]> {
  const unique = [...new Set(candidates)];
  if (count > unique.length) {
    throw new Error(`Requested ${count} ${kind}(s) but only ${unique.length} exist: ${unique.join(', ')}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const leased: string[] = [];
    for (const name of unique) {
      if (leased.length === count) break;
      if (tryLease(kind, name)) leased.push(name);
    }
    if (leased.length === count) return leased;
    // Give back a partial set so two waiting tests cannot block each other.
    releaseLeases(kind, leased);
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} free ${kind}(s); ${unique.length} exist and the rest are in use by other tests.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
  }
}
