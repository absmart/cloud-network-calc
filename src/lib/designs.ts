// Saved designs: named copies of a plan (plus its IaC naming options) that
// can be reopened later, and a JSON backup format for exporting and
// importing them.

import { migratePlan, newId } from './defaults';
import { DEFAULT_NAMING, type NamingOptions } from './naming';
import type { PlanSpec } from './planner';

export interface SavedDesign {
  id: string;
  name: string;
  /** ISO timestamp of the last save. */
  savedAt: string;
  plan: PlanSpec;
  naming: NamingOptions;
}

/** File format for exported designs. */
export interface DesignBackup {
  app: 'alz-cidr-planner';
  version: 1;
  exportedAt: string;
  designs: SavedDesign[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createDesign(plan: PlanSpec, naming: NamingOptions, now = new Date()): SavedDesign {
  return {
    id: newId(),
    name: plan.name.trim() || 'Untitled design',
    savedAt: now.toISOString(),
    plan: clone(plan),
    naming: { ...naming },
  };
}

/** Overwrite a saved design with the current plan, keeping its id. */
export function updateDesign(design: SavedDesign, plan: PlanSpec, naming: NamingOptions, now = new Date()): SavedDesign {
  return { ...createDesign(plan, naming, now), id: design.id };
}

export function renameDesign(design: SavedDesign, name: string): SavedDesign {
  return { ...design, name, plan: { ...design.plan, name } };
}

/** A copy with a new id and a name that doesn't clash with `existing`. */
export function duplicateDesign(design: SavedDesign, existing: SavedDesign[], now = new Date()): SavedDesign {
  const names = new Set(existing.map((d) => d.name));
  let name = `${design.name} (copy)`;
  for (let n = 2; names.has(name); n++) name = `${design.name} (copy ${n})`;
  return { ...renameDesign(clone(design), name), id: newId(), savedAt: now.toISOString() };
}

/** Whether the plan differs from what was last saved in the design. */
export function hasUnsavedChanges(design: SavedDesign | undefined, plan: PlanSpec): boolean {
  return !design || JSON.stringify(design.plan) !== JSON.stringify(plan);
}

export function toBackup(designs: SavedDesign[], now = new Date()): DesignBackup {
  return { app: 'alz-cidr-planner', version: 1, exportedAt: now.toISOString(), designs: clone(designs) };
}

export function backupFileName(designs: SavedDesign[], now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  if (designs.length !== 1) return `alz-designs-${date}.json`;
  const slug = designs[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
  return `alz-design-${slug}-${date}.json`;
}

const isPlan = (value: unknown): value is PlanSpec => {
  const p = value as PlanSpec;
  return !!p && typeof p === 'object' && p.version === 1 && typeof p.root === 'string' && Array.isArray(p.regions);
};

/**
 * Read an exported backup (or a single design, or a bare plan) and return its
 * designs with fresh ids, ready to add to the saved list.
 */
export function parseBackup(text: string, now = new Date()): SavedDesign[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }

  const candidates: unknown[] = Array.isArray((data as DesignBackup)?.designs)
    ? (data as DesignBackup).designs
    : isPlan(data)
      ? [{ name: data.name, plan: data }]
      : [data];

  const designs = candidates.map((c, i): SavedDesign => {
    const d = c as Partial<SavedDesign>;
    if (!isPlan(d?.plan)) throw new Error(`Design ${i + 1} doesn't contain a plan this app can open.`);
    const plan = migratePlan(d.plan);
    return {
      id: newId(),
      name: (typeof d.name === 'string' && d.name.trim()) || plan.name || 'Imported design',
      savedAt: typeof d.savedAt === 'string' ? d.savedAt : now.toISOString(),
      plan,
      naming: { ...DEFAULT_NAMING, ...(d.naming ?? {}) },
    };
  });
  if (designs.length === 0) throw new Error('The file has no designs.');
  return designs;
}
