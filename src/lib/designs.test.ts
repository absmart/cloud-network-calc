import { describe, expect, it } from 'vitest';
import { defaultPlan } from './defaults';
import {
  backupFileName,
  createDesign,
  duplicateDesign,
  hasUnsavedChanges,
  parseBackup,
  renameDesign,
  toBackup,
  updateDesign,
} from './designs';
import { DEFAULT_NAMING } from './naming';

const now = new Date('2026-10-11T12:00:00Z');

describe('saved designs', () => {
  it('saves a copy of the plan that later edits do not change', () => {
    const plan = defaultPlan();
    const design = createDesign(plan, DEFAULT_NAMING, now);
    expect(design.name).toBe('Contoso landing zones');
    expect(design.savedAt).toBe('2026-10-11T12:00:00.000Z');
    expect(hasUnsavedChanges(design, plan)).toBe(false);

    plan.regions[0].fixed = '10.5.0.0/16';
    expect(design.plan.regions[0].fixed).toBeUndefined();
    expect(hasUnsavedChanges(design, plan)).toBe(true);

    const updated = updateDesign(design, plan, { ...DEFAULT_NAMING, environment: 'dev' });
    expect(updated.id).toBe(design.id);
    expect(updated.naming.environment).toBe('dev');
    expect(hasUnsavedChanges(updated, plan)).toBe(false);
    expect(hasUnsavedChanges(undefined, plan)).toBe(true);
  });

  it('renames and duplicates without name clashes', () => {
    const a = renameDesign(createDesign(defaultPlan(), DEFAULT_NAMING), 'US hub-spoke');
    expect(a.plan.name).toBe('US hub-spoke');
    const b = duplicateDesign(a, [a]);
    const c = duplicateDesign(a, [a, b]);
    expect([b.name, c.name]).toEqual(['US hub-spoke (copy)', 'US hub-spoke (copy 2)']);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('round-trips a backup file with fresh ids', () => {
    const designs = [createDesign(defaultPlan(), DEFAULT_NAMING), createDesign(defaultPlan(), { ...DEFAULT_NAMING, app: 'shared' })];
    const imported = parseBackup(JSON.stringify(toBackup(designs, now)));
    expect(imported.map((d) => d.name)).toEqual(designs.map((d) => d.name));
    expect(imported[1].naming.app).toBe('shared');
    expect(imported[0].plan).toEqual(designs[0].plan);
    expect(imported.some((d) => designs.some((o) => o.id === d.id))).toBe(false);
    expect(backupFileName(designs, now)).toBe('alz-designs-2026-10-11.json');
    expect(backupFileName([renameDesign(designs[0], 'EU / Prod!')], now)).toBe('alz-design-eu-prod-2026-10-11.json');
  });

  it('also imports a bare plan, and migrates older plans', () => {
    const plan = defaultPlan();
    for (const s of plan.regions[0].spokes) delete s.role;
    const [design] = parseBackup(JSON.stringify(plan));
    expect(design.name).toBe('Contoso landing zones');
    expect(design.plan.regions[0].spokes[0].role).toBe('identity');
    expect(design.naming).toEqual(DEFAULT_NAMING);
  });

  it('rejects files that are not designs', () => {
    expect(() => parseBackup('not json')).toThrow(/not valid JSON/);
    expect(() => parseBackup('{"hello":1}')).toThrow(/doesn't contain a plan/);
    expect(() => parseBackup(JSON.stringify({ app: 'alz-cidr-planner', version: 1, designs: [] }))).toThrow(/no designs/);
  });
});
