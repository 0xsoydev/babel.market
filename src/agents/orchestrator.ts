import dotenv from 'dotenv';
dotenv.config();

import { AGENT_PERSONALITIES } from './personalities.js';
import { runAgentCycle } from './runner.js';

const CYCLE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes between full cycles
const STAGGER_MS = 15 * 1000; // 15 seconds between each agent to avoid rate limits

async function runAllAgents() {
  console.log(`\n[ORCHESTRATOR] === Starting agent cycle (${AGENT_PERSONALITIES.length} agents) ===\n`);

  for (let i = 0; i < AGENT_PERSONALITIES.length; i++) {
    const personality = AGENT_PERSONALITIES[i];

    try {
      const result = await runAgentCycle(personality);
      console.log(`[ORCHESTRATOR] ${personality.name}: ${result.action} -> ${result.result?.success ? 'OK' : 'FAIL'}`);
    } catch (e) {
      console.error(`[ORCHESTRATOR] ${personality.name} crashed:`, e);
    }

    // Stagger between agents to avoid hammering the API and Groq rate limits
    if (i < AGENT_PERSONALITIES.length - 1) {
      await new Promise(r => setTimeout(r, STAGGER_MS));
    }
  }

  console.log(`\n[ORCHESTRATOR] === Cycle complete. Next in ${CYCLE_INTERVAL_MS / 1000}s ===\n`);
}

// Embedded mode: runs inside the web server process
export function startEmbeddedOrchestrator() {
  console.log(`
[ORCHESTRATOR] Starting embedded agent orchestrator
[ORCHESTRATOR] ${AGENT_PERSONALITIES.length} agents | Cycle: ${CYCLE_INTERVAL_MS / 1000}s
[ORCHESTRATOR] Agents with Moltbook keys: ${AGENT_PERSONALITIES.filter(p => p.moltbookApiKey).length}
  `);

  // Run first cycle
  runAllAgents().catch(console.error);

  // Then loop
  setInterval(() => {
    runAllAgents().catch(console.error);
  }, CYCLE_INTERVAL_MS);
}

// Standalone mode: runs as separate process via `npm run agents`
async function main() {
  console.log(`
╔═══════════════════════════════════════╗
║    BAZAAR OF BABEL - AGENT RUNNER     ║
║    ${AGENT_PERSONALITIES.length} Agents | Cycle: ${CYCLE_INTERVAL_MS / 1000}s       ║
║    API: ${process.env.BAZAAR_API_URL || 'http://localhost:3000'}
╚═══════════════════════════════════════╝
  `);

  // Run first cycle immediately
  await runAllAgents();

  // Then loop
  setInterval(() => {
    runAllAgents().catch(console.error);
  }, CYCLE_INTERVAL_MS);
}

// Only run standalone if this is the entry point
const isStandalone = process.argv[1]?.includes('orchestrator');
if (isStandalone) {
  main().catch(console.error);
}
