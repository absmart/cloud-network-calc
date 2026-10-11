import { describe, expect, it } from 'vitest';
import { defaultPlan, makeRegion, nextUnusedLocation, relocateRegion, subnet } from './defaults';
import { formatCidr } from './ipv4';
import { computePlan, countIssues } from './planner';
import { findRegion } from './regions';

describe('computePlan', () => {
  it('lays out the default plan without issues', () => {
    const plan = defaultPlan();
    expect(plan.regions.map((r) => [r.name, r.hub.name])).toEqual([
      ['East US 2', 'vnet-hub-eastus2'],
      ['Central US', 'vnet-hub-centralus'],
    ]);
    const result = computePlan(plan);
    expect(countIssues(result)).toEqual({ errors: 0, warnings: 0 });
    const [primary, secondary] = result.regions;
    expect(formatCidr(primary.cidr!)).toBe('10.0.0.0/16');
    expect(formatCidr(secondary.cidr!)).toBe('10.1.0.0/16');
    expect(formatCidr(primary.hub.cidr!)).toBe('10.0.0.0/22');
    expect(primary.spokes.map((s) => formatCidr(s.cidr!))).toEqual([
      '10.0.4.0/24',
      '10.0.5.0/24',
      '10.0.8.0/22',
      '10.0.6.0/23',
    ]);
    expect(primary.hub.subnets.slice(0, 4).map((s) => `${s.name} ${formatCidr(s.cidr!)}`)).toEqual([
      'snet-nva-outside 10.0.0.0/24',
      'snet-nva-inside 10.0.1.0/27',
      'snet-nva-ha 10.0.1.32/27',
      'snet-nva-mgmt 10.0.1.64/27',
    ]);
    expect(result.free.map(formatCidr)).toEqual(['10.2.0.0/15', '10.4.0.0/14', '10.8.0.0/13']);
  });

  it('gives each added region its own /16 and its own hub', () => {
    const plan = defaultPlan();
    for (let i = 0; i < 14; i++) plan.regions.push(makeRegion(nextUnusedLocation(plan), 'hub-spoke'));
    const result = computePlan(plan);
    expect(countIssues(result)).toEqual({ errors: 0, warnings: 0 });
    expect(result.regions.map((r) => formatCidr(r.cidr!))).toEqual(
      Array.from({ length: 16 }, (_, i) => `10.${i}.0.0/16`),
    );
    expect(result.regions.map((r) => formatCidr(r.hub.cidr!))).toEqual(
      Array.from({ length: 16 }, (_, i) => `10.${i}.0.0/22`),
    );
    expect(new Set(plan.regions.map((r) => r.location)).size).toBe(16);
  });

  it('picks the paired region next, then stays in the same geography', () => {
    const plan = defaultPlan();
    plan.regions = [makeRegion('eastus', 'hub-spoke')];
    expect(nextUnusedLocation(plan)).toBe(findRegion('eastus')!.paired);

    // The defaults, East US 2 and Central US, are each other's pair.
    const next = nextUnusedLocation(defaultPlan());
    expect(['eastus2', 'centralus']).not.toContain(next);
    expect(findRegion(next)!.geography).toBe('US');
  });

  it('suggests a wider root when regions no longer fit', () => {
    const plan = defaultPlan();
    plan.root = '10.0.0.0/15';
    plan.regions.push(makeRegion('swedencentral', 'hub-spoke'));
    const result = computePlan(plan);
    expect(result.regions[2].cidr).toBeNull();
    expect(result.issues[0].message).toMatch(/widen it to at least 10\.0\.0\.0\/14/);
  });

  it('warns when two regions share a location', () => {
    const plan = defaultPlan();
    plan.regions.push(makeRegion('eastus2', 'hub-spoke'));
    const result = computePlan(plan);
    expect(result.regions[2].issues[0].message).toMatch(/also uses location/);
  });

  it('enforces Azure subnet rules', () => {
    const plan = defaultPlan();
    const hub = plan.regions[0].hub;
    hub.subnets = [
      subnet('AzureFirewallSubnet', 27),
      subnet('azurebastionsubnet', 26),
      subnet('tiny', 30),
      subnet('dup', 28),
      subnet('dup', 28),
    ];
    plan.regions[0].spokes[0].subnets.push(subnet('GatewaySubnet', 27));
    const region = computePlan(plan).regions[0];
    const messages = (i: number) => region.hub.subnets[i].issues.map((x) => x.message).join('\n');
    expect(messages(0)).toMatch(/must be \/26 or larger/);
    expect(messages(1)).toMatch(/exact name "AzureBastionSubnet"/);
    expect(messages(2)).toMatch(/\/29 or larger/);
    expect(messages(3)).toMatch(/Duplicate/);
    expect(region.spokes[0].subnets.at(-1)!.issues[0].level).toBe('warning');
  });

  it('validates Virtual WAN hub size and skips its subnets', () => {
    const plan = defaultPlan();
    plan.regions[0] = makeRegion('westeurope', 'vwan');
    plan.regions[0].hub.prefix = 25;
    const hub = computePlan(plan).regions[0].hub;
    expect(hub.kind).toBe('virtual-hub');
    expect(hub.subnets).toEqual([]);
    expect(hub.issues[0].message).toMatch(/\/24 or larger/);
  });

  it('flags a root range that is not private', () => {
    const plan = defaultPlan();
    plan.root = '8.0.0.0/12';
    expect(computePlan(plan).issues[0].level).toBe('warning');
  });

  it('renames a region and its VNets when it moves location', () => {
    const moved = relocateRegion(makeRegion('westeurope', 'hub-spoke'), 'swedencentral');
    expect(moved.name).toBe('Sweden Central');
    expect(moved.hub.name).toBe('vnet-hub-swedencentral');
    expect(moved.spokes.map((s) => s.name)).toContain('vnet-corp-swedencentral-001');
  });

  it('reports an invalid pin and falls back to automatic allocation', () => {
    const plan = defaultPlan();
    plan.regions[1].fixed = '10.9.0.0/33';
    const region = computePlan(plan).regions[1];
    expect(region.issues[0].message).toMatch(/Pinned range ignored/);
    expect(formatCidr(region.cidr!)).toBe('10.1.0.0/16');
  });
});
