import { describe, expect, it } from 'vitest';
import { defaultPlan } from './defaults';
import { DEFAULT_NAMING } from './naming';
import { computePlan } from './planner';
import { decodeDesign, encodeDesign, isShareFragment, shareUrl } from './shareLink';

const stripIds = (value: unknown) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'id' ? undefined : v)));

describe('share links', () => {
  it('round-trips a design through the URL fragment', async () => {
    const plan = { ...defaultPlan(), name: 'Contoso ✓ landing zones' };
    plan.regions[0].fixed = '10.0.0.0/16';
    plan.regions[0].spokes[0].splits = [{ offset: 0, prefix: 25 }];
    const naming = { ...DEFAULT_NAMING, environment: 'dev' };

    const url = await shareUrl('https://example.test/app?x=1#old', plan, naming);
    expect(url).toMatch(/^https:\/\/example\.test\/app\?x=1#d=[\w-]+$/);
    const hash = url.slice(url.indexOf('#'));
    expect(isShareFragment(hash)).toBe(true);

    const shared = await decodeDesign(hash);
    expect(stripIds(shared.plan)).toEqual(stripIds(plan));
    expect(shared.naming).toEqual(naming);
    expect(computePlan(shared.plan)).toEqual(
      expect.objectContaining({ issues: [], root: computePlan(plan).root }),
    );
  });

  it('gives every node a fresh id on opening', async () => {
    const plan = defaultPlan();
    const shared = await decodeDesign(await encodeDesign(plan, DEFAULT_NAMING));
    const ids = shared.plan.regions.flatMap((r) => [
      r.id,
      r.hub.id,
      ...r.hub.subnets.map((s) => s.id),
      ...r.spokes.flatMap((v) => [v.id, ...v.subnets.map((s) => s.id)]),
    ]);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the default plan short enough to paste anywhere', async () => {
    expect((await encodeDesign(defaultPlan(), DEFAULT_NAMING)).length).toBeLessThan(2000);
  });

  it('rejects damaged links', async () => {
    const fragment = await encodeDesign(defaultPlan(), DEFAULT_NAMING);
    await expect(decodeDesign(fragment.slice(0, fragment.length / 2))).rejects.toThrow('incomplete or damaged');
    await expect(decodeDesign('#d=not-a-design')).rejects.toThrow('incomplete or damaged');
    expect(isShareFragment('#section')).toBe(false);
  });
});
