import { initDb, closeDb } from '../db/connection.js';
import { seedDatabase, curriculumCountsFromDb } from '../db/seed.js';
import { config } from '../config.js';

try {
  initDb(config.dbPath);
  const r = seedDatabase();
  console.log(`Seeded curriculum (checksum ${r.checksum.slice(0, 12)}…) into ${config.dbPath}`);
  console.log(curriculumCountsFromDb());
  console.log('Learner progress, transcripts and assessments were preserved (seeding is idempotent).');
  closeDb();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
