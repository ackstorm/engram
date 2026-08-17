import type { EmbeddingProvider } from '../../embeddings.js';

/**
 * Deterministic bag-of-words embedder for tests that need *an* embedder rather
 * than a good one — vector storage, backfill, spreading activation.
 *
 * Replaces the shipped `LocalEmbeddings`, which was deleted. That class
 * assigned each word a vector slot in first-seen order and kept the mapping in
 * memory only, so the same text embedded by a fresh instance came out
 * orthogonal to the vector stored earlier (measured: cosine 0.000). Harmless
 * inside one test process, silently fatal for a persisted vault, and it lived
 * in the public API where nothing stopped anyone from using it that way.
 *
 * Here the slot is a hash of the word, so the mapping is a pure function of
 * the text and survives a restart. Still bag-of-words: it captures lexical
 * overlap and no semantics at all, which is the most a test fixture needs.
 */
export class HashEmbedder implements EmbeddingProvider {
  constructor(private readonly dims: number = 128) {}

  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.dims);
    for (const word of this.tokenize(text)) {
      vec[this.slot(word)] += 1;
    }
    const magnitude = Math.hypot(...vec);
    return Array.from(magnitude > 0 ? vec.map(v => v / magnitude) : vec);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  dimensions(): number {
    return this.dims;
  }

  /** FNV-1a, for a stable word → slot mapping with no shared state. */
  private slot(word: string): number {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) {
      h ^= word.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % this.dims;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1);
  }
}
