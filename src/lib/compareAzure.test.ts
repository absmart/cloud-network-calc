import { describe, expect, it } from 'vitest';
import { compareWithAzure } from './compareAzure';
import { defaultPlan, makeRegion } from './defaults';
import { buildIacModel } from './iac';
import { DEFAULT_NAMING } from './naming';
import { type PlanSpec, computePlan } from './planner';

const modelOf = (plan: PlanSpec) => buildIacModel(plan, computePlan(plan), DEFAULT_NAMING);

type Model = ReturnType<typeof modelOf>;

/** Resource Graph rows for a network deployed exactly as the IaC export describes it. */
function deployedAs(model: Model) {
  return [
    ...model.vnets.map((v) => ({
      id: `/subscriptions/0000/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/${v.name}`,
      name: v.name,
      type: 'microsoft.network/virtualnetworks',
      location: v.location,
      properties: {
        addressSpace: { addressPrefixes: [...v.prefixes] },
        subnets: v.subnets.map((s) => ({ name: s.name, properties: { addressPrefix: s.prefix } })),
      },
    })),
    ...model.virtualHubs.map((h) => ({
      id: `/subscriptions/0000/resourceGroups/rg-net/providers/Microsoft.Network/virtualHubs/${h.name}`,
      name: h.name,
      type: 'microsoft.network/virtualhubs',
      location: h.location,
      properties: { addressPrefix: h.prefix },
    })),
  ];
}

describe('compareWithAzure', () => {
  it('finds nothing to report when Azure matches the plan', () => {
    const model = modelOf(defaultPlan());
    const { networks, counts } = compareWithAzure(model, JSON.stringify({ data: deployedAs(model) }));
    expect(counts).toEqual({ different: 0, 'only-in-azure': 0, 'not-deployed': 0, same: 12 });
    expect(networks[0]).toMatchObject({
      status: 'same',
      matchedBy: 'name',
      planned: { name: 'hub-eus2-vnet', exportedName: 'hub-prd-eus2-01-vnet' },
      deployed: { name: 'hub-prd-eus2-01-vnet', resourceGroup: 'rg-net' },
    });
  });

  it('reports changed, missing and extra networks, subnets and ranges', () => {
    const model = modelOf(defaultPlan());
    const rows = deployedAs(model);
    // The East US 2 hub: one subnet moved, one missing, one extra, plus an extra range.
    const hub = rows[0].properties as { addressSpace: { addressPrefixes: string[] }; subnets: { name: string; properties: { addressPrefix: string } }[] };
    hub.addressSpace.addressPrefixes.push('10.0.250.0/24');
    hub.subnets.find((s) => s.name === 'GatewaySubnet')!.properties.addressPrefix = '10.0.250.0/27';
    hub.subnets = hub.subnets.filter((s) => s.name !== 'AzureBastionSubnet');
    hub.subnets.push({ name: 'legacy-snet', properties: { addressPrefix: '10.0.250.64/26' } });
    // A spoke renamed in Azure, still found by its address space.
    rows[1].name = 'identity-renamed';
    rows[1].id = rows[1].id.replace(/[^/]+$/, 'identity-renamed');
    // A planned spoke that was never deployed, and two networks only in Azure.
    const dropped = rows.splice(2, 1)[0].name;
    rows.push(
      { ...rows[1], id: '/x/resourceGroups/rg-old/y/clash', name: 'clash-vnet', location: 'westus3', properties: { addressSpace: { addressPrefixes: ['10.0.5.0/24'] }, subnets: [] } },
      { ...rows[1], id: '/x/resourceGroups/rg-lab/y/lab', name: 'lab-vnet', properties: { addressSpace: { addressPrefixes: ['192.168.0.0/24'] }, subnets: [] } },
    );

    const { networks, counts } = compareWithAzure(model, JSON.stringify(rows));
    expect(counts).toEqual({ different: 1, 'only-in-azure': 2, 'not-deployed': 1, same: 10 });
    expect(networks[0]).toMatchObject({ status: 'different', planned: { name: 'hub-eus2-vnet' } });
    expect(networks[0].differences).toEqual([
      'Azure also has address range 10.0.250.0/24',
      'Subnet GatewaySubnet: planned 10.0.2.0/27, Azure has 10.0.250.0/27',
      "Subnet AzureBastionSubnet (10.0.2.192/26) isn't in Azure",
      'Azure also has subnet legacy-snet (10.0.250.64/26)',
    ]);
    expect(networks.filter((n) => n.status === 'only-in-azure')).toEqual([
      expect.objectContaining({ deployed: expect.objectContaining({ name: 'clash-vnet', resourceGroup: 'rg-old' }), conflict: true, differences: ['Overlaps planned 10.0.5.0/24 (management-eus2-vnet)'] }),
      expect.objectContaining({ deployed: expect.objectContaining({ name: 'lab-vnet' }), conflict: false, differences: [] }),
    ]);
    expect(networks.find((n) => n.status === 'not-deployed')!.planned!.exportedName).toBe(dropped);
    expect(networks.find((n) => n.deployed?.name === 'identity-renamed')).toMatchObject({ status: 'same', matchedBy: 'address space' });
  });

  it('compares Virtual WAN hubs and notes what the plan leaves out', () => {
    const plan = defaultPlan();
    plan.regions[0] = makeRegion('eastus2', 'vwan');
    plan.root = '10.0.0.0/16';
    const model = modelOf(plan);
    const rows = deployedAs(model);
    (rows.find((r) => r.type === 'microsoft.network/virtualhubs')!.properties as { addressPrefix: string }).addressPrefix = '10.0.0.0/24';
    const { networks, notes } = compareWithAzure(model, JSON.stringify(rows));
    expect(networks[0]).toMatchObject({ status: 'different', kind: 'virtual-hub', differences: ["Address range 10.0.0.0/23 isn't in Azure", 'Azure also has address range 10.0.0.0/24'] });
    expect(notes.map((n) => n.message)).toContain("Not compared, because the plan doesn't allocate them: region Central US");
  });
});
