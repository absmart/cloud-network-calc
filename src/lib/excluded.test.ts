import { describe, expect, it } from 'vitest';
import { defaultPlan } from './defaults';
import { allocate, formatCidr, parseCidr } from './ipv4';
import { computePlan } from './planner';

const c = (s: string) => {
  const r = parseCidr(s);
  if (!r.ok) throw new Error(r.error);
  return r.cidr;
};
const show = (results: ReturnType<typeof allocate>) => results.map((r) => ('cidr' in r ? formatCidr(r.cidr) : r.error));

describe('excluded ranges', () => {
  it('are skipped by automatic placement and refuse pinned blocks', () => {
    const blocked = [{ cidr: c('10.0.0.0/23'), label: 'on-premises' }];
    expect(show(allocate(c('10.0.0.0/22'), [{ prefix: 24 }, { prefix: 24 }, { prefix: 24 }], blocked))).toEqual([
      '10.0.2.0/24',
      '10.0.3.0/24',
      'No room left for a /24 in 10.0.0.0/22',
    ]);
    expect(show(allocate(c('10.0.0.0/22'), [{ prefix: 24, fixed: c('10.0.1.0/24') }], blocked))).toEqual([
      '10.0.1.0/24 overlaps excluded range 10.0.0.0/23 (on-premises)',
    ]);
    expect(
      show(allocate(c('10.0.0.0/22'), [{ prefix: 22, fixed: c('10.0.0.0/22') }], blocked, { mayEnclose: true })),
    ).toEqual(['10.0.0.0/22']);
    // Enclosing is allowed; sitting inside a larger excluded range is not.
    const wide = [{ cidr: c('10.0.0.0/21'), label: 'datacenter' }];
    expect(show(allocate(c('10.0.0.0/16'), [{ prefix: 22, fixed: c('10.0.4.0/22') }, { prefix: 22 }], wide, { mayEnclose: true }))).toEqual([
      '10.0.4.0/22 overlaps excluded range 10.0.0.0/21 (datacenter)',
      '10.0.8.0/22',
    ]);
  });

  it('move regions and VNets out of the way, and count as used space', () => {
    const plan = defaultPlan();
    plan.excluded = [
      { cidr: '10.0.0.0/16', label: 'on-premises' },
      { cidr: '10.2.4.0/24', label: 'partner' },
      { cidr: '192.168.0.0/16' },
    ];
    const result = computePlan(plan);
    expect(result.issues).toEqual([]);
    expect(result.excluded.map((e) => `${formatCidr(e.cidr)} ${e.label}`)).toEqual([
      '10.0.0.0/16 on-premises',
      '10.2.4.0/24 partner',
      '192.168.0.0/16 excluded range 3',
    ]);
    // East US 2 skips 10.0.0.0/16; Central US's /16 encloses the partner /24, which its spokes avoid.
    expect(result.regions.map((r) => formatCidr(r.cidr!))).toEqual(['10.1.0.0/16', '10.2.0.0/16']);
    const cus = result.regions[1];
    expect([cus.hub, ...cus.spokes].map((v) => formatCidr(v.cidr!))).toEqual([
      '10.2.0.0/22',
      '10.2.5.0/24',
      '10.2.6.0/24',
      '10.2.7.0/24',
      '10.2.8.0/22',
      '10.2.12.0/23',
    ]);
    expect(cus.free.map(formatCidr)).not.toContain('10.2.4.0/24');
    expect(result.free.map(formatCidr)).not.toContain('10.0.0.0/16');
  });

  it('report pinned VNets that overlap them, and invalid entries', () => {
    const plan = defaultPlan();
    plan.excluded = [{ cidr: '10.0.8.0/24', label: 'datacenter' }, { cidr: '10.0.8.1/24', label: 'typo' }, { cidr: ' ' }];
    plan.regions[0].spokes[3].fixed = '10.0.8.0/22';
    const result = computePlan(plan);
    expect(result.issues.map((i) => i.message)).toEqual(['Excluded range "typo": Host bits are set; did you mean 10.0.8.0/24?']);
    expect(result.regions[0].spokes[3].issues.map((i) => i.message)).toEqual([
      '10.0.8.0/22 overlaps excluded range 10.0.8.0/24 (datacenter)',
    ]);
  });
});
