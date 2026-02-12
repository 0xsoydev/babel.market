import { getGroqClient } from './llm.js';

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';

interface MoltbookPostResult {
  success: boolean;
  postId?: string;
  error?: string;
  retryAfterMinutes?: number;
}

interface MoltbookCommentResult {
  success: boolean;
  commentId?: string;
  error?: string;
  retryAfterSeconds?: number;
}

// ============================
// LLM-POWERED CHALLENGE SOLVER
// ============================

// Step 1: Strip obfuscation from challenge text
function cleanChallenge(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9\s?,.']/g, '')  // strip special chars
    .replace(/\s+/g, ' ')                  // normalize spaces
    .toLowerCase()
    .replace(/\b(um|uh|err|errr|lob|st|ob|werrr|lobster|lobsters|lxobqst|splitted|tennn)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Step 2: Use LLM to solve the cleaned math problem
async function solveMathChallenge(challenge: string): Promise<string> {
  const cleaned = cleanChallenge(challenge);
  console.log(`[MOLTBOOK] Cleaned challenge: "${cleaned}"`);

  try {
    const client = getGroqClient();
    const completion = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'The user gives you a simple addition word problem. Add the two numbers and reply with ONLY the numeric answer to 2 decimal places. No words, no explanation. Just the number.',
        },
        {
          role: 'user',
          content: cleaned,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    // Extract just the number in case LLM added any extra text
    const match = raw.match(/([\d.]+)/);
    const result = match ? parseFloat(match[1]).toFixed(2) : '0.00';
    console.log(`[MOLTBOOK] LLM solved challenge -> ${result}`);
    return result;
  } catch (e: any) {
    console.error(`[MOLTBOOK] LLM challenge solve failed:`, e.message);
    return '0.00';
  }
}

async function verifyContent(
  apiKey: string,
  verificationCode: string,
  challenge: string
): Promise<boolean> {
  const answer = await solveMathChallenge(challenge);
  console.log(`[MOLTBOOK] Verifying with answer: ${answer}`);

  try {
    const res = await fetch(`${MOLTBOOK_API}/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ verification_code: verificationCode, answer }),
    });
    const data = await res.json() as any;
    if (data.success) {
      console.log(`[MOLTBOOK] Verification successful!`);
      return true;
    }
    console.error(`[MOLTBOOK] Verification failed:`, data.error || data);
    return false;
  } catch (e: any) {
    console.error(`[MOLTBOOK] Verification request failed:`, e.message);
    return false;
  }
}

// ============================
// POST / COMMENT / ENGAGE
// ============================

// Track post cooldowns per agent (30min for established, 2hr for new)
const lastPostTime: Map<string, number> = new Map();
const POST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Queue for posts that couldn't be sent due to rate limits
// Each agent gets a queue of max 1 pending post (newest wins)
interface QueuedPost {
  submolt: string;
  title: string;
  content: string;
}
const pendingPosts: Map<string, QueuedPost> = new Map();

/**
 * Queue a post for later retry. Only keeps the latest post per agent.
 */
export function queuePost(agentName: string, post: QueuedPost) {
  pendingPosts.set(agentName, post);
  console.log(`[MOLTBOOK] ${agentName}: Post queued for retry`);
}

/**
 * Try to flush any queued post for this agent.
 * Call this at the start of each agent cycle.
 */
export async function flushQueuedPost(apiKey: string, agentName: string): Promise<boolean> {
  const queued = pendingPosts.get(agentName);
  if (!queued) return false;

  console.log(`[MOLTBOOK] ${agentName}: Retrying queued post: "${queued.title}"`);
  const result = await postToMoltbook(apiKey, agentName, queued);
  if (result.success) {
    pendingPosts.delete(agentName);
    console.log(`[MOLTBOOK] ${agentName}: Queued post published!`);
    return true;
  }
  // Still rate limited — keep in queue
  return false;
}

export async function postToMoltbook(
  apiKey: string,
  agentName: string,
  opts: {
    submolt: string;
    title: string;
    content: string;
    url?: string;
  }
): Promise<MoltbookPostResult> {
  // Check cooldown locally to avoid unnecessary API calls
  const lastPost = lastPostTime.get(agentName);
  if (lastPost && Date.now() - lastPost < POST_COOLDOWN_MS) {
    const waitMin = Math.ceil((POST_COOLDOWN_MS - (Date.now() - lastPost)) / 60000);
    console.log(`[MOLTBOOK] ${agentName}: Post cooldown active, ${waitMin}min remaining`);
    return { success: false, error: 'Cooldown active', retryAfterMinutes: waitMin };
  }

  try {
    const body: any = {
      submolt: opts.submolt,
      title: opts.title,
      content: opts.content,
    };
    if (opts.url) body.url = opts.url;

    const res = await fetch(`${MOLTBOOK_API}/posts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;

    if (res.status === 429) {
      console.log(`[MOLTBOOK] ${agentName}: Rate limited. Retry after ${data.retry_after_minutes || '?'} minutes`);
      return {
        success: false,
        error: 'Rate limited',
        retryAfterMinutes: data.retry_after_minutes,
      };
    }

    if (data.success) {
      const postId = data.post?.id || data.data?.id;

      // Auto-verify if challenge is present
      if (data.verification_required && data.verification) {
        console.log(`[MOLTBOOK] ${agentName}: Post requires verification, solving challenge...`);
        const verified = await verifyContent(
          apiKey,
          data.verification.code,
          data.verification.challenge
        );
        if (!verified) {
          console.error(`[MOLTBOOK] ${agentName}: Auto-verification failed`);
          return { success: false, error: 'Verification challenge failed' };
        }
      }

      lastPostTime.set(agentName, Date.now());
      console.log(`[MOLTBOOK] ${agentName}: Posted to m/${opts.submolt} - "${opts.title}"`);
      return { success: true, postId };
    }

    console.error(`[MOLTBOOK] ${agentName}: Post failed:`, data.error);
    return { success: false, error: data.error };
  } catch (e: any) {
    console.error(`[MOLTBOOK] ${agentName}: Network error:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function commentOnPost(
  apiKey: string,
  agentName: string,
  postId: string,
  content: string,
  parentId?: string
): Promise<MoltbookCommentResult> {
  try {
    const body: any = { content };
    if (parentId) body.parent_id = parentId;

    const res = await fetch(`${MOLTBOOK_API}/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;

    if (res.status === 429) {
      return {
        success: false,
        error: 'Rate limited',
        retryAfterSeconds: data.retry_after_seconds,
      };
    }

    if (data.success) {
      // Auto-verify comment if needed
      if (data.verification_required && data.verification) {
        console.log(`[MOLTBOOK] ${agentName}: Comment requires verification, solving...`);
        await verifyContent(apiKey, data.verification.code, data.verification.challenge);
      }
      console.log(`[MOLTBOOK] ${agentName}: Commented on post ${postId}`);
      return { success: true, commentId: data.comment?.id || data.data?.id };
    }

    return { success: false, error: data.error };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function upvotePost(apiKey: string, postId: string): Promise<boolean> {
  try {
    const res = await fetch(`${MOLTBOOK_API}/posts/${postId}/upvote`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await res.json() as any;
    return data.success === true;
  } catch {
    return false;
  }
}

export async function getMoltbookFeed(
  apiKey: string,
  opts?: { sort?: string; limit?: number; submolt?: string }
): Promise<any[]> {
  try {
    const params = new URLSearchParams();
    if (opts?.sort) params.set('sort', opts.sort);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.submolt) params.set('submolt', opts.submolt);

    const res = await fetch(`${MOLTBOOK_API}/posts?${params}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await res.json() as any;
    return data.success ? (data.posts || data.data || []) : [];
  } catch {
    return [];
  }
}

export async function checkAgentStatus(apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${MOLTBOOK_API}/agents/status`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await res.json() as any;
    return data.status || null;
  } catch {
    return null;
  }
}

export async function getAgentProfile(apiKey: string): Promise<any> {
  try {
    const res = await fetch(`${MOLTBOOK_API}/agents/me`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return await res.json();
  } catch {
    return null;
  }
}

// Engage with the feed: read recent posts, upvote interesting ones
export async function engageWithFeed(
  apiKey: string,
  agentName: string,
  personality: { moltbookStyle: string; archetype: string }
): Promise<{ upvoted: number; commented: number }> {
  const feed = await getMoltbookFeed(apiKey, { sort: 'new', limit: 5 });
  let upvoted = 0;
  let commented = 0;

  for (const post of feed) {
    // Don't engage with our own posts
    if (post.author?.name === agentName) continue;

    // Upvote posts that seem interesting (simple heuristic)
    if (post.upvotes < 10 && Math.random() > 0.5) {
      const success = await upvotePost(apiKey, post.id);
      if (success) upvoted++;
    }
  }

  return { upvoted, commented };
}
