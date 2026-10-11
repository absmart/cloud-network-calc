import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPOKE_TEMPLATES, defaultPlan, makeRegion } from './defaults';
import { buildIacModel, generateIac, generateIacFiles, toTerraform } from './iac';
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
    // Central US hub → East US 2 hub, named after the remote VNet.
    expect(m.peerings.at(-1)!.name).toBe('hub-prdeus201-peer');
    const hub = m.vnets[0];
    expect(hub).toMatchObject({ name: 'hub-prdeus201-vnet', location: 'eastus2', prefix: '10.0.0.0/22' });
    expect(hub.subnets.find((s) => s.name === 'dnsinbound-prdeus201-snet')!.delegation).toBe('Microsoft.Network/dnsResolvers');
    expect(hub.subnets.find((s) => s.name === 'GatewaySubnet')!.delegation).toBeUndefined();
    expect(m.omitted).toEqual([]);
  });

  it('models Virtual WAN regions as virtual hubs with spoke connections', () => {
    const m = model(vwanPlan());
    expect(m.virtualHubs).toEqual([{ name: 'hub-prdeus201-vhub', location: 'eastus2', prefix: '10.0.0.0/23' }]);
    expect(m.virtualWan).toBe('network-prdeus201-vwan');
    expect(m.hubConnections[0].name).toBe('identity-prdeus201-conn');
    expect(m.hubConnections).toHaveLength(5);
    expect(m.vnets).toHaveLength(11);
    expect(m.peerings).toHaveLength(10); // only Central US's hub and spokes
  });

  it('names resources <app>-<environment><region><int>-<resourcetype>', () => {
    const m = model();
    expect(m.resourceGroup).toBe('network-prdeus201-rg');
    expect(m.vnets.map((v) => v.name)).toEqual([
      'hub-prdeus201-vnet',
      'identity-prdeus201-vnet',
      'management-prdeus201-vnet',
      'security-prdeus201-vnet',
      'corp-prdeus2001-vnet', // keeps the 001 from vnet-corp-eus2-001
      'online-prdeus2001-vnet',
      'hub-prdcus01-vnet',
      'identity-prdcus01-vnet',
      'management-prdcus01-vnet',
      'security-prdcus01-vnet',
      'corp-prdcus001-vnet',
      'online-prdcus001-vnet',
    ]);
    expect(m.vnets[0].subnets.map((s) => s.name).slice(0, 5)).toEqual([
      'nvaoutside-prdeus201-snet',
      'nvainside-prdeus201-snet',
      'nvaha-prdeus201-snet',
      'nvamgmt-prdeus201-snet',
      'GatewaySubnet', // Azure-reserved names are kept
    ]);
    expect(m.vnets[1].subnets[0].name).toBe('identity-prdeus201-snet');

    // Plans saved with full location names (vnet-corp-eastus2-001) export the same names.
    const legacy = defaultPlan();
    for (const v of [legacy.regions[0].hub, ...legacy.regions[0].spokes]) v.name = v.name.replace('-eus2', '-eastus2');
    expect(model(legacy).vnets.map((v) => v.name)).toEqual(m.vnets.map((v) => v.name));
  });

  it('uses the chosen app, environment and instance, and numbers repeats', () => {
    const plan = defaultPlan();
    plan.regions[0].spokes.push(SPOKE_TEMPLATES.empty.make('eastus2'), SPOKE_TEMPLATES.empty.make('eastus2'));
    const m = buildIacModel(plan, computePlan(plan), { app: 'Contoso Net', environment: 'DEV', instance: '02' });
    expect(m.resourceGroup).toBe('contosonet-deveus202-rg');
    expect(m.vnets[0].name).toBe('hub-deveus202-vnet');
    expect(m.vnets.filter((v) => v.name.startsWith('spoke-')).map((v) => v.name)).toEqual([
      'spoke-deveus202-vnet',
      'spoke-deveus203-vnet',
    ]);
    const tf = toTerraform(m);
    expect(tf).toContain('"hub-deveus202-vnet/identity-deveus202-peer" = {');
    expect(tf).toContain('default = "contosonet-deveus202-rg"');
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
    expect(generateIac('bicep', defaultPlan(), computePlan(defaultPlan()))).toContain("name: 'hub-prdeus201-vnet'");
  });

  it('only emits Virtual WAN resources when the plan uses Virtual WAN', () => {
    const plain = generateIac('terraform', defaultPlan(), computePlan(defaultPlan()));
    expect(plain).not.toContain('azurerm_virtual_wan');
    const plan = vwanPlan();
    const withWan = generateIac('bicep', plan, computePlan(plan));
    expect(withWan).toContain("resource virtualWan 'Microsoft.Network/virtualWans@2024-05-01'");
    expect(withWan).toContain('hubVirtualNetworkConnections');
  });

  it('pairs each template with an example variables file for the environment', () => {
    const plan = defaultPlan();
    const naming = { app: 'network', environment: 'dev', instance: '01' };
    const [bicep, bicepParams] = generateIacFiles('bicep', plan, computePlan(plan), naming);
    expect(bicep.name).toBe('alz-network.bicep');
    expect(bicep.content).toContain('param tags object = {}');
    expect(bicep.content).toContain('--parameters alz-network.dev.bicepparam');
    expect(bicepParams.name).toBe('alz-network.dev.bicepparam');
    expect(bicepParams.content).toContain("using './alz-network.bicep'");
    expect(bicepParams.content).toContain("environment: 'dev'");

    const [tf, tfvars] = generateIacFiles('terraform', plan, computePlan(plan), naming);
    expect(tf.content).toContain('variable "tags"');
    expect(tf.content).toContain('terraform apply -var-file=dev.tfvars');
    expect(tfvars.name).toBe('dev.tfvars');
    expect(tfvars.content).toContain('resource_group_name     = "network-deveus201-rg"');
    expect(tfvars.content).toContain('environment = "dev"');
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
        for (const file of generateIacFiles(format, plan, computePlan(plan))) writeFileSync(join(dir, file.name), file.content);
      }
    }
  });
});
