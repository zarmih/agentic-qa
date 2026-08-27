import { describe, expect, it } from 'vitest';
import { TimestampRunIdGenerator } from '../../src/infrastructure/run-id.js';

describe('TimestampRunIdGenerator', () => {
  it('creates sortable filesystem-safe IDs', () => {
    const id = new TimestampRunIdGenerator().next(new Date('2026-08-27T12:34:56.789Z'));
    expect(id).toMatch(/^20260827T123456789Z-[a-f0-9]{8}$/);
  });

  it('adds entropy to runs created at the same instant', () => {
    const generator = new TimestampRunIdGenerator();
    const at = new Date('2026-08-27T12:34:56.789Z');
    expect(generator.next(at)).not.toBe(generator.next(at));
  });
});
