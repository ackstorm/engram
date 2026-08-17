// ============================================================
// LLM transport — one OpenAI-compatible chat client
// ============================================================
//
// Native Gemini and Anthropic clients used to live inline at five call sites
// (vault, mcp, server, auto-ingest, claude-watcher), each hand-rolling the same
// fetch with a different request and response shape. They are gone: every
// gateway worth pointing at speaks /v1/chat/completions, including for Gemini
// and Claude models, so one client covers all of them.

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

/**
 * Retry on rate limits with the delay the provider asks for, falling back to
 * linear backoff. Shared by the chat and embedding paths.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 3, label = 'API call' }: { maxRetries?: number; label?: string } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate');
      if (is429 && attempt < maxRetries) {
        const retryMatch = msg.match(/retry in ([\d.]+)s/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 1 : (attempt + 1) * 15;
        console.error(`[engram] ${label} rate limited. Retrying in ${waitSec}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (is429) {
        throw new Error(
          `[engram] Rate limited after ${maxRetries} retries. ` +
          `Check your gateway's rate limits. ` +
          `Either wait a moment and retry, or use a key with a higher quota. ` +
          `Details: ${msg}`,
        );
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  /** API ROOT, not the versioned path — /v1/chat/completions is appended. */
  baseUrl?: string;
  maxTokens?: number;
}

/**
 * One chat completion, asking for a JSON object back. Returns the raw message
 * content; the caller parses it, because callers disagree on what shape they
 * expect and on what to do when the model returns prose instead.
 */
export async function chatJson(prompt: string, opts: ChatOptions): Promise<string> {
  const baseUrl = (opts.baseUrl ?? process.env.ENGRAM_LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL)
    .replace(/\/+$/, '');
  return withRetry(async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI-compatible API error: ${response.status} ${err}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }, { label: `OpenAI-compatible chat (${baseUrl})` });
}
