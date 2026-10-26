import fs from 'fs';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { TestUser } from './utils/users';
import { LEASE_DIR, RUN_LOCK, runLockOwner } from './utils/leases';

// Builds TEST_USER_POOL from every "<TEST_USER_POOL_PREFIX><number>-password" secret in Key Vault.
// Workers are started after this runs, so they inherit TEST_USER_POOL.
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export default async function globalSetup(): Promise<void> {
  // Two runs at once would share test users, wipe each other's leases and double the load on stage.
  const otherRun = runLockOwner();
  if (otherRun && otherRun !== process.pid && isRunning(otherRun)) {
    throw new Error(`Another test run (process ${otherRun}) is still running. Wait for it to finish, or stop it, before starting a new run.`);
  }
  // Leases left behind by an interrupted run would otherwise keep those users and line items locked forever.
  fs.rmSync(LEASE_DIR, { recursive: true, force: true });
  fs.mkdirSync(LEASE_DIR, { recursive: true });
  fs.writeFileSync(RUN_LOCK, String(process.pid));

  const poolPrefix = process.env.TEST_USER_POOL_PREFIX;
  const vaultUrl = process.env.KEY_VAULT_URL;
  if (!poolPrefix || !vaultUrl) {
    throw new Error('TEST_USER_POOL_PREFIX and KEY_VAULT_URL must be set in .env to load test users from Azure Key Vault.');
  }
  const domain = process.env.TEST_USER_POOL_DOMAIN ?? 'hamptonlumber.com';
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  const vaultError = (error: unknown) =>
    new Error(
      `Could not read test users from ${vaultUrl}. Run "az login --tenant <Hampton Lumber tenant>" and check you can read secrets in this vault.\n${error}`,
    );

  const secretPattern = new RegExp(`^${poolPrefix}(\\d+)-password$`);
  const poolNumbers: number[] = [];
  try {
    for await (const secret of client.listPropertiesOfSecrets()) {
      const match = secretPattern.exec(secret.name);
      if (match && secret.enabled !== false) {
        poolNumbers.push(Number(match[1]));
      }
    }
  } catch (error) {
    throw vaultError(error);
  }
  poolNumbers.sort((a, b) => a - b);

  const pool: TestUser[] = await Promise.all(
    poolNumbers.map(async n => {
      try {
        const secret = await client.getSecret(`${poolPrefix}${n}-password`);
        return { username: `${poolPrefix}${n}@${domain}`, password: secret.value ?? '' };
      } catch (error) {
        throw vaultError(error);
      }
    }),
  );
  if (pool.length === 0) {
    throw new Error(`No "${poolPrefix}<number>-password" secrets found in ${vaultUrl}.`);
  }
  process.env.TEST_USER_POOL = JSON.stringify(pool);
  console.log(`Loaded ${pool.length} pooled test users from Key Vault.`);
}
