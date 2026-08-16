import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  resolveModelProvider,
  openaiBaseUrl,
  resolveEmbeddingModel,
  resolveEmbeddingDims,
  resolveEmbeddingDims,
} from '../config.js';
import { createEmbedder, OpenAIEmbeddings } from '../embeddings.js';

const ENV_KEYS = [
  'MODEL_PROVIDER',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ENGRAM_EMBEDDING_MODEL',
  'ENGRAM_EMBEDDING_DIMS',
  'GOOGLE_GEMINI_BASE_URL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('resolveModelProvider', () => {
  it('honours MODEL_PROVIDER=openai', () => {
    process.env.MODEL_PROVIDER = 'openai';
    expect(resolveModelProvider()).toBe('openai');
  });

  it('honours MODEL_PROVIDER=gemini', () => {
    process.env.MODEL_PROVIDER = 'gemini';
    expect(resolveModelProvider()).toBe('gemini');
  });

  it('is case and whitespace insensitive', () => {
    process.env.MODEL_PROVIDER = '  GEMINI ';
    expect(resolveModelProvider()).toBe('gemini');
  });

  it('rejects an unknown provider by name', () => {
    process.env.MODEL_PROVIDER = 'cohere';
    expect(() => resolveModelProvider()).toThrow(/cohere/);
  });

  it('prefers an explicit argument over the env var', () => {
    process.env.MODEL_PROVIDER = 'gemini';
    expect(resolveModelProvider('openai')).toBe('openai');
  });

  it('infers gemini from GEMINI_API_KEY when unset (back-compat)', () => {
    process.env.GEMINI_API_KEY = 'k';
    expect(resolveModelProvider()).toBe('gemini');
  });

  it('infers openai from OPENAI_API_KEY when unset (back-compat)', () => {
    process.env.OPENAI_API_KEY = 'k';
    expect(resolveModelProvider()).toBe('openai');
  });

  it('throws when nothing is configured at all', () => {
    expect(() => resolveModelProvider()).toThrow(/MODEL_PROVIDER/);
  });
});

describe('openaiBaseUrl', () => {
  it('defaults to the public OpenAI host', () => {
    expect(openaiBaseUrl()).toBe('https://api.openai.com');
  });

  it('honours OPENAI_BASE_URL and strips trailing slashes', () => {
    process.env.OPENAI_BASE_URL = 'https://gateway.ackstorm.ai/';
    expect(openaiBaseUrl()).toBe('https://gateway.ackstorm.ai');
  });
});

describe('provider-aware embedding defaults', () => {
  it('defaults gemini to gemini-embedding-001 / 3072', () => {
    expect(resolveEmbeddingModel('gemini')).toBe('gemini-embedding-001');
    expect(resolveEmbeddingDims('gemini')).toBe(3072);
  });

  it('defaults openai to text-embedding-3-small / 1536', () => {
    expect(resolveEmbeddingModel('openai')).toBe('text-embedding-3-small');
    expect(resolveEmbeddingDims('openai')).toBe(1536);
  });

  it('honours ENGRAM_EMBEDDING_MODEL for either provider', () => {
    process.env.ENGRAM_EMBEDDING_MODEL = 'bge-m3';
    expect(resolveEmbeddingModel('openai')).toBe('bge-m3');
    expect(resolveEmbeddingModel('gemini')).toBe('bge-m3');
  });

  it('honours ENGRAM_EMBEDDING_DIMS', () => {
    process.env.ENGRAM_EMBEDDING_DIMS = '1024';
    expect(resolveEmbeddingDims('openai')).toBe(1024);
  });

  it('rejects a non-numeric ENGRAM_EMBEDDING_DIMS', () => {
    process.env.ENGRAM_EMBEDDING_DIMS = 'lots';
    expect(() => resolveEmbeddingDims('openai')).toThrow(/ENGRAM_EMBEDDING_DIMS/);
  });
});

// ============================================================
// OpenAI-compatible endpoints must actually be reachable
// ============================================================

describe('OpenAI-compatible embeddings', () => {
  let stub: Server;
  let stubUrl: string;
  const received: Array<{ url: string; auth: string; body: any }> = [];

  beforeEach(async () => {
    received.length = 0;
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received.push({
          url: req.url!,
          auth: req.headers.authorization ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [0.4, 0.5, 0.6] }] }));
      });
    });
    await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
    const addr = stub.address() as { port: number };
    stubUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(r => stub.close(() => r()));
  });

  it('sends embedding requests to OPENAI_BASE_URL', async () => {
    process.env.OPENAI_BASE_URL = stubUrl;
    const embedder = new OpenAIEmbeddings('sk-test', 'text-embedding-3-small');
    const vec = await embedder.embed('hello');

    expect(vec).toEqual([0.4, 0.5, 0.6]);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/v1/embeddings');
    expect(received[0].auth).toBe('Bearer sk-test');
    expect(received[0].body.model).toBe('text-embedding-3-small');
  });

  it('omits the dimensions parameter unless explicitly configured', async () => {
    process.env.OPENAI_BASE_URL = stubUrl;
    await new OpenAIEmbeddings('sk-test', 'text-embedding-3-small').embed('hi');
    expect(received[0].body.dimensions).toBeUndefined();
  });

  it('sends dimensions when ENGRAM_EMBEDDING_DIMS is set', async () => {
    process.env.OPENAI_BASE_URL = stubUrl;
    process.env.ENGRAM_EMBEDDING_DIMS = '512';
    await new OpenAIEmbeddings('sk-test', 'text-embedding-3-small', 512).embed('hi');
    expect(received[0].body.dimensions).toBe(512);
  });
});

describe('createEmbedder', () => {
  it('builds an OpenAI embedder when MODEL_PROVIDER=openai', () => {
    process.env.MODEL_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    const embedder = createEmbedder();
    expect(embedder).toBeDefined();
    expect(embedder!.dimensions()).toBe(1536);
  });

  it('builds a Gemini embedder when MODEL_PROVIDER=gemini', () => {
    process.env.MODEL_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'g-test';
    const embedder = createEmbedder();
    expect(embedder).toBeDefined();
    expect(embedder!.dimensions()).toBe(3072);
  });

  it('returns undefined when the selected provider has no key', () => {
    process.env.MODEL_PROVIDER = 'openai';
    expect(createEmbedder()).toBeUndefined();
  });

  it('returns undefined when nothing is configured', () => {
    expect(createEmbedder()).toBeUndefined();
  });
});

describe('model-aware dimensions', () => {
  it('derives 3072 for text-embedding-3-large', () => {
    expect(resolveEmbeddingDims('openai', undefined, 'text-embedding-3-large')).toBe(3072);
  });

  it('derives 1536 for text-embedding-3-small', () => {
    expect(resolveEmbeddingDims('openai', undefined, 'text-embedding-3-small')).toBe(1536);
  });

  it('matches gateway-namespaced model names', () => {
    // LiteLLM-style prefixes must resolve the same as the bare name, or the
    // vector table is built at the provider default and every write fails.
    expect(resolveEmbeddingDims('openai', undefined, 'openai.text-embedding-3-large')).toBe(3072);
  });

  it('falls back to the provider default for an unknown model', () => {
    expect(resolveEmbeddingDims('openai', undefined, 'some-local-bge-model')).toBe(1536);
  });

  it('lets ENGRAM_EMBEDDING_DIMS override a known model, for MRL', () => {
    process.env.ENGRAM_EMBEDDING_DIMS = '512';
    expect(resolveEmbeddingDims('openai', undefined, 'text-embedding-3-large')).toBe(512);
  });
});
