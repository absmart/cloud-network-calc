// Infrastructure-as-code export. Each format is a pair of files:
//
//   - a generic, reusable template (alz-network.bicep / main.tf) whose every
//     input is a parameter or variable: no names, CIDRs or regions are
//     hard-coded, so the same template deploys any plan;
//   - a variables file (alz-network.<env>.bicepparam / <env>.tfvars) holding
//     this plan's values.
//
// Both formats are built from the same intermediate model, so they always
// describe the same network.

import { delegationForName, presetForName } from './azure';
import { formatCidr } from './ipv4';
import {
  DEFAULT_NAMING,
  type NamingOptions,
  nameBase,
  normalizeNaming,
  parsePlannerName,
  resourceName,
} from './naming';
import { placementOf, isSubscriptionId } from './placement';
import type { PlanResult, PlanSpec, RegionSpec, VnetResult, VnetSpec } from './planner';

export type IacFormat = 'bicep' | 'terraform' | 'terragrunt';

export const IAC_FILE_NAME = {
  bicep: 'alz-network.bicep',
  terraform: 'main.tf',
} as const;

export interface IacFile {
  name: string;
  content: string;
  /** What the file is for, shown next to its name. */
  description: string;
}

/** Variables file per environment: alz-network.prd.bicepparam / prd.tfvars. */
export function variablesFileName(format: 'bicep' | 'terraform', environment: string): string {
  const env = environment || 'example';
  return format === 'bicep' ? `alz-network.${env}.bicepparam` : `${env}.tfvars`;
}

export interface IacSubnet {
  name: string;
  /** The subnet's name in the planner. */
  plannerName: string;
  prefix: string;
  delegation?: string;
}

export interface IacVnet {
  name: string;
  /** The planner VNet this comes from, by id and name. */
  plannerId: string;
  plannerName: string;
  /** <app>-<env><region><int>, reused to name peerings and hub connections to this VNet. */
  base: string;
  location: string;
  /** Subscription key and resource group it deploys into. */
  subscription: string;
  resourceGroup: string;
  /** Address ranges, main first. */
  prefixes: string[];
  subnets: IacSubnet[];
}

export interface IacVirtualHub {
  name: string;
  plannerId: string;
  plannerName: string;
  location: string;
  subscription: string;
  resourceGroup: string;
  prefix: string;
}

export interface IacResourceGroup {
  name: string;
  subscription: string;
  /** Location of the first network placed in it. */
  location: string;
}

export interface IacModel {
  planName: string;
  /** Normalized naming options, also used for the variables files. */
  naming: NamingOptions;
  primaryLocation: string;
  /** Subscription keys in first-use order; each maps to an ID in the variables file. */
  subscriptions: string[];
  resourceGroups: IacResourceGroup[];
  vnets: IacVnet[];
  /** One direction each; `from`/`to` index into `vnets`. Named after the remote VNet. */
  peerings: { name: string; from: number; to: number }[];
  /** Placed with the first virtual hub; null without Virtual WAN regions. */
  virtualWan: { name: string; location: string; subscription: string; resourceGroup: string } | null;
  virtualHubs: IacVirtualHub[];
  /** `hub` indexes `virtualHubs`, `vnet` indexes `vnets`. */
  hubConnections: { name: string; hub: number; vnet: number }[];
  /** Things the plan couldn't allocate, which the export leaves out. */
  omitted: string[];
}

