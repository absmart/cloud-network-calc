import { describe, expect, it } from 'vitest';
import { defaultPlan, makeRegion } from './defaults';
import { buildIacModel, toBicepParams, toTfvars } from './iac';
import { DEFAULT_NAMING } from './naming';
import { type PlacementLayout, type PlanSpec, computePlan } from './planner';

const modelOf = (plan: PlanSpec) => buildIacModel(plan, computePlan(plan), DEFAULT_NAMING);
const withLayout = (layout: PlacementLayout, plan = defaultPlan()) => ({ ...plan, placement: layout });
const placed = (plan: PlanSpec) => modelOf(plan).vnets.map((v) => `${v.name} → ${v.subscription} / ${v.resourceGroup}`);

describe('placement in subscriptions and resource groups', () => {
  it('keeps everything in one subscription and resource group by default', () => {
    const m = modelOf(defaultPlan());
    expect(m.subscriptions).toEqual(['main']);
    expect(new Set(m.vnets.map((v) => v.resourceGroup))).toEqual(new Set(['network-prd-eus2-01-rg']));
  });

  it('follows the Azure Landing Zones layout: platform subscriptions plus one per landing zone', () => {
    const plan = withLayout('alz');
    expect(placed(plan).slice(0, 7)).toEqual([
      'hub-prd-eus2-01-vnet → connectivity / connectivity-prd-eus2-01-rg',
      'identity-prd-eus2-01-vnet → identity / identity-prd-eus2-01-rg',
      'management-prd-eus2-01-vnet → management / management-prd-eus2-01-rg',
      'security-prd-eus2-01-vnet → security / security-prd-eus2-01-rg',
      'corp-prd-eus2-001-vnet → corp-eus2-001 / corp-prd-eus2-001-rg',
      'online-prd-eus2-001-vnet → online-eus2-001 / online-prd-eus2-001-rg',
      'hub-prd-cus-01-vnet → connectivity / connectivity-prd-cus-01-rg',
    ]);
    const m = modelOf(plan);
    expect(m.subscriptions).toEqual([
      'connectivity',
      'identity',
      'management',
      'security',
      'corp-eus2-001',
      'online-eus2-001',
      'corp-cus-001',
      'online-cus-001',
    ]);
    // One resource group per network and region; the platform subscriptions hold one per region.
    expect(m.resourceGroups).toHaveLength(12);
    expect(m.resourceGroups.filter((g) => g.subscription === 'connectivity').map((g) => `${g.name} ${g.location}`)).toEqual([
      'connectivity-prd-eus2-01-rg eastus2',
      'connectivity-prd-cus-01-rg centralus',
    ]);
  });

  it('puts hubs and platform networks in one platform subscription with the smaller ALZ layout', () => {
    const m = modelOf(withLayout('alz-platform'));
    expect(m.subscriptions).toEqual(['platform', 'corp-eus2-001', 'online-eus2-001', 'corp-cus-001', 'online-cus-001']);
    expect(placed(withLayout('alz-platform'))[1]).toBe('identity-prd-eus2-01-vnet → platform / identity-prd-eus2-01-rg');
  });

  it('places the Virtual WAN with the first virtual hub, in connectivity', () => {
    const plan = withLayout('alz');
    plan.regions[0] = makeRegion('eastus2', 'vwan');
    const m = modelOf(plan);
    expect(m.virtualWan).toEqual({
      name: 'network-prd-eus2-01-vwan',
      location: 'eastus2',
      subscription: 'connectivity',
      resourceGroup: 'connectivity-prd-eus2-01-rg',
    });
    expect(m.virtualHubs[0]).toMatchObject({ subscription: 'connectivity', resourceGroup: 'connectivity-prd-eus2-01-rg' });
  });

  it('lets a VNet override its subscription and resource group, and uses a subscription ID as is', () => {
    const plan = withLayout('alz');
    const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    Object.assign(plan.regions[0].spokes[3], { subscription: id, resourceGroup: 'legacy-network-rg' });
    const m = modelOf(plan);
    expect(m.vnets[4]).toMatchObject({ name: 'corp-prd-eus2-001-vnet', subscription: id, resourceGroup: 'legacy-network-rg' });
    expect(toTfvars(m)).toContain(`"${id}" = "${id}"\n`);
    expect(toTfvars(m)).toMatch(/"connectivity" += "00000000-0000-0000-0000-000000000000" # replace with the subscription ID/);
    expect(toBicepParams(m)).toContain(`'${id}': '${id}'\n`);
    expect(toBicepParams(m)).toContain("  connectivity: '00000000-0000-0000-0000-000000000000' // replace with the subscription ID");
  });
});
