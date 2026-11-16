import { afterAll } from 'vitest';
import { disconnectTestDb } from './helpers';

afterAll(async () => {
  await disconnectTestDb();
});
