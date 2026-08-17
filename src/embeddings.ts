// ============================================================
// Embedding Provider — Pluggable embedding generation
// ============================================================

import { withRetry } from './llm.js';
import {
  assertSupportedProvider,
  resolveEmbeddingModel,
  resolveEmbeddingDims,
  openaiBaseUrl,
} from './config.js';


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
    this.model = resolveEmbeddingModel(model);
    this.explicitDims = dims !== undefined || !!process.env.ENGRAM_EMBEDDING_DIMS?.trim();
    this.dims = resolveEmbeddingDims(dims, this.model);
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
// Factory — the single place an embedder is chosen
// ============================================================

/**
 * Build the embedder, or undefined when no API key is configured (the vault
 * then refuses to open unless ENGRAM_ALLOW_NO_EMBEDDER=1).
 *
 * Replaces the key-sniffing that was duplicated in mcp.ts and server.ts.
 */
export function createEmbedder(opts?: {
  apiKey?: string;
  model?: string;
  dims?: number;
  baseUrl?: string;
}): EmbeddingProvider | undefined {
  assertSupportedProvider();
  const key = opts?.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key?.trim()) return undefined;
  return new OpenAIEmbeddings(key, opts?.model, opts?.dims, opts?.baseUrl);
}
