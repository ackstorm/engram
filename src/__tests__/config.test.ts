import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  geminiBaseUrl,
  geminiEndpoint,
  resolveLlmModel,
  resolveEmbeddingModel,
  corsAllowlist,
  resolveCorsOrigin,
  requireAuthToken,
  checkBearerToken,
} from '../config.js';

const ENV_KEYS = [
  'GOOGLE_GEMINI_BASE_URL',
  'ENGRAM_LLM_MODEL',
  'ENGRAM_EMBEDDING_MODEL',
  'ENGRAM_CORS_ORIGIN',
  'ENGRAM_AUTH_TOKEN',
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

describe('geminiBaseUrl', () => {
  it('defaults to the public Google endpoint', () => {
    expect(geminiBaseUrl()).toBe('https://generativelanguage.googleapis.com');
  });

  it('honours GOOGLE_GEMINI_BASE_URL', () => {
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://gemini.internal.ackstorm.com';
    expect(geminiBaseUrl()).toBe('https://gemini.internal.ackstorm.com');
  });

  it('strips trailing slashes so URL joining stays correct', () => {
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://proxy.example.com/';
    expect(geminiBaseUrl()).toBe('https://proxy.example.com');
  });

  it('ignores a blank value', () => {
    process.env.GOOGLE_GEMINI_BASE_URL = '   ';
    expect(geminiBaseUrl()).toBe('https://generativelanguage.googleapis.com');
  });
});

describe('geminiEndpoint', () => {
  it('builds a generateContent URL against the default host', () => {
    expect(geminiEndpoint('gemini-flash-latest', 'generateContent', 'k1')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=k1',
    );
  });

  it('builds against an overridden host', () => {
    process.env.GOOGLE_GEMINI_BASE_URL = 'https://proxy.example.com';
    expect(geminiEndpoint('any-model', 'embedContent', 'k2')).toBe(
      'https://proxy.example.com/v1beta/models/any-model:embedContent?key=k2',
    );
  });

  it('url-encodes the api key', () => {
    expect(geminiEndpoint('m', 'generateContent', 'a b&c')).toContain('?key=a%20b%26c');
  });
});

describe('resolveLlmModel', () => {
  it('prefers the explicitly configured model', () => {
    process.env.ENGRAM_LLM_MODEL = 'from-env';
    expect(resolveLlmModel('from-config')).toBe('from-config');
  });

  it('falls back to ENGRAM_LLM_MODEL', () => {
    process.env.ENGRAM_LLM_MODEL = 'gemini-flash-latest';
    expect(resolveLlmModel()).toBe('gemini-flash-latest');
  });

  it('accepts any model name, including non-gemini prefixes', () => {
    expect(resolveLlmModel('llama-3.3-70b-versatile')).toBe('llama-3.3-70b-versatile');
  });

  it('throws an actionable error when nothing is configured', () => {
    expect(() => resolveLlmModel()).toThrow(/ENGRAM_LLM_MODEL/);
  });

  it('treats a blank configured value as unset', () => {
    expect(() => resolveLlmModel('   ')).toThrow(/ENGRAM_LLM_MODEL/);
  });
});

describe('resolveEmbeddingModel', () => {
  it('keeps a default because the vector dimension is baked into the schema', () => {
    expect(resolveEmbeddingModel()).toBe('gemini-embedding-001');
  });

  it('honours ENGRAM_EMBEDDING_MODEL', () => {
    process.env.ENGRAM_EMBEDDING_MODEL = 'gemini-embedding-002';
    expect(resolveEmbeddingModel()).toBe('gemini-embedding-002');
  });

  it('prefers an explicit argument', () => {
    expect(resolveEmbeddingModel('explicit')).toBe('explicit');
  });
});

describe('corsAllowlist', () => {
  it('is empty by default — CORS off unless asked for', () => {
    expect(corsAllowlist()).toEqual([]);
  });

  it('splits and trims a comma-separated list', () => {
    process.env.ENGRAM_CORS_ORIGIN = 'https://a.example.com, https://b.example.com';
    expect(corsAllowlist()).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});

describe('resolveCorsOrigin', () => {
  it('returns null when no allowlist is configured', () => {
    expect(resolveCorsOrigin('https://a.example.com')).toBeNull();
  });

  it('matches an allowed origin exactly', () => {
    expect(resolveCorsOrigin('https://a.example.com', ['https://a.example.com']))
      .toBe('https://a.example.com');
  });

  it('rejects a non-listed origin', () => {
    expect(resolveCorsOrigin('https://evil.example.com', ['https://a.example.com'])).toBeNull();
  });

  // The bug this replaces: the old prefix check let localhost.evil.com through.
  it('does NOT prefix-match', () => {
    expect(resolveCorsOrigin('http://localhost.evil.com', ['http://localhost'])).toBeNull();
    expect(resolveCorsOrigin('http://localhost:3000.evil.com', ['http://localhost:3000'])).toBeNull();
  });

  it('supports an explicit wildcard', () => {
    expect(resolveCorsOrigin('https://anything.example.com', ['*'])).toBe('*');
  });

  it('rejects an empty origin even under a wildcard-free allowlist', () => {
    expect(resolveCorsOrigin('', ['https://a.example.com'])).toBeNull();
  });
});

describe('requireAuthToken', () => {
  it('returns the configured token', () => {
    process.env.ENGRAM_AUTH_TOKEN = 's3cret';
    expect(requireAuthToken('test listener')).toBe('s3cret');
  });

  it('throws naming the listener when unset', () => {
    expect(() => requireAuthToken('engram-serve')).toThrow(/engram-serve/);
    expect(() => requireAuthToken('engram-serve')).toThrow(/ENGRAM_AUTH_TOKEN/);
  });

  it('treats a blank token as unset', () => {
    process.env.ENGRAM_AUTH_TOKEN = '  ';
    expect(() => requireAuthToken('engram-serve')).toThrow(/ENGRAM_AUTH_TOKEN/);
  });
});

describe('checkBearerToken', () => {
  it('accepts a matching bearer header', () => {
    expect(checkBearerToken('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(checkBearerToken('Bearer wrong', 's3cret')).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkBearerToken(undefined, 's3cret')).toBe(false);
  });

  it('rejects a non-bearer scheme', () => {
    expect(checkBearerToken('Basic s3cret', 's3cret')).toBe(false);
  });

  it('rejects a token of different length', () => {
    expect(checkBearerToken('Bearer s3cretlonger', 's3cret')).toBe(false);
  });
});
