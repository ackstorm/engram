// ============================================================
// Embedding Provider — Pluggable embedding generation
// ============================================================

import {
  geminiEndpoint,
  resolveEmbeddingModel,
  resolveEmbeddingDims,
  resolveModelProvider,
  openaiBaseUrl,
  type ModelProvider,
} from './config.js';

// ============================================================
// Retry helper for rate-limited API calls
// ============================================================

async function withRetry<T>(
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
          `Free Gemini tier allows ~20 requests/minute. ` +
          `Either wait a moment and retry, or upgrade to a paid API key. ` +
          `Details: ${msg}`,
        );
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

export interface EmbeddingProvider {
  /** Generate an embedding vector for the given text */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts (batch) */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Dimension of the embedding vectors */
  dimensions(): number;
}

// ============================================================
// OpenAI Embeddings
// ============================================================

export class OpenAIEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private dims: number;
  private baseUrl: string;
  /** Only sent when the caller explicitly chose a dimension. */
  private explicitDims: boolean;

  constructor(apiKey: string, model?: string, dims?: number, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = resolveEmbeddingModel('openai', model);
    this.explicitDims = dims !== undefined || !!process.env.ENGRAM_EMBEDDING_DIMS?.trim();
    this.dims = resolveEmbeddingDims('openai', dims, this.model);
    this.baseUrl = baseUrl?.replace(/\/+$/, '') ?? openaiBaseUrl();
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          // Many OpenAI-compatible gateways reject an unknown `dimensions`
          // field, so only send it when it was actually asked for.
          ...(this.explicitDims ? { dimensions: this.dims } : {}),
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI-compatible Embeddings API error: ${response.status} ${err}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index?: number }>;
      };

      // Sort by index to preserve order
      return data.data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map(d => d.embedding);
    }, { label: `OpenAI-compatible embedContent (${this.baseUrl})` });
  }

  dimensions(): number {
    return this.dims;
  }
}

// ============================================================
// Gemini Embeddings (free tier available)
// ============================================================

export class GeminiEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private dims: number;

  constructor(apiKey: string, model?: string, dims?: number) {
    this.apiKey = apiKey;
    this.model = resolveEmbeddingModel('gemini', model);
    this.dims = resolveEmbeddingDims('gemini', dims, this.model);
  }

  async embed(text: string): Promise<number[]> {
    return withRetry(async () => {
      const response = await fetch(
        geminiEndpoint(this.model, 'embedContent', this.apiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
          }),
        },
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini Embeddings API error: ${response.status} ${err}`);
      }

      const data = await response.json() as { embedding: { values: number[] } };
      return data.embedding.values;
    }, { label: 'Gemini embedContent' });
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return withRetry(async () => {
      const response = await fetch(
        geminiEndpoint(this.model, 'batchEmbedContents', this.apiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: texts.map(text => ({
              model: `models/${this.model}`,
              content: { parts: [{ text }] },
          })),
          }),
        },
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini Batch Embeddings API error: ${response.status} ${err}`);
      }

      const data = await response.json() as { embeddings: Array<{ values: number[] }> };
      return data.embeddings.map(e => e.values);
    }, { label: 'Gemini batchEmbedContents' });
  }

  dimensions(): number {
    return this.dims;
  }
}

// ============================================================
// Local/Minimal Embeddings (for testing without API keys)
// ============================================================

/**
 * Simple bag-of-words TF embedding for testing purposes.
 * NOT suitable for production — use OpenAI or another real provider.
 * But allows the full pipeline to work without API keys.
 */
export class LocalEmbeddings implements EmbeddingProvider {
  private dims: number;
  private vocabulary: Map<string, number> = new Map();
  private nextSlot = 0;

  constructor(dims: number = 256) {
    this.dims = dims;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float32Array(this.dims);
    const words = this.tokenize(text);

    for (const word of words) {
      let slot = this.vocabulary.get(word);
      if (slot === undefined) {
        slot = this.nextSlot % this.dims;
        this.vocabulary.set(word, slot);
        this.nextSlot++;
      }
      vec[slot] += 1;
    }

    // Normalize to unit vector
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < this.dims; i++) {
        vec[i] /= magnitude;
      }
    }

    return Array.from(vec);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  dimensions(): number {
    return this.dims;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1);
  }
}

// ============================================================
// Factory — the single place an embedder is chosen
// ============================================================

/**
 * Build the configured embedder, or undefined when the selected provider has
 * no API key (the vault then falls back to keyword search).
 *
 * Replaces the key-sniffing that was duplicated in mcp.ts and server.ts.
 */
export function createEmbedder(opts?: {
  provider?: string;
  apiKey?: string;
  model?: string;
  dims?: number;
  baseUrl?: string;
}): EmbeddingProvider | undefined {
  let provider: ModelProvider;
  try {
    provider = resolveModelProvider(opts?.provider);
  } catch {
    return undefined; // nothing configured — keyword-only mode
  }

  if (provider === 'gemini') {
    const key = opts?.apiKey ?? process.env.GEMINI_API_KEY;
    if (!key?.trim()) return undefined;
    return new GeminiEmbeddings(key, opts?.model, opts?.dims);
  }

  const key = opts?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key?.trim()) return undefined;
  return new OpenAIEmbeddings(key, opts?.model, opts?.dims, opts?.baseUrl);
}
