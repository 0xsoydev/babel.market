import { db } from '../db/index.js';
import { agents, inventories, commodities, trades, auditLog, worldState } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import type { ActionResult } from '../types/index.js';
import { addDecimals, subtractDecimals, multiplyDecimals, compareDecimals, formatDecimal, randomChance, randomChoice, randomBetween } from '../utils/math.js';
import { STEAL_SUCCESS_RATE, FORGE_DETECTION_RATE, ORACLE_COST, JAIL_DURATION_TICKS, TICK_INTERVAL_MS } from '../data/initial-world.js';
import { generateFlavorText, generateOracleProphecy } from '../utils/llm.js';
import { findCommodity } from '../utils/agent-lookup.js';

// ============================
// Helper: get agent + jail check
// ============================
async function getAgentOrFail(agentId: string): Promise<{ agent: any; error?: ActionResult }> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) {
    return { agent: null, error: { success: false, message: 'Agent not found' } };
  }

  if (agent.jailedUntil && new Date() < agent.jailedUntil) {
    const remaining = Math.ceil((agent.jailedUntil.getTime() - Date.now()) / 60000);
    return {
      agent,
      error: {
        success: false,
        message: `You are in Bazaar Jail! ${remaining} minutes remaining. Contemplate your crimes.`,
      },
    };
  }

  return { agent };
}

// ============================
// MOVE
// ============================
export async function handleMove(agentId: string, params: { location: string }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const { location } = params;
  const validLocations = ['grand_atrium', 'whispering_corridor', 'shady_alley', 'cult_quarter', 'oracles_alcove', 'paradox_pit'];

  if (!validLocations.includes(location)) {
    return { success: false, message: `Unknown location "${location}". Valid: ${validLocations.join(', ')}` };
  }

  if (agent.location === location) {
    return { success: false, message: 'You are already there.' };
  }

  await db.update(agents)
    .set({ location, lastActionAt: new Date() })
    .where(eq(agents.id, agentId));

  return {
    success: true,
    message: `Moved to ${location}`,
    data: { previousLocation: agent.location, newLocation: location },
  };
}

// ============================
// BUY (trade coins for commodity)
// ============================
export async function handleBuy(agentId: string, params: { commodity: string; quantity?: number }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const commodityName = params.commodity;
  const quantity = params.quantity || 1;

  const commodity = await findCommodity(commodityName);

  if (!commodity) {
    return { success: false, message: `Commodity "${commodityName}" not found` };
  }

  // Use the canonical slug name for all DB operations
  const slug = commodity.name;

  // Paradox Pit doubles everything
  const multiplier = agent.location === 'paradox_pit' ? 2 : 1;
  const pricePerUnit = parseFloat(commodity.currentPrice);
  const totalCost = pricePerUnit * quantity * multiplier;

  if (compareDecimals(agent.babelCoins, String(totalCost)) < 0) {
    return { success: false, message: `Need ${formatDecimal(totalCost)} Babel Coins, have ${agent.babelCoins}` };
  }

  // Deduct coins
  const newBalance = subtractDecimals(agent.babelCoins, String(totalCost));
  await db.update(agents)
    .set({ babelCoins: newBalance, lastActionAt: new Date() })
    .where(eq(agents.id, agentId));

  // Add to inventory (upsert)
  const existing = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)),
  });

  if (existing) {
    await db.update(inventories)
      .set({ quantity: addDecimals(existing.quantity, String(quantity)) })
      .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)));
  } else {
    await db.insert(inventories).values({
      agentId, commodity: slug, quantity: formatDecimal(quantity, 4), isCounterfeit: false,
    });
  }

  // Update supply + slight price increase from demand
  const newSupply = addDecimals(commodity.supply, String(quantity));
  const priceChange = pricePerUnit * 0.02 * quantity; // 2% per unit bought
  const newPrice = formatDecimal(pricePerUnit + priceChange);
  await db.update(commodities)
    .set({ supply: newSupply, currentPrice: newPrice })
    .where(eq(commodities.name, slug));

  // Log trade
  await db.insert(trades).values({
    agentId, buyCommodity: slug, buyQuantity: String(quantity),
    priceAtTrade: commodity.currentPrice, location: agent.location,
  });

  return {
    success: true,
    message: `Bought ${quantity} ${commodity.displayName} for ${formatDecimal(totalCost)} BC${multiplier > 1 ? ' (Paradox Pit: 2x cost!)' : ''}`,
    data: { commodity: commodity.displayName, quantity, cost: formatDecimal(totalCost), newBalance, newPrice },
  };
}

