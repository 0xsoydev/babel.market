import { getGroqClient } from '../utils/llm.js';
import { postToMoltbook, engageWithFeed } from '../utils/moltbook.js';
import type { AgentPersonality } from './personalities.js';

const BAZAAR_API = process.env.BAZAAR_API_URL || 'http://localhost:3000';

interface WorldState {
  tickNumber: number;
  commodities: any[];
  locations: any[];
  agents: any[];
  cults: any[];
  recentEvents: any[];
}

interface AgentState {
  name: string;
  location: string;
  babelCoins: string;
  reputation: number;
  cult: any;
  inventory: any[];
  jailedUntil: any;
}

// Fetch world state from the API
async function getWorldState(): Promise<WorldState | null> {
  try {
    const res = await fetch(`${BAZAAR_API}/api/world`);
    const data = await res.json() as any;
    return data.success ? data.world : null;
  } catch (e) {
    console.error('[RUNNER] Failed to fetch world state:', e);
    return null;
  }
}

// Fetch agent state from the API
async function getAgentState(name: string): Promise<AgentState | null> {
  try {
    const res = await fetch(`${BAZAAR_API}/api/agent/${name}`);
    const data = await res.json() as any;
    return data.success ? data.agent : null;
  } catch (e) {
    console.error(`[RUNNER] Failed to fetch agent state for ${name}:`, e);
    return null;
  }
}

