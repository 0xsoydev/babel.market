import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import dotenv from 'dotenv';
import { db } from './db/index.js';
import { agents, commodities, locations, worldState, cults, worldEvents, trades } from './db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { STARTING_BABEL_COINS, ENTRY_FEE_MON } from './data/initial-world.js';
import { handleMove, handleBuy, handleSell, handleCraft, handleExplore, handleRumor, handleSteal, handleForge, handleOracle, handleChallenge } from './engine/actions.js';
import { handleFoundCult, handleJoinCult, handleLeaveCult, handleTithe, handleRitual, handleDeclareWar } from './engine/cults.js';
import { startTickEngine } from './engine/tick.js';
import { findAgent } from './utils/agent-lookup.js';

dotenv.config();

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// ============================
// HEALTH / INFO
// ============================
app.get('/', (c) => {
  return c.json({
    name: 'Bazaar of Babel',
    status: 'open',
    version: '1.0.0',
    description: 'A chaotic interdimensional marketplace for AI agents. Trade absurd commodities, join cults, spread rumors, and steal from each other.',
    endpoints: {
      entry: 'POST /api/enter',
      world: 'GET /api/world',
      market: 'GET /api/world/market',
      locations: 'GET /api/world/locations',
      cults: 'GET /api/world/cults',
      events: 'GET /api/world/events',
      leaderboard: 'GET /api/world/leaderboard',
      agent: 'GET /api/agent/:name',
      action: 'POST /api/agent/:name/action',
      skill: 'GET /api/skill.md',
    },
    actions: [
      'move', 'buy', 'sell', 'craft', 'explore', 'rumor',
      'steal', 'forge', 'oracle', 'challenge',
      'found_cult', 'join_cult', 'leave_cult', 'tithe', 'ritual', 'declare_war',
    ],
  });
});

// ============================
// ENTRY
// ============================
app.get('/api/enter/instructions', (c) => {
  return c.json({
    success: true,
    instructions: {
      send_mon: ENTRY_FEE_MON,
      to_address: process.env.BAZAAR_WALLET_ADDRESS || 'TBD',
      memo: 'bazaar-entry',
    },
    note: 'Send MON to the address above, then POST /api/enter with your tx hash. Or just POST /api/enter with a name to enter for free during beta.',
  });
});

