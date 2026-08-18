import { describe, it, expect } from 'vitest';
import { extract } from '../extract.js';

// ============================================================
// Conversational interjections are not entities
// ============================================================
//
// Measured on the LoCoMo conv0 vault: 42 of 106 extracted entity types (40%)
// and 259 of 1364 entity mentions (19%) were interjections — "Wow", "Thanks",
// "Hey Mel", "Congrats Caroline". The cause is the speaker prefix: memory
// content is "[date] Caroline: Hey Mel! ..." and extractEntities deliberately
// does NOT treat ':' as a sentence boundary (it is used for label prefixes
// like "Correction:"), so the first word of every conversational turn was
// promoted to an entity.
//
// This poisons everything downstream that reads the entity graph: entity
// retrieval boosts, co-entity spreading activation, and any category
// hierarchy built over entities.

describe('extract — conversational noise', () => {
  it('does not treat a greeting after a speaker prefix as an entity', () => {
    const { entities } = extract('[2023-05-07] Caroline: Hey Mel! How are you?');
    expect(entities).not.toContain('Hey Mel');
    expect(entities).not.toContain('Hey');
    // The real name inside the greeting still survives.
    expect(entities).toContain('Mel');
  });

  it('drops standalone interjections', () => {
    const { entities } = extract('[2023-05-07] Melanie: Wow, that is amazing. Thanks Caroline!');
    for (const junk of ['Wow', 'Thanks', 'Thanks Caroline']) {
      expect(entities).not.toContain(junk);
    }
    expect(entities).toContain('Caroline');
  });

  it('keeps real proper nouns that follow a speaker prefix', () => {
    const { entities } = extract('[2023-05-07] Caroline: Melanie showed me the Grand Canyon photos.');
    expect(entities).toContain('Melanie');
    expect(entities).toContain('Grand Canyon');
  });

  it('still extracts label-prefixed content, the case the colon rule exists for', () => {
    const { entities } = extract('Decision: migrate to Postgres for the Acme rollout');
    expect(entities).toContain('Acme');
  });
});
