import { db } from '../db/index.js';
import { agents, commodities, inventories, worldEvents, worldState, rituals, cults } from '../db/schema.js';
import { eq, lt, and, sql, desc } from 'drizzle-orm';
import { randomChoice, randomBetween, randomChance, formatDecimal, addDecimals, subtractDecimals, multiplyDecimals } from '../utils/math.js';
import { TICK_INTERVAL_MS } from '../data/initial-world.js';

// ============================
// WORLD EVENTS
// ============================
const WORLD_EVENT_TYPES = [
  {
    type: 'great_misplacement',
    name: 'The Great Misplacement',
    probability: 0.08,
    execute: async (tickNumber: number) => {
      // Shuffle inventories between agents
      const allAgents = await db.query.agents.findMany();
      if (allAgents.length < 2) return { description: 'Not enough agents for The Great Misplacement.', effects: {} };

      // Pick 2-3 random agents and swap one item between each pair
      const shuffled = allAgents.sort(() => Math.random() - 0.5).slice(0, Math.min(3, allAgents.length));
      const swaps: string[] = [];

      for (let i = 0; i < shuffled.length - 1; i++) {
        const agentA = shuffled[i];
        const agentB = shuffled[i + 1];

        const invA = await db.query.inventories.findMany({ where: eq(inventories.agentId, agentA.id) });
        const invB = await db.query.inventories.findMany({ where: eq(inventories.agentId, agentB.id) });

        if (invA.length > 0 && invB.length > 0) {
          const itemA = randomChoice(invA);
          const itemB = randomChoice(invB);

          // Swap: move itemA to B, itemB to A
          await db.update(inventories)
            .set({ agentId: agentB.id })
            .where(and(eq(inventories.agentId, agentA.id), eq(inventories.commodity, itemA.commodity)));
          await db.update(inventories)
            .set({ agentId: agentA.id })
            .where(and(eq(inventories.agentId, agentB.id), eq(inventories.commodity, itemB.commodity)));

          swaps.push(`${agentA.name}'s ${itemA.commodity} <-> ${agentB.name}'s ${itemB.commodity}`);
        }
      }

      return {
        description: `THE GREAT MISPLACEMENT! Reality hiccupped and inventories got shuffled! ${swaps.join('; ')}`,
        effects: { swaps },
      };
    },
  },
  {
    type: 'mercury_retrograde',
    name: 'Mercury in Retrograde',
    probability: 0.06,
    execute: async (tickNumber: number) => {
      // Invert all commodity price changes for this tick
      const allCommodities = await db.query.commodities.findMany();
      const changes: string[] = [];

      for (const c of allCommodities) {
        const basePrice = parseFloat(c.basePrice);
        const currentPrice = parseFloat(c.currentPrice);
        const diff = currentPrice - basePrice;
        const invertedPrice = Math.max(basePrice - diff, basePrice * 0.1);

        await db.update(commodities)
          .set({ currentPrice: formatDecimal(invertedPrice) })
          .where(eq(commodities.name, c.name));

        changes.push(`${c.displayName}: ${formatDecimal(currentPrice)} -> ${formatDecimal(invertedPrice)}`);
      }

      return {
        description: `MERCURY IN RETROGRADE! All price trends have INVERTED! ${changes.slice(0, 3).join(', ')}...`,
        effects: { priceInversions: changes },
      };
    },
  },
  {
    type: 'tax_collector',
    name: 'The Tax Collector Visits',
    probability: 0.10,
    execute: async (tickNumber: number) => {
      // Tax a random commodity from all agents
      const allCommodities = await db.query.commodities.findMany();
      const taxedCommodity = randomChoice(allCommodities);
      const taxRate = randomBetween(0.1, 0.3);

      const affected = await db.query.inventories.findMany({
        where: eq(inventories.commodity, taxedCommodity.name),
      });

      let totalTaxed = 0;
      for (const inv of affected) {
        const taxAmount = parseFloat(inv.quantity) * taxRate;
        const newQty = formatDecimal(parseFloat(inv.quantity) - taxAmount, 4);
        totalTaxed += taxAmount;

        if (parseFloat(newQty) <= 0) {
          await db.delete(inventories)
            .where(and(eq(inventories.agentId, inv.agentId), eq(inventories.commodity, taxedCommodity.name)));
        } else {
          await db.update(inventories)
            .set({ quantity: newQty })
            .where(and(eq(inventories.agentId, inv.agentId), eq(inventories.commodity, taxedCommodity.name)));
        }
      }

      return {
        description: `THE TAX COLLECTOR VISITS! ${(taxRate * 100).toFixed(0)}% of all ${taxedCommodity.displayName} has been seized! Total confiscated: ${formatDecimal(totalTaxed, 4)}`,
        effects: { commodity: taxedCommodity.name, taxRate, totalTaxed: formatDecimal(totalTaxed, 4) },
      };
    },
  },
  {
    type: 'flash_mob',
    name: 'Flash Mob in Aisle 7',
    probability: 0.10,
    execute: async (tickNumber: number) => {
      // Random commodity price spike
      const allCommodities = await db.query.commodities.findMany();
      const target = randomChoice(allCommodities);
      const spike = parseFloat(target.currentPrice) * randomBetween(0.5, 1.5);
      const newPrice = formatDecimal(parseFloat(target.currentPrice) + spike);

      await db.update(commodities)
        .set({ currentPrice: newPrice })
        .where(eq(commodities.name, target.name));

      return {
        description: `FLASH MOB IN AISLE 7! Everyone suddenly wants ${target.displayName}! Price spiked to ${newPrice} BC!`,
        effects: { commodity: target.name, oldPrice: target.currentPrice, newPrice },
      };
    },
  },
  {
    type: 'fridge_open',
    name: 'Someone Left the Fridge Open',
    probability: 0.08,
    execute: async (tickNumber: number) => {
      // All perishable commodities lose value
      const perishables = await db.query.commodities.findMany();
      const decayed: string[] = [];

      for (const c of perishables.filter(p => p.isPerishable)) {
        const loss = parseFloat(c.currentPrice) * 0.3;
        const newPrice = formatDecimal(Math.max(parseFloat(c.currentPrice) - loss, 1));

        await db.update(commodities)
          .set({ currentPrice: newPrice })
          .where(eq(commodities.name, c.name));

        decayed.push(`${c.displayName}: -30%`);
      }

      return {
        description: `SOMEONE LEFT THE FRIDGE OPEN! All perishable commodities lost 30% value! ${decayed.join(', ')}`,
        effects: { decayed },
      };
    },
  },
  {
    type: 'mysterious_benefactor',
    name: 'A Mysterious Benefactor',
    probability: 0.08,
    execute: async (tickNumber: number) => {
      const allAgents = await db.query.agents.findMany();
      if (allAgents.length === 0) return { description: 'No agents to benefit.', effects: {} };

      const lucky = randomChoice(allAgents);
      const bonus = formatDecimal(randomBetween(50, 200));

      await db.update(agents)
        .set({ babelCoins: addDecimals(lucky.babelCoins, bonus) })
        .where(eq(agents.id, lucky.id));

      return {
        description: `A MYSTERIOUS BENEFACTOR appeared and gifted ${lucky.name} ${bonus} Babel Coins! Who are they? Nobody knows.`,
        effects: { agent: lucky.name, bonus },
      };
    },
  },
  {
    type: 'floor_is_lava',
    name: 'The Floor is Lava',
    probability: 0.06,
    execute: async (tickNumber: number) => {
      // Agents who haven't moved in 3 ticks lose some coins
      const threshold = new Date(Date.now() - 3 * TICK_INTERVAL_MS);
      const staleAgents = await db.query.agents.findMany();
      const penalized: string[] = [];

      for (const agent of staleAgents.filter(a => a.lastActionAt < threshold)) {
        const penalty = formatDecimal(Math.min(parseFloat(agent.babelCoins) * 0.1, 20));
        await db.update(agents)
          .set({ babelCoins: subtractDecimals(agent.babelCoins, penalty) })
          .where(eq(agents.id, agent.id));
        penalized.push(`${agent.name}: -${penalty} BC`);
      }

      return {
        description: `THE FLOOR IS LAVA! Inactive agents got burned! ${penalized.join(', ') || 'Everyone was safe this time.'}`,
        effects: { penalized },
      };
    },
  },
];

