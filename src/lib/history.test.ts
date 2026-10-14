import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, MERGE_WINDOW_MS, record, redo, startHistory, undo } from './history';

describe('undo history', () => {
  it('undoes and redoes separate edits one at a time', () => {
    let h = startHistory('a');
    h = record(h, 'b', 10_000);
    h = record(h, 'c', 20_000);
    expect(h.present).toBe('c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(undo(h)).toBe(h);
    h = redo(redo(h));
    expect(h.present).toBe('c');
    expect(redo(h)).toBe(h);
  });

  it('merges quick edits into one step, but never into the starting state', () => {
    let h = startHistory('');
    for (const [i, text] of ['n', 'ne', 'new'].entries()) h = record(h, text, 1000 + i * 100);
    expect(h).toMatchObject({ past: [''], present: 'new' });
    h = record(h, 'new!', 1000 + 200 + MERGE_WINDOW_MS);
    expect(undo(h).present).toBe('new');
    expect(undo(undo(h)).present).toBe('');
  });

  it('starts a new step after an undo, and drops the redo branch', () => {
    let h = startHistory(1);
    h = record(h, 2, 10_000);
    h = undo(h);
    h = record(h, 3, 10_100);
    expect(h).toMatchObject({ past: [1], present: 3, future: [] });
  });

  it('ignores no-op updates and keeps a bounded history', () => {
    let h = startHistory(0);
    expect(record(h, 0)).toBe(h);
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) h = record(h, i, i * 10_000);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(10);
  });
});