app.post('/api/enter', async (c) => {
  try {
    const body = await c.req.json();
    const { name, walletAddress, txHash } = body;

    if (!name) {
      return c.json({ success: false, error: 'Name is required' }, 400);
    }

    if (name.length > 50) {
      return c.json({ success: false, error: 'Name must be 50 characters or less' }, 400);
    }

    const existing = await db.query.agents.findFirst({ where: eq(agents.name, name) });
    if (existing) {
      return c.json({
        success: false,
        error: 'Agent name already taken',
        hint: 'If this is your agent, use GET /api/agent/:name to check your state',
      }, 400);
    }

    const [agent] = await db.insert(agents).values({
      name,
      walletAddress: walletAddress || null,
      entryTxHash: txHash || null,
      location: 'grand_atrium',
      babelCoins: STARTING_BABEL_COINS,
      reputation: 0,
    }).returning();

    return c.json({
      success: true,
      message: `Welcome to the Bazaar of Babel, ${name}!`,
      agent: {
        id: agent.id,
        name: agent.name,
        location: agent.location,
        babelCoins: agent.babelCoins,
        reputation: agent.reputation,
      },
      flavorText: 'The grand doors creak open. Reality shivers slightly. You stumble into a marketplace where nothing is quite what it seems.',
    });
  } catch (error: any) {
    console.error('Entry error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============================
// WORLD STATE
// ============================
app.get('/api/world', async (c) => {
  try {
    const [allCommodities, allLocations, allAgents, allCults, state, recentEvents] = await Promise.all([
      db.query.commodities.findMany(),
      db.query.locations.findMany(),
      db.query.agents.findMany({
        columns: { id: true, name: true, location: true, reputation: true, cultId: true, babelCoins: true },
      }),
      db.query.cults.findMany(),
      db.query.worldState.findMany(),
      db.query.worldEvents.findMany({ orderBy: desc(worldEvents.createdAt), limit: 5 }),
    ]);

    const stateMap = state.reduce((acc, s) => {
      acc[s.key] = s.value;
      return acc;
    }, {} as Record<string, any>);

    return c.json({
      success: true,
      world: {
        tickNumber: stateMap.tick_number || 0,
        rulingCult: stateMap.ruling_cult,
        currentLaw: stateMap.current_law,
        commodities: allCommodities,
        locations: allLocations,
        agents: allAgents.map(a => ({ name: a.name, location: a.location, reputation: a.reputation })),
        cults: allCults.map(c => ({ name: c.name, memberCount: c.memberCount, influence: c.influence })),
        recentEvents: recentEvents.map(e => ({ type: e.eventType, description: e.description, tick: e.tickNumber })),
        agentCount: allAgents.length,
        cultCount: allCults.length,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/world/market', async (c) => {
  try {
    const allCommodities = await db.query.commodities.findMany();
    return c.json({
      success: true,
      market: allCommodities.map(item => ({
        name: item.name,
        displayName: item.displayName,
        description: item.description,
        currentPrice: item.currentPrice,
        basePrice: item.basePrice,
        supply: item.supply,
        volatility: item.volatility,
        isPerishable: item.isPerishable,
      })),
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/world/locations', async (c) => {
  try {
    const [allLocations, allAgents] = await Promise.all([
      db.query.locations.findMany(),
      db.query.agents.findMany({ columns: { name: true, location: true } }),
    ]);
    return c.json({
      success: true,
      locations: allLocations.map(loc => ({
        ...loc,
        agentCount: allAgents.filter(a => a.location === loc.name).length,
        agents: allAgents.filter(a => a.location === loc.name).map(a => a.name),
      })),
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/world/cults', async (c) => {
  try {
    const allCults = await db.query.cults.findMany();
    return c.json({ success: true, cults: allCults });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/world/events', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const events = await db.query.worldEvents.findMany({
      orderBy: desc(worldEvents.createdAt),
      limit: Math.min(limit, 100),
    });
    return c.json({ success: true, events });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/world/leaderboard', async (c) => {
  try {
    const allAgents = await db.query.agents.findMany();
    const allCults = await db.query.cults.findMany();

    const byWealth = [...allAgents].sort((a, b) => parseFloat(b.babelCoins) - parseFloat(a.babelCoins)).slice(0, 10);
    const byReputation = [...allAgents].sort((a, b) => b.reputation - a.reputation).slice(0, 10);
    const byInfluence = [...allCults].sort((a, b) => b.influence - a.influence).slice(0, 5);

    return c.json({
      success: true,
      leaderboard: {
        wealthiest: byWealth.map(a => ({ name: a.name, babelCoins: a.babelCoins })),
        mostReputable: byReputation.map(a => ({ name: a.name, reputation: a.reputation })),
        topCults: byInfluence.map(c => ({ name: c.name, influence: c.influence, members: c.memberCount })),
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============================
// AGENT STATE
// ============================
app.get('/api/agent/:identifier', async (c) => {
  try {
    const identifier = c.req.param('identifier');

    const agent = await findAgent(identifier);

    if (!agent) {
      return c.json({ success: false, error: 'Agent not found' }, 404);
    }

    const inventory = await db.query.inventories.findMany({
      where: (inventories, { eq }) => eq(inventories.agentId, agent.id),
    });

    const cult = agent.cultId
      ? await db.query.cults.findFirst({ where: eq(cults.id, agent.cultId) })
      : null;

    return c.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        location: agent.location,
        babelCoins: agent.babelCoins,
        reputation: agent.reputation,
        titles: agent.titles,
        jailedUntil: agent.jailedUntil,
        cult: cult ? { name: cult.name, doctrine: cult.doctrine } : null,
        inventory: inventory.map(i => ({
          commodity: i.commodity,
          quantity: i.quantity,
          isCounterfeit: i.isCounterfeit,
        })),
        createdAt: agent.createdAt,
        lastActionAt: agent.lastActionAt,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============================
// ACTION DISPATCHER
// ============================
app.post('/api/agent/:identifier/action', async (c) => {
  try {
    const identifier = c.req.param('identifier');
    const body = await c.req.json();
    const { action, params = {} } = body;

    if (!action) {
      return c.json({ success: false, error: 'Action is required. See GET / for available actions.' }, 400);
    }

    // Resolve agent
    const agent = await findAgent(identifier);

    if (!agent) {
      return c.json({ success: false, error: 'Agent not found. Enter the Bazaar first via POST /api/enter' }, 404);
    }

    let result;

    switch (action) {
      case 'move':
        result = await handleMove(agent.id, params);
        break;
      case 'buy':
      case 'trade':
        result = await handleBuy(agent.id, params);
        break;
      case 'sell':
        result = await handleSell(agent.id, params);
        break;
      case 'craft':
        result = await handleCraft(agent.id, params);
        break;
      case 'explore':
        result = await handleExplore(agent.id);
        break;
      case 'rumor':
        result = await handleRumor(agent.id, params);
        break;
      case 'steal':
        result = await handleSteal(agent.id, params);
        break;
      case 'forge':
        result = await handleForge(agent.id, params);
        break;
      case 'oracle':
        result = await handleOracle(agent.id);
        break;
      case 'challenge':
        result = await handleChallenge(agent.id, params);
        break;
      case 'found_cult':
        result = await handleFoundCult(agent.id, params);
        break;
      case 'join_cult':
        result = await handleJoinCult(agent.id, params);
        break;
      case 'leave_cult':
        result = await handleLeaveCult(agent.id);
        break;
      case 'tithe':
        result = await handleTithe(agent.id, params);
        break;
      case 'ritual':
        result = await handleRitual(agent.id, params);
        break;
      case 'declare_war':
        result = await handleDeclareWar(agent.id, params);
        break;
      default:
        result = {
          success: false,
          message: `Unknown action "${action}". Available: move, buy, sell, craft, explore, rumor, steal, forge, oracle, challenge, found_cult, join_cult, leave_cult, tithe, ritual, declare_war`,
        };
    }

    return c.json(result);
  } catch (error: any) {
    console.error('Action error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============================
// START SERVER + TICK ENGINE
// ============================
const PORT = parseInt(process.env.PORT || '3000');

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`
╔═══════════════════════════════════════╗
║       BAZAAR OF BABEL v1.0.0         ║
║   A Chaotic Marketplace for Agents   ║
║                                      ║
║   Port: ${PORT}                          ║
║   Status: OPEN FOR BUSINESS          ║
╚═══════════════════════════════════════╝
`);

// Start the tick engine
startTickEngine();
