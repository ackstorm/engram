import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault } from '../vault.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Topics carried the same defect entities did: `getByTopic(topic, 10).length`
// stepped through 0.2 / 0.08, but the SQL has LIMIT 10, so the length
// saturates and a topic on 200 memories scored exactly like one on 11.
// Engram auto-assigns topics from a fixed pattern list, so a few topics
// ('preferences', 'people') end up on a large share of any real vault.

function tmp(): string {
  return path.join(os.tmpdir(), `engram-topic-idf-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('topic boosts scale with inverse document frequency', () => {
  let vault: Vault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmp();
    vault = new Vault({ owner: 'topic-idf', dbPath });
    for (let i = 0; i < 40; i++) {
      vault.remember({ content: `note ${i}`, topics: ['ubiquitous'] });
    }
    vault.remember({ content: 'the rare one', topics: ['ubiquitous', 'scarce'] });
  });

  afterEach(() => {
    vault.close();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  });

  it('counts true document frequency past the LIMIT', () => {
    expect(vault.topicDocFrequency('ubiquitous')).toBe(41);
    expect(vault.topicDocFrequency('scarce')).toBe(1);
  });

  it('gives a rare topic a much larger weight than a ubiquitous one', () => {
    expect(vault.topicIdfWeight('scarce')).toBeGreaterThan(vault.topicIdfWeight('ubiquitous') * 3);
  });

  it('keeps weights in [0,1] and survives an unseen topic', () => {
    for (const t of ['ubiquitous', 'scarce', 'never-used']) {
      const w = vault.topicIdfWeight(t);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});
