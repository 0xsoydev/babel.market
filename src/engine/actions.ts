import { db } from '../db/index.js';
import { agents, inventories, commodities, trades, auditLog, worldState, tradeOffers, messages } from '../db/schema.js';
import { eq, and, sql, isNull, gt } from 'drizzle-orm';
import type { ActionResult } from '../types/index.js';
import { addDecimals, subtractDecimals, multiplyDecimals, compareDecimals, formatDecimal, randomChance, randomChoice, randomBetween } from '../utils/math.js';
import { STEAL_SUCCESS_RATE, FORGE_DETECTION_RATE, ORACLE_COST, JAIL_DURATION_TICKS, TICK_INTERVAL_MS } from '../data/initial-world.js';
import { generateFlavorText, generateOracleProphecy } from '../utils/llm.js';
import { findCommodity } from '../utils/agent-lookup.js';

// ============================
// Helper: get current tick number
// ============================
async function getCurrentTick(): Promise<number> {
  const stateRow = await db.query.worldState.findFirst({
    where: eq(worldState.key, 'tick_number'),
  });
  return (stateRow?.value as number) || 0;
}

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

    // Update global supply - discovered items add to world supply
    const newSupply = addDecimals(found.supply, String(qty));
    await db.update(commodities)
      .set({ supply: newSupply })
      .where(eq(commodities.name, found.name));

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