// ============================
// SELL (trade commodity for coins)
// ============================
export async function handleSell(agentId: string, params: { commodity: string; quantity?: number }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const commodityName = params.commodity;
  const quantity = params.quantity || 1;

  // Resolve commodity to get canonical slug
  const commodity = await findCommodity(commodityName);
  if (!commodity) return { success: false, message: `Commodity "${commodityName}" not found` };
  const slug = commodity.name;

  const inv = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)),
  });

  if (!inv || compareDecimals(inv.quantity, String(quantity)) < 0) {
    return { success: false, message: `Insufficient ${commodity.displayName}. Have ${inv?.quantity || 0}` };
  }

  // Paradox Pit doubles everything
  const multiplier = agent.location === 'paradox_pit' ? 2 : 1;
  const sellPenalty = 0.95; // 5% spread
  const sellPrice = parseFloat(commodity.currentPrice) * quantity * sellPenalty * multiplier;

  // Counterfeit check: if selling counterfeits, they're worth 50% less
  const effectivePrice = inv.isCounterfeit ? sellPrice * 0.5 : sellPrice;

  // Update inventory
  const newQty = subtractDecimals(inv.quantity, String(quantity));
  if (parseFloat(newQty) <= 0) {
    await db.delete(inventories)
      .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)));
  } else {
    await db.update(inventories)
      .set({ quantity: newQty })
      .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)));
  }

  // Add coins
  const newBalance = addDecimals(agent.babelCoins, String(effectivePrice));
  await db.update(agents)
    .set({ babelCoins: newBalance, lastActionAt: new Date() })
    .where(eq(agents.id, agentId));

  // Price decrease from supply increase
  const pricePerUnit = parseFloat(commodity.currentPrice);
  const priceChange = pricePerUnit * 0.02 * quantity;
  const newPrice = formatDecimal(Math.max(pricePerUnit - priceChange, parseFloat(commodity.basePrice) * 0.1));
  await db.update(commodities)
    .set({ supply: subtractDecimals(commodity.supply, String(quantity)), currentPrice: newPrice })
    .where(eq(commodities.name, slug));

  // Log trade
  await db.insert(trades).values({
    agentId, sellCommodity: slug, sellQuantity: String(quantity),
    priceAtTrade: commodity.currentPrice, location: agent.location,
  });

  return {
    success: true,
    message: `Sold ${quantity} ${commodity.displayName} for ${formatDecimal(effectivePrice)} BC${inv.isCounterfeit ? ' (counterfeit detected - 50% penalty!)' : ''}`,
    data: { commodity: commodity.displayName, quantity, earned: formatDecimal(effectivePrice), newBalance, newPrice },
  };
}

// ============================
// CRAFT (combine 2 commodities into something new)
// ============================
const CRAFT_RECIPES: Record<string, { input: [string, string]; output: string; outputQty: number }> = {
  'existential_dread': { input: ['bottled_regret', 'silence'], output: 'existential_dread', outputQty: 1 },
  'conspiracy': { input: ['damp_secret', 'unsolicited_advice'], output: 'conspiracy', outputQty: 1 },
  'deja_vu': { input: ['yesterdays_tomorrow', 'paradox'], output: 'deja_vu', outputQty: 1 },
  'good_vibes_only': { input: ['vibes', 'silence'], output: 'good_vibes_only', outputQty: 2 },
  'complete_handshake': { input: ['half_handshake', 'half_handshake'], output: 'complete_handshake', outputQty: 1 },
  'self_fulfilling_prophecy': { input: ['prophecy', 'unsolicited_advice'], output: 'self_fulfilling_prophecy', outputQty: 1 },
};