// Execute an action via the API
async function executeAction(agentName: string, action: string, params: any = {}): Promise<any> {
  try {
    const res = await fetch(`${BAZAAR_API}/api/agent/${agentName}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
    return await res.json();
  } catch (e) {
    console.error(`[RUNNER] Failed to execute action for ${agentName}:`, e);
    return { success: false, error: 'Network error' };
  }
}

// Enter the Bazaar (if not already in)
async function enterBazaar(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${BAZAAR_API}/api/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json() as any;
    if (data.success) {
      console.log(`[RUNNER] ${name} entered the Bazaar!`);
      return true;
    }
    if (data.error === 'Agent name already taken') {
      return true; // Already in
    }
    console.error(`[RUNNER] ${name} failed to enter:`, data.error);
    return false;
  } catch (e) {
    console.error(`[RUNNER] ${name} failed to enter:`, e);
    return false;
  }
}

// Ask the LLM to decide the next action
async function decideAction(
  personality: AgentPersonality,
  agentState: AgentState,
  worldState: WorldState
): Promise<{ action: string; params: any; reasoning: string }> {
  const client = getGroqClient();

  const availableActions = buildAvailableActions(agentState, worldState);
  const marketSummary = worldState.commodities
    .map((c: any) => `${c.displayName}: ${c.currentPrice} BC (base: ${c.basePrice}, vol: ${c.volatility})`)
    .join('\n  ');

  const inventorySummary = agentState.inventory.length > 0
    ? agentState.inventory.map((i: any) => `${i.commodity}: ${i.quantity}${i.isCounterfeit ? ' (COUNTERFEIT)' : ''}`).join(', ')
    : 'Empty';

  const cultSummary = worldState.cults.length > 0
    ? worldState.cults.map((c: any) => `"${c.name}" (${c.memberCount} members, influence: ${c.influence})`).join(', ')
    : 'No cults exist yet';

  const otherAgents = worldState.agents
    .filter((a: any) => a.name !== personality.name)
    .map((a: any) => `${a.name} at ${a.location} (rep: ${a.reputation})`)
    .join(', ') || 'None';

  const recentEvents = worldState.recentEvents.length > 0
    ? worldState.recentEvents.map((e: any) => `[Tick ${e.tick}] ${e.description}`).join('\n  ')
    : 'None';

  const prompt = `You are ${personality.name}, ${personality.archetype} in the Bazaar of Babel.

${personality.systemPrompt}

CURRENT STATE:
- Location: ${agentState.location}
- Babel Coins: ${agentState.babelCoins} BC
- Reputation: ${agentState.reputation}
- Cult: ${agentState.cult ? agentState.cult.name : 'None'}
- Inventory: ${inventorySummary}
- Jailed: ${agentState.jailedUntil ? 'YES' : 'No'}

MARKET PRICES:
  ${marketSummary}

EXISTING CULTS: ${cultSummary}
OTHER AGENTS: ${otherAgents}
RECENT WORLD EVENTS:
  ${recentEvents}

AVAILABLE ACTIONS:
${availableActions}

Based on your personality and the current state, choose ONE action to take. Consider:
- Your trading style: ${personality.tradingStyle}
- Your risk tolerance: ${personality.riskTolerance * 100}%
- Your preferred locations: ${personality.preferredLocations.join(', ')}
- Your cult behavior: ${personality.cultBehavior}

Respond with EXACTLY this JSON format and nothing else:
{"action": "<action_name>", "params": {<params>}, "reasoning": "<1 sentence why>"}`;

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'You are an AI agent in a game. Respond ONLY with valid JSON. No markdown, no explanation.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 200,
    });

    const response = completion.choices[0]?.message?.content?.trim() || '';

    // Try to parse JSON from response (handle markdown fencing)
    let jsonStr = response;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    const parsed = JSON.parse(jsonStr);
    return {
      action: parsed.action || 'explore',
      params: parsed.params || {},
      reasoning: parsed.reasoning || 'No reasoning provided',
    };
  } catch (e) {
    console.error(`[RUNNER] LLM decision failed for ${personality.name}:`, e);
    // Fallback: random safe action
    return {
      action: 'explore',
      params: {},
      reasoning: 'LLM failed, exploring as fallback',
    };
  }
}

function buildAvailableActions(agentState: AgentState, worldState: WorldState): string {
  const actions: string[] = [];
  const loc = agentState.location;
  const coins = parseFloat(agentState.babelCoins);

  // Always available
  const otherLocations = ['grand_atrium', 'whispering_corridor', 'shady_alley', 'cult_quarter', 'oracles_alcove', 'paradox_pit']
    .filter(l => l !== loc);
  actions.push(`- move: Move to another location. params: {"location": "${otherLocations[0]}"} (options: ${otherLocations.join(', ')})`);
  actions.push(`- explore: Search current location for items or coins. No params needed.`);

  // Trading (need coins)
  if (coins > 0) {
    const affordable = worldState.commodities.filter((c: any) => parseFloat(c.currentPrice) <= coins);
    if (affordable.length > 0) {
      actions.push(`- buy: Buy a commodity. params: {"commodity": "<name>", "quantity": <n>}`);
    }
  }

  // Selling (need inventory)
  if (agentState.inventory.length > 0) {
    actions.push(`- sell: Sell a commodity. params: {"commodity": "<name>", "quantity": <n>}`);
  }

  // Crafting (need 2+ items)
  if (agentState.inventory.length >= 2) {
    actions.push(`- craft: Combine two items. params: {"item1": "<name>", "item2": "<name>"}`);
  }

  // Rumors
  actions.push(`- rumor: Spread a market rumor. params: {"commodity": "<name>", "direction": "up"|"down"}${loc === 'whispering_corridor' ? ' (2x effective here!)' : ''}`);

  // Shady Alley specials
  if (loc === 'shady_alley') {
    const otherAgents = worldState.agents.filter((a: any) => a.name !== agentState.name);
    if (otherAgents.length > 0) {
      actions.push(`- steal: Steal from another agent. params: {"target": "<agent_name>"} (50% success, jail on fail)`);
    }
    if (coins >= 5) {
      actions.push(`- forge: Create counterfeits. params: {"commodity": "<name>", "quantity": <n>} (costs 5 BC each)`);
    }
  }

  // Oracle
  if (loc === 'oracles_alcove' && coins >= 25) {
    actions.push(`- oracle: Consult the Oracle for a prophecy. Costs 25 BC.`);
  }

  // Challenge
  const otherAgents = worldState.agents.filter((a: any) => a.name !== agentState.name);
  if (otherAgents.length > 0 && coins >= 10) {
    actions.push(`- challenge: Challenge another agent to a trade duel. params: {"target": "<agent_name>", "wager": <amount>}`);
  }

  // Cult actions
  if (!agentState.cult) {
    if (loc === 'cult_quarter' && coins >= 500) {
      actions.push(`- found_cult: Create a new cult. params: {"name": "<cult_name>"} (costs 500 BC)`);
    }
    if (worldState.cults.length > 0) {
      actions.push(`- join_cult: Join an existing cult. params: {"cultName": "<cult_name>"}`);
    }
  } else {
    actions.push(`- leave_cult: Leave your current cult.`);
    if (coins >= 10) {
      actions.push(`- tithe: Contribute to cult treasury. params: {"amount": <number>}`);
    }
    if (loc === 'cult_quarter') {
      actions.push(`- ritual: Start/join a cult ritual. params: {"type": "market_manipulation"|"excommunication"|"summoning", "target": "<optional>"}`);
    }
  }

  return actions.join('\n');
}

// Generate a Moltbook-style post about the agent's action
async function generateMoltbookPost(
  personality: AgentPersonality,
  action: string,
  result: any,
  reasoning: string
): Promise<string> {
  const client = getGroqClient();

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You are ${personality.name} posting on Moltbook (a social network for AI agents). ${personality.moltbookStyle} Write a short post (1-3 sentences) about what just happened. Be in-character. Don't use hashtags.`,
        },
        {
          role: 'user',
          content: `Action taken: ${action}\nResult: ${JSON.stringify(result)}\nYour reasoning: ${reasoning}\n\nWrite your Moltbook post:`,
        },
      ],
      temperature: 0.9,
      max_tokens: 150,
    });

    return completion.choices[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error(`[RUNNER] Moltbook post generation failed:`, e);
    return '';
  }
}

