import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPOKE_TEMPLATES, defaultPlan, makeRegion } from './defaults';
import { type IacFormat, TERRAGRUNT_ROOT, buildIacModel, generateIacFiles, providerAliases, toBicepParams, toTfvars } from './iac';
import { crc32, createZip } from './zip';
import { DEFAULT_NAMING, type NamingOptions } from './naming';
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
    expect(m.peerings.at(-1)!.name).toBe('hub-prd-eus2-01-peer');
    const hub = m.vnets[0];
    expect(hub).toMatchObject({ name: 'hub-prd-eus2-01-vnet', location: 'eastus2', prefixes: ['10.0.0.0/22'] });
    expect(hub.subnets.find((s) => s.name === 'dns-inbound-prd-eus2-01-snet')!.delegation).toBe('Microsoft.Network/dnsResolvers');
    expect(hub.subnets.find((s) => s.name === 'GatewaySubnet')!.delegation).toBeUndefined();
    expect(m.omitted).toEqual([]);
  });

  it('exports platform subnets in the hub when the platform layout is "hub"', () => {
    const plan = defaultPlan();
    plan.regions[0] = makeRegion('eastus2', 'hub-spoke', 'hub');
    const m = model(plan);
    expect(m.vnets).toHaveLength(9); // 2 hubs + 2 landing zones + 5 spokes in Central US
    expect(m.vnets[0].subnets.slice(-3)).toEqual([
      { name: 'identity-prd-eus2-01-snet', plannerName: 'identity-snet', prefix: '10.0.3.0/27' },
      { name: 'management-prd-eus2-01-snet', plannerName: 'management-snet', prefix: '10.0.3.32/27' },
      { name: 'security-prd-eus2-01-snet', plannerName: 'security-snet', prefix: '10.0.3.64/27' },
    ]);
    expect(m.omitted).toEqual([]);
  });

  it('models Virtual WAN regions as virtual hubs with spoke connections', () => {
    const m = model(vwanPlan());
    expect(m.virtualHubs).toEqual([
      expect.objectContaining({ name: 'hub-prd-eus2-01-vhub', plannerName: 'hub-eus2-vhub', location: 'eastus2', prefix: '10.0.0.0/23' }),
    ]);
    expect(m.virtualWan).toEqual({
      name: 'network-prd-eus2-01-vwan',
      location: 'eastus2',
      subscription: 'main',
      resourceGroup: 'network-prd-eus2-01-rg',
    });
    expect(m.hubConnections[0].name).toBe('identity-prd-eus2-01-conn');
    expect(m.hubConnections).toHaveLength(5);
    expect(m.vnets).toHaveLength(11);
    expect(m.peerings).toHaveLength(10); // only Central US's hub and spokes
  });

  it('names resources <app>-<environment>-<region>-<int>-<resourcetype>', () => {
    const m = model();
    expect(m.subscriptions).toEqual(['main']);
    expect(m.resourceGroups).toEqual([{ name: 'network-prd-eus2-01-rg', subscription: 'main', location: 'eastus2' }]);
    expect(m.vnets.map((v) => v.name)).toEqual([
      'hub-prd-eus2-01-vnet',
      'identity-prd-eus2-01-vnet',
      'management-prd-eus2-01-vnet',
      'security-prd-eus2-01-vnet',
      'corp-prd-eus2-001-vnet', // keeps the 001 from corp-eus2-001-vnet
      'online-prd-eus2-001-vnet',
      'hub-prd-cus-01-vnet',
      'identity-prd-cus-01-vnet',
      'management-prd-cus-01-vnet',
      'security-prd-cus-01-vnet',
      'corp-prd-cus-001-vnet',
      'online-prd-cus-001-vnet',
    ]);
    expect(m.vnets[0].subnets.map((s) => s.name).slice(0, 5)).toEqual([
      'nva-outside-prd-eus2-01-snet',
      'nva-inside-prd-eus2-01-snet',
      'nva-ha-prd-eus2-01-snet',
      'nva-mgmt-prd-eus2-01-snet',
      'GatewaySubnet', // Azure-reserved names are kept
    ]);
    expect(m.vnets[1].subnets[0].name).toBe('identity-prd-eus2-01-snet');

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
    expect(legacyModel.vnets[0].subnets.find((s) => s.name === 'dns-inbound-prd-eus2-01-snet')!.delegation).toBe(
      'Microsoft.Network/dnsResolvers',
    );
  });

  it('separates every name component with a single hyphen', () => {
    const names = (naming: NamingOptions) => {
      const m = buildIacModel(defaultPlan(), computePlan(defaultPlan()), naming);
      return [m.resourceGroups[0].name, ...m.vnets.flatMap((v) => [v.name, ...v.subnets.map((s) => s.name)])];
    };
    for (const name of names(DEFAULT_NAMING).filter((n) => !/^[A-Z]/.test(n))) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-(prd)-(eus2|cus)-\d+-(rg|vnet|snet)$/);
    }
    // A blank environment is left out instead of leaving a double hyphen.
    const blank = names({ ...DEFAULT_NAMING, environment: '' });
    expect(blank[0]).toBe('network-eus2-01-rg');
    expect(blank.some((n) => n.includes('--'))).toBe(false);
  });

  it('uses the chosen app, environment and instance, and numbers repeats', () => {
    const plan = defaultPlan();
    plan.regions[0].spokes.push(SPOKE_TEMPLATES.empty.make('eastus2'), SPOKE_TEMPLATES.empty.make('eastus2'));
    const m = buildIacModel(plan, computePlan(plan), { app: 'Contoso Net', environment: 'DEV', instance: '02' });
    expect(m.resourceGroups[0].name).toBe('contoso-net-dev-eus2-02-rg');
    expect(m.vnets[0].name).toBe('hub-dev-eus2-02-vnet');
    expect(m.vnets.filter((v) => v.name.startsWith('spoke-')).map((v) => v.name)).toEqual([
      'spoke-dev-eus2-02-vnet',
      'spoke-dev-eus2-03-vnet',
    ]);
    const tfvars = toTfvars(m);
    expect(tfvars).toContain('"hub-dev-eus2-02-vnet/identity-dev-eus2-02-peer" = {');
    expect(tfvars).toContain('"main/contoso-net-dev-eus2-02-rg" = {');
  });

  it('keeps templates generic: the same template for any plan, values only in the variables file', () => {
    const a = files('bicep', defaultPlan());
    const b = files('bicep', vwanPlan(), { app: 'other', environment: 'dev', instance: '07' });
    expect(a[0].content).toBe(b[0].content);
    // Terraform's root depends only on the plan's subscriptions; its modules on nothing.
    expect(files('terraform', defaultPlan())[0].content).toBe(files('terraform', vwanPlan())[0].content);

    // No plan values in the templates and modules (everything but the variables file)...
    for (const template of [...a.slice(0, -1), ...files('terraform', { ...defaultPlan(), placement: 'alz' }).slice(0, -1)]) {
      expect(template.content).not.toMatch(/10\.0\.|eastus2|prd-eus2|eus2-01|GatewaySubnet/);
    }
    // ...every input is a parameter / variable.
    for (const p of ['subscriptions', 'resourceGroups', 'tags', 'vnets', 'peerings', 'virtualWan', 'virtualHubs', 'hubConnections']) {
      expect(a[0].content).toMatch(new RegExp(`^param ${p} `, 'm'));
    }
    const tf = files('terraform', defaultPlan())[0].content;
    for (const v of ['subscriptions', 'resource_groups', 'tags', 'vnets', 'peerings', 'virtual_wan', 'virtual_hubs', 'hub_connections']) {
      expect(tf).toContain(`variable "${v}" {`);
    }
  });

  it('gives Terraform an azurerm provider and a pair of module calls per subscription', () => {
    const root = files('terraform', { ...defaultPlan(), placement: 'alz' })[0].content;
    const aliases = [...root.matchAll(/^ {2}alias {11}= "([a-z0-9_]+)"$/gm)].map((m) => m[1]);
    expect(aliases).toEqual([
      'connectivity',
      'identity',
      'management',
      'security',
      'corp_eus2_001',
      'online_eus2_001',
      'corp_cus_001',
      'online_cus_001',
    ]);
    expect(root).toContain('provider "azurerm" {\n  alias           = "corp_eus2_001"\n  subscription_id = var.subscriptions["corp-eus2-001"]');
    expect(root).toContain('module "network_corp_eus2_001" {\n  source    = "./modules/network"\n  providers = { azurerm = azurerm.corp_eus2_001 }');
    expect(root).toContain('module "links_corp_eus2_001" {');
    expect(root).not.toContain('azapi');
    // Aliases are valid and unique whatever the keys: subscription IDs, clashes after cleaning.
    expect([...providerAliases(['0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 'corp-a', 'corp_a', '--'])].map(([, a]) => a)).toEqual([
      'sub_0f1e2d3c_4b5a_6978_8796_a5b4c3d2e1f0',
      'corp_a',
      'corp_a_2',
      'subscription',
    ]);
  });

  it('puts the plan into the variables files', () => {
    const params = files('bicep', defaultPlan()).at(-1)!;
    expect(params.content).toContain("using './alz-network.bicep'");
    expect(params.content).toContain("param subscriptions = {\n  main: '00000000-0000-0000-0000-000000000000' // replace");
    expect(params.content).toContain(
      "  'hub-prd-eus2-01-vnet': {\n    subscription: 'main'\n    resourceGroup: 'network-prd-eus2-01-rg'",
    );
    expect(params.content).toContain("delegation: 'Microsoft.Network/dnsResolvers'");
    expect(params.content).toContain("remoteVnet: 'identity-prd-eus2-01-vnet'");
    expect(params.content).not.toContain('param virtualWan');

    const tfvars = files('terraform', defaultPlan()).at(-1)!;
    expect(tfvars.content).toContain('"hub-prd-eus2-01-vnet" = {');
    expect(tfvars.content).toContain('"GatewaySubnet"');
    expect(tfvars.content).toContain('remote_vnet             = "identity-prd-eus2-01-vnet"');
    expect(tfvars.content).not.toContain('virtual_wan');

    const wanParams = files('bicep', vwanPlan()).at(-1)!;
    expect(wanParams.content).toContain("param virtualWan = {\n  name: 'network-prd-eus2-01-vwan'\n  location: 'eastus2'\n  subscription: 'main'");
    expect(wanParams.content).toContain("virtualHub: 'hub-prd-eus2-01-vhub'");
    const wanVars = files('terraform', vwanPlan()).at(-1)!;
    expect(wanVars.content).toContain('virtual_hub = "hub-prd-eus2-01-vhub"');
  });

  it('exports every address range of a VNet, and lists ranges it leaves out', () => {
    const plan = defaultPlan();
    plan.regions[0].spokes[3].ranges = [{ prefix: 24, fixed: '10.0.200.0/24' }, { prefix: 24, fixed: '10.5.0.0/24' }];
    const m = model(plan);
    expect(m.vnets.find((v) => v.name === 'corp-prd-eus2-001-vnet')!.prefixes).toEqual(['10.0.8.0/22', '10.0.200.0/24']);
    expect(m.omitted).toEqual(['address range 3 of VNet corp-eus2-001-vnet']);

    const params = files('bicep', plan).at(-1)!;
    expect(params.content).toContain("    addressPrefixes: [\n      '10.0.8.0/22'\n      '10.0.200.0/24'\n    ]");
    const tfvars = files('terraform', plan).at(-1)!;
    expect(tfvars.content).toMatch(/address_space +\= \["10\.0\.8\.0\/22", "10\.0\.200\.0\/24"\]/);
  });

  it('names the variables file after the environment', () => {
    const naming = { app: 'network', environment: 'dev', instance: '01' };
    expect(files('bicep', defaultPlan(), naming).map((f) => f.name)).toEqual([
      'alz-network.bicep',
      'modules/resource-group.bicep',
      'modules/virtual-wan.bicep',
      'modules/network.bicep',
      'modules/links.bicep',
      'alz-network.dev.bicepparam',
    ]);
    expect(files('terraform', defaultPlan(), naming).map((f) => f.name)).toEqual([
      'main.tf',
      'modules/network/main.tf',
      'modules/links/main.tf',
      'dev.tfvars',
    ]);
    expect(files('terraform', defaultPlan(), naming).at(-1)!.content).toContain('terraform apply -var-file=dev.tfvars');
  });

  it('lists what it leaves out', () => {
    const plan = defaultPlan();
    plan.root = '10.0.0.0/16';
    expect(model(plan).omitted).toEqual(['region Central US']);
    expect(files('terraform', plan).at(-1)!.content).toContain('#   - region Central US');
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
      'modules/alz-network/modules/network/main.tf',
      'modules/alz-network/modules/links/main.tf',
      'live/dev/alz-network/terragrunt.hcl',
      'README.md',
    ]);
    const [root, module, network, links, live] = tg.map((f) => f.content);
    expect(root).toContain('backend = "azurerm"');
    // The providers are in the module, one per subscription, so root.hcl doesn't generate one.
    expect(root).not.toContain('generate "provider"');
    // The module is the same Terraform configuration and modules as the Terraform export.
    const tf = files('terraform', defaultPlan(), naming);
    expect([module, network, links]).toEqual(tf.slice(0, 3).map((f) => f.content));
    expect(live).toContain('path = find_in_parent_folders("root.hcl")');
    expect(live).toContain('source = "${get_parent_terragrunt_dir("root")}/modules//alz-network"');
    expect(live).toContain('inputs = {\n  subscriptions = {\n    "main" = "00000000-0000-0000-0000-000000000000" # replace');
    expect(live).toContain('    "main/network-dev-eus2-01-rg" = {');
    expect(live).toContain('    "hub-dev-eus2-01-vnet" = {');
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
      ['alz-hub-spoke', { ...defaultPlan(), placement: 'alz' }],
      ['alz-vwan', { ...vwanPlan(), placement: 'alz' }],
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