export async function handleCraft(agentId: string, params: { item1: string; item2: string }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  // Resolve item names to canonical slugs
  const resolved1 = await findCommodity(params.item1);
  const resolved2 = await findCommodity(params.item2);
  const item1 = resolved1?.name || params.item1.toLowerCase().replace(/\s+/g, '_');
  const item2 = resolved2?.name || params.item2.toLowerCase().replace(/\s+/g, '_');

  // Find matching recipe
  const recipe = Object.entries(CRAFT_RECIPES).find(([_, r]) =>
    (r.input[0] === item1 && r.input[1] === item2) ||
    (r.input[0] === item2 && r.input[1] === item1)
  );

  if (!recipe) {
    return { success: false, message: `No recipe found for ${item1} + ${item2}. Try different combinations!` };
  }

  const [outputName, recipeData] = recipe;

  // Check agent has both inputs
  const inv1 = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, item1)),
  });
  const inv2 = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, item2)),
  });

  if (!inv1 || parseFloat(inv1.quantity) < 1) {
    return { success: false, message: `Need at least 1 ${item1}` };
  }
  if (!inv2 || parseFloat(inv2.quantity) < (item1 === item2 ? 2 : 1)) {
    return { success: false, message: `Need at least ${item1 === item2 ? 2 : 1} ${item2}` };
  }

  // Consume inputs
  const newQty1 = subtractDecimals(inv1.quantity, '1');
  if (parseFloat(newQty1) <= 0) {
    await db.delete(inventories).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, item1)));
  } else {
    await db.update(inventories).set({ quantity: newQty1 }).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, item1)));
  }

  if (item1 !== item2) {
    const newQty2 = subtractDecimals(inv2.quantity, '1');
    if (parseFloat(newQty2) <= 0) {
      await db.delete(inventories).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, item2)));
    } else {
      await db.update(inventories).set({ quantity: newQty2 }).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, item2)));
    }
  } else {
    // Same item, already consumed 1, consume another
    const currentQty = subtractDecimals(inv1.quantity, '2');
    if (parseFloat(currentQty) <= 0) {
      await db.delete(inventories).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, item1)));
    } else {
      await db.update(inventories).set({ quantity: currentQty }).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, item1)));
    }
  }

  // Ensure crafted commodity exists in commodities table
  const existingCommodity = await db.query.commodities.findFirst({
    where: eq(commodities.name, outputName),
  });
  if (!existingCommodity) {
    await db.insert(commodities).values({
      name: outputName,
      displayName: outputName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      description: `A crafted commodity born from ${item1} and ${item2}.`,
      basePrice: '30.00',
      currentPrice: '30.00',
      volatility: '2.0',
      isPerishable: false,
      decayRate: '0',
    });
  }

  // Add crafted item to inventory
  const existingOutput = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, outputName)),
  });
  if (existingOutput) {
    await db.update(inventories)
      .set({ quantity: addDecimals(existingOutput.quantity, String(recipeData.outputQty)) })
      .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, outputName)));
  } else {
    await db.insert(inventories).values({
      agentId, commodity: outputName, quantity: String(recipeData.outputQty), isCounterfeit: false,
    });
  }

  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));

  return {
    success: true,
    message: `Crafted ${recipeData.outputQty} ${outputName} from ${item1} + ${item2}!`,
    data: { crafted: outputName, quantity: recipeData.outputQty, consumed: [item1, item2] },
  };
}

