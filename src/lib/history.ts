// Undo and redo for the plan. Edits made in quick succession (typing a name,
// say) are merged into one step, so undo goes back a meaningful amount.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** When `present` was last changed by `record`, for merging quick edits. */
  changedAt: number;
}

/** Edits closer together than this are one undo step. */
export const MERGE_WINDOW_MS = 1000;

/** Steps kept; older ones are dropped. */
export const HISTORY_LIMIT = 100;

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], changedAt: 0 });

/** Make `next` the present, as a new undo step unless it follows the last edit closely. */
export function record<T>(h: History<T>, next: T, now = Date.now()): History<T> {
  if (next === h.present) return h;
  const merge = h.past.length > 0 && h.future.length === 0 && now - h.changedAt < MERGE_WINDOW_MS;
  const past = merge ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], changedAt: now };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], changedAt: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), changedAt: 0 };
}
