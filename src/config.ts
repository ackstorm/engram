// ============================================================
// Engram runtime configuration — single source of truth for env vars
// ============================================================
//
// Every function reads process.env at CALL time (not module load) so that
// tests and embedders can change the environment between invocations.

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/** Base URL for the Google Gemini API. Override with GOOGLE_GEMINI_BASE_URL. */
export function geminiBaseUrl(): string {
  const raw = process.env.GOOGLE_GEMINI_BASE_URL?.trim();
  return (raw || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
}

/** Build a Gemini REST endpoint, e.g. geminiEndpoint(model, 'generateContent', key). */
export function geminiEndpoint(model: string, method: string, apiKey: string): string {
  return `${geminiBaseUrl()}/v1beta/models/${model}:${method}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Resolve the LLM model. There is deliberately NO built-in default (issue #6):
 * an unset model is a configuration error, not something to guess at. Guessing
 * is how the old code ended up pinned to a model nobody chose.
 */
export function resolveLlmModel(configured?: string): string {
  const model = configured?.trim() || process.env.ENGRAM_LLM_MODEL?.trim();
  if (!model) {
    throw new Error(
      '[engram] No LLM model configured. Set ENGRAM_LLM_MODEL ' +
      '(e.g. ENGRAM_LLM_MODEL=gemini-flash-latest) or pass llm.model in VaultConfig.',
    );
  }
  return model;
}

// ============================================================
// Embedding provider selection
// ============================================================

/** The env var that selects the embedding provider. Rename here only. */
const MODEL_PROVIDER_ENV = 'MODEL_PROVIDER';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';

export type ModelProvider = 'openai' | 'gemini';

const EMBEDDING_DEFAULTS: Record<ModelProvider, { model: string; dims: number }> = {
  gemini: { model: 'gemini-embedding-001', dims: 3072 },
  openai: { model: 'text-embedding-3-small', dims: 1536 },
};

/**
 * Which provider serves embeddings. Explicit argument wins, then
 * MODEL_PROVIDER, then whichever API key is present (back-compat with
 * installs that predate this variable).
 *
 * This selects the EMBEDDING provider only. The LLM provider is
 * ENGRAM_LLM_PROVIDER and is resolved separately.
 */
export function resolveModelProvider(configured?: string): ModelProvider {
  const raw = (configured ?? process.env[MODEL_PROVIDER_ENV] ?? '').trim().toLowerCase();
  if (raw === 'openai' || raw === 'gemini') return raw;
  if (raw) {
    throw new Error(
      `[engram] ${MODEL_PROVIDER_ENV} must be 'openai' or 'gemini', got '${raw}'.`,
    );
  }
  if (process.env.GEMINI_API_KEY?.trim()) return 'gemini';
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai';
  throw new Error(
    `[engram] No embedding provider configured. Set ${MODEL_PROVIDER_ENV}=openai|gemini ` +
    'together with the matching OPENAI_API_KEY or GEMINI_API_KEY.',
  );
}

/** Base URL for OpenAI-compatible embedding endpoints (Groq, vLLM, LiteLLM, Ollama…). */
export function openaiBaseUrl(): string {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  return (raw || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
}

/**
 * Embedding model. Unlike the LLM model this keeps per-provider defaults:
 * the vector dimension is part of the SQLite schema, so the model is not a
 * free choice once a vault exists.
 */
export function resolveEmbeddingModel(provider: ModelProvider, configured?: string): string {
  return (
    configured?.trim() ||
    process.env.ENGRAM_EMBEDDING_MODEL?.trim() ||
    EMBEDDING_DEFAULTS[provider].model
  );
}

/**
 * Embedding dimension. Override with ENGRAM_EMBEDDING_DIMS when pointing at a
 * gateway whose model is not one of the provider defaults.
 */
export function resolveEmbeddingDims(provider: ModelProvider, configured?: number): number {
  if (configured !== undefined) return configured;
  const raw = process.env.ENGRAM_EMBEDDING_DIMS?.trim();
  if (!raw) return EMBEDDING_DEFAULTS[provider].dims;
  const dims = Number(raw);
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`[engram] ENGRAM_EMBEDDING_DIMS must be a positive integer, got '${raw}'.`);
  }
  return dims;
}

/** ENGRAM_CORS_ORIGIN as a list of exact origins. Empty means CORS is off. */
export function corsAllowlist(): string[] {
  return (process.env.ENGRAM_CORS_ORIGIN ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Exact-match origin check. Returns the value for Access-Control-Allow-Origin,
 * or null when the origin is not allowed (in which case omit the header).
 *
 * Exact match only. The previous implementation used
 * `origin.startsWith('http://localhost')`, which any attacker could satisfy by
 * serving from http://localhost.evil.com.
 */
export function resolveCorsOrigin(
  requestOrigin: string,
  allowlist: string[] = corsAllowlist(),
): string | null {
  if (allowlist.length === 0) return null;
  if (allowlist.includes('*')) return '*';
  if (!requestOrigin) return null;
  return allowlist.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Every HTTP listener requires a bearer token — no exceptions for loopback.
 * Throws at startup with an actionable message; callers should let it crash.
 */
export function requireAuthToken(what: string): string {
  const token = process.env.ENGRAM_AUTH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      `[engram] ${what} requires ENGRAM_AUTH_TOKEN. HTTP listeners are never unauthenticated. ` +
      'Generate one with: openssl rand -hex 32',
    );
  }
  return token;
}

/** Length-checked, constant-time bearer comparison. */
export function checkBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