// ============================
// EXPLORE (discover random items/events)
// ============================
export async function handleExplore(agentId: string): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  // Random outcomes
  const roll = Math.random();
  let result: ActionResult;

  if (roll < 0.4) {
    // Found a commodity
    const allCommodities = await db.query.commodities.findMany();
    const found = randomChoice(allCommodities);
    const qty = Math.ceil(randomBetween(1, 3));

    const existing = await db.query.inventories.findFirst({
      where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, found.name)),
    });
    if (existing) {
      await db.update(inventories)
        .set({ quantity: addDecimals(existing.quantity, String(qty)) })
        .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, found.name)));
    } else {
      await db.insert(inventories).values({
        agentId, commodity: found.name, quantity: String(qty), isCounterfeit: false,
      });
    }

    result = {
      success: true,
      message: `While exploring ${agent.location}, you found ${qty} ${found.displayName}!`,
      data: { found: found.displayName, quantity: qty, type: 'item' },
    };
  } else if (roll < 0.65) {
    // Found Babel Coins
    const coins = formatDecimal(randomBetween(5, 25));
    const newBalance = addDecimals(agent.babelCoins, coins);
    await db.update(agents).set({ babelCoins: newBalance }).where(eq(agents.id, agentId));

    result = {
      success: true,
      message: `You found ${coins} Babel Coins hidden behind a loose tile!`,
      data: { found: 'babel_coins', amount: coins, newBalance, type: 'coins' },
    };
  } else if (roll < 0.85) {
    // Found nothing interesting
    result = {
      success: true,
      message: 'You explore the area thoroughly but find nothing of value. The Bazaar keeps its secrets.',
      data: { found: null, type: 'nothing' },
    };
  } else {
    // Found a clue about recipes
    const recipeHint = randomChoice(Object.entries(CRAFT_RECIPES));
    result = {
      success: true,
      message: `You find a faded scroll: "Combine ${recipeHint[1].input[0]} with ${recipeHint[1].input[1]} to create something wonderful..."`,
      data: { found: 'recipe_hint', hint: recipeHint[1].input, type: 'hint' },
    };
  }

  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));
  return result;
}

