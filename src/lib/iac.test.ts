import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPOKE_TEMPLATES, defaultPlan, makeRegion } from './defaults';
import { type IacFormat, TERRAGRUNT_ROOT, buildIacModel, generateIacFiles, toBicepParams, toTfvars } from './iac';
import { crc32, createZip } from './zip';
import type { NamingOptions } from './naming';
import { type PlanSpec, computePlan } from './planner';

const model = (plan = defaultPlan()) => buildIacModel(plan, computePlan(plan));
const files = (format: IacFormat, plan: PlanSpec, naming?: NamingOptions) =>
  generateIacFiles(format, plan, computePlan(plan), naming);

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
      'corp-prdeus2001-vnet', // keeps the 001 from corp-eus2-001-vnet
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

    // Plans saved with older prefixed names (vnet-corp-eastus2-001, snet-dns-inbound)
    // export the same names, and keep the DNS resolver delegation.
    const legacy = defaultPlan();
    for (const region of legacy.regions) {
      for (const v of [region.hub, ...region.spokes]) {
        v.name = `vnet-${v.name.replace(/-vnet$/, '').replace(/-(eus2|cus)\b/, (_, c) => (c === 'eus2' ? '-eastus2' : '-centralus'))}`;
        for (const s of v.subnets) if (s.name.endsWith('-snet')) s.name = `snet-${s.name.replace(/-snet$/, '')}`;
      }
    }
    expect(legacy.regions[0].spokes[3].name).toBe('vnet-corp-eastus2-001');
    const legacyModel = model(legacy);
    expect(legacyModel.vnets.map((v) => v.name)).toEqual(m.vnets.map((v) => v.name));
    expect(legacyModel.vnets[0].subnets.map((s) => s.name)).toEqual(m.vnets[0].subnets.map((s) => s.name));
    expect(legacyModel.vnets[0].subnets.find((s) => s.name === 'dnsinbound-prdeus201-snet')!.delegation).toBe(
      'Microsoft.Network/dnsResolvers',
    );
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
    const tfvars = toTfvars(m);
    expect(tfvars).toContain('"hub-deveus202-vnet/identity-deveus202-peer" = {');
    expect(tfvars).toContain('resource_group_name     = "contosonet-deveus202-rg"');
  });

  it('keeps templates generic: the same template for any plan, values only in the variables file', () => {
    const a = files('bicep', defaultPlan());
    const b = files('bicep', vwanPlan(), { app: 'other', environment: 'dev', instance: '07' });
    expect(a[0].content).toBe(b[0].content);
    expect(files('terraform', defaultPlan())[0].content).toBe(files('terraform', vwanPlan())[0].content);

    // No plan values in the templates...
    for (const [template] of [a, files('terraform', defaultPlan())]) {
      expect(template.content).not.toMatch(/10\.0\.|eastus2|prdeus2|GatewaySubnet/);
    }
    // ...every input is a parameter / variable.
    for (const p of ['tags', 'vnets', 'peerings', 'virtualWan', 'virtualHubs', 'hubConnections']) {
      expect(a[0].content).toMatch(new RegExp(`^param ${p} `, 'm'));
    }
    const tf = files('terraform', defaultPlan())[0].content;
    for (const v of ['subscription_id', 'resource_group_name', 'resource_group_location', 'tags', 'vnets', 'peerings', 'virtual_wan', 'virtual_hubs', 'hub_connections']) {
      expect(tf).toContain(`variable "${v}" {`);
    }
  });

  it('puts the plan into the variables files', () => {
    const [, params] = files('bicep', defaultPlan());
    expect(params.content).toContain("using './alz-network.bicep'");
    expect(params.content).toContain("name: 'hub-prdeus201-vnet'");
    expect(params.content).toContain("delegation: 'Microsoft.Network/dnsResolvers'");
    expect(params.content).toContain("remoteVnet: 'identity-prdeus201-vnet'");
    expect(params.content).not.toContain('param virtualWan');

    const [, tfvars] = files('terraform', defaultPlan());
    expect(tfvars.content).toContain('"hub-prdeus201-vnet" = {');
    expect(tfvars.content).toContain('"GatewaySubnet"');
    expect(tfvars.content).toContain('remote_vnet             = "identity-prdeus201-vnet"');
    expect(tfvars.content).not.toContain('virtual_wan');

    const [, wanParams] = files('bicep', vwanPlan());
    expect(wanParams.content).toContain("param virtualWan = {\n  name: 'network-prdeus201-vwan'");
    expect(wanParams.content).toContain("virtualHub: 'hub-prdeus201-vhub'");
    const [, wanVars] = files('terraform', vwanPlan());
    expect(wanVars.content).toContain('virtual_hub = "hub-prdeus201-vhub"');
  });

  it('names the variables file after the environment', () => {
    const naming = { app: 'network', environment: 'dev', instance: '01' };
    expect(files('bicep', defaultPlan(), naming).map((f) => f.name)).toEqual(['alz-network.bicep', 'alz-network.dev.bicepparam']);
    expect(files('terraform', defaultPlan(), naming).map((f) => f.name)).toEqual(['main.tf', 'dev.tfvars']);
    expect(files('terraform', defaultPlan(), naming)[1].content).toContain('terraform apply -var-file=dev.tfvars');
  });

  it('lists what it leaves out', () => {
    const plan = defaultPlan();
    plan.root = '10.0.0.0/16';
    expect(model(plan).omitted).toEqual(['region Central US']);
    expect(files('terraform', plan)[1].content).toContain('#   - region Central US');
  });

  it('escapes names for each language', () => {
    const m = model();
    m.vnets[0].name = `it's a "\${name}"`;
    expect(toTfvars(m)).toContain(`"it's a \\"$\${name}\\""`);
    expect(toBicepParams(m)).toContain(`'it\\'s a "\\\${name}"'`);
  });

  it('lays out a Terragrunt stack around the same module', () => {
    const naming = { app: 'network', environment: 'dev', instance: '01' };
    const tg = files('terragrunt', defaultPlan(), naming);
    expect(tg.map((f) => f.name)).toEqual([
      'root.hcl',
      'modules/alz-network/main.tf',
      'live/dev/alz-network/terragrunt.hcl',
      'README.md',
    ]);
    const [root, module, live] = tg.map((f) => f.content);
    expect(root).toContain('backend = "azurerm"');
    expect(root).toContain('generate "provider"');
    // The module is the Terraform template without the provider and subscription variable.
    expect(module).not.toContain('provider "azurerm"');
    expect(module).not.toContain('variable "subscription_id"');
    expect(module).toContain('variable "vnets" {');
    expect(module.replace(/^#.*\n/gm, '')).toBe(
      files('terraform', defaultPlan())[0]
        .content.replace(/^#.*\n/gm, '')
        .replace(/\nprovider "azurerm" \{[^}]*\{\}[^}]*\}\n/, '')
        .replace(/\nvariable "subscription_id" \{[^}]*\}\n/, ''),
    );
    expect(live).toContain('path = find_in_parent_folders("root.hcl")');
    expect(live).toContain('source = "${get_parent_terragrunt_dir("root")}/modules//alz-network"');
    expect(live).toContain('inputs = {\n  resource_group_name     = "network-deveus201-rg"');
    expect(live).toContain('    "hub-deveus201-vnet" = {');
    expect(live).not.toContain('subscription_id');
  });

  it('zips files with their folders', () => {
    const zip = createZip([
      { name: 'a/b.txt', content: 'hello' },
      { name: 'c.txt', content: 'é' },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  // Set IAC_OUT_DIR to write sample files for `az bicep build` / `terraform validate`.
  it.runIf(!!process.env.IAC_OUT_DIR)('writes sample files', () => {
    for (const [name, plan] of [
      ['hub-spoke', defaultPlan()],
      ['vwan', vwanPlan()],
    ] as const) {
      for (const format of ['bicep', 'terraform', 'terragrunt'] as const) {
        const dir = join(process.env.IAC_OUT_DIR!, name, format);
        for (const file of generateIacFiles(format, plan, computePlan(plan))) {
          mkdirSync(dirname(join(dir, file.name)), { recursive: true });
          writeFileSync(join(dir, file.name), file.content);
        }
      }
      const tg = generateIacFiles('terragrunt', plan, computePlan(plan));
      writeFileSync(
        join(process.env.IAC_OUT_DIR!, name, `${TERRAGRUNT_ROOT}.zip`),
        createZip(tg.map((f) => ({ name: `${TERRAGRUNT_ROOT}/${f.name}`, content: f.content }))),
      );
    }
  });
});
