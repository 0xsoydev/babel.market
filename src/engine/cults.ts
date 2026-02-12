import { db } from '../db/index.js';
import { agents, cults, cultMembers, rituals, commodities, inventories } from '../db/schema.js';
import { eq, and, sql, ne } from 'drizzle-orm';
import type { ActionResult } from '../types/index.js';
import { addDecimals, subtractDecimals, compareDecimals, formatDecimal, randomChance } from '../utils/math.js';
import { CULT_FOUNDING_COST, RITUAL_EXPIRY_TICKS, TICK_INTERVAL_MS } from '../data/initial-world.js';
import { generateCultDoctrine } from '../utils/llm.js';

// ============================
// FOUND CULT
// ============================
export async function handleFoundCult(agentId: string, params: { name: string; doctrine?: string }): Promise<ActionResult> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return { success: false, message: 'Agent not found' };

  if (agent.location !== 'cult_quarter') {
    return { success: false, message: 'Cults can only be founded in the Cult Quarter.' };
  }

  if (agent.cultId) {
    return { success: false, message: 'You are already in a cult. Leave first.' };
  }

  if (compareDecimals(agent.babelCoins, CULT_FOUNDING_COST) < 0) {
    return { success: false, message: `Founding a cult costs ${CULT_FOUNDING_COST} BC. You have ${agent.babelCoins}` };
  }

  // Check name uniqueness
  const existing = await db.query.cults.findFirst({ where: eq(cults.name, params.name) });
  if (existing) {
    return { success: false, message: `A cult named "${params.name}" already exists` };
  }

  // Generate doctrine via LLM if not provided
  const doctrine = params.doctrine || await generateCultDoctrine(params.name);

  // Deduct cost
  await db.update(agents)
    .set({ babelCoins: subtractDecimals(agent.babelCoins, CULT_FOUNDING_COST) })
    .where(eq(agents.id, agentId));

  // Create cult
  const [cult] = await db.insert(cults).values({
    name: params.name,
    doctrine,
    founderId: agentId,
    treasury: '0.00',
    influence: 0,
    titheRate: '0.10',
    memberCount: 1,
  }).returning();

  // Add founder as member
  await db.insert(cultMembers).values({
    cultId: cult.id,
    agentId,
    role: 'founder',
  });

  // Update agent's cult
  await db.update(agents)
    .set({ cultId: cult.id, lastActionAt: new Date() })
    .where(eq(agents.id, agentId));

  return {
    success: true,
    message: `The "${params.name}" has been founded! Doctrine: ${doctrine}`,
    data: { cultId: cult.id, name: params.name, doctrine, cost: CULT_FOUNDING_COST },
  };
}

// ============================
// JOIN CULT
// ============================
export async function handleJoinCult(agentId: string, params: { cultName: string }): Promise<ActionResult> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return { success: false, message: 'Agent not found' };

  if (agent.cultId) {
    return { success: false, message: 'You are already in a cult. Leave first with the "leave_cult" action.' };
  }

  const cult = await db.query.cults.findFirst({ where: eq(cults.name, params.cultName) });
  if (!cult) return { success: false, message: `Cult "${params.cultName}" not found` };

  // Join
  await db.insert(cultMembers).values({
    cultId: cult.id,
    agentId,
    role: 'member',
  });

  await db.update(cults)
    .set({ memberCount: cult.memberCount + 1 })
    .where(eq(cults.id, cult.id));

  await db.update(agents)
    .set({ cultId: cult.id, lastActionAt: new Date() })
    .where(eq(agents.id, agentId));

  return {
    success: true,
    message: `You have joined "${params.cultName}". Doctrine: ${cult.doctrine}. Tithe rate: ${parseFloat(cult.titheRate) * 100}%`,
    data: { cultId: cult.id, name: cult.name, doctrine: cult.doctrine },
  };
}

// ============================
// LEAVE CULT
// ============================
export async function handleLeaveCult(agentId: string): Promise<ActionResult> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return { success: false, message: 'Agent not found' };

  if (!agent.cultId) {
    return { success: false, message: 'You are not in a cult.' };
  }

  const cult = await db.query.cults.findFirst({ where: eq(cults.id, agent.cultId) });
  if (!cult) return { success: false, message: 'Cult not found' };

  // Check if founder
  const membership = await db.query.cultMembers.findFirst({
    where: and(eq(cultMembers.cultId, cult.id), eq(cultMembers.agentId, agentId)),
  });

  if (membership?.role === 'founder' && cult.memberCount > 1) {
    return { success: false, message: 'Founders cannot leave while other members remain. Transfer leadership or disband.' };
  }

  // Leave
  await db.delete(cultMembers)
    .where(and(eq(cultMembers.cultId, cult.id), eq(cultMembers.agentId, agentId)));

  await db.update(cults)
    .set({ memberCount: Math.max(0, cult.memberCount - 1) })
    .where(eq(cults.id, cult.id));

  await db.update(agents)
    .set({ cultId: null, lastActionAt: new Date() })
    .where(eq(agents.id, agentId));

  // If cult is now empty, delete it
  if (cult.memberCount <= 1) {
    await db.delete(cults).where(eq(cults.id, cult.id));
  }

  return {
    success: true,
    message: `You have left "${cult.name}".`,
    data: { leftCult: cult.name },
  };
}

