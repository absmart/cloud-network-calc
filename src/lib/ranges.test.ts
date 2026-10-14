import { describe, expect, it } from 'vitest';
import { makeRegion } from './defaults';
import { formatCidr } from './ipv4';
import { addRange, applyRangeView, divide, rangeView, removeRange, vnetLeaves } from './layout';
import { type PlanSpec, type SubnetSpec, type VnetResult, type VnetSpec, computePlan } from './planner';

const sn = (name: string, prefix: number, extra: Partial<SubnetSpec> = {}): SubnetSpec => ({ id: name, name, prefix, ...extra });

/** A one-region plan whose only spoke is `spoke`, in 10.0.0.0/16. */
function planWith(spoke: VnetSpec): PlanSpec {
  const region = { ...makeRegion('eastus2', 'hub-spoke'), fixed: '10.0.0.0/16', spokes: [spoke] };
  return { version: 1, name: 'ranges', root: '10.0.0.0/16', regions: [region] };
}

const spokeResult = (spoke: VnetSpec): VnetResult => computePlan(planWith(spoke)).regions[0].spokes[0];
const placed = (v: VnetResult) => v.subnets.map((s) => `${s.name} ${s.cidr ? formatCidr(s.cidr) : s.issues.map((i) => i.message).join('; ')}`);

const twoRanges: VnetSpec = {
  id: 'spoke',
  name: 'app-vnet',
  prefix: 24,
  fixed: '10.0.8.0/24',
  ranges: [{ prefix: 25, fixed: '10.0.20.0/25' }, { prefix: 26 }],
  subnets: [],
};

describe('VNets with several address ranges', () => {
  it('allocates extra ranges after every main range and reports them per VNet', () => {
    const v = spokeResult(twoRanges);
    expect(v.ranges.map((r) => r && formatCidr(r))).toEqual(['10.0.8.0/24', '10.0.20.0/25', '10.0.4.0/26']);
    expect(v.issues).toEqual([]);
    expect(v.free.map(formatCidr)).toEqual(['10.0.8.0/24', '10.0.20.0/25', '10.0.4.0/26']);

    const clash = spokeResult({ ...twoRanges, ranges: [{ prefix: 25, fixed: '10.0.8.0/25' }] });
    expect(clash.ranges[1]).toBeNull();
    expect(clash.issues.map((i) => i.message)).toEqual(['Address range 2: 10.0.8.0/25 overlaps 10.0.8.0/24']);
  });

  it('fills the main range first, then overflows into the extra ranges in order', () => {
    const v = spokeResult({
      ...twoRanges,
      subnets: [sn('a', 25), sn('b', 25), sn('c', 26), sn('d', 26), sn('e', 26), sn('f', 26)],
    });
    expect(placed(v)).toEqual([
      'a 10.0.8.0/25',
      'b 10.0.8.128/25',
      'c 10.0.20.0/26',
      'd 10.0.20.64/26',
      'e 10.0.4.0/26',
      'f No room left for a /26 in 10.0.4.0/26',
    ]);
  });

  it('places pinned subnets in the range that holds them, and positioned ones relative to their range', () => {
    const v = spokeResult({
      ...twoRanges,
      subnets: [
        sn('pinned', 26, { fixed: '10.0.20.64/26' }),
        sn('positioned', 26, { range: 1, offset: 0 }),
        sn('only-third', 27, { range: 2 }),
        sn('outside', 26, { fixed: '10.0.30.0/26' }),
        sn('missing', 27, { range: 5 }),
      ],
    });
    expect(placed(v)).toEqual([
      'pinned 10.0.20.64/26',
      'positioned 10.0.20.0/26',
      'only-third 10.0.4.0/27',
      'outside 10.0.30.0/26 is outside 10.0.8.0/24, 10.0.20.0/25, 10.0.4.0/26',
      'missing The VNet has no address range 6',
    ]);
  });

  it('keeps a single-range VNet exactly as before', () => {
    const single = { ...twoRanges, ranges: undefined, subnets: [sn('a', 25), sn('b', 24)] };
    expect(placed(spokeResult(single))).toEqual(['a 10.0.8.0/25', 'b No room left for a /24 in 10.0.8.0/24']);
  });

  it('edits one range in the visual editor without touching the others', () => {
    const spec = { ...twoRanges, subnets: [sn('a', 24), sn('b', 26)] };
    const result = spokeResult(spec);
    expect(placed(result)).toEqual(['a 10.0.8.0/24', 'b 10.0.20.0/26']);

    const view = rangeView(spec, result, 1)!;
    expect(view.spec.subnets.map((s) => s.name)).toEqual(['b']);
    expect(vnetLeaves(view.spec, view.result).map((l) => formatCidr(l.cidr))).toEqual(['10.0.20.0/26', '10.0.20.64/26']);

    // Divide the subnet's block: it shrinks to the first half, at a fixed position in range 2.
    const leaf = vnetLeaves(view.spec, view.result)[0];
    const edited = applyRangeView(spec, 1, view.spec, divide(view.spec, view.result, leaf));
    expect(edited.subnets).toEqual([sn('a', 24), sn('b', 27, { offset: 0, range: 1 })]);
    expect(edited.splits).toEqual([{ offset: 32, prefix: 27, range: 1 }]);
    expect(placed(spokeResult(edited))).toEqual(['a 10.0.8.0/24', 'b 10.0.20.0/27']);
  });

  it('adds and removes ranges, renumbering the subnets and splits of later ones', () => {
    const spec: VnetSpec = {
      ...addRange(twoRanges, 27),
      subnets: [sn('second', 26, { range: 1, offset: 0 }), sn('third', 27, { range: 2, offset: 0 }), sn('fourth', 28, { range: 3 })],
      splits: [{ offset: 64, prefix: 26, range: 1 }, { offset: 32, prefix: 27, range: 3 }],
    };
    expect(spec.ranges).toHaveLength(3);
    const removed = removeRange(spec, 1);
    expect(removed.ranges).toEqual([{ prefix: 26 }, { prefix: 27 }]);
    expect(removed.subnets).toEqual([sn('second', 26), sn('third', 27, { range: 1, offset: 0 }), sn('fourth', 28, { range: 2 })]);
    expect(removed.splits).toEqual([{ offset: 32, prefix: 27, range: 2 }]);
    expect(removeRange(removeRange(removed, 1), 1).ranges).toBeUndefined();
  });
});