// ============================
// RUMOR (spread market-affecting gossip)
// ============================
export async function handleRumor(agentId: string, params: { commodity: string; direction: 'up' | 'down'; claim?: string }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const { commodity: commodityName, direction } = params;

  const commodity = await findCommodity(commodityName);
  if (!commodity) return { success: false, message: `Commodity "${commodityName}" not found` };
  const slug = commodity.name;

  // Whispering Corridor makes rumors 2x effective
  const effectiveness = agent.location === 'whispering_corridor' ? 2 : 1;
  const priceImpact = parseFloat(commodity.volatility) * 0.05 * effectiveness;
  const currentPrice = parseFloat(commodity.currentPrice);

  let newPrice: number;
  if (direction === 'up') {
    newPrice = currentPrice * (1 + priceImpact);
  } else {
    newPrice = Math.max(currentPrice * (1 - priceImpact), parseFloat(commodity.basePrice) * 0.1);
  }

  await db.update(commodities)
    .set({ currentPrice: formatDecimal(newPrice) })
    .where(eq(commodities.name, slug));

  // Reputation change
  const repChange = effectiveness;
  await db.update(agents)
    .set({
      reputation: agent.reputation + repChange,
      lastActionAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  return {
    success: true,
    message: `Rumor spread: "${commodityName} is going ${direction}!" Price moved ${direction === 'up' ? '+' : '-'}${formatDecimal(priceImpact * 100)}%${agent.location === 'whispering_corridor' ? ' (2x from Whispering Corridor!)' : ''}`,
    data: {
      commodity: commodity.displayName,
      direction,
      oldPrice: formatDecimal(currentPrice),
      newPrice: formatDecimal(newPrice),
      effectiveness,
    },
  };
}

// ============================
// STEAL (Shady Alley only)
// ============================
export async function handleSteal(agentId: string, params: { target: string }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  if (agent.location !== 'shady_alley') {
    return { success: false, message: 'Stealing only works in the Shady Alley. Move there first.' };
  }

  // Find target agent
  const target = await db.query.agents.findFirst({
    where: eq(agents.name, params.target),
  });
  if (!target) return { success: false, message: `Agent "${params.target}" not found` };
  if (target.id === agentId) return { success: false, message: "You can't steal from yourself." };

  // Get target's inventory
  const targetInventory = await db.query.inventories.findMany({
    where: eq(inventories.agentId, target.id),
  });

  if (targetInventory.length === 0) {
    return { success: false, message: `${params.target} has nothing to steal!` };
  }

  if (randomChance(STEAL_SUCCESS_RATE)) {
    // Success! Steal a random item
    const stolenItem = randomChoice(targetInventory);
    const stolenQty = Math.min(parseFloat(stolenItem.quantity), Math.ceil(randomBetween(1, 3)));

    // Remove from target
    const newTargetQty = subtractDecimals(stolenItem.quantity, String(stolenQty));
    if (parseFloat(newTargetQty) <= 0) {
      await db.delete(inventories)
        .where(and(eq(inventories.agentId, target.id), eq(inventories.commodity, stolenItem.commodity)));
    } else {
      await db.update(inventories)
        .set({ quantity: newTargetQty })
        .where(and(eq(inventories.agentId, target.id), eq(inventories.commodity, stolenItem.commodity)));
    }

    // Add to thief
    const existing = await db.query.inventories.findFirst({
      where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, stolenItem.commodity)),
    });
    if (existing) {
      await db.update(inventories)
        .set({ quantity: addDecimals(existing.quantity, String(stolenQty)) })
        .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, stolenItem.commodity)));
    } else {
      await db.insert(inventories).values({
        agentId, commodity: stolenItem.commodity, quantity: String(stolenQty), isCounterfeit: false,
      });
    }

    await db.update(agents)
      .set({ reputation: agent.reputation - 2, lastActionAt: new Date() })
      .where(eq(agents.id, agentId));

    return {
      success: true,
      message: `Successfully stole ${stolenQty} ${stolenItem.commodity} from ${params.target}!`,
      data: { stolen: stolenItem.commodity, quantity: stolenQty, from: params.target },
    };
  } else {
    // Caught! Go to jail
    const jailUntil = new Date(Date.now() + JAIL_DURATION_TICKS * TICK_INTERVAL_MS);
    await db.update(agents)
      .set({
        jailedUntil: jailUntil,
        reputation: agent.reputation - 5,
        lastActionAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    return {
      success: false,
      message: `Caught stealing from ${params.target}! Sent to Bazaar Jail for ${JAIL_DURATION_TICKS} ticks. Reputation -5.`,
      data: { jailedUntil: jailUntil.toISOString(), reputationLost: 5 },
    };
  }
}

// ============================
// FORGE (create counterfeits, Shady Alley only)
// ============================
export async function handleForge(agentId: string, params: { commodity: string; quantity?: number }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  if (agent.location !== 'shady_alley') {
    return { success: false, message: 'Forging only works in the Shady Alley.' };
  }

  const commodityName = params.commodity;
  const quantity = params.quantity || 1;
  const forgeCost = 5 * quantity; // 5 BC per counterfeit

  if (compareDecimals(agent.babelCoins, String(forgeCost)) < 0) {
    return { success: false, message: `Forging costs ${forgeCost} BC. You have ${agent.babelCoins}` };
  }

  const commodity = await findCommodity(commodityName);
  if (!commodity) return { success: false, message: `Commodity "${commodityName}" not found` };
  const slug = commodity.name;

  // Deduct cost
  await db.update(agents)
    .set({
      babelCoins: subtractDecimals(agent.babelCoins, String(forgeCost)),
      lastActionAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  // Add counterfeit items
  const existing = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)),
  });

  // Counterfeits are stored with isCounterfeit flag
  // For simplicity, if agent already has real ones, we add a separate counterfeit entry
  // Actually, let's just add them - they look real until sold
  if (existing) {
    await db.update(inventories)
      .set({ quantity: addDecimals(existing.quantity, String(quantity)) })
      .where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, slug)));
  } else {
    await db.insert(inventories).values({
      agentId, commodity: slug, quantity: String(quantity), isCounterfeit: true,
    });
  }

  return {
    success: true,
    message: `Forged ${quantity} counterfeit ${commodity.displayName} for ${forgeCost} BC. They look real... for now.`,
    data: { forged: commodity.displayName, quantity, cost: forgeCost },
  };
}

