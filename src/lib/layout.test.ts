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
      '10.0.0.0/27 GatewaySubnet',
      '10.0.0.32/28 snet-dns-inbound',
      '10.0.0.48/28 snet-dns-outbound',
      '10.0.0.64/26 AzureFirewallSubnet',
      '10.0.0.128/26 AzureFirewallManagementSubnet',
      '10.0.0.192/26 AzureBastionSubnet',
      '10.0.1.0/24 snet-nva-outside',
      '10.0.2.0/27 snet-nva-inside',
      '10.0.2.32/29 snet-nva-ha',
      '10.0.2.40/29 -',
      '10.0.2.48/28 snet-nva-mgmt',
      '10.0.2.64/26 -',
      '10.0.2.128/25 -',
      '10.0.3.0/24 -',
    ]);
  });

  it('divides free space, names a block, and joins it back', () => {
    const plan = defaultPlan();
    let { spec, result } = hubOf(plan);
    setHub(plan, divide(spec, result, leafAt(plan, '10.0.3.0/24')));
    expect(describeLeaves(plan).slice(-2)).toEqual(['10.0.3.0/25 -', '10.0.3.128/25 -']);

    ({ spec, result } = hubOf(plan));
    setHub(plan, assign(spec, result, leafAt(plan, '10.0.3.128/25'), 'snet-shared'));
    expect(describeLeaves(plan).slice(-2)).toEqual(['10.0.3.0/25 -', '10.0.3.128/25 snet-shared']);

    ({ spec, result } = hubOf(plan));
    setHub(plan, join(spec, result, vnetLeaves(spec, result), c('10.0.3.0/24')));
    expect(describeLeaves(plan).at(-1)).toBe('10.0.3.0/24 snet-shared');
  });

  it('refuses to join two subnets', () => {
    const plan = defaultPlan();
    const { spec, result } = hubOf(plan);
    expect(join(spec, result, vnetLeaves(spec, result), c('10.0.0.0/25'))).toBe(spec);
  });

  it('divides a subnet, keeping the first half and freeing the second', () => {
    const plan = defaultPlan();
    const { spec, result } = hubOf(plan);
    setHub(plan, divide(spec, result, leafAt(plan, '10.0.0.192/26')));
    expect(describeLeaves(plan)).toContain('10.0.0.192/27 AzureBastionSubnet');
    expect(describeLeaves(plan)).toContain('10.0.0.224/27 -');
    const bastion = computePlan(plan).regions[0].hub.subnets[3];
    expect(bastion.issues[0].message).toMatch(/must be \/26 or larger/);
  });

  it('keeps the layout when a subnet is removed or the VNet moves', () => {
    const plan = defaultPlan();
    let { spec, result } = hubOf(plan);
    setHub(plan, release(spec, result, 0)); // GatewaySubnet
    expect(describeLeaves(plan)[0]).toBe('10.0.0.0/27 -');

    plan.root = '10.16.0.0/12';
    expect(describeLeaves(plan)[1]).toBe('10.16.0.32/28 snet-dns-inbound');

    ({ spec } = hubOf(plan));
    setHub(plan, autoPack(spec));
    // Packed first-fit in list order again, now without the GatewaySubnet.
    expect(describeLeaves(plan).slice(0, 2)).toEqual([
      '10.16.0.0/26 AzureFirewallSubnet',
      '10.16.0.64/26 AzureFirewallManagementSubnet',
    ]);
  });
});