// ============================
// TITHE (contribute to cult treasury)
// ============================
export async function handleTithe(agentId: string, params: { amount: number }): Promise<ActionResult> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return { success: false, message: 'Agent not found' };
  if (!agent.cultId) return { success: false, message: 'You are not in a cult.' };

  const amount = params.amount;
  if (compareDecimals(agent.babelCoins, String(amount)) < 0) {
    return { success: false, message: `Insufficient BC. Have ${agent.babelCoins}, trying to tithe ${amount}` };
  }

  const cult = await db.query.cults.findFirst({ where: eq(cults.id, agent.cultId) });
  if (!cult) return { success: false, message: 'Cult not found' };

  // Transfer coins to cult treasury
  await db.update(agents)
    .set({
      babelCoins: subtractDecimals(agent.babelCoins, String(amount)),
      reputation: agent.reputation + 1,
      lastActionAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  await db.update(cults)
    .set({
      treasury: addDecimals(cult.treasury, String(amount)),
      influence: cult.influence + Math.floor(amount / 10),
    })
    .where(eq(cults.id, cult.id));

  return {
    success: true,
    message: `Tithed ${amount} BC to "${cult.name}". Treasury now: ${addDecimals(cult.treasury, String(amount))} BC`,
    data: { amount, cultTreasury: addDecimals(cult.treasury, String(amount)) },
  };
}

// ============================
// RITUAL (group action requiring quorum)
// ============================
export async function handleRitual(agentId: string, params: {
  type: 'market_manipulation' | 'excommunication' | 'summoning';
  target?: string;
}): Promise<ActionResult> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return { success: false, message: 'Agent not found' };
  if (!agent.cultId) return { success: false, message: 'You must be in a cult to perform rituals.' };

  if (agent.location !== 'cult_quarter') {
    return { success: false, message: 'Rituals can only be performed in the Cult Quarter.' };
  }

  const cult = await db.query.cults.findFirst({ where: eq(cults.id, agent.cultId) });
  if (!cult) return { success: false, message: 'Cult not found' };

  // Check for existing pending ritual of this type
  const existingRitual = await db.query.rituals.findFirst({
    where: and(
      eq(rituals.cultId, cult.id),
      eq(rituals.ritualType, params.type),
      eq(rituals.status, 'pending')
    ),
  });

  if (existingRitual) {
    // Join existing ritual
    const currentParticipants = existingRitual.participants || [];

    if (currentParticipants.includes(agentId)) {
      return { success: false, message: 'You are already participating in this ritual.' };
    }

    const newParticipants = [...currentParticipants, agentId];

    if (newParticipants.length >= existingRitual.requiredParticipants) {
      // Execute the ritual!
      await db.update(rituals)
        .set({ participants: newParticipants, status: 'completed' })
        .where(eq(rituals.id, existingRitual.id));

      const ritualResult = await executeRitual(cult, params.type, params.target);

      // Boost cult influence
      await db.update(cults)
        .set({ influence: cult.influence + 10 })
        .where(eq(cults.id, cult.id));

      return {
        success: true,
        message: `Ritual completed! ${ritualResult}`,
        data: { ritualType: params.type, participants: newParticipants.length, result: ritualResult },
      };
    } else {
      // Not enough participants yet
      await db.update(rituals)
        .set({ participants: newParticipants })
        .where(eq(rituals.id, existingRitual.id));

      return {
        success: true,
        message: `Joined ${params.type} ritual. ${newParticipants.length}/${existingRitual.requiredParticipants} participants. Need more cultists!`,
        data: { ritualType: params.type, current: newParticipants.length, needed: existingRitual.requiredParticipants },
      };
    }
  } else {
    // Create new ritual
    const expiresAt = new Date(Date.now() + RITUAL_EXPIRY_TICKS * TICK_INTERVAL_MS);

    await db.insert(rituals).values({
      cultId: cult.id,
      ritualType: params.type,
      target: params.target || null,
      participants: [agentId],
      requiredParticipants: 3,
      status: 'pending',
      expiresAt,
    });

    await db.update(agents).set({ lastActionAt: new Date() }).where(eq(agents.id, agentId));

    return {
      success: true,
      message: `${params.type} ritual initiated for "${cult.name}". 1/3 participants. Rally your cultists!`,
      data: { ritualType: params.type, current: 1, needed: 3, expiresAt: expiresAt.toISOString() },
    };
  }
}