export function buildIacModel(plan: PlanSpec, result: PlanResult, naming: NamingOptions = DEFAULT_NAMING): IacModel {
  const opts = normalizeNaming(naming);
  const primaryLocation = plan.regions[0]?.location ?? 'eastus2';
  const layout = plan.placement ?? 'single';
  const model: IacModel = {
    planName: plan.name,
    naming: opts,
    primaryLocation,
    subscriptions: [],
    resourceGroups: [],
    vnets: [],
    peerings: [],
    virtualWan: null,
    virtualHubs: [],
    hubConnections: [],
    omitted: [],
  };
  const hubVnets: number[] = [];

  /** Place a network, recording its subscription and resource group the first time they're used. */
  const place = (region: RegionSpec, vnet: VnetSpec, kind: 'hub' | 'virtual-hub' | 'spoke') => {
    const p = placementOf(layout, region, vnet, kind, opts, primaryLocation);
    if (!model.subscriptions.includes(p.subscription)) model.subscriptions.push(p.subscription);
    if (!model.resourceGroups.some((g) => g.subscription === p.subscription && g.name === p.resourceGroup))
      model.resourceGroups.push({ name: p.resourceGroup, subscription: p.subscription, location: region.location });
    return p;
  };

  // VNets and virtual hubs share a resource group, so their names must be
  // unique: a repeat gets the next instance number (01 → 02).
  const usedBases = new Set<string>();
  const uniqueBase = (app: string, location: string, instance: string) => {
    let n = Number(instance);
    let base = nameBase(app, opts, location, instance);
    while (usedBases.has(base)) base = nameBase(app, opts, location, String(++n).padStart(instance.length, '0'));
    usedBases.add(base);
    return base;
  };

  const peer = (a: number, b: number) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      model.peerings.push({ name: resourceName(model.vnets[to].base, 'peer'), from, to });
    }
  };

  plan.regions.forEach((region, i) => {
    const r = result.regions[i];
    if (!r.cidr) {
      model.omitted.push(`region ${region.name}`);
      return;
    }
    const location = region.location;

    const addVnet = (v: VnetResult, spec: VnetSpec, kind: 'hub' | 'spoke', fallbackApp: string): number | null => {
      if (!v.cidr) {
        model.omitted.push(`VNet ${v.name}`);
        return null;
      }
      const parsed = parsePlannerName(v.name, location);
      const instance = parsed.instance ?? opts.instance;
      const base = uniqueBase(parsed.app || fallbackApp, location, instance);

      const subnets: IacSubnet[] = [];
      const usedSubnets = new Set<string>();
      for (const s of v.subnets) {
        if (!s.cidr) {
          model.omitted.push(`subnet ${v.name}/${s.name || '(unnamed)'}`);
          continue;
        }
        // Azure-reserved names (GatewaySubnet, AzureFirewallSubnet, ...) must stay exact.
        let name = s.name;
        if (!presetForName(s.name)?.reservedName) {
          const app = parsePlannerName(s.name, location).app || 'subnet';
          name = resourceName(nameBase(app, opts, location, instance), 'snet');
          for (let n = 2; usedSubnets.has(name); n++) name = resourceName(nameBase(`${app}${n}`, opts, location, instance), 'snet');
        }
        usedSubnets.add(name);
        subnets.push({ name, plannerName: s.name, prefix: formatCidr(s.cidr), delegation: delegationForName(s.name) });
      }
      const prefixes = v.ranges.flatMap((c, k) => {
        if (!c) model.omitted.push(`address range ${k + 1} of VNet ${v.name}`);
        return c ? [formatCidr(c)] : [];
      });
      model.vnets.push({
        name: resourceName(base, 'vnet'),
        plannerId: v.id,
        plannerName: v.name,
        base,
        location,
        ...place(region, spec, kind),
        prefixes,
        subnets,
      });
      return model.vnets.length - 1;
    };

    if (region.topology === 'vwan') {
      let hubIndex: number | null = null;
      if (r.hub.cidr) {
        const parsed = parsePlannerName(r.hub.name, location);
        const base = uniqueBase(parsed.app || 'hub', location, parsed.instance ?? opts.instance);
        const placement = place(region, region.hub, 'virtual-hub');
        // The Virtual WAN lives with the first virtual hub.
        model.virtualWan ??= { name: resourceName(nameBase(opts.app, opts, location), 'vwan'), location, ...placement };
        hubIndex = model.virtualHubs.push({
          name: resourceName(base, 'vhub'),
          plannerId: r.hub.id,
          plannerName: r.hub.name,
          location,
          ...placement,
          prefix: formatCidr(r.hub.cidr),
        }) - 1;
      } else {
        model.omitted.push(`virtual hub ${r.hub.name}`);
      }
      r.spokes.forEach((spoke, j) => {
        const vnet = addVnet(spoke, region.spokes[j], 'spoke', region.spokes[j].role ?? 'spoke');
        if (vnet !== null && hubIndex !== null)
          model.hubConnections.push({ name: resourceName(model.vnets[vnet].base, 'conn'), hub: hubIndex, vnet });
      });
    } else {
      const hub = addVnet(r.hub, region.hub, 'hub', 'hub');
      if (hub !== null) hubVnets.push(hub);
      r.spokes.forEach((spoke, j) => {
        const vnet = addVnet(spoke, region.spokes[j], 'spoke', region.spokes[j].role ?? 'spoke');
        if (vnet !== null && hub !== null) peer(hub, vnet);
      });
    }
  });

  // Hub-and-spoke hubs in different regions are peered with each other (full mesh).
  hubVnets.forEach((a, i) => hubVnets.slice(i + 1).forEach((b) => peer(a, b)));
  return model;
}

const commentBlock = (comment: string, lines: string[]) =>
  lines.map((l) => (l ? `${comment} ${l}` : comment)).join('\n') + '\n';

/** Header for a variables file: where the values came from and how to deploy them. */
function variablesHeader(model: IacModel, comment: string, template: string, usage: string[]): string {
  const lines = [
    `Values for ${template}: ALZ network "${model.planName}", ${model.naming.environment || 'example'} environment.`,
    `Generated by ALZ CIDR Planner on ${new Date().toISOString().slice(0, 10)}.`,
    'Names follow <app>-<environment>-<region>-<int>-<resourcetype>.',
    'Copy this file per environment and edit any value; the template itself stays unchanged.',
    '',
    ...usage,
  ];
  if (model.omitted.length) {
    lines.push('', 'Not allocated in the plan, so left out of this file:', ...model.omitted.map((o) => `  - ${o}`));
  }
  return commentBlock(comment, lines);
}

// ---------------------------------------------------------------- Bicep

const bq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$\{/g, '\\${')}'`;

/** An object key: bare when it is a valid identifier (as the Bicep linter prefers), else quoted. */
const bkey = (s: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : bq(s));

/** A subscription key's value in a variables file: the ID itself, or a placeholder to replace. */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
const subscriptionValue = (key: string) => (isSubscriptionId(key) ? key : PLACEHOLDER_ID);

/** Bicep modules, by path relative to the main template. */
export const BICEP_MODULES = {
  resourceGroup: 'modules/resource-group.bicep',
  virtualWan: 'modules/virtual-wan.bicep',
  network: 'modules/network.bicep',
  links: 'modules/links.bicep',
} as const;