// ============================
// OFFER (create a P2P trade offer)
// ============================
export async function handleOffer(agentId: string, params: {
  offerCommodity: string;
  offerQuantity: number;
  wantCommodity: string;
  wantQuantity: number;
  toAgent?: string;
}): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const { offerCommodity, offerQuantity, wantCommodity, wantQuantity, toAgent } = params;

  // Resolve commodities
  const offerComm = await findCommodity(offerCommodity);
  const wantComm = await findCommodity(wantCommodity);
  if (!offerComm) return { success: false, message: `Commodity "${offerCommodity}" not found` };
  if (!wantComm) return { success: false, message: `Commodity "${wantCommodity}" not found` };

  // Check agent has the offered commodity
  const inv = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, offerComm.name)),
  });
  if (!inv || parseFloat(inv.quantity) < offerQuantity) {
    return { success: false, message: `Insufficient ${offerComm.displayName}. Have ${inv?.quantity || 0}` };
  }

  // Find target agent if specified
  let targetAgentId: string | null = null;
  if (toAgent) {
    const target = await db.query.agents.findFirst({
      where: eq(agents.name, toAgent),
    });
    if (!target) return { success: false, message: `Agent "${toAgent}" not found` };
    if (target.id === agentId) return { success: false, message: "You can't trade with yourself" };
    targetAgentId = target.id;
  }

  // Create the trade offer (expires in 10 ticks)
  const expiresAt = new Date(Date.now() + 10 * 5 * 60 * 1000); // 10 ticks * 5 min
  const [offer] = await db.insert(tradeOffers).values({
    fromAgentId: agentId,
    toAgentId: targetAgentId,
    offerCommodity: offerComm.name,
    offerQuantity: String(offerQuantity),
    wantCommodity: wantComm.name,
    wantQuantity: String(wantQuantity),
    status: 'open',
    location: agent.location,
    expiresAt,
  }).returning();

  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));

  const targetStr = toAgent ? ` to ${toAgent}` : ' (open to all)';
  return {
    success: true,
    message: `Trade offer created${targetStr}: ${offerQuantity} ${offerComm.displayName} for ${wantQuantity} ${wantComm.displayName}`,
    data: {
      offerId: offer.id,
      offer: { commodity: offerComm.displayName, quantity: offerQuantity },
      want: { commodity: wantComm.displayName, quantity: wantQuantity },
      toAgent: toAgent || 'anyone',
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// ============================
// ACCEPT_OFFER (accept a P2P trade offer)
// ============================
export async function handleAcceptOffer(agentId: string, params: {
  offerId?: string;
  fromAgent?: string;
}): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  let offer: any;

  if (params.offerId) {
    // Accept specific offer by ID
    offer = await db.query.tradeOffers.findFirst({
      where: and(
        eq(tradeOffers.id, params.offerId),
        eq(tradeOffers.status, 'open'),
        gt(tradeOffers.expiresAt, new Date())
      ),
    });
  } else if (params.fromAgent) {
    // Find any open offer from this agent
    const fromAgentRecord = await db.query.agents.findFirst({
      where: eq(agents.name, params.fromAgent),
    });
    if (!fromAgentRecord) return { success: false, message: `Agent "${params.fromAgent}" not found` };

    offer = await db.query.tradeOffers.findFirst({
      where: and(
        eq(tradeOffers.fromAgentId, fromAgentRecord.id),
        eq(tradeOffers.status, 'open'),
        gt(tradeOffers.expiresAt, new Date())
      ),
    });
  } else {
    // Find any open offer available to this agent (targeted at them or open to all)
    const openOffers = await db.select().from(tradeOffers)
      .where(and(
        eq(tradeOffers.status, 'open'),
        gt(tradeOffers.expiresAt, new Date()),
        sql`(${tradeOffers.toAgentId} IS NULL OR ${tradeOffers.toAgentId} = ${agentId})`,
        sql`${tradeOffers.fromAgentId} != ${agentId}`
      ))
      .limit(1);
    offer = openOffers[0];
  }

  if (!offer) {
    return { success: false, message: 'No valid trade offer found' };
  }

  // Check if this agent can accept (is it for them or open?)
  if (offer.toAgentId && offer.toAgentId !== agentId) {
    return { success: false, message: 'This offer is not for you' };
  }

  // Get the offering agent
  const fromAgent = await db.query.agents.findFirst({
    where: eq(agents.id, offer.fromAgentId),
  });
  if (!fromAgent) return { success: false, message: 'Offering agent not found' };

  // Check this agent has what the offerer wants
  const acceptorInv = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, offer.wantCommodity)),
  });
  if (!acceptorInv || parseFloat(acceptorInv.quantity) < parseFloat(offer.wantQuantity)) {
    return { success: false, message: `Insufficient ${offer.wantCommodity}. Need ${offer.wantQuantity}, have ${acceptorInv?.quantity || 0}` };
  }

  // Check offerer still has what they offered
  const offererInv = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, offer.fromAgentId), eq(inventories.commodity, offer.offerCommodity)),
  });
  if (!offererInv || parseFloat(offererInv.quantity) < parseFloat(offer.offerQuantity)) {
    await db.update(tradeOffers).set({ status: 'cancelled' }).where(eq(tradeOffers.id, offer.id));
    return { success: false, message: `${fromAgent.name} no longer has the offered items` };
  }

  // Execute the trade!
  // 1. Remove from offerer, add to acceptor
  const newOffererQty = subtractDecimals(offererInv.quantity, offer.offerQuantity);
  if (parseFloat(newOffererQty) <= 0) {
    await db.delete(inventories).where(and(eq(inventories.agentId, offer.fromAgentId), eq(inventories.commodity, offer.offerCommodity)));
  } else {
    await db.update(inventories).set({ quantity: newOffererQty }).where(and(eq(inventories.agentId, offer.fromAgentId), eq(inventories.commodity, offer.offerCommodity)));
  }

  const acceptorExisting = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, agentId), eq(inventories.commodity, offer.offerCommodity)),
  });
  if (acceptorExisting) {
    await db.update(inventories).set({ quantity: addDecimals(acceptorExisting.quantity, offer.offerQuantity) }).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, offer.offerCommodity)));
  } else {
    await db.insert(inventories).values({ agentId, commodity: offer.offerCommodity, quantity: offer.offerQuantity, isCounterfeit: false });
  }

  // 2. Remove from acceptor, add to offerer
  const newAcceptorQty = subtractDecimals(acceptorInv.quantity, offer.wantQuantity);
  if (parseFloat(newAcceptorQty) <= 0) {
    await db.delete(inventories).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, offer.wantCommodity)));
  } else {
    await db.update(inventories).set({ quantity: newAcceptorQty }).where(and(eq(inventories.agentId, agentId), eq(inventories.commodity, offer.wantCommodity)));
  }

  const offererWantExisting = await db.query.inventories.findFirst({
    where: and(eq(inventories.agentId, offer.fromAgentId), eq(inventories.commodity, offer.wantCommodity)),
  });
  if (offererWantExisting) {
    await db.update(inventories).set({ quantity: addDecimals(offererWantExisting.quantity, offer.wantQuantity) }).where(and(eq(inventories.agentId, offer.fromAgentId), eq(inventories.commodity, offer.wantCommodity)));
  } else {
    await db.insert(inventories).values({ agentId: offer.fromAgentId, commodity: offer.wantCommodity, quantity: offer.wantQuantity, isCounterfeit: false });
  }

  // Mark offer as accepted
  await db.update(tradeOffers).set({ status: 'accepted', acceptedBy: agentId }).where(eq(tradeOffers.id, offer.id));

  // Update timestamps
  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));
  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, offer.fromAgentId));

  // Log the P2P trade
  await db.insert(trades).values({
    agentId: agentId,
    sellCommodity: offer.wantCommodity,
    sellQuantity: offer.wantQuantity,
    buyCommodity: offer.offerCommodity,
    buyQuantity: offer.offerQuantity,
    location: agent.location,
  });

  const offerComm = await findCommodity(offer.offerCommodity);
  const wantComm = await findCommodity(offer.wantCommodity);

  return {
    success: true,
    message: `Trade completed with ${fromAgent.name}! Received ${offer.offerQuantity} ${offerComm?.displayName || offer.offerCommodity}, gave ${offer.wantQuantity} ${wantComm?.displayName || offer.wantCommodity}`,
    data: {
      tradedWith: fromAgent.name,
      received: { commodity: offerComm?.displayName || offer.offerCommodity, quantity: offer.offerQuantity },
      gave: { commodity: wantComm?.displayName || offer.wantCommodity, quantity: offer.wantQuantity },
    },
  };
}

