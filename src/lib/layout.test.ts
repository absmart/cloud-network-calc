import { describe, expect, it } from 'vitest';
import { defaultPlan } from './defaults';
import { formatCidr, parseCidr } from './ipv4';
import { assign, autoPack, divide, join, release, vnetLeaves } from './layout';
import { type PlanSpec, type VnetSpec, computePlan } from './planner';

const c = (s: string) => {
  const r = parseCidr(s);
  if (!r.ok) throw new Error(r.error);
  return r.cidr;
};

/** The primary region's hub (10.0.0.0/23) and its computed result. */
function hubOf(plan: PlanSpec) {
  return { spec: plan.regions[0].hub, result: computePlan(plan).regions[0].hub };
}

function setHub(plan: PlanSpec, hub: VnetSpec) {
  plan.regions[0].hub = hub;
}

const describeLeaves = (plan: PlanSpec) => {
  const { spec, result } = hubOf(plan);
  return vnetLeaves(spec, result).map((l) => `${formatCidr(l.cidr)} ${l.subnet === null ? '-' : spec.subnets[l.subnet].name}`);
};

const leafAt = (plan: PlanSpec, cidr: string) => {
  const { spec, result } = hubOf(plan);
  const leaf = vnetLeaves(spec, result).find((l) => formatCidr(l.cidr) === cidr);
  if (!leaf) throw new Error(`no leaf ${cidr}`);
  return leaf;
};

describe('visual layout', () => {
  it('derives leaves from subnets and free space', () => {
    expect(describeLeaves(defaultPlan())).toEqual([
      '10.0.0.0/24 nva-outside-snet',
      '10.0.1.0/27 nva-inside-snet',
      '10.0.1.32/27 nva-ha-snet',
      '10.0.1.64/27 nva-mgmt-snet',
      '10.0.1.96/27 -',
      '10.0.1.128/25 -',
      '10.0.2.0/27 GatewaySubnet',
      '10.0.2.32/28 dns-inbound-snet',
      '10.0.2.48/28 dns-outbound-snet',
      '10.0.2.64/26 AzureFirewallSubnet',
      '10.0.2.128/26 AzureFirewallManagementSubnet',
      '10.0.2.192/26 AzureBastionSubnet',
      '10.0.3.0/24 -',
    ]);
  });

  it('divides free space, names a block, and joins it back', () => {
    const plan = defaultPlan();
    let { spec, result } = hubOf(plan);
    setHub(plan, divide(spec, result, leafAt(plan, '10.0.3.0/24')));
    expect(describeLeaves(plan).slice(-2)).toEqual(['10.0.3.0/25 -', '10.0.3.128/25 -']);

    ({ spec, result } = hubOf(plan));
    setHub(plan, assign(spec, result, leafAt(plan, '10.0.3.128/25'), 'shared-snet'));
    expect(describeLeaves(plan).slice(-2)).toEqual(['10.0.3.0/25 -', '10.0.3.128/25 shared-snet']);

    ({ spec, result } = hubOf(plan));
    setHub(plan, join(spec, result, vnetLeaves(spec, result), c('10.0.3.0/24')));
    expect(describeLeaves(plan).at(-1)).toBe('10.0.3.0/24 shared-snet');
  });

  it('refuses to join two subnets', () => {
    const plan = defaultPlan();
    const { spec, result } = hubOf(plan);
    expect(join(spec, result, vnetLeaves(spec, result), c('10.0.1.0/25'))).toBe(spec);
  });

  it('divides a subnet, keeping the first half and freeing the second', () => {
    const plan = defaultPlan();
    const { spec, result } = hubOf(plan);
    setHub(plan, divide(spec, result, leafAt(plan, '10.0.2.192/26')));
    expect(describeLeaves(plan)).toContain('10.0.2.192/27 AzureBastionSubnet');
    expect(describeLeaves(plan)).toContain('10.0.2.224/27 -');
    const bastion = computePlan(plan).regions[0].hub.subnets.find((s) => s.name === 'AzureBastionSubnet')!;
    expect(bastion.issues[0].message).toMatch(/must be \/26 or larger/);
  });

  it('keeps the layout when a subnet is removed or the VNet moves', () => {
    const plan = defaultPlan();
    let { spec, result } = hubOf(plan);
    setHub(plan, release(spec, result, 0)); // nva-outside-snet
    expect(describeLeaves(plan)[0]).toBe('10.0.0.0/24 -');

    plan.root = '10.16.0.0/12';
    expect(describeLeaves(plan)[1]).toBe('10.16.1.0/27 nva-inside-snet');

    ({ spec } = hubOf(plan));
    setHub(plan, autoPack(spec));
    // Packed first-fit in list order again, now without the outside subnet.
    expect(describeLeaves(plan).slice(0, 2)).toEqual([
      '10.16.0.0/27 nva-inside-snet',
      '10.16.0.32/27 nva-ha-snet',
    ]);
  });
});