/** The reusable Bicep template: every input is a parameter. Deployed at management-group scope. */
export function toBicep(): string {
  return `${commentBlock('//', [
    'Azure Landing Zone network: resource groups in one or more subscriptions,',
    'VNets and subnets, VNet peerings, and an optional Virtual WAN with virtual',
    'hubs and hub connections. Generated by ALZ CIDR Planner.',
    '',
    'Reusable: every input is a parameter. Supply values with a .bicepparam file',
    'and deploy at a management group above every subscription it uses:',
    '',
    '  az deployment mg create --management-group-id <management group> --location <location> \\',
    '    --parameters alz-network.<env>.bicepparam',
    '',
    'Resource groups are created first, then the Virtual WAN, then each resource',
    "group's VNets and virtual hubs, and last the peerings and hub connections,",
    'once every VNet they connect exists.',
  ])}
targetScope = 'managementGroup'

// ------------------------------------------------------------ Types

type subnetType = {
  name: string
  addressPrefix: string
  @description('Service to delegate the subnet to, for example Microsoft.Network/dnsResolvers.')
  delegation: string?
}

type vnetType = {
  @description('Key of the subscriptions parameter.')
  subscription: string
  resourceGroup: string
  location: string
  addressPrefixes: string[]
  subnets: subnetType[]
}

type resourceGroupType = {
  name: string
  @description('Key of the subscriptions parameter.')
  subscription: string
  location: string
}

type peeringType = {
  @description('Name of the peering on the local VNet.')
  name: string
  @description('Local VNet: a key of the vnets parameter.')
  vnet: string
  @description('Remote VNet: a key of the vnets parameter, in any subscription.')
  remoteVnet: string
  allowVirtualNetworkAccess: bool?
  allowForwardedTraffic: bool?
  allowGatewayTransit: bool?
  useRemoteGateways: bool?
}

type virtualWanType = {
  name: string
  location: string
  subscription: string
  resourceGroup: string
  type: ('Basic' | 'Standard')?
}

type virtualHubType = {
  subscription: string
  resourceGroup: string
  location: string
  addressPrefix: string
  sku: ('Basic' | 'Standard')?
}

type hubConnectionType = {
  name: string
  @description('A key of the virtualHubs parameter.')
  virtualHub: string
  @description('A key of the vnets parameter.')
  vnet: string
}

// ------------------------------------------------------------ Parameters

@description('Subscription IDs, by the keys the other parameters use.')
param subscriptions { *: string }

@description('Resource groups to create.')
param resourceGroups resourceGroupType[]

@description('Tags applied to every resource group, VNet, Virtual WAN and virtual hub.')
param tags object = {}

@description('Virtual networks and their subnets, keyed by VNet name.')
param vnets { *: vnetType }

@description('VNet peerings, one direction each. Defaults: network access and forwarded traffic allowed; no gateway transit.')
param peerings peeringType[] = []

@description('Virtual WAN; required when virtualHubs is not empty.')
param virtualWan virtualWanType?

@description('Virtual WAN hubs, keyed by name.')
param virtualHubs { *: virtualHubType } = {}

@description('Connections from virtual hubs to VNets.')
param hubConnections hubConnectionType[] = []

// ------------------------------------------------------------ Deployment

var vnetIds = toObject(
  items(vnets),
  v => v.key,
  v => '/subscriptions/\${subscriptions[v.value.subscription]}/resourceGroups/\${v.value.resourceGroup}/providers/Microsoft.Network/virtualNetworks/\${v.key}'
)

var virtualWanId = virtualWan == null
  ? ''
  : '/subscriptions/\${subscriptions[virtualWan!.subscription]}/resourceGroups/\${virtualWan!.resourceGroup}/providers/Microsoft.Network/virtualWans/\${virtualWan!.name}'

module groups '${BICEP_MODULES.resourceGroup}' = [for g in resourceGroups: {
  name: take('rg-\${g.subscription}-\${g.name}', 64)
  scope: subscription(subscriptions[g.subscription])
  params: {
    name: g.name
    location: g.location
    tags: tags
  }
}]

module wan '${BICEP_MODULES.virtualWan}' = if (virtualWan != null) {
  name: 'virtual-wan'
  scope: resourceGroup(
    subscriptions[virtualWan.?subscription ?? resourceGroups[0].subscription],
    virtualWan.?resourceGroup ?? resourceGroups[0].name
  )
  params: {
    name: virtualWan.?name ?? ''
    location: virtualWan.?location ?? ''
    type: virtualWan.?type ?? 'Standard'
    tags: tags
  }
  dependsOn: [
    groups
  ]
}

module networks '${BICEP_MODULES.network}' = [for g in resourceGroups: {
  name: take('network-\${g.subscription}-\${g.name}', 64)
  scope: resourceGroup(subscriptions[g.subscription], g.name)
  params: {
    tags: tags
    vnets: filter(items(vnets), v => v.value.subscription == g.subscription && v.value.resourceGroup == g.name)
    virtualHubs: filter(items(virtualHubs), h => h.value.subscription == g.subscription && h.value.resourceGroup == g.name)
    virtualWanId: virtualWanId
  }
  dependsOn: [
    groups
    wan
  ]
}]

module links '${BICEP_MODULES.links}' = [for g in resourceGroups: {
  name: take('links-\${g.subscription}-\${g.name}', 64)
  scope: resourceGroup(subscriptions[g.subscription], g.name)
  params: {
    peerings: map(
      filter(peerings, p => vnets[p.vnet].subscription == g.subscription && vnets[p.vnet].resourceGroup == g.name),
      p => union(p, { remoteVnetId: vnetIds[p.remoteVnet] })
    )
    hubConnections: map(
      filter(hubConnections, c => virtualHubs[c.virtualHub].subscription == g.subscription && virtualHubs[c.virtualHub].resourceGroup == g.name),
      c => union(c, { remoteVnetId: vnetIds[c.vnet] })
    )
  }
  dependsOn: [
    networks
  ]
}]
`;
}

const bicepModuleHeader = (what: string) => commentBlock('//', [`${what} Part of alz-network.bicep, generated by ALZ CIDR Planner.`]);

