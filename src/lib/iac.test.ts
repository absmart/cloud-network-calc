import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPlan, makeRegion } from './defaults';
import { IAC_FILE_NAME, buildIacModel, generateIac, toTerraform } from './iac';
import { computePlan } from './planner';

const model = (plan = defaultPlan()) => buildIacModel(plan, computePlan(plan));

const vwanPlan = () => {
  const plan = defaultPlan();
  plan.regions[0] = makeRegion('eastus2', 'vwan');
  return plan;
};

describe('IaC export', () => {
  it('models hub-and-spoke regions with spoke and hub-to-hub peerings', () => {
    const m = model();
    expect(m.vnets).toHaveLength(12); // 2 hubs + 2 × 5 spokes
    expect(m.virtualHubs).toHaveLength(0);
    // Hub↔spoke both ways (2 × 5 × 2) plus the two hubs peered both ways.
    expect(m.peerings).toHaveLength(22);
    expect(m.peerings.at(-1)!.name).toBe('peer-vnet-hub-centralus-to-vnet-hub-eastus2');
    const hub = m.vnets[0];
    expect(hub).toMatchObject({ name: 'vnet-hub-eastus2', location: 'eastus2', prefix: '10.0.0.0/22' });
    expect(hub.subnets.find((s) => s.name === 'snet-dns-inbound')!.delegation).toBe('Microsoft.Network/dnsResolvers');
    expect(hub.subnets.find((s) => s.name === 'GatewaySubnet')!.delegation).toBeUndefined();
    expect(m.omitted).toEqual([]);
  });

  it('models Virtual WAN regions as virtual hubs with spoke connections', () => {
    const m = model(vwanPlan());
    expect(m.virtualHubs).toEqual([{ name: 'vhub-eastus2', location: 'eastus2', prefix: '10.0.0.0/23' }]);
    expect(m.hubConnections).toHaveLength(5);
    expect(m.vnets).toHaveLength(11);
    expect(m.peerings).toHaveLength(10); // only Central US's hub and spokes
  });

  it('lists what it leaves out', () => {
    const plan = defaultPlan();
    plan.root = '10.0.0.0/16';
    const m = model(plan);
    expect(m.omitted).toEqual(['region Central US']);
    expect(generateIac('terraform', plan, computePlan(plan))).toContain('#   - region Central US');
  });

  it('escapes names for each language', () => {
    const m = model();
    m.vnets[0].name = `it's a "\${name}"`;
    expect(toTerraform(m)).toContain(`"it's a \\"$\${name}\\""`);
    expect(generateIac('bicep', defaultPlan(), computePlan(defaultPlan()))).toContain("name: 'vnet-hub-eastus2'");
  });

  it('only emits Virtual WAN resources when the plan uses Virtual WAN', () => {
    const plain = generateIac('terraform', defaultPlan(), computePlan(defaultPlan()));
    expect(plain).not.toContain('azurerm_virtual_wan');
    const plan = vwanPlan();
    const withWan = generateIac('bicep', plan, computePlan(plan));
    expect(withWan).toContain("resource virtualWan 'Microsoft.Network/virtualWans@2024-05-01'");
    expect(withWan).toContain('hubVirtualNetworkConnections');
  });

  // Set IAC_OUT_DIR to write sample files for `az bicep build` / `terraform validate`.
  it.runIf(!!process.env.IAC_OUT_DIR)('writes sample files', () => {
    for (const [name, plan] of [
      ['hub-spoke', defaultPlan()],
      ['vwan', vwanPlan()],
    ] as const) {
      for (const format of ['bicep', 'terraform'] as const) {
        const dir = join(process.env.IAC_OUT_DIR!, name, format);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, IAC_FILE_NAME[format]), generateIac(format, plan, computePlan(plan)));
      }
    }
  });
});
