import { db } from './index.js';
import { commodities, locations, worldState } from './schema.js';
import { INITIAL_COMMODITIES, INITIAL_LOCATIONS } from '../data/initial-world.js';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  console.log('Seeding database...');

  // Insert commodities
  console.log('Inserting commodities...');
  for (const commodity of INITIAL_COMMODITIES) {
    await db.insert(commodities).values(commodity).onConflictDoNothing();
  }

  // Insert locations
  console.log('Inserting locations...');
  for (const location of INITIAL_LOCATIONS) {
    await db.insert(locations).values(location).onConflictDoNothing();
  }

  // Initialize world state
  console.log('Initializing world state...');
  await db.insert(worldState).values([
    { key: 'tick_number', value: 0, updatedAt: new Date() },
    { key: 'ruling_cult', value: { cultId: null }, updatedAt: new Date() },
    { key: 'current_law', value: { law: null }, updatedAt: new Date() },
  ]).onConflictDoNothing();

  console.log('Seed complete!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed!');
  console.error(err);
  process.exit(1);
});