/** The Bicep modules the main template deploys, keyed by path. */
export function toBicepModules(): Record<string, string> {
  return {
    [BICEP_MODULES.resourceGroup]: `${bicepModuleHeader('A resource group.')}
targetScope = 'subscription'

param name string
param location string
param tags object

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: name
  location: location
  tags: tags
}
`,
    [BICEP_MODULES.virtualWan]: `${bicepModuleHeader('The Virtual WAN.')}
param name string
param location string
param type string
param tags object

resource wan 'Microsoft.Network/virtualWans@2024-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    type: type
  }
}
`,
    [BICEP_MODULES.network]: `${bicepModuleHeader("One resource group's VNets and virtual hubs.")}
param tags object

@description('items() of the main template\\'s vnets: { key: VNet name, value: vnetType }.')
param vnets array

@description('items() of the main template\\'s virtualHubs: { key: hub name, value: virtualHubType }.')
param virtualHubs array

param virtualWanId string

resource virtualNetworks 'Microsoft.Network/virtualNetworks@2024-05-01' = [for v in vnets: {
  name: v.key
  location: v.value.location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: v.value.addressPrefixes
    }
    subnets: [for s in v.value.subnets: {
      name: s.name
      properties: {
        addressPrefix: s.addressPrefix
        delegations: empty(s.?delegation ?? '') ? [] : [
          {
            name: 'delegation'
            properties: {
              serviceName: s.?delegation
            }
          }
        ]
      }
    }]
  }
}]

resource hubs 'Microsoft.Network/virtualHubs@2024-05-01' = [for h in virtualHubs: {
  name: h.key
  location: h.value.location
  tags: tags
  properties: {
    addressPrefix: h.value.addressPrefix
    sku: h.value.?sku ?? 'Standard'
    virtualWan: {
      id: virtualWanId
    }
  }
}]
`,
    [BICEP_MODULES.links]: `${bicepModuleHeader("Peerings from one resource group's VNets, and connections from its virtual hubs.")}
@description('Peerings whose local VNet is in this resource group, each with the remote VNet\\'s resource ID as remoteVnetId.')
param peerings array

@description('Hub connections whose virtual hub is in this resource group, each with the VNet\\'s resource ID as remoteVnetId.')
param hubConnections array

// One at a time: Azure doesn't allow two peering changes on a VNet at once.
@batchSize(1)
resource vnetPeerings 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = [for p in peerings: {
  #disable-next-line use-parent-property
  name: '\${p.vnet}/\${p.name}'
  properties: {
    remoteVirtualNetwork: {
      id: p.remoteVnetId
    }
    allowVirtualNetworkAccess: p.?allowVirtualNetworkAccess ?? true
    allowForwardedTraffic: p.?allowForwardedTraffic ?? true
    allowGatewayTransit: p.?allowGatewayTransit ?? false
    useRemoteGateways: p.?useRemoteGateways ?? false
  }
}]

@batchSize(1)
resource connections 'Microsoft.Network/virtualHubs/hubVirtualNetworkConnections@2024-05-01' = [for c in hubConnections: {
  #disable-next-line use-parent-property
  name: '\${c.virtualHub}/\${c.name}'
  properties: {
    remoteVirtualNetwork: {
      id: c.remoteVnetId
    }
  }
}]
`,
  };
}

/** This plan's values for the Bicep template. */
export function toBicepParams(model: IacModel): string {
  const env = model.naming.environment;
  const out: string[] = [
    variablesHeader(model, '//', IAC_FILE_NAME.bicep, [
      'Replace the placeholder subscription IDs, then deploy at a management group',
      'above every subscription:',
      '',
      `  az deployment mg create --management-group-id <management group> --location ${model.primaryLocation} \\`,
      `    --parameters ${variablesFileName('bicep', env)}`,
    ]),
    `using './${IAC_FILE_NAME.bicep}'`,
    '',
    'param subscriptions = {',
    ...model.subscriptions.map(
      (key) => `  ${bkey(key)}: ${bq(subscriptionValue(key))}${isSubscriptionId(key) ? '' : ' // replace with the subscription ID'}`,
    ),
    '}',
    '',
    'param resourceGroups = [',
  ];
  for (const g of model.resourceGroups) {
    out.push('  {', `    name: ${bq(g.name)}`, `    subscription: ${bq(g.subscription)}`, `    location: ${bq(g.location)}`, '  }');
  }
  out.push(
    ']',
    '',
    'param tags = {',
    `  environment: ${bq(env)}`,
    `  workload: ${bq(model.naming.app)}`,
    "  // owner: 'network-team@contoso.com'",
    "  // costCenter: '12345'",
    '}',
    '',
    'param vnets = {',
  );
  for (const v of model.vnets) {
    out.push(
      `  ${bkey(v.name)}: {`,
      `    subscription: ${bq(v.subscription)}`,
      `    resourceGroup: ${bq(v.resourceGroup)}`,
      `    location: ${bq(v.location)}`,
      '    addressPrefixes: [',
      ...v.prefixes.map((p) => `      ${bq(p)}`),
      '    ]',
    );
    if (v.subnets.length === 0) {
      out.push('    subnets: []');
    } else {
      out.push('    subnets: [');
      for (const s of v.subnets) {
        out.push('      {', `        name: ${bq(s.name)}`, `        addressPrefix: ${bq(s.prefix)}`);
        if (s.delegation) out.push(`        delegation: ${bq(s.delegation)}`);
        out.push('      }');
      }
      out.push('    ]');
    }
    out.push('  }');
  }
  out.push('}', '');

  out.push('param peerings = [');
  for (const p of model.peerings) {
    out.push(
      '  {',
      `    name: ${bq(p.name)}`,
      `    vnet: ${bq(model.vnets[p.from].name)}`,
      `    remoteVnet: ${bq(model.vnets[p.to].name)}`,
      '    allowForwardedTraffic: true',
      '    allowGatewayTransit: false',
      '    useRemoteGateways: false',
      '  }',
    );
  }
  out.push(']');

  if (model.virtualWan) {
    const wan = model.virtualWan;
    out.push(
      '',
      'param virtualWan = {',
      `  name: ${bq(wan.name)}`,
      `  location: ${bq(wan.location)}`,
      `  subscription: ${bq(wan.subscription)}`,
      `  resourceGroup: ${bq(wan.resourceGroup)}`,
      "  type: 'Standard'",
      '}',
      '',
      'param virtualHubs = {',
    );
    for (const h of model.virtualHubs) {
      out.push(
        `  ${bkey(h.name)}: {`,
        `    subscription: ${bq(h.subscription)}`,
        `    resourceGroup: ${bq(h.resourceGroup)}`,
        `    location: ${bq(h.location)}`,
        `    addressPrefix: ${bq(h.prefix)}`,
        "    sku: 'Standard'",
        '  }',
      );
    }
    out.push('}', '', 'param hubConnections = [');
    for (const c of model.hubConnections) {
      out.push(
        '  {',
        `    name: ${bq(c.name)}`,
        `    virtualHub: ${bq(model.virtualHubs[c.hub].name)}`,
        `    vnet: ${bq(model.vnets[c.vnet].name)}`,
        '  }',
      );
    }
    out.push(']');
  }

  return out.join('\n') + '\n';
}

// ------------------------------------------------------------ Terraform

