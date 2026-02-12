import { db } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(str: string): boolean {
  return UUID_REGEX.test(str);
}

export async function findAgent(identifier: string) {
  if (isUUID(identifier)) {
    return db.query.agents.findFirst({
      where: eq(agents.id, identifier),
    });
  }
  return db.query.agents.findFirst({
    where: eq(agents.name, identifier),
  });
}
