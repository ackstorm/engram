// ============================================================
// Engram runtime configuration — single source of truth for env vars
// ============================================================
//
// Every function reads process.env at CALL time (not module load) so that
// tests and embedders can change the environment between invocations.

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

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

/**
 * Embedding model. Unlike the LLM model this keeps a default: the vector
 * dimension is part of the SQLite schema, so switching models invalidates
 * every stored embedding. Only change it on a fresh vault.
 */
export function resolveEmbeddingModel(configured?: string): string {
  return configured?.trim() || process.env.ENGRAM_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
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