// HCL escapes interpolation as $${ and %%{. (A replacer function avoids JS's own `$$` handling.)
const tq = (s: string) =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/([$%])\{/g, (_, sigil: string) => `${sigil}${sigil}{`)}"`;

/** HCL `key = value` lines with the `=` signs aligned, as terraform fmt does. */
function aligned(indent: string, pairs: [string, string][]): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${k.padEnd(width)} = ${v}`);
}

/** Key of a resource group in var.resource_groups: names repeat across subscriptions. */
const groupKey = (subscription: string, name: string) => `${subscription}/${name}`;

/** Terraform modules, by path relative to the root configuration. */
export const TERRAFORM_MODULES = {
  network: 'modules/network/main.tf',
  links: 'modules/links/main.tf',
} as const;

/**
 * A provider alias (and module name suffix) for each subscription key:
 * lower-case letters, digits and underscores, starting with a letter, and
 * unique. Subscription IDs as keys get a `sub_` prefix.
 */
export function providerAliases(subscriptions: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of subscriptions) {
    let alias = key.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'subscription';
    if (!/^[a-z]/.test(alias)) alias = `sub_${alias}`;
    let unique = alias;
    for (let n = 2; used.has(unique); n++) unique = `${alias}_${n}`;
    used.add(unique);
    out.set(key, unique);
  }
  return out;
}

const AZURERM_REQUIREMENT = `terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}`;

/**
 * The root Terraform configuration. azurerm talks to one subscription per
 * provider, and provider blocks can't be created from a variable, so this
 * file has a provider alias and a pair of module calls for each of the plan's
 * subscriptions. That is all it takes from the plan: names, CIDRs and regions
 * are variables, and the modules are generic.
 */
export function toTerraform(subscriptions: string[]): string {
  const aliases = providerAliases(subscriptions);
  const providers = subscriptions.map(
    (key) => `provider "azurerm" {
  alias           = ${tq(aliases.get(key)!)}
  subscription_id = var.subscriptions[${tq(key)}]
  features {}
}`,
  );
  const networkModules = subscriptions.map((key) => {
    const alias = aliases.get(key)!;
    const k = tq(key);
    return `module "network_${alias}" {
  source    = "./modules/network"
  providers = { azurerm = azurerm.${alias} }

  resource_groups = { for g in values(var.resource_groups) : g.name => g.location if g.subscription == ${k} }
  vnets           = { for name, v in var.vnets : name => v if v.subscription == ${k} }
  virtual_wan     = try(var.virtual_wan.subscription, null) == ${k} ? var.virtual_wan : null
  virtual_hubs    = { for name, h in var.virtual_hubs : name => h if h.subscription == ${k} }
  virtual_wan_id  = local.virtual_wan_id
  tags            = var.tags
}`;
  });
  const linkModules = subscriptions.map((key) => {
    const alias = aliases.get(key)!;
    const k = tq(key);
    return `module "links_${alias}" {
  source    = "./modules/links"
  providers = { azurerm = azurerm.${alias} }

  peerings = {
    for id, p in var.peerings : id => merge(p, {
      resource_group = var.vnets[p.vnet].resource_group
      remote_vnet_id = local.vnet_ids[p.remote_vnet]
    }) if var.vnets[p.vnet].subscription == ${k}
  }
  hub_connections = {
    for id, c in var.hub_connections : id => {
      name           = c.name
      virtual_hub_id = local.virtual_hub_ids[c.virtual_hub]
      remote_vnet_id = local.vnet_ids[c.vnet]
    } if var.virtual_hubs[c.virtual_hub].subscription == ${k}
  }

  # The local VNets must exist; remote ones are waited for through remote_vnet_id.
  depends_on = [module.network_${alias}]
}`;
  });
  const outputsOf = (output: string) =>
    subscriptions.map((key) => `    module.network_${aliases.get(key)!}.${output},`).join('\n');

  return `${commentBlock('#', [
    'Azure Landing Zone network: resource groups in one or more subscriptions,',
    'VNets and subnets, VNet peerings, and an optional Virtual WAN with virtual',
    'hubs and hub connections. Generated by ALZ CIDR Planner.',
    '',
    'Supply values with a .tfvars file:',
    '',
    '  terraform init',
    '  terraform apply -var-file=<env>.tfvars',
    '',
    'azurerm deploys to one subscription per provider, so this file has a',
    "provider alias and two module calls for each of this plan's subscriptions:",
    `${subscriptions.join(', ')}.`,
    'For another subscription, add a provider and its two module calls. Every',
    'other value comes from the variables, and modules/ is generic.',
  ])}
${AZURERM_REQUIREMENT}

# ------------------------------------------------------------ Providers

# One per subscription. They sign in like the Azure CLI (az login) or with ARM_* environment variables.
${providers.join('\n\n')}

# ------------------------------------------------------------ Variables

variable "subscriptions" {
  type        = map(string)
  description = "Subscription IDs, by the keys the other variables use. Needs every key the provider blocks name."
}

variable "resource_groups" {
  description = "Resource groups to create, keyed \\"<subscription key>/<name>\\"."
  type = map(object({
    name         = string
    subscription = string
    location     = string
  }))
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource group, VNet, Virtual WAN and virtual hub."
  default     = {}
}

variable "vnets" {
  description = "Virtual networks keyed by name, each with its subnets keyed by name. subscription is a key of var.subscriptions."
  type = map(object({
    subscription   = string
    resource_group = string
    location       = string
    address_space  = list(string)
    subnets = optional(map(object({
      address_prefix = string
      delegation     = optional(string)
    })), {})
  }))

  validation {
    condition = alltrue(flatten([
      for vnet in values(var.vnets) : concat(
        [for prefix in vnet.address_space : can(cidrnetmask(prefix))],
        [for subnet in values(vnet.subnets) : can(cidrnetmask(subnet.address_prefix))],
      )
    ]))
    error_message = "Every VNet address_space entry and subnet address_prefix must be a valid IPv4 CIDR."
  }
}

