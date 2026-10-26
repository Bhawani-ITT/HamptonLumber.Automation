import fs from 'fs';
import path from 'path';

export function loadTestData<T>(fileName: string): T {
  const filePath = path.join(__dirname, '..', 'test-data', fileName);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}