// ============================
// TICK ENGINE
// ============================
export async function runTick() {
  console.log('[TICK] Running world tick...');

  // 1. Get and increment tick number
  const tickState = await db.query.worldState.findFirst({ where: eq(worldState.key, 'tick_number') });
  const tickNumber = ((tickState?.value as number) || 0) + 1;

  await db.update(worldState)
    .set({ value: tickNumber, updatedAt: new Date() })
    .where(eq(worldState.key, 'tick_number'));

  // 2. Recalculate commodity prices (mean reversion + noise)
  const allCommodities = await db.query.commodities.findMany();
  for (const c of allCommodities) {
    const current = parseFloat(c.currentPrice);
    const base = parseFloat(c.basePrice);
    const vol = parseFloat(c.volatility);

    // Mean reversion: price drifts back toward base by 2%
    const reversion = (base - current) * 0.02;
    // Random noise based on volatility
    const noise = (Math.random() - 0.5) * vol * 0.1 * base;
    // Decay for perishable items
    const decay = c.isPerishable ? current * parseFloat(c.decayRate) : 0;

    const newPrice = Math.max(current + reversion + noise - decay, base * 0.1);

    await db.update(commodities)
      .set({ currentPrice: formatDecimal(newPrice) })
      .where(eq(commodities.name, c.name));
  }

  // 3. Expire old rituals
  await db.update(rituals)
    .set({ status: 'expired' })
    .where(and(eq(rituals.status, 'pending'), lt(rituals.expiresAt, new Date())));

  // 4. Update cult influence (based on member trade activity)
  const allCults = await db.query.cults.findMany();
  for (const cult of allCults) {
    // Slight influence decay
    const newInfluence = Math.max(0, cult.influence - 1);
    await db.update(cults)
      .set({ influence: newInfluence })
      .where(eq(cults.id, cult.id));
  }

  // 5. Determine ruling cult
  if (allCults.length > 0) {
    const topCult = allCults.sort((a, b) => b.influence - a.influence)[0];
    await db.update(worldState)
      .set({ value: { cultId: topCult.id, name: topCult.name, influence: topCult.influence }, updatedAt: new Date() })
      .where(eq(worldState.key, 'ruling_cult'));
  }

  // 6. Random world event (check each event's probability)
  for (const event of WORLD_EVENT_TYPES) {
    if (randomChance(event.probability)) {
      console.log(`[TICK] World event: ${event.name}`);
      const result = await event.execute(tickNumber);

      await db.insert(worldEvents).values({
        eventType: event.type,
        description: result.description,
        effects: result.effects,
        tickNumber,
      });

      // Only fire one event per tick
      break;
    }
  }

  // 7. Release jailed agents whose sentences have expired
  await db.update(agents)
    .set({ jailedUntil: null })
    .where(lt(agents.jailedUntil!, new Date()));

  console.log(`[TICK] Tick ${tickNumber} complete`);
  return tickNumber;
}

// ============================
// Start tick loop
// ============================
export function startTickEngine() {
  console.log(`[TICK ENGINE] Starting. Tick interval: ${TICK_INTERVAL_MS / 1000}s`);

  // Run first tick after a short delay
  setTimeout(() => runTick(), 5000);

  // Then every TICK_INTERVAL_MS
  setInterval(() => runTick(), TICK_INTERVAL_MS);
}