variable "peerings" {
  description = "VNet peerings, one direction each, keyed by a unique id. vnet and remote_vnet are keys of var.vnets, in any subscriptions."
  type = map(object({
    name                         = string
    vnet                         = string
    remote_vnet                  = string
    allow_virtual_network_access = optional(bool, true)
    allow_forwarded_traffic      = optional(bool, true)
    allow_gateway_transit        = optional(bool, false)
    use_remote_gateways          = optional(bool, false)
  }))
  default = {}
}

variable "virtual_wan" {
  description = "Virtual WAN; required when virtual_hubs is not empty."
  type = object({
    name           = string
    location       = string
    subscription   = string
    resource_group = string
    type           = optional(string, "Standard")
  })
  default = null
}

variable "virtual_hubs" {
  description = "Virtual WAN hubs keyed by name."
  type = map(object({
    subscription   = string
    resource_group = string
    location       = string
    address_prefix = string
    sku            = optional(string, "Standard")
  }))
  default = {}
}

variable "hub_connections" {
  description = "Connections from virtual hubs to VNets, keyed by a unique id. virtual_hub and vnet are keys of var.virtual_hubs and var.vnets."
  type = map(object({
    name        = string
    virtual_hub = string
    vnet        = string
  }))
  default = {}
}

# ------------------------------------------------------------ Modules

locals {
  # Resource IDs from every subscription, for peerings and hub connections that cross them.
  vnet_ids = merge(
${outputsOf('vnet_ids')}
  )
  virtual_hub_ids = merge(
${outputsOf('virtual_hub_ids')}
  )
  virtual_wan_id = one(compact([
${outputsOf('virtual_wan_id')}
  ]))
}

# Resource groups, VNets, the Virtual WAN and virtual hubs, per subscription.
${networkModules.join('\n\n')}

# Peerings and hub connections, per subscription, once the VNets they connect exist.
${linkModules.join('\n\n')}
`;
}

/** The generic Terraform modules the root configuration calls, keyed by path. */
export function toTerraformModules(): Record<string, string> {
  const header = (what: string) => commentBlock('#', [`${what} Called by the root main.tf, generated by ALZ CIDR Planner.`]);
  return {
    [TERRAFORM_MODULES.network]: `${header("One subscription's resource groups, VNets and subnets, Virtual WAN and virtual hubs.")}
${AZURERM_REQUIREMENT}

variable "resource_groups" {
  type        = map(string)
  description = "Resource groups to create: name => location."
}

variable "vnets" {
  description = "The root's var.vnets entries in this subscription."
  type = map(object({
    subscription   = string
    resource_group = string
    location       = string
    address_space  = list(string)
    subnets = optional(map(object({
      address_prefix = string
      delegation     = optional(string)
    })), {})
  }))
}

variable "virtual_wan" {
  description = "The Virtual WAN, if it is in this subscription."
  type = object({
    name           = string
    location       = string
    subscription   = string
    resource_group = string
    type           = optional(string, "Standard")
  })
  default = null
}

variable "virtual_hubs" {
  description = "The root's var.virtual_hubs entries in this subscription."
  type = map(object({
    subscription   = string
    resource_group = string
    location       = string
    address_prefix = string
    sku            = optional(string, "Standard")
  }))
  default = {}
}

variable "virtual_wan_id" {
  type        = string
  description = "Resource ID of the Virtual WAN, wherever it is; needed when virtual_hubs is not empty."
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  # One entry per subnet, keyed "<vnet>/<subnet>".
  subnets = merge({}, [
    for vnet_name, vnet in var.vnets : {
      for subnet_name, subnet in vnet.subnets : "\${vnet_name}/\${subnet_name}" => {
        vnet           = vnet_name
        name           = subnet_name
        address_prefix = subnet.address_prefix
        delegation     = subnet.delegation
      }
    }
  ]...)
}

resource "azurerm_resource_group" "this" {
  for_each = var.resource_groups

  name     = each.key
  location = each.value
  tags     = var.tags
}

resource "azurerm_virtual_network" "this" {
  for_each = var.vnets

  name                = each.key
  location            = each.value.location
  resource_group_name = azurerm_resource_group.this[each.value.resource_group].name
  address_space       = each.value.address_space
  tags                = var.tags
}

resource "azurerm_subnet" "this" {
  for_each = local.subnets

  name                 = each.value.name
  resource_group_name  = azurerm_virtual_network.this[each.value.vnet].resource_group_name
  virtual_network_name = azurerm_virtual_network.this[each.value.vnet].name
  address_prefixes     = [each.value.address_prefix]

  dynamic "delegation" {
    for_each = each.value.delegation == null ? [] : [each.value.delegation]
    content {
      name = "delegation"
      service_delegation {
        name    = delegation.value
        actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
      }
    }
  }
}

resource "azurerm_virtual_wan" "this" {
  count = var.virtual_wan == null ? 0 : 1

  name                = var.virtual_wan.name
  location            = var.virtual_wan.location
  resource_group_name = azurerm_resource_group.this[var.virtual_wan.resource_group].name
  type                = var.virtual_wan.type
  tags                = var.tags
}

resource "azurerm_virtual_hub" "this" {
  for_each = var.virtual_hubs

  name                = each.key
  location            = each.value.location
  resource_group_name = azurerm_resource_group.this[each.value.resource_group].name
  virtual_wan_id      = var.virtual_wan_id
  address_prefix      = each.value.address_prefix
  sku                 = each.value.sku
  tags                = var.tags

  lifecycle {
    precondition {
      condition     = var.virtual_wan_id != null
      error_message = "virtual_hubs needs a Virtual WAN."
    }
  }
}

output "vnet_ids" {
  value = { for name, v in azurerm_virtual_network.this : name => v.id }
}

output "virtual_hub_ids" {
  value = { for name, h in azurerm_virtual_hub.this : name => h.id }
}

output "virtual_wan_id" {
  value = one(azurerm_virtual_wan.this[*].id)
}
`,
    [TERRAFORM_MODULES.links]: `${header("Peerings from one subscription's VNets, and connections from its virtual hubs, to VNets in any subscription.")}