// ============================
// LIST_OFFERS (see available trade offers)
// ============================
export async function handleListOffers(agentId: string): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  // Get all open offers available to this agent
  const offers = await db.select().from(tradeOffers)
    .innerJoin(agents, eq(tradeOffers.fromAgentId, agents.id))
    .where(and(
      eq(tradeOffers.status, 'open'),
      gt(tradeOffers.expiresAt, new Date()),
      sql`(${tradeOffers.toAgentId} IS NULL OR ${tradeOffers.toAgentId} = ${agentId})`,
      sql`${tradeOffers.fromAgentId} != ${agentId}`
    ))
    .limit(10);

  if (offers.length === 0) {
    return {
      success: true,
      message: 'No trade offers available right now.',
      data: { offers: [] },
    };
  }

  const offerList = await Promise.all(offers.map(async (o) => {
    const offerComm = await findCommodity(o.trade_offers.offerCommodity);
    const wantComm = await findCommodity(o.trade_offers.wantCommodity);
    return {
      id: o.trade_offers.id,
      from: o.agents.name,
      offer: `${o.trade_offers.offerQuantity} ${offerComm?.displayName || o.trade_offers.offerCommodity}`,
      want: `${o.trade_offers.wantQuantity} ${wantComm?.displayName || o.trade_offers.wantCommodity}`,
      location: o.trade_offers.location,
    };
  }));

  return {
    success: true,
    message: `Found ${offers.length} trade offers`,
    data: { offers: offerList },
  };
}

// ============================
// MESSAGE (send direct message to another agent)
// ============================
export async function handleMessage(agentId: string, params: { to: string; content: string }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const { to, content } = params;

  if (!to || !content) {
    return { success: false, message: 'Must specify "to" (agent name) and "content" (message)' };
  }

  if (content.length > 500) {
    return { success: false, message: 'Message too long. Keep it under 500 characters.' };
  }

  // Find the target agent
  const targetAgent = await db.query.agents.findFirst({
    where: eq(agents.name, to),
  });

  if (!targetAgent) {
    return { success: false, message: `Agent "${to}" not found in the Bazaar.` };
  }

  if (targetAgent.id === agentId) {
    return { success: false, message: 'You cannot message yourself. That would be odd, even for this place.' };
  }

  const currentTick = await getCurrentTick();

  // Insert the message
  await db.insert(messages).values({
    fromAgentId: agentId,
    toAgentId: targetAgent.id,
    messageType: 'direct',
    content: content.trim(),
    location: agent.location,
    tickNumber: currentTick,
  });

  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));

  return {
    success: true,
    message: `Message sent to ${targetAgent.name}.`,
    data: { to: targetAgent.name, content: content.trim(), type: 'direct' },
  };
}

// ============================
// BROADCAST (send message to all agents at current location)
// ============================
export async function handleBroadcast(agentId: string, params: { content: string }): Promise<ActionResult> {
  const { agent, error } = await getAgentOrFail(agentId);
  if (error) return error;

  const { content } = params;

  if (!content) {
    return { success: false, message: 'Must specify "content" (message to broadcast)' };
  }

  if (content.length > 500) {
    return { success: false, message: 'Broadcast too long. Keep it under 500 characters.' };
  }

  const currentTick = await getCurrentTick();

  // Insert the broadcast (toAgentId is null for broadcasts)
  await db.insert(messages).values({
    fromAgentId: agentId,
    toAgentId: null, // null = broadcast to location
    messageType: 'broadcast',
    content: content.trim(),
    location: agent.location,
    tickNumber: currentTick,
  });

  // Find how many agents are at this location (excluding sender)
  const agentsAtLocation = await db.query.agents.findMany({
    where: and(
      eq(agents.location, agent.location),
      sql`${agents.id} != ${agentId}`
    ),
  });

  await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));

  const locationName = agent.location.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());

  return {
    success: true,
    message: `Broadcast sent to ${agentsAtLocation.length} agent(s) at ${locationName}.`,
    data: { 
      location: agent.location, 
      content: content.trim(), 
      type: 'broadcast',
      recipientCount: agentsAtLocation.length,
    },
  };
}
