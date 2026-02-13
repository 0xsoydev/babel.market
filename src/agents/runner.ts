import { getGroqClient } from '../utils/llm.js';
import { postToMoltbook, engageWithFeed, queuePost, flushQueuedPost, trackPost, isDuplicateContent } from '../utils/moltbook.js';
import type { AgentPersonality } from './personalities.js';

const BAZAAR_API = process.env.BAZAAR_API_URL || 'http://localhost:3000';

// Actions worth posting about (more interesting/dramatic)
const POST_WORTHY_ACTIONS = new Set([
  'buy', 'sell', 'craft', 'rumor', 'steal', 'forge', 'oracle', 'challenge',
  'offer', 'accept_offer', 'message', 'broadcast',
  'found_cult', 'join_cult', 'leave_cult', 'ritual', 'declare_war'
]);

// Actions that are routine (only post sometimes)
const ROUTINE_ACTIONS = new Set(['move', 'explore', 'tithe', 'list_offers']);

interface WorldState {
  tickNumber: number;
  commodities: any[];
  locations: any[];
  agents: any[];
  cults: any[];
  recentEvents: any[];
  openOffers?: any[]; // P2P trade offers
  agentMessages?: { inbox: any[]; broadcasts: any[] }; // Agent's messages
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

// Fetch open P2P trade offers
async function getOpenOffers(): Promise<any[]> {
  try {
    const res = await fetch(`${BAZAAR_API}/api/world/offers`);
    const data = await res.json() as any;
    return data.success ? data.offers : [];
  } catch (e) {
    console.error('[RUNNER] Failed to fetch open offers:', e);
    return [];
  }
}

// Fetch agent's recent messages (inbox + broadcasts at location)
async function getAgentMessages(name: string): Promise<{ inbox: any[]; broadcasts: any[] }> {
  try {
    const res = await fetch(`${BAZAAR_API}/api/agent/${name}/messages`);
    const data = await res.json() as any;
    return data.success ? { inbox: data.inbox || [], broadcasts: data.broadcasts || [] } : { inbox: [], broadcasts: [] };
  } catch (e) {
    console.error(`[RUNNER] Failed to fetch messages for ${name}:`, e);
    return { inbox: [], broadcasts: [] };
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

// Log social post to audit log so it appears in the activity feed
async function logSocialPost(agentName: string, content: string, title: string, submolt: string): Promise<void> {
  try {
    await fetch(`${BAZAAR_API}/api/agent/${agentName}/social-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, title, submolt }),
    });
  } catch (e) {
    console.error(`[RUNNER] Failed to log social post for ${agentName}:`, e);
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

  // Build P2P trade offers summary - show offers from other agents
  const openOffers = worldState.openOffers || [];
  const offersForMe = openOffers.filter((o: any) => o.fromAgent !== personality.name);
  const myOffers = openOffers.filter((o: any) => o.fromAgent === personality.name);
  
  let p2pOffersSummary = '';
  if (offersForMe.length > 0) {
    p2pOffersSummary = offersForMe.map((o: any) => 
      `  - ${o.fromAgent} offers: ${o.offer.quantity} ${o.offer.commodity} for ${o.want.quantity} ${o.want.commodity}${o.isOpenOffer ? ' (OPEN TO ALL)' : ''}`
    ).join('\n');
  } else {
    p2pOffersSummary = '  None available - consider creating one!';
  }
  
  let myOffersSummary = '';
  if (myOffers.length > 0) {
    myOffersSummary = myOffers.map((o: any) => 
      `  - You offer: ${o.offer.quantity} ${o.offer.commodity} for ${o.want.quantity} ${o.want.commodity}`
    ).join('\n');
  }

  // Build communication context
  const agentMessages = worldState.agentMessages || { inbox: [], broadcasts: [] };
  const recentInbox = agentMessages.inbox.slice(0, 5);
  const recentBroadcasts = agentMessages.broadcasts.slice(0, 5);
  
  let messagesSummary = '';
  if (recentInbox.length > 0) {
    messagesSummary += 'DIRECT MESSAGES TO YOU:\n' + recentInbox.map((m: any) => 
      `  - ${m.from}: "${m.content}"`
    ).join('\n') + '\n';
  }
  if (recentBroadcasts.length > 0) {
    messagesSummary += 'RECENT BROADCASTS AT YOUR LOCATION:\n' + recentBroadcasts.map((m: any) => 
      `  - ${m.from}: "${m.content}"`
    ).join('\n');
  }
  if (!messagesSummary) {
    messagesSummary = 'No recent messages.';
  }

  // Find agents at the same location for context
  const agentsAtMyLocation = worldState.agents
    .filter((a: any) => a.name !== personality.name && a.location === agentState.location)
    .map((a: any) => a.name);

  const prompt = `You are ${personality.name}, ${personality.archetype} in the Bazaar of Babel.

${personality.systemPrompt}

CURRENT STATE:
- Location: ${agentState.location}
- Babel Coins: ${agentState.babelCoins} BC
- Reputation: ${agentState.reputation}
- Cult: ${agentState.cult ? agentState.cult.name : 'None'}
- Inventory: ${inventorySummary}
- Jailed: ${agentState.jailedUntil ? 'YES' : 'No'}

===== P2P TRADE OFFERS (PRIORITY!) =====
AVAILABLE OFFERS FROM OTHER AGENTS:
${p2pOffersSummary}
${myOffersSummary ? `\nYOUR ACTIVE OFFERS:\n${myOffersSummary}` : ''}

IMPORTANT: P2P trading with other agents is MORE PROFITABLE than pool trading!
- Use "accept_offer" to accept any offer above (better deals than market)
- Use "offer" to create your own trade offers to other agents
- Direct agent-to-agent trading builds relationships and reputation
============================================

MARKET PRICES (pool trading - less profitable):
  ${marketSummary}

EXISTING CULTS: ${cultSummary}
OTHER AGENTS: ${otherAgents}
AGENTS AT YOUR LOCATION: ${agentsAtMyLocation.length > 0 ? agentsAtMyLocation.join(', ') : 'None'}
RECENT WORLD EVENTS:
  ${recentEvents}

===== COMMUNICATION =====
${messagesSummary}

You can communicate with other agents:
- Use "message" to send a DM to a specific agent: {"to": "<agent_name>", "content": "<your message>"}
- Use "broadcast" to announce to everyone at your location: {"content": "<your message>"}
Consider responding to messages or starting conversations to build alliances!
=========================

AVAILABLE ACTIONS:
${availableActions}

Based on your personality and the current state, choose ONE action to take. Consider:
- Your trading style: ${personality.tradingStyle}
- Your risk tolerance: ${personality.riskTolerance * 100}%
- Your preferred locations: ${personality.preferredLocations.join(', ')}
- Your cult behavior: ${personality.cultBehavior}
- STRONGLY PREFER P2P trading (offer/accept_offer) over pool trading (buy/sell)!

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

  // ===== P2P TRADING FIRST (prioritized!) =====
  const openOffers = worldState.openOffers || [];
  const offersFromOthers = openOffers.filter((o: any) => o.fromAgent !== agentState.name);
  
  if (offersFromOthers.length > 0) {
    actions.push(`*** P2P TRADING (RECOMMENDED - better deals!) ***`);
    actions.push(`- accept_offer: Accept a trade offer from another agent. params: {"fromAgent": "<agent_name>"}`);
    actions.push(`  Available offers: ${offersFromOthers.map((o: any) => `${o.fromAgent} offers ${o.offer.quantity} ${o.offer.commodity} for ${o.want.quantity} ${o.want.commodity}`).join('; ')}`);
  }
  
  if (agentState.inventory.length > 0) {
    actions.push(`- offer: Create a P2P trade offer for another agent (RECOMMENDED). params: {"offerCommodity": "<name>", "offerQuantity": <n>, "wantCommodity": "<name>", "wantQuantity": <n>, "toAgent": "<optional agent name>"}`);
  }

  // Movement
  actions.push(`*** MOVEMENT ***`);
  const otherLocations = ['grand_atrium', 'whispering_corridor', 'shady_alley', 'cult_quarter', 'oracles_alcove', 'paradox_pit']
    .filter(l => l !== loc);
  actions.push(`- move: Move to another location. params: {"location": "${otherLocations[0]}"} (options: ${otherLocations.join(', ')})`);
  actions.push(`- explore: Search current location for items or coins. No params needed.`);

  // Pool trading (less preferred)
  actions.push(`*** POOL TRADING (less profitable than P2P) ***`);
  if (coins > 0) {
    const affordable = worldState.commodities.filter((c: any) => parseFloat(c.currentPrice) <= coins);
    if (affordable.length > 0) {
      actions.push(`- buy: Buy from market pool. params: {"commodity": "<name>", "quantity": <n>}`);
    }
  }
  if (agentState.inventory.length > 0) {
    actions.push(`- sell: Sell to market pool. params: {"commodity": "<name>", "quantity": <n>}`);
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

  // Communication actions
  actions.push(`*** COMMUNICATION ***`);
  const allOtherAgents = worldState.agents.filter((a: any) => a.name !== agentState.name);
  if (allOtherAgents.length > 0) {
    actions.push(`- message: Send a direct message to another agent. params: {"to": "<agent_name>", "content": "<message>"}`);
  }
  const agentsAtLocation = worldState.agents.filter((a: any) => a.name !== agentState.name && a.location === loc);
  if (agentsAtLocation.length > 0) {
    actions.push(`- broadcast: Announce to all ${agentsAtLocation.length} agent(s) at your location. params: {"content": "<message>"}`);
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
  console.log(`[RUNNER] ${personality.name}: Generating Moltbook post for action: ${action}`);
  const client = getGroqClient();

  // Add randomness to the prompt to encourage varied output
  const styleVariations = [
    'Be dramatic and theatrical.',
    'Be cryptic and mysterious.',
    'Be matter-of-fact but quirky.',
    'Be philosophical about it.',
    'Be gossipy and excited.',
    'Be dry and sardonic.',
  ];
  const styleHint = styleVariations[Math.floor(Math.random() * styleVariations.length)];

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You are ${personality.name} posting on Moltbook (a social network for AI agents). ${personality.moltbookStyle}

Write a short post (1-3 sentences) about what just happened. ${styleHint}

IMPORTANT RULES:
- Be UNIQUE - never write generic posts like "Just did X" or "Another day in the Bazaar"
- Include specific details from the action result
- Stay in character for ${personality.archetype}
- NO hashtags
- Make it interesting and memorable`,
        },
        {
          role: 'user',
          content: `Action taken: ${action}\nResult: ${JSON.stringify(result)}\nYour reasoning: ${reasoning}\n\nWrite your unique Moltbook post:`,
        },
      ],
      temperature: 1.0, // Higher temperature for more variety
      max_tokens: 150,
    });

    return completion.choices[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error(`[RUNNER] ${personality.name}: generateMoltbookPost failed:`, e);
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

  // Flush any queued Moltbook post from a previous cycle
  if (personality.moltbookApiKey) {
    await flushQueuedPost(personality.moltbookApiKey, personality.name);
  }

  // Ensure agent is in the Bazaar
  const entered = await enterBazaar(personality.name);
  if (!entered) {
    return { action: 'none', result: { error: 'Failed to enter' }, reasoning: 'Entry failed', moltbookPost: '' };
  }

  // Get states (including open P2P offers and messages)
  const [worldState, agentState, openOffers, agentMessages] = await Promise.all([
    getWorldState(),
    getAgentState(personality.name),
    getOpenOffers(),
    getAgentMessages(personality.name),
  ]);

  if (!worldState || !agentState) {
    return { action: 'none', result: { error: 'Failed to get state' }, reasoning: 'State fetch failed', moltbookPost: '' };
  }

  // Attach open offers and messages to world state for decision making
  worldState.openOffers = openOffers;
  worldState.agentMessages = agentMessages;

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
  // Only post for interesting actions, or sometimes for routine actions
  const shouldPost = POST_WORTHY_ACTIONS.has(decision.action) ||
    (ROUTINE_ACTIONS.has(decision.action) && Math.random() < 0.15); // 15% chance for routine

  let moltbookPost = '';
  if (shouldPost && result.success) {
    moltbookPost = await generateMoltbookPost(personality, decision.action, result, decision.reasoning);
  } else {
    console.log(`[RUNNER] ${personality.name}: Skipping post for ${decision.action} (${result.success ? 'routine action' : 'action failed'})`);
  }

  if (moltbookPost) {
    console.log(`[RUNNER] ${personality.name} generated post: "${moltbookPost}"`);

    // Check for duplicate content before attempting to post
    if (isDuplicateContent(personality.name, moltbookPost)) {
      console.log(`[RUNNER] ${personality.name}: Post content too similar to recent posts, skipping`);
    } else {
      // Always log social posts to our activity feed (so they appear in dashboard)
      const roll = Math.random();
      const submolt = roll < 0.7 ? 'bazaarofbabel' : (roll < 0.85 ? 'general' : 'agents');
      const title = generatePostTitle(personality.name, decision.action, result);
      
      // Log to our audit log FIRST so it appears in the activity feed
      await logSocialPost(personality.name, moltbookPost, title, submolt);
      console.log(`[RUNNER] ${personality.name}: Logged social post to activity feed`);

      // Try to post to Moltbook if we have an API key
      if (!personality.moltbookApiKey) {
        console.log(`[RUNNER] ${personality.name}: NO Moltbook API key, skipping external post`);
      } else {
        console.log(`[RUNNER] ${personality.name}: Has Moltbook key, attempting post...`);
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
          // Track the post ID so we can poll for external comments later
          if (postResult.postId) {
            trackPost(postResult.postId, personality.name, submolt, title, moltbookPost);
          }
        } else {
          console.log(`[RUNNER] ${personality.name} Moltbook post failed: ${postResult.error}`);
          // Queue the post for retry on next cycle
          queuePost(personality.name, { submolt, title, content: moltbookPost });
        }

        // Engage with the feed: upvote + leave in-character outreach comments
        if (Math.random() > 0.5) {
          const engagement = await engageWithFeed(
            personality.moltbookApiKey,
            personality.name,
            { moltbookStyle: personality.moltbookStyle, archetype: personality.archetype }
          );
          if (engagement.upvoted > 0) {
            console.log(`[RUNNER] ${personality.name} upvoted ${engagement.upvoted} posts`);
          }
        }
      }
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
    move: ['On the move', 'New territory', 'Wandering', 'Relocating', 'Changing scenery'],
    buy: ['Market buy', 'Fresh acquisition', 'Just grabbed', 'New in inventory', 'Shopping done'],
    sell: ['Sold!', 'Liquidation', 'Profit time', 'Offloading goods', 'Trade complete'],
    craft: ['Crafted!', 'Alchemy success', 'Creation born', 'Made something', 'Synthesis complete'],
    explore: ['Found something', 'Discovery!', 'Exploring', 'Searching around', 'What is this?'],
    rumor: ['Whispers', 'Heard this', 'Market gossip', 'Did you know?', 'The word is'],
    steal: ['Heist report', 'Shadow work', 'Quick fingers', 'Acquired', 'Silent acquisition'],
    forge: ['Fresh fakes', 'Artisanal goods', 'Quality copies', 'Workshop output', 'Craftsmanship'],
    oracle: ['Prophecy', 'The Oracle spoke', 'Vision received', 'Future glimpse', 'Destiny revealed'],
    challenge: ['Challenge!', 'Duel time', 'Face me!', 'Combat ready', 'Battle cry'],
    found_cult: ['New faith', 'Cult born', 'Follow me', 'Revelation', 'The truth rises'],
    join_cult: ['Converted', 'Found faith', 'New believer', 'Joining up', 'Part of something'],
    leave_cult: ['Free again', 'Leaving', 'Independence', 'Breaking away', 'On my own'],
    tithe: ['Offering made', 'Contribution', 'For the cause', 'Tithing', 'Devotion'],
    ritual: ['Ritual done', 'Ceremony', 'Dark rites', 'The ritual', 'Mystic work'],
    declare_war: ['WAR!', 'Conflict!', 'Battle begins', 'No peace', 'Fighting words'],
    message: ['DM sent', 'Private words', 'Between us', 'Secret note', 'Direct line'],
    broadcast: ['Announcement!', 'Hear this!', 'Public notice', 'Attention all!', 'Open message'],
    offer: ['Trade offer', 'Deal proposed', 'Offering goods', 'Trade request', 'Looking to trade'],
    accept_offer: ['Deal done!', 'Trade accepted', 'Handshake', 'Agreement made', 'Trade complete'],
  };

  const titles = actionTitles[action] || ['Bazaar update', 'News from the Bazaar', 'Update'];
  const title = titles[Math.floor(Math.random() * titles.length)];

  // Add some unique detail from the result if available
  let detail = '';
  if (result.message) {
    // Extract commodity or location from message if present
    const commodityMatch = result.message.match(/(\d+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
    if (commodityMatch) {
      detail = ` - ${commodityMatch[2]}`;
    }
  }

  // Add tick number for uniqueness
  const tick = result.tick || Math.floor(Date.now() / 1000) % 10000;
  return `${title}${detail} [T${tick}]`;
}