${AZURERM_REQUIREMENT}

variable "peerings" {
  description = "Peerings whose local VNet is in this subscription, with its resource group and the remote VNet's resource ID."
  type = map(object({
    name                         = string
    vnet                         = string
    resource_group               = string
    remote_vnet_id               = string
    allow_virtual_network_access = optional(bool, true)
    allow_forwarded_traffic      = optional(bool, true)
    allow_gateway_transit        = optional(bool, false)
    use_remote_gateways          = optional(bool, false)
  }))
  default = {}
}

variable "hub_connections" {
  description = "Connections from virtual hubs in this subscription, by resource ID."
  type = map(object({
    name           = string
    virtual_hub_id = string
    remote_vnet_id = string
  }))
  default = {}
}

resource "azurerm_virtual_network_peering" "this" {
  for_each = var.peerings

  name                         = each.value.name
  resource_group_name          = each.value.resource_group
  virtual_network_name         = each.value.vnet
  remote_virtual_network_id    = each.value.remote_vnet_id
  allow_virtual_network_access = each.value.allow_virtual_network_access
  allow_forwarded_traffic      = each.value.allow_forwarded_traffic
  allow_gateway_transit        = each.value.allow_gateway_transit
  use_remote_gateways          = each.value.use_remote_gateways
}

resource "azurerm_virtual_hub_connection" "this" {
  for_each = var.hub_connections

  name                      = each.value.name
  virtual_hub_id            = each.value.virtual_hub_id
  remote_virtual_network_id = each.value.remote_vnet_id
}
`,
  };
}

/** This plan's values for the Terraform configuration. */
export function toTfvars(model: IacModel): string {
  return [
    variablesHeader(model, '#', IAC_FILE_NAME.terraform, [
      'Replace the placeholder subscription IDs, then:',
      '',
      '  terraform init',
      `  terraform apply -var-file=${variablesFileName('terraform', model.naming.environment)}`,
    ]).trimEnd(),
    '',
    ...terraformValues(model),
  ].join('\n') + '\n';
}

/** The plan's values as HCL attributes: the body of a .tfvars file, or of a Terragrunt inputs block. */
function terraformValues(model: IacModel): string[] {
  const env = model.naming.environment;
  const out: string[] = [
    'subscriptions = {',
    ...aligned(
      '  ',
      model.subscriptions.map((key): [string, string] => [tq(key), tq(subscriptionValue(key))]),
    ).map((line, i) => (isSubscriptionId(model.subscriptions[i]) ? line : `${line} # replace with the subscription ID`)),
    '}',
    '',
    'resource_groups = {',
  ];
  for (const g of model.resourceGroups) {
    out.push(`  ${tq(groupKey(g.subscription, g.name))} = {`);
    out.push(
      ...aligned('    ', [
        ['name', tq(g.name)],
        ['subscription', tq(g.subscription)],
        ['location', tq(g.location)],
      ]),
    );
    out.push('  }');
  }
  out.push(
    '}',
    '',
    'tags = {',
    ...aligned('  ', [
      ['environment', tq(env)],
      ['workload', tq(model.naming.app)],
    ]),
    '  # owner      = "network-team@contoso.com"',
    '  # costCenter = "12345"',
    '}',
    '',
    'vnets = {',
  );
  for (const v of model.vnets) {
    out.push(`  ${tq(v.name)} = {`);
    out.push(
      ...aligned('    ', [
        ['subscription', tq(v.subscription)],
        ['resource_group', tq(v.resourceGroup)],
        ['location', tq(v.location)],
        ['address_space', `[${v.prefixes.map(tq).join(', ')}]`],
      ]),
    );
    if (v.subnets.length === 0) {
      out.push('    subnets        = {}');
    } else {
      out.push('    subnets = {');
      out.push(
        ...aligned(
          '      ',
          v.subnets.map((s): [string, string] => {
            const fields = [`address_prefix = ${tq(s.prefix)}`];
            if (s.delegation) fields.push(`delegation = ${tq(s.delegation)}`);
            return [tq(s.name), `{ ${fields.join(', ')} }`];
          }),
        ),
      );
      out.push('    }');
    }
    out.push('  }');
  }
  out.push('}', '');

  // Peering and connection names are unique per parent, so keys include the parent.
  out.push('peerings = {');
  for (const p of model.peerings) {
    const vnet = model.vnets[p.from].name;
    out.push(`  ${tq(`${vnet}/${p.name}`)} = {`);
    out.push(
      ...aligned('    ', [
        ['name', tq(p.name)],
        ['vnet', tq(vnet)],
        ['remote_vnet', tq(model.vnets[p.to].name)],
        ['allow_forwarded_traffic', 'true'],
        ['allow_gateway_transit', 'false'],
        ['use_remote_gateways', 'false'],
      ]),
    );
    out.push('  }');
  }
  out.push('}');

  if (model.virtualWan) {
    const wan = model.virtualWan;
    out.push('', 'virtual_wan = {');
    out.push(
      ...aligned('  ', [
        ['name', tq(wan.name)],
        ['location', tq(wan.location)],
        ['subscription', tq(wan.subscription)],
        ['resource_group', tq(wan.resourceGroup)],
        ['type', '"Standard"'],
      ]),
    );
    out.push('}', '', 'virtual_hubs = {');
    for (const h of model.virtualHubs) {
      out.push(`  ${tq(h.name)} = {`);
      out.push(
        ...aligned('    ', [
          ['subscription', tq(h.subscription)],
          ['resource_group', tq(h.resourceGroup)],
          ['location', tq(h.location)],
          ['address_prefix', tq(h.prefix)],
          ['sku', '"Standard"'],
        ]),
      );
      out.push('  }');
    }
    out.push('}', '', 'hub_connections = {');
    for (const c of model.hubConnections) {
      const hub = model.virtualHubs[c.hub].name;
      out.push(`  ${tq(`${hub}/${c.name}`)} = {`);
      out.push(
        ...aligned('    ', [
          ['name', tq(c.name)],
          ['virtual_hub', tq(hub)],
          ['vnet', tq(model.vnets[c.vnet].name)],
        ]),
      );
      out.push('  }');
    }
    out.push('}');
  }

  return out;
}