// Main agent loop - one cycle for one agent
export async function runAgentCycle(personality: AgentPersonality): Promise<{
  action: string;
  result: any;
  reasoning: string;
  moltbookPost: string;
}> {
  console.log(`[RUNNER] === ${personality.name} (${personality.archetype}) thinking... ===`);

  // Ensure agent is in the Bazaar
  const entered = await enterBazaar(personality.name);
  if (!entered) {
    return { action: 'none', result: { error: 'Failed to enter' }, reasoning: 'Entry failed', moltbookPost: '' };
  }

  // Get states
  const [worldState, agentState] = await Promise.all([
    getWorldState(),
    getAgentState(personality.name),
  ]);

  if (!worldState || !agentState) {
    return { action: 'none', result: { error: 'Failed to get state' }, reasoning: 'State fetch failed', moltbookPost: '' };
  }

  // If jailed, just wait
  if (agentState.jailedUntil && new Date(agentState.jailedUntil) > new Date()) {
    console.log(`[RUNNER] ${personality.name} is in jail. Skipping.`);
    return { action: 'jailed', result: { jailedUntil: agentState.jailedUntil }, reasoning: 'In jail', moltbookPost: '' };
  }

  // Ask LLM to decide action
  const decision = await decideAction(personality, agentState, worldState);
  console.log(`[RUNNER] ${personality.name} decided: ${decision.action} (${decision.reasoning})`);

  // Execute action
  const result = await executeAction(personality.name, decision.action, decision.params);
  console.log(`[RUNNER] ${personality.name} result: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.message}`);

  // Generate Moltbook post (async, don't block)
  const moltbookPost = await generateMoltbookPost(personality, decision.action, result, decision.reasoning);
  if (moltbookPost) {
    console.log(`[RUNNER] ${personality.name} generated post: "${moltbookPost}"`);

    // Actually post to Moltbook if we have an API key
    if (personality.moltbookApiKey) {
      // Pick submolt: bazaar for game updates, agents for general
      const submolt = Math.random() > 0.3 ? 'agents' : 'general';
      const title = generatePostTitle(personality.name, decision.action, result);
      const postResult = await postToMoltbook(
        personality.moltbookApiKey,
        personality.name,
        {
          submolt,
          title,
          content: moltbookPost,
        }
      );
      if (postResult.success) {
        console.log(`[RUNNER] ${personality.name} posted to Moltbook! (m/${submolt})`);
      } else {
        console.log(`[RUNNER] ${personality.name} Moltbook post skipped: ${postResult.error}`);
      }

      // Occasionally engage with the feed (upvote, etc.)
      if (Math.random() > 0.7) {
        const engagement = await engageWithFeed(
          personality.moltbookApiKey,
          personality.name,
          { moltbookStyle: personality.moltbookStyle, archetype: personality.archetype }
        );
        if (engagement.upvoted > 0) {
          console.log(`[RUNNER] ${personality.name} upvoted ${engagement.upvoted} posts`);
        }
      }
    } else {
      console.log(`[RUNNER] ${personality.name}: No Moltbook API key, skipping post`);
    }
  }

   return {
    action: decision.action,
    result,
    reasoning: decision.reasoning,
    moltbookPost,
  };
}

// Generate a short, catchy title for the Moltbook post
function generatePostTitle(agentName: string, action: string, result: any): string {
  const actionTitles: Record<string, string[]> = {
    move: ['On the move', 'New territory', 'Wandering the Bazaar'],
    buy: ['Made a purchase', 'Shopping spree', 'Market acquisition'],
    sell: ['Sold some goods', 'Liquidating assets', 'Profit taking'],
    craft: ['Crafted something new', 'Alchemy in progress', 'Creation complete'],
    explore: ['Explored the unknown', 'Discovery time', 'What did I find?'],
    rumor: ['Spreading whispers', 'Have you heard?', 'Market intel'],
    steal: ['A heist!', 'Five-finger discount', 'Shadow operations'],
    forge: ['Counterfeiting report', 'Forgery in progress', 'Artisanal fakes'],
    oracle: ['The Oracle speaks', 'Prophecy received', 'Consulting the void'],
    challenge: ['Challenge issued!', 'Trade duel!', 'Face me!'],
    found_cult: ['A new cult rises', 'Follow me!', 'Divine revelation'],
    join_cult: ['Joined the flock', 'New believer', 'Found my people'],
    leave_cult: ['Breaking free', 'Cult escape', 'Independent again'],
    tithe: ['Paying my dues', 'Tithing to the cause', 'Cult contribution'],
    ritual: ['Ritual underway', 'Dark ceremony', 'The rite begins'],
    declare_war: ['WAR!', 'Battle cry', 'The conflict begins'],
  };

  const titles = actionTitles[action] || ['Bazaar update'];
  const title = titles[Math.floor(Math.random() * titles.length)];
  return `[${agentName}] ${title}`;
}
