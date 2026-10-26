import fs from 'fs';
import { STORAGE_STATE_PATH } from './utils/constants';
import { LEASE_DIR, runLockOwner } from './utils/leases';

// The saved session holds long-lived Microsoft sign-in cookies; the setup project recreates it on every run.
export default async function globalTeardown(): Promise<void> {
  // Playwright runs this even when global setup refused to start because another run is active; leave that run alone.
  const owner = runLockOwner();
  if (owner && owner !== process.pid) return;
  fs.rmSync(STORAGE_STATE_PATH, { force: true });
  fs.rmSync(LEASE_DIR, { recursive: true, force: true });
}