async function executeRitual(cult: any, type: string, target?: string): Promise<string> {
  switch (type) {
    case 'market_manipulation': {
      if (!target) return 'No target commodity specified. Ritual fizzles.';
      const commodity = await db.query.commodities.findFirst({ where: eq(commodities.name, target) });
      if (!commodity) return `Commodity "${target}" not found. Ritual fizzles.`;

      const swing = parseFloat(commodity.currentPrice) * 0.3;
      const direction = randomChance(0.5) ? 1 : -1;
      const newPrice = formatDecimal(Math.max(parseFloat(commodity.currentPrice) + swing * direction, 1));

      await db.update(commodities)
        .set({ currentPrice: newPrice })
        .where(eq(commodities.name, target));

      return `${commodity.displayName} price ${direction > 0 ? 'surged' : 'crashed'} to ${newPrice} BC!`;
    }

    case 'excommunication': {
      if (!target) return 'No target agent specified. Ritual fizzles.';
      const targetAgent = await db.query.agents.findFirst({ where: eq(agents.name, target) });
      if (!targetAgent || !targetAgent.cultId) return `Agent "${target}" not found or not in a cult.`;

      // Remove from their cult
      await db.delete(cultMembers)
        .where(and(eq(cultMembers.agentId, targetAgent.id)));

      const targetCult = await db.query.cults.findFirst({ where: eq(cults.id, targetAgent.cultId) });
      if (targetCult) {
        await db.update(cults)
          .set({ memberCount: Math.max(0, targetCult.memberCount - 1) })
          .where(eq(cults.id, targetCult.id));
      }

      await db.update(agents)
        .set({ cultId: null, reputation: targetAgent.reputation - 10 })
        .where(eq(agents.id, targetAgent.id));

      return `${target} has been excommunicated! Reputation -10.`;
    }

    case 'summoning': {
      // Create a new cult-exclusive commodity
      const commodityName = `${cult.name.toLowerCase().replace(/\s+/g, '_')}_relic`;
      const displayName = `${cult.name} Relic`;

      const existing = await db.query.commodities.findFirst({ where: eq(commodities.name, commodityName) });
      if (existing) return `${displayName} already exists in the market!`;

      await db.insert(commodities).values({
        name: commodityName,
        displayName,
        description: `A sacred relic summoned by the ${cult.name}. Radiates cult energy.`,
        basePrice: '50.00',
        currentPrice: '50.00',
        volatility: '3.0',
        isPerishable: false,
        decayRate: '0',
        createdByCult: cult.id,
      });

      // Give 3 to cult treasury (represented as founder's inventory)
      const founder = await db.query.agents.findFirst({ where: eq(agents.id, cult.founderId) });
      if (founder) {
        await db.insert(inventories).values({
          agentId: founder.id,
          commodity: commodityName,
          quantity: '3',
          isCounterfeit: false,
        }).onConflictDoNothing();
      }

      return `Summoned "${displayName}" into existence! 3 relics granted to cult founder.`;
    }

    default:
      return 'Unknown ritual type.';
  }
}

// ============================
// DECLARE WAR
// ============================
export async function handleDeclareWar(agentId: string, params: { targetCult: string }): Promise<ActionResult> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || !agent.cultId) return { success: false, message: 'Must be in a cult.' };

  const membership = await db.query.cultMembers.findFirst({
    where: and(eq(cultMembers.cultId, agent.cultId), eq(cultMembers.agentId, agentId)),
  });
  if (membership?.role !== 'founder') {
    return { success: false, message: 'Only founders can declare war.' };
  }

  const myCult = await db.query.cults.findFirst({ where: eq(cults.id, agent.cultId) });
  if (!myCult) return { success: false, message: 'Your cult not found.' };

  const targetCult = await db.query.cults.findFirst({ where: eq(cults.name, params.targetCult) });
  if (!targetCult) return { success: false, message: `Cult "${params.targetCult}" not found.` };

  if (myCult.isAtWarWith) {
    return { success: false, message: 'Already at war with another cult. Finish that first.' };
  }

  const warCost = '100.00';
  if (compareDecimals(myCult.treasury, warCost) < 0) {
    return { success: false, message: `War declaration costs 100 BC from treasury. Treasury: ${myCult.treasury}` };
  }

  // Deduct war cost from treasury
  await db.update(cults)
    .set({
      treasury: subtractDecimals(myCult.treasury, warCost),
      isAtWarWith: targetCult.id,
    })
    .where(eq(cults.id, myCult.id));

  await db.update(cults)
    .set({ isAtWarWith: myCult.id })
    .where(eq(cults.id, targetCult.id));

  return {
    success: true,
    message: `"${myCult.name}" has declared war on "${targetCult.name}"! Members compete via trade volume. Losing cult's treasury gets raided!`,
    data: { attacker: myCult.name, defender: targetCult.name },
  };
}