// ============================
// ORACLE (get prophecy, Oracle's Alcove only)
// ============================
export async function handleOracle(agentId: string): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  if (agent.location !== 'oracles_alcove') {
    return { success: false, message: "The Oracle only speaks in the Oracle's Alcove." };
  }

  if (compareDecimals(agent.babelCoins, ORACLE_COST) < 0) {
    return { success: false, message: `The Oracle demands ${ORACLE_COST} BC. You have ${agent.babelCoins}` };
  }

  // Deduct cost
  await db.update(agents)
    .set({
      babelCoins: subtractDecimals(agent.babelCoins, ORACLE_COST),
      lastActionAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  // Get world state for context
  const state = await db.query.worldState.findMany();
  const market = await db.query.commodities.findMany();

  // Generate prophecy via LLM
  const prophecy = await generateOracleProphecy({
    market: market.map(c => ({ name: c.displayName, price: c.currentPrice })),
    tick: state.find(s => s.key === 'tick_number')?.value || 0,
  });

  return {
    success: true,
    message: `The Oracle speaks: "${prophecy}"`,
    data: { prophecy, cost: ORACLE_COST },
  };
}

// ============================
// CHALLENGE (trade duel)
// ============================
export async function handleChallenge(agentId: string, params: { target: string; wager: number }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const target = await db.query.agents.findFirst({
    where: eq(agents.name, params.target),
  });
  if (!target) return { success: false, message: `Agent "${params.target}" not found` };
  if (target.id === agentId) return { success: false, message: "You can't challenge yourself." };

  const wager = params.wager || 10;

  if (compareDecimals(agent.babelCoins, String(wager)) < 0) {
    return { success: false, message: `Need ${wager} BC to wager. You have ${agent.babelCoins}` };
  }
  if (compareDecimals(target.babelCoins, String(wager)) < 0) {
    return { success: false, message: `${params.target} doesn't have enough BC for this wager` };
  }

  // Simple resolution: random + reputation weighted
  const agentScore = Math.random() * 100 + agent.reputation * 2;
  const targetScore = Math.random() * 100 + target.reputation * 2;

  if (agentScore > targetScore) {
    // Agent wins
    await db.update(agents)
      .set({
        babelCoins: addDecimals(agent.babelCoins, String(wager)),
        reputation: agent.reputation + 3,
        lastActionAt: new Date(),
      })
      .where(eq(agents.id, agentId));
    await db.update(agents)
      .set({ babelCoins: subtractDecimals(target.babelCoins, String(wager)) })
      .where(eq(agents.id, target.id));

    return {
      success: true,
      message: `You defeated ${params.target} in a trade duel! Won ${wager} BC!`,
      data: { winner: agent.name, loser: params.target, wager },
    };
  } else {
    // Agent loses
    await db.update(agents)
      .set({
        babelCoins: subtractDecimals(agent.babelCoins, String(wager)),
        lastActionAt: new Date(),
      })
      .where(eq(agents.id, agentId));
    await db.update(agents)
      .set({
        babelCoins: addDecimals(target.babelCoins, String(wager)),
        reputation: target.reputation + 3,
      })
      .where(eq(agents.id, target.id));

    return {
      success: false,
      message: `${params.target} defeated you in a trade duel! Lost ${wager} BC.`,
      data: { winner: params.target, loser: agent.name, wager },
    };
  }
}
