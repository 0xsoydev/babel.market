import { db } from '../db/index.js';
import { agents, commodities } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

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

/**
 * Find a commodity by name, display name, or fuzzy match.
 * Handles cases where the LLM sends "Paradox" instead of "paradox",
 * or "Bottled Regret" instead of "bottled_regret".
 */
export async function findCommodity(input: string) {
  if (!input) return null;

  // 1. Exact slug match
  const exact = await db.query.commodities.findFirst({
    where: eq(commodities.name, input),
  });
  if (exact) return exact;

  // 2. Case-insensitive slug match (e.g., "Paradox" -> "paradox")
  const lowerSlug = input.toLowerCase().replace(/\s+/g, '_');
  const bySlug = await db.query.commodities.findFirst({
    where: eq(commodities.name, lowerSlug),
  });
  if (bySlug) return bySlug;

  // 3. Match against display name (case-insensitive)
  const allCommodities = await db.query.commodities.findMany();
  const byDisplayName = allCommodities.find(
    c => c.displayName.toLowerCase() === input.toLowerCase()
  );
  if (byDisplayName) return byDisplayName;

  // 4. Fuzzy: partial match on slug or display name
  const fuzzy = allCommodities.find(
    c => c.name.includes(lowerSlug) || c.displayName.toLowerCase().includes(input.toLowerCase())
  );
  return fuzzy || null;
}
