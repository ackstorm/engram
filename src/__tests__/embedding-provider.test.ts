import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  assertSupportedProvider,
  openaiBaseUrl,
  resolveEmbeddingModel,
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

// MODEL_PROVIDER survives only as a rejection: installs carrying
// MODEL_PROVIDER=gemini also carry a Gemini key and model name, and sending
// those to an OpenAI-compatible endpoint fails far from the cause.
describe('assertSupportedProvider', () => {
  it('accepts MODEL_PROVIDER=openai', () => {
    process.env.MODEL_PROVIDER = 'openai';
    expect(() => assertSupportedProvider()).not.toThrow();
  });

  it('accepts an unset MODEL_PROVIDER', () => {
    expect(() => assertSupportedProvider()).not.toThrow();
  });

  it('rejects a leftover MODEL_PROVIDER=gemini with an actionable message', () => {
    process.env.MODEL_PROVIDER = 'gemini';
    expect(() => assertSupportedProvider()).toThrow(/gemini/);
    expect(() => assertSupportedProvider()).toThrow(/OPENAI_BASE_URL/);
  });

  it('rejects any other provider name', () => {
    process.env.MODEL_PROVIDER = 'cohere';
    expect(() => assertSupportedProvider()).toThrow(/cohere/);
  });

  it('is case and whitespace insensitive', () => {
    expect(() => assertSupportedProvider('  OPENAI ')).not.toThrow();
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

describe('embedding defaults', () => {
  it('defaults to text-embedding-3-small / 1536', () => {
    expect(resolveEmbeddingModel()).toBe('text-embedding-3-small');
    expect(resolveEmbeddingDims()).toBe(1536);
  });

  it('honours ENGRAM_EMBEDDING_MODEL', () => {
    process.env.ENGRAM_EMBEDDING_MODEL = 'bge-m3';
    expect(resolveEmbeddingModel()).toBe('bge-m3');
  });

  it('honours ENGRAM_EMBEDDING_DIMS', () => {
    process.env.ENGRAM_EMBEDDING_DIMS = '1024';
    expect(resolveEmbeddingDims()).toBe(1024);
  });

  it('rejects a non-numeric ENGRAM_EMBEDDING_DIMS', () => {
    process.env.ENGRAM_EMBEDDING_DIMS = 'lots';
    expect(() => resolveEmbeddingDims()).toThrow(/ENGRAM_EMBEDDING_DIMS/);
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
  it('builds an embedder from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const embedder = createEmbedder();
    expect(embedder).toBeDefined();
    expect(embedder!.dimensions()).toBe(1536);
  });

  it('returns undefined when no key is configured', () => {
    expect(createEmbedder()).toBeUndefined();
  });

  // A GEMINI_API_KEY alone must not silently produce a working embedder — the
  // key would be sent to an OpenAI-compatible endpoint that will reject it.
  it('ignores a stray GEMINI_API_KEY', () => {
    process.env.GEMINI_API_KEY = 'g-test';
    expect(createEmbedder()).toBeUndefined();
  });

  it('refuses to build when MODEL_PROVIDER still says gemini', () => {
    process.env.MODEL_PROVIDER = 'gemini';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => createEmbedder()).toThrow(/no longer supported/);
  });
});

describe('model-aware dimensions', () => {
  it('derives 3072 for text-embedding-3-large', () => {
    expect(resolveEmbeddingDims(undefined, 'text-embedding-3-large')).toBe(3072);
  });

  it('derives 1536 for text-embedding-3-small', () => {
    expect(resolveEmbeddingDims(undefined, 'text-embedding-3-small')).toBe(1536);
  });

  it('matches gateway-namespaced model names', () => {
    // LiteLLM-style prefixes must resolve the same as the bare name, or the
    // vector table is built at the provider default and every write fails.
    expect(resolveEmbeddingDims(undefined, 'openai.text-embedding-3-large')).toBe(3072);
  });

  it('falls back to the generic default for an unknown model', () => {
    expect(resolveEmbeddingDims(undefined, 'some-local-bge-model')).toBe(1536);
  });

  it('lets ENGRAM_EMBEDDING_DIMS override a known model, for MRL', () => {
    process.env.ENGRAM_EMBEDDING_DIMS = '512';
    expect(resolveEmbeddingDims(undefined, 'text-embedding-3-large')).toBe(512);
  });
});
