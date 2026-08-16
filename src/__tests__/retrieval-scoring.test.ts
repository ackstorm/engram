import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Vault } from '../vault.js';
import { cosineFromL2 } from '../store.js';
import { fuseRetrievalScores, normaliseBm25 } from '../vault.js';
import type { EmbeddingProvider } from '../embeddings.js';

// ============================================================
// Bug A — L2 → cosine
// ============================================================

describe('cosineFromL2', () => {
  it('maps identical vectors to similarity 1', () => {
    expect(cosineFromL2(0)).toBeCloseTo(1, 6);
  });

  it('maps orthogonal vectors to 0', () => {
    expect(cosineFromL2(Math.SQRT2)).toBeCloseTo(0, 6);
  });

  it('maps opposite vectors to -1', () => {
    expect(cosineFromL2(2)).toBeCloseTo(-1, 6);
  });

  it('recovers the documented thresholds', () => {
    // 0.92 similarity is L2 = sqrt(2 - 2*0.92) = 0.4
    expect(cosineFromL2(0.4)).toBeCloseTo(0.92, 6);
    // The value the code currently uses as "0.92" is really 0.9968
    expect(cosineFromL2(0.08)).toBeCloseTo(0.9968, 4);
  });

  it('clamps out-of-range input rather than returning nonsense', () => {
    expect(cosineFromL2(3)).toBeGreaterThanOrEqual(-1);
    expect(cosineFromL2(-1)).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// Bug B — the fused base score must have real dynamic range
// ============================================================

describe('fuseRetrievalScores', () => {
  const vec = new Map([['a', 0.90], ['b', 0.55], ['c', 0.30]]);

  it('gives a clearly better match a decisive margin', () => {
    const out = fuseRetrievalScores(vec, new Map(), true, false);
    // The step-8 multiplier spans 0.64-0.89, a factor of 1.39. The base score
    // gap between a strong and a mediocre match must exceed that or salience
    // decides the ranking instead of relevance.
    expect(out.get('a')! / out.get('b')!).toBeGreaterThan(1.39);
  });

  it('preserves the shape of the similarity distribution', () => {
    const out = fuseRetrievalScores(vec, new Map(), true, false);
    expect(out.get('a')).toBeGreaterThan(out.get('b')!);
    expect(out.get('b')).toBeGreaterThan(out.get('c')!);
  });

  it('caps the primary signal at 0.6', () => {
    const out = fuseRetrievalScores(new Map([['a', 1.0]]), new Map(), true, false);
    expect(out.get('a')).toBeCloseTo(0.6, 6);
  });

  it('gives lexical-only mode the full ceiling, not half of it', () => {
    // Regression: the old 2/(K+1) normalisation halved every score when only
    // one retriever ran, which is the permanent state without an embedder.
    const out = fuseRetrievalScores(new Map(), new Map([['a', 1.0]]), false, true);
    expect(out.get('a')).toBeCloseTo(0.6, 6);
  });

  it('ranks an item found by both above one found by only one', () => {
    const out = fuseRetrievalScores(
      new Map([['both', 0.7], ['vecOnly', 0.7]]),
      new Map([['both', 1.0]]),
      true, true,
    );
    expect(out.get('both')).toBeGreaterThan(out.get('vecOnly')!);
  });
});

// ============================================================
// End to end — the query must decide the answer
// ============================================================

/** Deterministic embedder: each text gets a hand-placed vector. No network. */
class StubEmbedder implements EmbeddingProvider {
  constructor(private readonly vectors: Record<string, number[]>) {}
  private lookup(text: string): number[] {
    for (const [key, v] of Object.entries(this.vectors)) {
      if (text.includes(key)) return this.normalise(v);
    }
    return this.normalise([0, 0, 1]);
  }
  private normalise(v: number[]): number[] {
    const n = Math.hypot(...v);
    return v.map(x => x / n);
  }
  async embed(text: string) { return this.lookup(text); }
  async embedBatch(texts: string[]) { return texts.map(t => this.lookup(t)); }
  dimensions() { return 3; }
}

describe('recall is driven by the query', () => {
  it('returns the semantically closest memory first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-scoring-'));
    // 'incidents' sits near 'on-call'; 'language' sits near 'TypeScript'.
    const embedder = new StubEmbedder({
      'incidents':  [1, 0, 0],
      'on-call':    [0.97, 0.24, 0],
      'language':   [0, 1, 0],
      'TypeScript': [0.24, 0.97, 0],
      'Coffee':     [0, 0, 1],
      'Kubernetes': [0, 0, 1],
    });
    const v = new Vault({ owner: 't', dbPath: join(dir, 'v.db') }, embedder);
    try {
      v.remember({ content: 'Marta is the SRE lead and owns the on-call rotation' });
      v.remember({ content: 'Juan Carlos prefers TypeScript for backend services' });
      v.remember({ content: 'Coffee machine on floor 3 is broken again' });
      v.remember({ content: 'Kubernetes migration is planned for Q3' });
      await v.flush();

      const incidents = await v.recall({ context: 'who handles incidents', limit: 2 });
      expect(incidents[0].content).toContain('on-call');

      const language = await v.recall({ context: 'what language do we use', limit: 2 });
      expect(language[0].content).toContain('TypeScript');

      // The two queries must not return the same thing.
      expect(incidents[0].id).not.toBe(language[0].id);
    } finally {
      await v.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('similarity thresholds', () => {
  it('treats paraphrases as near-duplicates, not distinct memories', async () => {
    // Two vectors at cosine 0.95 — inside the documented 0.92 dedup band,
    // but L2 0.316, far outside the 0.08 the code compares against today.
    const embedder = new StubEmbedder({
      'deploys on Friday':   [1, 0, 0],
      'ships every Friday':  [0.95, 0.312, 0],
    });
    const dir = mkdtempSync(join(tmpdir(), 'engram-dedup-'));
    const v = new Vault({ owner: 't', dbPath: join(dir, 'v.db') }, embedder);
    try {
      v.remember({ content: 'The team deploys on Friday' });
      await v.flush();
      v.remember({ content: 'The team ships every Friday' });
      await v.flush();
      // Dedup marks the loser 'superseded' rather than deleting it, so
      // stats().total (a raw row count) stays at 2 either way — recall,
      // which filters to active memories by default, is the real signal.
      const active = await v.recall({ context: 'Friday', limit: 10 });
      expect(active.length).toBe(1);
    } finally {
      await v.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Stopword-only lexical matches must not outweigh real semantics
// ============================================================

describe('normaliseBm25', () => {
  // Calibrated against measured SQLite bm25() output. Across corpora of 5 to
  // 401 memories, stopword noise sits at 1.8e-6 to 3.9e-6 and does not grow,
  // while the weakest genuine 1-term match is 2.07 and grows to 10.6.

  it('discards stopword noise regardless of corpus size', () => {
    const noise = [
      { id: 'a', score: 3.91e-6 }, { id: 'b', score: 3.83e-6 }, { id: 'c', score: 1.84e-6 },
    ];
    expect(normaliseBm25(noise, 2).size).toBe(0);
  });

  it('keeps the weakest genuine match observed', () => {
    // 2.07 = 1-term match in a 5-memory corpus, the smallest real score measured.
    expect(normaliseBm25([{ id: 'a', score: 2.07 }], 1).get('a')).toBeGreaterThan(0.3);
  });

  it('does not promote a mediocre match to full marks for lack of competition', () => {
    // The min-max failure mode: a lone result normalised to exactly 1.0.
    expect(normaliseBm25([{ id: 'a', score: 2.07 }], 1).get('a')).toBeLessThan(0.6);
  });

  it('scores a strong match well above a weak one', () => {
    const out = normaliseBm25([{ id: 'strong', score: 10.6 }, { id: 'weak', score: 2.07 }], 1);
    expect(out.get('strong')!).toBeGreaterThan(0.9);
    expect(out.get('strong')! - out.get('weak')!).toBeGreaterThan(0.3);
  });

  it('adapts to query length so longer queries are not inflated', () => {
    // A 4-term query scoring 12.4 is as ordinary as a 1-term query scoring 2.07.
    const oneTerm = normaliseBm25([{ id: 'a', score: 2.07 }], 1).get('a')!;
    const fourTerm = normaliseBm25([{ id: 'a', score: 12.4 }], 4).get('a')!;
    expect(Math.abs(oneTerm - fourTerm)).toBeLessThan(0.15);
  });

  it('never reaches 1, so lexical evidence cannot max out the blend', () => {
    // 63.4 is the largest score measured (4-term query, 401 memories).
    expect(normaliseBm25([{ id: 'a', score: 63.4 }], 4).get('a')!).toBeLessThan(1);
  });

  it('returns nothing for no hits', () => {
    expect(normaliseBm25([], 3).size).toBe(0);
  });
});

describe('stopwords', () => {
  it('does not let a shared stopword decide the ranking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-stopword-'));
    // 'container' sits near 'Kubernetes'. The distractors share only the word
    // "is" with the query — lexically worthless, semantically unrelated.
    const embedder = new StubEmbedder({
      'container':  [1, 0, 0],
      'Kubernetes': [0.95, 0.31, 0],
      'Coffee':     [0, 0, 1],
      'Marta':      [0, 1, 0],
    });
    const v = new Vault({ owner: 't', dbPath: join(dir, 'v.db') }, embedder);
    try {
      v.remember({ content: 'The team decided to migrate the gateway to Kubernetes in Q3' });
      v.remember({ content: 'Coffee machine on floor 3 is broken again' });
      v.remember({ content: 'Marta is the SRE lead and owns the on-call rotation' });
      await v.flush();

      const hits = await v.recall({ context: 'what is our container strategy?', limit: 1 });
      expect(hits[0].content).toContain('Kubernetes');
    } finally {
      await v.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hybrid alpha', () => {
  it('gives lexical the full weight when no vector search ran', () => {
    // Regression: computing wl as 1 - alpha left a keyword-only vault with
    // zero signal at alpha 1.0, returning nothing at all.
    const prev = process.env.ENGRAM_HYBRID_ALPHA;
    process.env.ENGRAM_HYBRID_ALPHA = '1';
    try {
      const out = fuseRetrievalScores(new Map(), new Map([['a', 0.5]]), false, true);
      expect(out.get('a')).toBeCloseTo(0.6 * 0.5, 6);
    } finally {
      if (prev === undefined) delete process.env.ENGRAM_HYBRID_ALPHA;
      else process.env.ENGRAM_HYBRID_ALPHA = prev;
    }
  });

  it('falls back to the default for an out-of-range value', () => {
    const prev = process.env.ENGRAM_HYBRID_ALPHA;
    process.env.ENGRAM_HYBRID_ALPHA = 'banana';
    try {
      const out = fuseRetrievalScores(new Map([['a', 1]]), new Map(), true, false);
      expect(out.get('a')).toBeCloseTo(0.6, 6);
    } finally {
      if (prev === undefined) delete process.env.ENGRAM_HYBRID_ALPHA;
      else process.env.ENGRAM_HYBRID_ALPHA = prev;
    }
  });
});
