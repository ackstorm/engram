import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEngramServer } from '../server.js';
import type { VaultConfig } from '../types.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================
// Engram REST API Server Tests
// ============================================================

const tmpDir = mkdtempSync(join(tmpdir(), 'engram-server-test-'));
const dbPath = join(tmpDir, 'test.db');
const TEST_TOKEN = 'test-token-abc123';

const vaultConfig: VaultConfig = {
  owner: 'test-agent',
  dbPath,
};

let baseUrl: string;
let server: ReturnType<typeof createEngramServer>;

beforeAll(async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  server = createEngramServer({
    port,
    host: '127.0.0.1',
    authToken: TEST_TOKEN,
    vaults: {},
    defaultVault: vaultConfig,
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper — every call carries the bearer token.
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ============================================================
// Tests
// ============================================================

describe('Health', () => {
  it('GET /health returns ok', async () => {
    const { status, data } = await api('GET', '/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('Memories', () => {
  let memoryId: string;

  it('POST /v1/memories creates a memory from string', async () => {
    const { status, data } = await api('POST', '/v1/memories', {
      content: 'User prefers dark mode and concise answers',
      scope: 'project',
      entities: ['User'],
      topics: ['preferences'],
      salience: 0.8,
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.content).toBe('User prefers dark mode and concise answers');
    expect(data.entities).toContain('User');
    memoryId = data.id;
  });

  it('POST /v1/memories creates another memory', async () => {
    const { status, data } = await api('POST', '/v1/memories', {
      content: 'User is training for a marathon in April',
      scope: 'project',
      entities: ['User', 'marathon'],
      topics: ['fitness', 'goals'],
      salience: 0.7,
    });
    expect(status).toBe(201);
    expect(data.entities).toContain('marathon');
  });

  it('POST a third memory for graph testing', async () => {
    const { status } = await api('POST', '/v1/memories', {
      content: 'User switched from Vue to React last month',
      scope: 'project',
      entities: ['User', 'React', 'Vue'],
      topics: ['engineering', 'frontend'],
    });
    expect(status).toBe(201);
  });

  it('GET /v1/memories/recall returns relevant memories', async () => {
    const { status, data } = await api('GET', '/v1/memories/recall?context=dark+mode+preferences');
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
    expect(data.memories[0].content).toContain('dark mode');
  });

  it('POST /v1/memories/recall with body works', async () => {
    const { status, data } = await api('POST', '/v1/memories/recall', {
      context: 'fitness goals',
      entities: ['User'],
      limit: 5,
    });
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
  });

  it('GET /v1/memories/recall requires context', async () => {
    const { status, data } = await api('GET', '/v1/memories/recall');
    expect(status).toBe(400);
    expect(data.error).toContain('context');
  });

  it('DELETE /v1/memories/:id soft forgets', async () => {
    const { status, data } = await api('DELETE', `/v1/memories/${memoryId}`);
    expect(status).toBe(200);
    expect(data.deleted).toBe(memoryId);
    expect(data.hard).toBe(false);
  });

  it('DELETE /v1/memories/:id?hard=true hard deletes', async () => {
    // Create a throwaway memory
    const { data: mem } = await api('POST', '/v1/memories', {
      content: 'Throwaway memory for deletion test',
      scope: 'project',
    });
    const { status, data } = await api('DELETE', `/v1/memories/${mem.id}?hard=true`);
    expect(status).toBe(200);
    expect(data.hard).toBe(true);
  });
});

describe('Connections', () => {
  let mem1Id: string;
  let mem2Id: string;

  beforeAll(async () => {
    const { data: m1 } = await api('POST', '/v1/memories', {
      content: 'TypeScript is the best language for SDKs',
      scope: 'project',
      entities: ['TypeScript'],
      topics: ['engineering'],
    });
    const { data: m2 } = await api('POST', '/v1/memories', {
      content: 'JavaScript ecosystem has the most packages',
      scope: 'project',
      entities: ['JavaScript'],
      topics: ['engineering'],
    });
    mem1Id = m1.id;
    mem2Id = m2.id;
  });

  it('POST /v1/connections creates an edge', async () => {
    const { status, data } = await api('POST', '/v1/connections', {
      sourceId: mem1Id,
      targetId: mem2Id,
      type: 'supports',
      strength: 0.7,
    });
    expect(status).toBe(201);
    expect(data.sourceId).toBe(mem1Id);
    expect(data.type).toBe('supports');
  });

  it('GET /v1/memories/:id/neighbors returns connected memories', async () => {
    const { status, data } = await api('GET', `/v1/memories/${mem1Id}/neighbors`);
    expect(status).toBe(200);
    expect(data.memories.length).toBeGreaterThan(0);
  });

  it('POST /v1/connections requires all fields', async () => {
    const { status, data } = await api('POST', '/v1/connections', {
      sourceId: mem1Id,
    });
    expect(status).toBe(400);
  });
});

describe('Consolidation', () => {
  it('POST /v1/consolidate reports per scope', async () => {
    const { status, data } = await api('POST', '/v1/consolidate');
    expect(status).toBe(200);
    for (const scope of ['global', 'project']) {
      expect(data[scope].episodesProcessed).toBeDefined();
      expect(data[scope].startedAt).toBeDefined();
      expect(data[scope].completedAt).toBeDefined();
    }
  });
});

describe('Entities', () => {
  it('GET /v1/entities lists entities', async () => {
    const { status, data } = await api('GET', '/v1/entities');
    expect(status).toBe(200);
    expect(Array.isArray(data.entities)).toBe(true);
  });
});

describe('Stats', () => {
  it('GET /v1/stats returns statistics per scope', async () => {
    const { status, data } = await api('GET', '/v1/stats');
    expect(status).toBe(200);
    expect(data.global.total).toBeDefined();
    expect(data.project.total).toBeDefined();
  });
});

describe('Export', () => {
  it('POST /v1/export returns full vault data', async () => {
    const { status, data } = await api('POST', '/v1/export');
    expect(status).toBe(200);
    expect(data.memories).toBeDefined();
    expect(Array.isArray(data.memories)).toBe(true);
  });
});

describe('Scope', () => {
  it('rejects a memory with no scope', async () => {
    const { status, data } = await api('POST', '/v1/memories', { content: 'no scope given' });
    expect(status).toBe(400);
    expect(data.error).toContain('scope');
  });

  it('rejects an invalid scope', async () => {
    const { status } = await api('POST', '/v1/memories', { content: 'bad', scope: 'universal' });
    expect(status).toBe(400);
  });

  it('accepts and echoes a valid scope', async () => {
    const { status, data } = await api('POST', '/v1/memories', {
      content: 'a global preference', scope: 'global', type: 'profile',
    });
    expect(status).toBe(201);
    expect(data.scope).toBe('global');
  });

  it('recall labels results with scope', async () => {
    await api('POST', '/v1/memories', { content: 'project detail about caching', scope: 'project' });
    const { data } = await api('GET', '/v1/memories/recall?context=caching');
    expect(data.memories[0].scope).toBeDefined();
  });

  it('POST /v1/move relocates a memory', async () => {
    const { data: created } = await api('POST', '/v1/memories', {
      content: 'filed in the wrong place', scope: 'project',
    });
    const { status, data } = await api('POST', '/v1/move', { id: created.id, scope: 'global' });
    expect(status).toBe(200);
    expect(data.moved).toBe(true);
    expect(data.from).toBe('project');
  });

  // These endpoints read the global store only until the router is wired in,
  // which silently hides every project-scoped memory from them.
  it('read endpoints cover the project store, not just global', async () => {
    const marker = 'quicksilver telemetry pipeline';
    const { status } = await api('POST', '/v1/memories', { content: marker, scope: 'project' });
    expect(status).toBe(201);

    const { data: exported } = await api('POST', '/v1/export');
    const found = exported.memories.find((m: any) => m.content === marker);
    expect(found).toBeDefined();
    expect(found.scope).toBe('project');

    const { data: stats } = await api('GET', '/v1/stats');
    expect(stats.project.total).toBeGreaterThan(0);
  });
});

describe('Error handling', () => {
  it('404 on unknown route', async () => {
    const { status, data } = await api('GET', '/v1/nonexistent');
    expect(status).toBe(404);
  });

  it('500 on malformed JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: '{invalid json',
    });
    expect(res.status).toBe(500);
  });
});

// ============================================================
// Attribution Tests
// ============================================================

describe('Attribution', () => {
  it('GET /v1/memories/recall includes attribution by default', async () => {
    const { status, data } = await api('GET', '/v1/memories/recall?context=test+query');
    expect(status).toBe(200);
    expect(data.attribution).toBeDefined();
    expect(data.attribution.enabled).toBe(true);
    expect(data.attribution.text).toContain('Engram');
    expect(data.attribution.link).toBe('https://github.com/tstockham96/engram');
  });

  it('POST /v1/memories/recall includes attribution by default', async () => {
    const { status, data } = await api('POST', '/v1/memories/recall', {
      context: 'test query',
    });
    expect(status).toBe(200);
    expect(data.attribution).toBeDefined();
    expect(data.attribution.text).toContain('Engram');
  });

  it('GET /v1/powered-by returns attribution info', async () => {
    const { status, data } = await api('GET', '/v1/powered-by');
    expect(status).toBe(200);
    expect(data.enabled).toBe(true);
    expect(data.text).toContain('Engram');
    expect(data.link).toBe('https://github.com/tstockham96/engram');
  });
});

describe('Attribution disabled', () => {
  let attrServer: ReturnType<typeof createEngramServer>;
  let attrBaseUrl: string;
  const attrTmpDir = mkdtempSync(join(tmpdir(), 'engram-attr-test-'));

  beforeAll(async () => {
    const port = 38000 + Math.floor(Math.random() * 1000);
    attrServer = createEngramServer({
      port,
      host: '127.0.0.1',
      authToken: TEST_TOKEN,
      vaults: {},
      defaultVault: {
        owner: 'test-no-attr',
        dbPath: join(attrTmpDir, 'test.db'),
        attribution: { enabled: false },
      },
    });
    await attrServer.listen();
    attrBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await attrServer.close();
    rmSync(attrTmpDir, { recursive: true, force: true });
  });

  async function attrApi(method: string, path: string, body?: unknown) {
    const res = await fetch(`${attrBaseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  }

  it('recall omits attribution when disabled', async () => {
    const { status, data } = await attrApi('GET', '/v1/memories/recall?context=test');
    expect(status).toBe(200);
    expect(data.attribution).toBeUndefined();
  });

  it('powered-by returns enabled:false when disabled', async () => {
    const { status, data } = await attrApi('GET', '/v1/powered-by');
    expect(status).toBe(200);
    expect(data.enabled).toBe(false);
  });
});

describe('Attribution custom text', () => {
  let customServer: ReturnType<typeof createEngramServer>;
  let customBaseUrl: string;
  const customTmpDir = mkdtempSync(join(tmpdir(), 'engram-custom-attr-'));

  beforeAll(async () => {
    const port = 38000 + Math.floor(Math.random() * 1000);
    customServer = createEngramServer({
      port,
      host: '127.0.0.1',
      authToken: TEST_TOKEN,
      vaults: {},
      defaultVault: {
        owner: 'test-custom-attr',
        dbPath: join(customTmpDir, 'test.db'),
        attribution: { enabled: true, text: 'Powered by Acme Memory', includeLink: false },
      },
    });
    await customServer.listen();
    customBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await customServer.close();
    rmSync(customTmpDir, { recursive: true, force: true });
  });

  async function customApi(method: string, path: string, body?: unknown) {
    const res = await fetch(`${customBaseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  }

  it('recall uses custom attribution text', async () => {
    const { data } = await customApi('GET', '/v1/memories/recall?context=test');
    expect(data.attribution.text).toBe('Powered by Acme Memory');
    expect(data.attribution.link).toBe('');
  });

  it('powered-by uses custom text', async () => {
    const { data } = await customApi('GET', '/v1/powered-by');
    expect(data.text).toBe('Powered by Acme Memory');
    expect(data.link).toBe('');
  });
});

// ============================================================
// Auth + CORS hardening
// ============================================================

describe('Authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await fetch(`${baseUrl}/v1/stats`);
    expect(res.status).toBe(401);
  });

  it('rejects a request with a wrong token', async () => {
    const res = await fetch(`${baseUrl}/v1/stats`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a request with the correct token', async () => {
    const res = await fetch(`${baseUrl}/v1/stats`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('leaves /health open for container probes', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });
});

// Multi-tenant mode looks the tenant up by the bearer value itself, so the
// lookup must not walk the prototype chain: `Bearer __proto__` used to resolve
// to a truthy value and open a vault at ~/.engram/undefined.db.
describe('Multi-tenant authentication', () => {
  let mtUrl: string;
  let mtServer: ReturnType<typeof createEngramServer>;
  const TENANT_KEY = 'tenant-key-xyz';

  beforeAll(async () => {
    const port = 39000 + Math.floor(Math.random() * 900);
    mtServer = createEngramServer({
      port,
      host: '127.0.0.1',
      authToken: TEST_TOKEN,
      vaults: { [TENANT_KEY]: { owner: 'tenant-a', dbPath: join(tmpDir, 'tenant-a.db') } },
    });
    await mtServer.listen();
    mtUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { await mtServer.close(); });

  it('accepts a registered tenant key', async () => {
    const res = await fetch(`${mtUrl}/v1/stats`, {
      headers: { Authorization: `Bearer ${TENANT_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it.each(['__proto__', 'constructor', 'toString', 'valueOf'])(
    'rejects the prototype-chain key %s',
    async key => {
      const res = await fetch(`${mtUrl}/v1/stats`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(res.status).toBe(401);
    },
  );
});

describe('CORS', () => {
  it('sends no ACAO header when no allowlist is configured', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not prefix-match localhost lookalikes', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://localhost.evil.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
