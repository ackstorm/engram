// ============================================================
// Engram runtime configuration — single source of truth for env vars
// ============================================================
//
// Every function reads process.env at CALL time (not module load) so that
// tests and embedders can change the environment between invocations.

import { existsSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import type { VaultConfig } from './types.js';

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
      '(e.g. ENGRAM_LLM_MODEL=gpt-4o-mini) or pass llm.model in VaultConfig.',
    );
  }
  return model;
}

// ============================================================
// Embeddings
// ============================================================
//
// One transport: the OpenAI-compatible /v1/embeddings and /v1/chat/completions
// endpoints. Native Gemini and Anthropic clients were removed — every gateway
// worth pointing at (LiteLLM, vLLM, Groq, Ollama, OpenRouter, Vertex's
// compatibility layer) speaks this shape, including for Gemini and Claude
// models, so the second and third clients bought nothing but branches.

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_DIMS = 1536;

/** The env var that used to select between providers. Kept only to reject it. */
const MODEL_PROVIDER_ENV = 'MODEL_PROVIDER';

/**
 * Reject a leftover MODEL_PROVIDER=gemini rather than ignoring it. An install
 * carrying that value has a Gemini key and a Gemini model name; silently
 * sending both to an OpenAI-compatible endpoint fails somewhere far less
 * obvious than startup.
 */
export function assertSupportedProvider(configured?: string): void {
  const raw = (configured ?? process.env[MODEL_PROVIDER_ENV] ?? '').trim().toLowerCase();
  if (raw && raw !== 'openai') {
    throw new Error(
      `[engram] ${MODEL_PROVIDER_ENV}='${raw}' is no longer supported — only the ` +
      "OpenAI-compatible route remains. Point OPENAI_BASE_URL at a gateway that " +
      'proxies the model you want (LiteLLM, vLLM, OpenRouter, Vertex AI) and set ' +
      `${MODEL_PROVIDER_ENV}=openai.`,
    );
  }
}

/**
 * LLM config for consolidation, ask(), checkpoint() and audit() — separate
 * from the embedding config above. Shared by MemoryRouter.open() and the MCP
 * server so both build the same {apiKey, baseUrl} shape from the same env vars.
 */
export function resolveLlmConfig(): VaultConfig['llm'] | undefined {
  const apiKey = process.env.ENGRAM_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const baseUrl = process.env.ENGRAM_LLM_BASE_URL;
  return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

/** Base URL for OpenAI-compatible embedding endpoints (Groq, vLLM, LiteLLM, Ollama…). */
export function openaiBaseUrl(): string {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  return (raw || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
}

/**
 * Embedding model. Unlike the LLM model this keeps a default: the vector
 * dimension is part of the SQLite schema, so the model is not a free choice
 * once a vault exists.
 */
export function resolveEmbeddingModel(configured?: string): string {
  return (
    configured?.trim() ||
    process.env.ENGRAM_EMBEDDING_MODEL?.trim() ||
    DEFAULT_EMBEDDING_MODEL
  );
}

/**
 * Native output width of models we know, matched on suffix so gateway
 * namespacing ("openai.text-embedding-3-large") resolves the same as the bare
 * name. Without this the generic default is used, and switching from -small to
 * -large builds the vector table at 1536 while the API returns 3072 — every
 * write then fails with a bare SQL error, and because embedding is
 * fire-and-forget the vault silently ends up with no vectors at all.
 *
 * The Gemini models stay listed: a gateway can serve them over the
 * OpenAI-compatible /v1/embeddings route, which is the only route left.
 */
const KNOWN_MODEL_DIMS: Array<[string, number]> = [
  ['text-embedding-3-small', 1536],
  ['text-embedding-3-large', 3072],
  ['text-embedding-ada-002', 1536],
  ['gemini-embedding-001', 3072],
  ['gemini-embedding-2', 3072],
];

/** Native dimension for a model name, or undefined when unrecognised. */
export function knownModelDims(model: string): number | undefined {
  const name = model.trim().toLowerCase();
  return KNOWN_MODEL_DIMS.find(([m]) => name.endsWith(m))?.[1];
}

/**
 * Embedding dimension. Resolution order: explicit argument, then
 * ENGRAM_EMBEDDING_DIMS, then the model's known native width, then the
 * generic default. Set ENGRAM_EMBEDDING_DIMS only for a model we do not
 * recognise, or to request a shortened MRL vector.
 */
export function resolveEmbeddingDims(configured?: number, model?: string): number {
  if (configured !== undefined) return configured;
  const raw = process.env.ENGRAM_EMBEDDING_DIMS?.trim();
  if (!raw) {
    const known = model ? knownModelDims(model) : undefined;
    return known ?? DEFAULT_EMBEDDING_DIMS;
  }
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

// ============================================================
// Memory scope and vault paths
// ============================================================

export type MemoryScope = 'project' | 'global';

function slugify(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function findGitRoot(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Which project this process belongs to:
 *   1. ENGRAM_PROJECT   2. enclosing git repo basename   3. cwd basename
 *
 * MCP hosts spawn one server process per project with the project as its cwd,
 * which is what makes 2 and 3 meaningful. ENGRAM_PROJECT comes first because
 * that behaviour is only verified on Claude Code. Never throws.
 */
export function resolveProject(cwd: string = process.cwd()): string {
  const explicit = process.env.ENGRAM_PROJECT?.trim();
  if (explicit) return slugify(explicit);
  try {
    const gitRoot = findGitRoot(cwd);
    return slugify(basename(gitRoot ?? resolve(cwd)));
  } catch {
    return 'default';
  }
}

/** True when both scopes collapse onto a single file (daemon / legacy layouts). */
/**
 * The single-file path both scopes collapse onto (ENGRAM_DB_PATH or
 * ENGRAM_OWNER), or null when neither override is set. Single source of
 * truth for the ENGRAM_DB_PATH/ENGRAM_OWNER precedence — isSingleStoreMode
 * and resolveVaultPath both derive from it so they can't drift apart.
 */
function singleStoreOverridePath(): string | null {
  const explicitPath = process.env.ENGRAM_DB_PATH?.trim();
  if (explicitPath) return explicitPath;

  const owner = process.env.ENGRAM_OWNER?.trim();
  if (owner) return join(homedir(), '.engram', `${owner}.db`);

  return null;
}

export function isSingleStoreMode(): boolean {
  return singleStoreOverridePath() !== null;
}

/** Absolute path to the vault backing a given scope. */
export function resolveVaultPath(scope: MemoryScope, cwd?: string): string {
  const override = singleStoreOverridePath();
  if (override) return override;

  return scope === 'global'
    ? join(homedir(), '.engram', 'global.db')
    : join(homedir(), '.engram', 'projects', `${resolveProject(cwd)}.db`);
}