// ------------------------------------------------------------ Terragrunt

/** Folder the Terragrunt files are zipped under. */
export const TERRAGRUNT_ROOT = 'alz-network-terragrunt';

const terragruntLiveDir = (env: string) => `live/${env || 'example'}/alz-network`;

/** Shared settings: remote state in Azure Storage. The providers are in the module's main.tf, one per subscription. */
export function toTerragruntRoot(): string {
  return `${commentBlock('#', [
    'Shared Terragrunt settings, included by every live/<env>/<stack>/terragrunt.hcl.',
    'Generated by ALZ CIDR Planner.',
    '',
    'State is kept in an Azure Storage account named by environment variables:',
    '  ARM_SUBSCRIPTION_ID        subscription of the state storage account',
    '  TG_STATE_RESOURCE_GROUP    resource group of the state storage account',
    '  TG_STATE_STORAGE_ACCOUNT   state storage account',
    '  TG_STATE_CONTAINER         blob container (default: tfstate)',
  ])}
locals {
  state_resource_group  = get_env("TG_STATE_RESOURCE_GROUP")
  state_storage_account = get_env("TG_STATE_STORAGE_ACCOUNT")
  state_container       = get_env("TG_STATE_CONTAINER", "tfstate")
}

remote_state {
  backend = "azurerm"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    resource_group_name  = local.state_resource_group
    storage_account_name = local.state_storage_account
    container_name       = local.state_container
    key                  = "\${path_relative_to_include()}/terraform.tfstate"
    use_azuread_auth     = true
  }
}

# No generated provider: modules/alz-network/main.tf has an azurerm provider
# for each subscription the network uses.
`;
}

/** One environment's stack: the module source plus this plan's values as inputs. */
export function toTerragruntLive(model: IacModel): string {
  const env = model.naming.environment || 'example';
  return `${variablesHeader(model, '#', 'modules/alz-network', [
    'Replace the placeholder subscription IDs, then:',
    '',
    `  cd ${terragruntLiveDir(env)}`,
    '  terragrunt apply',
    '',
    `For another environment, copy this folder to live/<env>/alz-network and edit the inputs.`,
  ])}
include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "\${get_parent_terragrunt_dir("root")}/modules//alz-network"
}

inputs = {
${terraformValues(model)
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
}
`;
}

function toTerragruntReadme(model: IacModel): string {
  const live = terragruntLiveDir(model.naming.environment);
  return `# ALZ network: Terragrunt

Generated by ALZ CIDR Planner for "${model.planName}".

\`\`\`
root.hcl                     shared remote state (Azure Storage)
modules/alz-network/main.tf  an azurerm provider and two module calls per subscription
modules/alz-network/modules/ generic network and links modules
${live}/terragrunt.hcl
                             this environment: the module source and its inputs
\`\`\`

The network spans ${model.subscriptions.length} subscription${model.subscriptions.length === 1 ? '' : 's'} (${model.subscriptions.join(', ')}).
Put their IDs in \`subscriptions\` in the inputs. Your identity needs rights to create
resource groups and networks in each of them. For another subscription, add its
provider and module calls to modules/alz-network/main.tf (or export again).

## Deploy

\`\`\`sh
az login
export ARM_SUBSCRIPTION_ID=<subscription of the state storage account>
export TG_STATE_RESOURCE_GROUP=<state resource group>
export TG_STATE_STORAGE_ACCOUNT=<state storage account>
export TG_STATE_CONTAINER=tfstate   # optional

cd ${live}
terragrunt plan
terragrunt apply
\`\`\`

The state storage account and container must already exist, and your identity needs the
Storage Blob Data Contributor role on them (state uses Entra ID auth).

## Another environment

Copy \`${live}\` to \`live/<env>/alz-network\` and change its \`inputs\`. The module and root.hcl are shared.
`;
}

/** Folder a format's files are zipped under, when they need folders. */
export const zipRoot = (format: IacFormat) => (format === 'terragrunt' ? TERRAGRUNT_ROOT : `alz-network-${format}`);

/** The files for a format: a reusable template (with Bicep's modules) plus this plan's values (and, for Terragrunt, the stack layout). */
export function generateIacFiles(
  format: IacFormat,
  plan: PlanSpec,
  result: PlanResult,
  naming: NamingOptions = DEFAULT_NAMING,
): IacFile[] {
  const model = buildIacModel(plan, result, naming);
  const env = model.naming.environment;
  switch (format) {
    case 'bicep':
      return [
        { name: IAC_FILE_NAME.bicep, content: toBicep(), description: 'reusable template' },
        ...Object.entries(toBicepModules()).map(([name, content]) => ({ name, content, description: 'module' })),
        { name: variablesFileName('bicep', env), content: toBicepParams(model), description: 'values for this plan' },
      ];
    case 'terraform':
      return [
        { name: IAC_FILE_NAME.terraform, content: toTerraform(model.subscriptions), description: 'providers and modules per subscription' },
        ...Object.entries(toTerraformModules()).map(([name, content]) => ({ name, content, description: 'module' })),
        { name: variablesFileName('terraform', env), content: toTfvars(model), description: 'values for this plan' },
      ];
    case 'terragrunt':
      return [
        { name: 'root.hcl', content: toTerragruntRoot(), description: 'shared remote state' },
        {
          name: 'modules/alz-network/main.tf',
          content: toTerraform(model.subscriptions),
          description: 'providers and modules per subscription',
        },
        ...Object.entries(toTerraformModules()).map(([name, content]) => ({
          name: `modules/alz-network/${name}`,
          content,
          description: 'module',
        })),
        { name: `${terragruntLiveDir(env)}/terragrunt.hcl`, content: toTerragruntLive(model), description: 'values for this plan' },
        { name: 'README.md', content: toTerragruntReadme(model), description: 'how to deploy' },
      ];
  }
}
