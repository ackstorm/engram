import { DatabaseSync } from 'node:sqlite';
import { v4 as uuid } from 'uuid';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import type { Memory, Edge, Entity, RememberParsed } from './types.js';

// ============================================================
// SQLite Storage Layer for Engram
// Uses Node.js built-in node:sqlite (Node 22.5+) — zero native deps.
// ============================================================

/**
 * sqlite-vec's vec0 tables default to EUCLIDEAN distance — `distance_metric=cosine`
 * is not set on vec_memories. For unit-normalised vectors (all three providers
 * emit them) the identity is d = sqrt(2 - 2*cos), so cos = 1 - d^2 / 2.
 *
 * Treating the raw L2 distance as a cosine distance understates similarity
 * badly: d=1.13 is cosine 0.36, but `1 - d` reads as -0.13.
 */
/**
 * English function words that carry no retrieval signal. An explicit list
 * rather than a length cutoff: `t.length > 2` dropped "go", "ts", "js", "ci",
 * "db" and "ai" — all searchable technical terms — while letting "the", "our"
 * and "was" straight through.
 *
 * It stays short on purpose. Near-zero-IDF hits are discarded by
 * BM25_NOISE_FLOOR in vault.ts anyway, so this only spares the index work; it
 * is not what makes stopwords harmless.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is',
  'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 'so', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * Split a query into BM25 terms. Exported so the scorer can count terms without
 * re-deriving them — a mismatch between what is searched and what is counted
 * would silently mis-calibrate the score normalisation.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t));
}

export function cosineFromL2(distance: number): number {
  const cos = 1 - (distance * distance) / 2;
  return Math.max(-1, Math.min(1, cos));
}

export class MemoryStore {
  private db: DatabaseSync;
  private vecEnabled: boolean = false;
  private embeddingDimensions: number = 0;
  private dbPath: string;

  constructor(dbPath: string, embeddingDimensions?: number) {
    this.dbPath = dbPath;
    // Auto-create parent directory if it doesn't exist
    mkdirSync(dirname(dbPath), { recursive: true });
    const needsExtensions = !!(embeddingDimensions && embeddingDimensions > 0);
    this.db = needsExtensions
      ? new DatabaseSync(dbPath, { allowExtension: true })
      : new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    // Load sqlite-vec extension
    if (needsExtensions) {
      try {
        const require = createRequire(import.meta.url);
        const sqliteVec = require('sqlite-vec');
        const extPath = sqliteVec.getLoadablePath();
        this.db.enableLoadExtension(true);
        this.db.loadExtension(extPath);
        this.db.enableLoadExtension(false);
        this.vecEnabled = true;
        this.embeddingDimensions = embeddingDimensions;
      } catch (err) {
        console.warn('sqlite-vec extension not available, falling back to non-vector search:', (err as Error).message);
      }
    }

    this.migrate();
  }

  // --------------------------------------------------------
  // Schema Migration
  // --------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        content TEXT NOT NULL,
        summary TEXT NOT NULL,

        -- Provenance
        source_type TEXT NOT NULL,
        source_session_id TEXT,
        source_agent_id TEXT,
        source_evidence TEXT,  -- JSON array of memory IDs
        source_timestamp TEXT NOT NULL,

        -- Temporal
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,

        -- Weight & Trust
        salience REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.8,
        stability REAL NOT NULL DEFAULT 1.0,

        -- Semantic Anchors
        entities TEXT NOT NULL DEFAULT '[]',   -- JSON array
        topics TEXT NOT NULL DEFAULT '[]',     -- JSON array

        -- Lifecycle
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'fulfilled', 'superseded', 'archived')),

        -- Access Control
        visibility TEXT NOT NULL DEFAULT 'owner_agents',

        -- Embedding
        embedding BLOB
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS engram_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'concept',
        aliases TEXT NOT NULL DEFAULT '[]',        -- JSON array
        properties TEXT NOT NULL DEFAULT '{}',     -- JSON object
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        memory_count INTEGER NOT NULL DEFAULT 0,
        importance REAL NOT NULL DEFAULT 0.5
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        layer INTEGER NOT NULL,
        built_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS category_edges (
        parent_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        child_id  TEXT NOT NULL,
        child_kind TEXT NOT NULL CHECK(child_kind IN ('category', 'entity')),
        PRIMARY KEY (parent_id, child_id)
      );

      -- Indices for fast retrieval
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_stability ON memories(stability);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_category_layer ON categories(layer);
      CREATE INDEX IF NOT EXISTS idx_category_edges_parent ON category_edges(parent_id);
    `);

    // Bi-temporal columns migration (added in 0.3.4)
    // valid_from = when this fact became true in the real world
    // valid_until = when this fact stopped being true (NULL = still true)
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN valid_from TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN valid_until TEXT`);
    } catch { /* column already exists */ }
    // Backfill: set valid_from = created_at for any memory where it's NULL
    this.db.exec(`UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL`);

    // Scope column for memory routing (added for enterprise tier)
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'both'`);
    } catch { /* column already exists */ }

    // Index for temporal queries
    try {
      this.db.exec(`CREATE INDEX idx_memories_valid_from ON memories(valid_from)`);
    } catch { /* index already exists */ }
    try {
      this.db.exec(`CREATE INDEX idx_memories_valid_until ON memories(valid_until)`);
    } catch { /* index already exists */ }

    // Create vector virtual table if sqlite-vec is loaded
    if (this.vecEnabled && this.embeddingDimensions > 0) {
      // A vault's embedding dimension is baked into vec_memories. CREATE VIRTUAL
      // TABLE IF NOT EXISTS would silently keep the old width on a provider
      // switch, so check it explicitly instead.
      const row = this.db
        .prepare(`SELECT value FROM engram_meta WHERE key = 'embedding_dims'`)
        .get() as { value: string } | undefined;

      if (row && Number(row.value) !== this.embeddingDimensions) {
        throw new Error(
          `[engram] Vault at ${this.dbPath} was built with ${row.value}-dimension embeddings ` +
          `but the current configuration produces ${this.embeddingDimensions}. ` +
          'Changing the embedding model invalidates every stored vector. ' +
          'Either restore the previous embedding settings, or start a new vault ' +
          '(ENGRAM_DB_PATH) and re-import.',
        );
      }

      if (!row) {
        this.db
          .prepare(`INSERT INTO engram_meta (key, value) VALUES ('embedding_dims', ?)`)
          .run(String(this.embeddingDimensions));
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${this.embeddingDimensions}]
        );
      `);
    }

    // ── Schema v2: drop the CHECK on memories.type so the taxonomy can grow ──
    // SQLite cannot alter a CHECK constraint, so the table must be rebuilt.
    // Guarded by schema_version so this runs exactly once per vault.
    const version = (this.db
      .prepare(`SELECT value FROM engram_meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined)?.value;

    if (version !== '2') {
      const COLS = [
        'id', 'type', 'content', 'summary',
        'source_type', 'source_session_id', 'source_agent_id', 'source_evidence',
        'source_timestamp', 'created_at', 'last_accessed_at', 'last_modified_at',
        'access_count', 'expires_at', 'salience', 'confidence', 'stability',
        'entities', 'topics', 'status', 'visibility', 'embedding',
        'valid_from', 'valid_until', 'scope',
      ].join(', ');

      this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec('BEGIN');
      try {
        this.db.exec(`
          CREATE TABLE memories_new (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            summary TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_session_id TEXT,
            source_agent_id TEXT,
            source_evidence TEXT,
            source_timestamp TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
            access_count INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT,
            salience REAL NOT NULL DEFAULT 0.5,
            confidence REAL NOT NULL DEFAULT 0.8,
            stability REAL NOT NULL DEFAULT 1.0,
            entities TEXT NOT NULL DEFAULT '[]',
            topics TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'active'
              CHECK(status IN ('active','pending','fulfilled','superseded','archived')),
            visibility TEXT NOT NULL DEFAULT 'owner_agents',
            embedding BLOB,
            valid_from TEXT,
            valid_until TEXT,
            scope TEXT NOT NULL DEFAULT 'both'
          );
        `);
        this.db.exec(`INSERT INTO memories_new (${COLS}) SELECT ${COLS} FROM memories;`);
        this.db.exec('DROP TABLE memories');
        this.db.exec('ALTER TABLE memories_new RENAME TO memories');
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
          CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience DESC);
          CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed_at DESC);
          CREATE INDEX IF NOT EXISTS idx_memories_stability ON memories(stability);
          CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from);
          CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until);
        `);

        const violations = this.db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`foreign_key_check found ${violations.length} violations`);
        }

        this.db.exec(
          `INSERT OR REPLACE INTO engram_meta (key, value) VALUES ('schema_version', '2')`,
        );
        // Rebuilding `memories` reassigns every rowid, and the FTS index is an
        // external-content table keyed on them. Clearing the marker forces the
        // index to be rebuilt below; without this a future migration would
        // leave it silently pointing at the wrong rows.
        this.db.exec(`DELETE FROM engram_meta WHERE key = 'fts_built'`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
    }

    // ── Full-text index (FTS5 + BM25, built into Node's SQLite) ──
    // External-content table: memories owns the rows, the index mirrors them.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, summary, entities, topics,
        content='memories', content_rowid='rowid', tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, summary, entities, topics)
        VALUES (new.rowid, new.content, new.summary, new.entities, new.topics);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary, entities, topics)
        VALUES ('delete', old.rowid, old.content, old.summary, old.entities, old.topics);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary, entities, topics)
        VALUES ('delete', old.rowid, old.content, old.summary, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, content, summary, entities, topics)
        VALUES (new.rowid, new.content, new.summary, new.entities, new.topics);
      END;
    `);

    // Backfill once for vaults that predate the index.
    const ftsBuilt = this.db
      .prepare(`SELECT value FROM engram_meta WHERE key = 'fts_built'`)
      .get() as { value: string } | undefined;
    if (!ftsBuilt) {
      this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
      this.db
        .prepare(`INSERT OR REPLACE INTO engram_meta (key, value) VALUES ('fts_built', '1')`)
        .run();
    }
  }

  /** Embedding dimension this vault was built with; 0 when it has no vectors. */
  embeddingDims(): number {
    return this.embeddingDimensions;
  }

  // --------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------

  createMemory(input: RememberParsed): Memory {
    const now = new Date().toISOString();
    const id = uuid();

    const summary = input.summary ?? input.content.slice(0, 120) + (input.content.length > 120 ? '...' : '');

    const memory: Memory = {
      id,
      type: input.type ?? 'episodic',
      content: input.content,
      summary,
      source: {
        type: input.source?.type ?? 'conversation',
        sessionId: input.source?.sessionId,
        agentId: input.source?.agentId,
        evidence: input.source?.evidence,
        timestamp: now,
      },
      createdAt: now,
      lastAccessedAt: now,
      lastModifiedAt: now,
      accessCount: 0,
      expiresAt: input.expiresAt,
      validFrom: (input as any).validFrom ?? now,
      validUntil: (input as any).validUntil ?? undefined,
      salience: input.salience ?? 0.5,
      confidence: input.confidence ?? 0.8,
      stability: 1.0,
      entities: input.entities ?? [],
      topics: input.topics ?? [],
      status: input.status ?? 'active',
      visibility: input.visibility ?? 'owner_agents',
      scope: input.scope ?? 'both',
    };

    this.db.prepare(`
      INSERT INTO memories (
        id, type, content, summary,
        source_type, source_session_id, source_agent_id, source_evidence, source_timestamp,
        created_at, last_accessed_at, last_modified_at, access_count, expires_at,
        valid_from, valid_until,
        salience, confidence, stability,
        entities, topics, status, visibility, scope
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).run(
      memory.id, memory.type, memory.content, memory.summary,
      memory.source.type, memory.source.sessionId ?? null, memory.source.agentId ?? null,
      JSON.stringify(memory.source.evidence ?? []), memory.source.timestamp,
      memory.createdAt, memory.lastAccessedAt, memory.lastModifiedAt,
      memory.accessCount, memory.expiresAt ?? null,
      memory.validFrom ?? now, memory.validUntil ?? null,
      memory.salience, memory.confidence, memory.stability,
      JSON.stringify(memory.entities), JSON.stringify(memory.topics), memory.status, memory.visibility,
      memory.scope ?? 'both',
    );

    // Auto-discover/update entities
    for (const entityName of memory.entities) {
      this.upsertEntity(entityName, memory.type === 'episodic' ? 'unknown' : 'concept');
    }

    return memory;
  }

  /**
   * Insert a fully-formed memory verbatim, preserving its own id and
   * timestamps rather than generating new ones. Used by MemoryRouter.move to
   * re-home a memory into another store. The embedding vector is handled
   * separately (it lives in vec_memories, not this table).
   */
  insertMemoryVerbatim(memory: Memory): void {
    this.db.prepare(`
      INSERT INTO memories (
        id, type, content, summary,
        source_type, source_session_id, source_agent_id, source_evidence, source_timestamp,
        created_at, last_accessed_at, last_modified_at, access_count, expires_at,
        valid_from, valid_until,
        salience, confidence, stability,
        entities, topics, status, visibility, scope
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).run(
      memory.id, memory.type, memory.content, memory.summary,
      memory.source.type, memory.source.sessionId ?? null, memory.source.agentId ?? null,
      JSON.stringify(memory.source.evidence ?? []), memory.source.timestamp,
      memory.createdAt, memory.lastAccessedAt, memory.lastModifiedAt,
      memory.accessCount, memory.expiresAt ?? null,
      memory.validFrom ?? memory.createdAt, memory.validUntil ?? null,
      memory.salience, memory.confidence, memory.stability,
      JSON.stringify(memory.entities), JSON.stringify(memory.topics), memory.status, memory.visibility,
      memory.scope ?? 'both',
    );

    for (const entityName of memory.entities) {
      this.upsertEntity(entityName, memory.type === 'episodic' ? 'unknown' : 'concept');
    }
  }

  getMemory(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined;
    if (!row) return null;

    // Update access stats
    this.db.prepare(`
      UPDATE memories 
      SET last_accessed_at = datetime('now'), access_count = access_count + 1, stability = MIN(stability * 1.05, 10.0)
      WHERE id = ?
    `).run(id);

    return this.rowToMemory(row);
  }

  /** Read a memory without updating access stats (for graph traversal, activation spreading) */
  getMemoryDirect(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow | undefined;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  /** Get all memories by a list of IDs without updating access stats */
  getMemoriesDirect(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    ).all(...ids) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  updateMemory(id: string, updates: Partial<Pick<Memory, 'content' | 'summary' | 'salience' | 'confidence' | 'entities' | 'topics' | 'type'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
    if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary); }
    if (updates.salience !== undefined) { sets.push('salience = ?'); values.push(updates.salience); }
    if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.entities !== undefined) { sets.push('entities = ?'); values.push(JSON.stringify(updates.entities)); }
    if (updates.topics !== undefined) { sets.push('topics = ?'); values.push(JSON.stringify(updates.topics)); }
    if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type); }

    if (sets.length === 0) return;

    sets.push("last_modified_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values as any[]);
  }

  /** Update a memory's status (active, pending, fulfilled, superseded, archived) */
  updateStatus(id: string, status: string): void {
    this.db.prepare(`UPDATE memories SET status = ?, last_modified_at = datetime('now') WHERE id = ?`).run(status, id);
  }

  /** Set valid_until on a memory (used when superseding — marks when the fact stopped being true) */
  setValidUntil(id: string, validUntil: string): void {
    this.db.prepare(`UPDATE memories SET valid_until = ?, last_modified_at = datetime('now') WHERE id = ?`).run(validUntil, id);
  }

  /** Point-in-time query: get memories that were valid at a specific date */
  getValidAt(asOf: string, limit: number = 50): Memory[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories 
      WHERE valid_from <= ? 
        AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY salience DESC, created_at DESC 
      LIMIT ?
    `).all(asOf, asOf, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Resolve a short ID prefix to a full UUID. Returns null if no match, throws if ambiguous. */
  resolveId(idPrefix: string): string | null {
    if (idPrefix.length >= 36) return idPrefix; // Already a full UUID
    const rows = this.db.prepare('SELECT id FROM memories WHERE id LIKE ?').all(`${idPrefix}%`) as Array<{ id: string }>;
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new Error(`Ambiguous ID prefix "${idPrefix}" matches ${rows.length} memories. Use more characters.`);
    return rows[0].id;
  }

  deleteMemory(id: string): number {
    const row = this.db.prepare('SELECT entities FROM memories WHERE id = ?').get(id) as { entities: string } | undefined;
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    if (row && result.changes > 0) {
      for (const entityName of JSON.parse(row.entities) as string[]) {
        this.decrementEntity(entityName);
      }
    }
    return Number(result.changes);
  }

  // --------------------------------------------------------
  // Retrieval
  // --------------------------------------------------------

  /** Get recent memories, ordered by creation time */
  getRecent(limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by entity */
  getByEntity(entityName: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE entities LIKE ? ORDER BY salience DESC, created_at DESC LIMIT ?`
    ).all(`%"${entityName}"%`, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by topic */
  getByTopic(topic: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE topics LIKE ? ORDER BY salience DESC, created_at DESC LIMIT ?`
    ).all(`%"${topic}"%`, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by status */
  getByStatus(status: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE status = ? ORDER BY salience DESC, created_at DESC LIMIT ?'
    ).all(status, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories by type */
  getByType(type: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE type = ? ORDER BY salience DESC, created_at DESC LIMIT ?'
    ).all(type, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Full-text search on content */
  search(query: string, limit: number = 20): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? ORDER BY salience DESC, created_at DESC LIMIT ?`
    ).all(`%${query}%`, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get all memories (for consolidation) */
  getEpisodicSince(since: string, limit: number = 500): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE type = 'episodic' AND created_at >= ? ORDER BY created_at ASC LIMIT ?`
    ).all(since, limit) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Get memories below stability threshold (candidates for archival) */
  getDecayedMemories(threshold: number = 0.05): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE stability < ? AND type != \'procedural\' ORDER BY stability ASC'
    ).all(threshold) as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** Count memories by type */
  getStats(): { total: number; episodic: number; semantic: number; procedural: number; profile: number; entities: number } {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN type = 'episodic' THEN 1 ELSE 0 END) as episodic,
        SUM(CASE WHEN type = 'semantic' THEN 1 ELSE 0 END) as semantic,
        SUM(CASE WHEN type = 'procedural' THEN 1 ELSE 0 END) as procedural,
        SUM(CASE WHEN type = 'profile' THEN 1 ELSE 0 END) as profile
      FROM memories
    `).get() as unknown as { total: number; episodic: number; semantic: number; procedural: number; profile: number };

    const entityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as unknown as { count: number };

    return { ...counts, entities: entityCount.count };
  }

  // --------------------------------------------------------
  // Edges
  // --------------------------------------------------------

  createEdge(sourceId: string, targetId: string, type: Edge['type'] | string, strength: number = 0.5): Edge {
    const id = uuid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO edges (id, source_id, target_id, type, strength, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, type, strength, now);

    return { id, sourceId, targetId, type: type as Edge['type'], strength, createdAt: now };
  }

  getEdgesFrom(memoryId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ?'
    ).all(memoryId) as unknown as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  getEdgesTo(memoryId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE target_id = ?'
    ).all(memoryId) as unknown as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /** Get all edges connected to a memory (both directions) */
  getEdgesBidirectional(memoryId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ? OR target_id = ?'
    ).all(memoryId, memoryId) as unknown as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /** Batch: get all edges for a set of memory IDs (both directions) */
  getEdgesForMemories(memoryIds: string[]): Edge[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
    ).all(...memoryIds, ...memoryIds) as unknown as EdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /** Get memories that share entities with the given memory */
  getCoEntityMemories(memoryId: string, limit: number = 20): Array<{ memory: Memory; sharedEntities: string[] }> {
    const source = this.getMemoryDirect(memoryId);
    if (!source || source.entities.length === 0) return [];

    const results: Map<string, { memory: Memory; sharedEntities: string[] }> = new Map();
    for (const entity of source.entities) {
      const rows = this.db.prepare(
        `SELECT * FROM memories WHERE id != ? AND entities LIKE ? ORDER BY salience DESC LIMIT ?`
      ).all(memoryId, `%"${entity}"%`, limit) as unknown as MemoryRow[];

      for (const row of rows) {
        const mem = this.rowToMemory(row);
        const existing = results.get(mem.id);
        if (existing) {
          existing.sharedEntities.push(entity);
        } else {
          results.set(mem.id, { memory: mem, sharedEntities: [entity] });
        }
      }
    }

    return [...results.values()]
      .sort((a, b) => b.sharedEntities.length - a.sharedEntities.length)
      .slice(0, limit);
  }

  getNeighbors(memoryId: string, depth: number = 1): Memory[] {
    if (depth < 1) return [];

    const neighborIds = new Set<string>();
    const queue = [memoryId];

    for (let d = 0; d < depth; d++) {
      const nextQueue: string[] = [];
      for (const id of queue) {
        const edges = [...this.getEdgesFrom(id), ...this.getEdgesTo(id)];
        for (const edge of edges) {
          const neighborId = edge.sourceId === id ? edge.targetId : edge.sourceId;
          if (!neighborIds.has(neighborId) && neighborId !== memoryId) {
            neighborIds.add(neighborId);
            nextQueue.push(neighborId);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
    }

    return [...neighborIds]
      .map(id => this.getMemory(id))
      .filter((m): m is Memory => m !== null);
  }

  // --------------------------------------------------------
  // Entities
  // --------------------------------------------------------

  upsertEntity(name: string, type: string = 'concept'): Entity {
    const existing = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? OR aliases LIKE ?'
    ).get(name, `%"${name}"%`) as unknown as EntityRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE entities 
        SET last_seen = datetime('now'), memory_count = memory_count + 1
        WHERE id = ?
      `).run(existing.id);
      return this.rowToEntity(existing);
    }

    const id = uuid();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO entities (id, name, type, aliases, properties, first_seen, last_seen, memory_count, importance)
      VALUES (?, ?, ?, '[]', '{}', ?, ?, 1, 0.5)
    `).run(id, name, type, now, now);

    return { id, name, type, aliases: [], properties: {}, firstSeen: now, lastSeen: now, memoryCount: 1, importance: 0.5 };
  }

  /** Mirror of upsertEntity's increment, for when a memory referencing this entity is deleted. */
  private decrementEntity(name: string): void {
    const existing = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? OR aliases LIKE ?'
    ).get(name, `%"${name}"%`) as unknown as EntityRow | undefined;
    if (!existing) return;

    this.db.prepare(`
      UPDATE entities SET memory_count = MAX(memory_count - 1, 0) WHERE id = ?
    `).run(existing.id);
  }

  getEntity(name: string): Entity | null {
    const row = this.db.prepare(
      'SELECT * FROM entities WHERE name = ? OR aliases LIKE ?'
    ).get(name, `%"${name}"%`) as unknown as EntityRow | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  getAllEntities(): Entity[] {
    const rows = this.db.prepare(
      'SELECT * FROM entities ORDER BY importance DESC, memory_count DESC'
    ).all() as unknown as EntityRow[];
    return rows.map(r => this.rowToEntity(r));
  }

  getAllEntityNames(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT name FROM entities ORDER BY name').all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  // --------------------------------------------------------
  // Category hierarchy
  // --------------------------------------------------------

  insertCategory(row: { id: string; name: string; tags: string[]; layer: number }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO categories (id, name, tags, layer) VALUES (?, ?, ?, ?)'
    ).run(row.id, row.name, JSON.stringify(row.tags), row.layer);
  }

  linkCategoryChild(parentId: string, childId: string, childKind: 'category' | 'entity'): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO category_edges (parent_id, child_id, child_kind) VALUES (?, ?, ?)'
    ).run(parentId, childId, childKind);
  }

  getCategoriesByLayer(layer: number): Array<{ id: string; name: string; tags: string[]; layer: number }> {
    const rows = this.db.prepare(
      'SELECT id, name, tags, layer FROM categories WHERE layer = ? ORDER BY name'
    ).all(layer) as Array<{ id: string; name: string; tags: string; layer: number }>;
    return rows.map(r => ({ id: r.id, name: r.name, tags: JSON.parse(r.tags), layer: r.layer }));
  }

  getCategoryChildren(parentIds: string[]): Array<{ parentId: string; childId: string; childKind: 'category' | 'entity' }> {
    if (parentIds.length === 0) return [];
    const placeholders = parentIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT parent_id, child_id, child_kind FROM category_edges WHERE parent_id IN (${placeholders})`
    ).all(...parentIds) as Array<{ parent_id: string; child_id: string; child_kind: 'category' | 'entity' }>;
    return rows.map(r => ({ parentId: r.parent_id, childId: r.child_id, childKind: r.child_kind }));
  }

  getMaxCategoryLayer(): number {
    const row = this.db.prepare('SELECT MAX(layer) AS m FROM categories').get() as { m: number | null };
    return row?.m ?? 0;
  }

  clearCategories(): void {
    this.db.exec('DELETE FROM category_edges; DELETE FROM categories;');
  }

  // --------------------------------------------------------
  // Vector Search
  // --------------------------------------------------------

  /** Store an embedding for a memory */
  storeEmbedding(memoryId: string, embedding: number[]): void {
    if (!this.vecEnabled) return;

    // Convert to Float32Array for sqlite-vec
    const arr = new Float32Array(embedding);
    const buf = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

    // vec0 virtual tables don't support INSERT OR REPLACE
    // Delete first, then insert
    this.db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(memoryId);
    this.db.prepare(`
      INSERT INTO vec_memories (memory_id, embedding)
      VALUES (?, ?)
    `).run(memoryId, buf);
  }

  /** Find nearest neighbors by embedding vector */
  searchByVector(embedding: number[], limit: number = 20): Array<{ memoryId: string; distance: number; similarity: number }> {
    if (!this.vecEnabled) return [];

    const arr = new Float32Array(embedding);
    const buf = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

    const rows = this.db.prepare(`
      SELECT memory_id, distance
      FROM vec_memories
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, limit) as unknown as Array<{ memory_id: string; distance: number }>;

    return rows.map(r => ({ memoryId: r.memory_id, distance: r.distance, similarity: cosineFromL2(r.distance) }));
  }

  /** Check if vector search is available */
  hasVectorSearch(): boolean {
    return this.vecEnabled;
  }

  /**
   * Lexical search over the FTS5 index. `bm25()` returns lower-is-better, so
   * the sign is flipped for consistency with every other score in the system.
   * The query is tokenised into bare terms — FTS5 operators in user text would
   * otherwise be a syntax error rather than a search.
   */
  searchBM25(query: string, limit: number = 20): Array<{ id: string; score: number }> {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return [];

    const match = terms.map(t => `"${t}"`).join(' OR ');
    try {
      return this.db.prepare(`
        SELECT m.id AS id, -bm25(memories_fts, 4.0, 2.0, 1.0, 1.0) AS score
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `).all(match, limit) as Array<{ id: string; score: number }>;
    } catch {
      return []; // never let a search syntax problem break recall
    }
  }

  /** Get the stored embedding for a memory (for dedup checks) */
  getEmbedding(memoryId: string): number[] | null {
    if (!this.vecEnabled) return null;
    try {
      const row = this.db.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?').get(memoryId) as unknown as { embedding: Uint8Array } | undefined;
      if (!row) return null;
      return Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    } catch {
      return null;
    }
  }

  /** Find memories with very high semantic similarity (for dedup) */
  findSimilar(embedding: number[], threshold: number = 0.12, limit: number = 3): Array<{ memoryId: string; distance: number; similarity: number }> {
    if (!this.vecEnabled) return [];
    const results = this.searchByVector(embedding, limit);
    // `threshold` is a COSINE DISTANCE (1 - similarity), not the raw L2 value.
    return results
      .filter(r => 1 - r.similarity <= threshold)
      .map(r => ({ ...r, similarity: r.similarity }));
  }

  // --------------------------------------------------------
  // Decay
  // --------------------------------------------------------

  /** Apply time-based decay to all memories */
  applyDecay(halfLifeHours: number = 168): number {
    const now = Date.now();
    let decayed = 0;

    const memories = this.db.prepare('SELECT id, last_accessed_at, stability FROM memories').all() as unknown as Array<{
      id: string;
      last_accessed_at: string;
      stability: number;
    }>;

    const update = this.db.prepare('UPDATE memories SET stability = ? WHERE id = ?');

    this.db.exec('BEGIN');
    try {
      for (const mem of memories) {
        const lastAccessed = new Date(mem.last_accessed_at).getTime();
        const hoursSince = (now - lastAccessed) / (1000 * 60 * 60);
        const decayRate = Math.log(2) / halfLifeHours;
        const newStability = mem.stability * Math.exp(-decayRate * hoursSince);

        if (Math.abs(newStability - mem.stability) > 0.001) {
          update.run(Math.max(newStability, 0.001), mem.id);
          decayed++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return decayed;
  }

  // --------------------------------------------------------
  // Export / Import
  // --------------------------------------------------------

  exportAll(): { memories: Memory[]; edges: Edge[]; entities: Entity[] } {
    const memories = (this.db.prepare('SELECT * FROM memories').all() as unknown as MemoryRow[]).map(r => this.rowToMemory(r));
    const edges = (this.db.prepare('SELECT * FROM edges').all() as unknown as EdgeRow[]).map(r => this.rowToEdge(r));
    const entities = (this.db.prepare('SELECT * FROM entities').all() as unknown as EntityRow[]).map(r => this.rowToEntity(r));
    return { memories, edges, entities };
  }

  // --------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------

  private rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      type: row.type as Memory['type'],
      content: row.content,
      summary: row.summary,
      source: {
        type: row.source_type as Memory['source']['type'],
        sessionId: row.source_session_id ?? undefined,
        agentId: row.source_agent_id ?? undefined,
        evidence: row.source_evidence ? JSON.parse(row.source_evidence) : undefined,
        timestamp: row.source_timestamp,
      },
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      lastModifiedAt: row.last_modified_at,
      accessCount: row.access_count,
      expiresAt: row.expires_at ?? undefined,
      validFrom: (row as any).valid_from ?? row.created_at,
      validUntil: (row as any).valid_until ?? undefined,
      salience: row.salience,
      confidence: row.confidence,
      stability: row.stability,
      entities: JSON.parse(row.entities),
      topics: JSON.parse(row.topics),
      status: (row as any).status ?? 'active',
      visibility: row.visibility as Memory['visibility'],
      scope: ((row as any).scope as Memory['scope']) ?? 'both',
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as Edge['type'],
      strength: row.strength,
      createdAt: row.created_at,
    };
  }

  private rowToEntity(row: EntityRow): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: JSON.parse(row.aliases),
      properties: JSON.parse(row.properties),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      memoryCount: row.memory_count,
      importance: row.importance,
    };
  }

  close(): void {
    this.db.close();
  }
}

// --------------------------------------------------------
// Row types for SQLite
// --------------------------------------------------------

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  summary: string;
  source_type: string;
  source_session_id: string | null;
  source_agent_id: string | null;
  source_evidence: string | null;
  source_timestamp: string;
  created_at: string;
  last_accessed_at: string;
  last_modified_at: string;
  access_count: number;
  expires_at: string | null;
  salience: number;
  confidence: number;
  stability: number;
  entities: string;
  topics: string;
  status: string;
  visibility: string;
  embedding: Buffer | null;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
  created_at: string;
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  aliases: string;
  properties: string;
  first_seen: string;
  last_seen: string;
  memory_count: number;
  importance: number;
}
