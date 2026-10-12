// Browser storage for the app. Everything is per browser; storage can be
// unavailable (private windows, blocked site data), so every access is guarded.

import { DEFAULT_NAMING, type NamingOptions } from './naming';

export const STORAGE_KEYS = {
  /** The plan being edited. */
  plan: 'alz-cidr-planner:plan',
  /** IaC export naming options. */
  naming: 'alz-cidr-planner:naming',
  /** Saved designs. */
  designs: 'alz-cidr-planner:designs',
  /** Id of the saved design the current plan was opened from or saved as. */
  activeDesign: 'alz-cidr-planner:active-design',
} as const;

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function loadNaming(): NamingOptions {
  return { ...DEFAULT_NAMING, ...(readJson<Partial<NamingOptions>>(STORAGE_KEYS.naming) ?? {}) };
}

/** Returns false if the value couldn't be stored. */
export function writeJson(key: string, value: unknown): boolean {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
