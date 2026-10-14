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
import type { PlanResult, PlanSpec, VnetResult } from './planner';

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

interface IacSubnet {
  name: string;
  prefix: string;
  delegation?: string;
}

interface IacVnet {
  name: string;
  /** <app>-<env><region><int>, reused to name peerings and hub connections to this VNet. */
  base: string;
  location: string;
  /** Address ranges, main first. */
  prefixes: string[];
  subnets: IacSubnet[];
}

interface IacModel {
  planName: string;
  /** Normalized naming options, also used for the variables files. */
  naming: NamingOptions;
  primaryLocation: string;
  resourceGroup: string;
  vnets: IacVnet[];
  /** One direction each; `from`/`to` index into `vnets`. Named after the remote VNet. */
  peerings: { name: string; from: number; to: number }[];
  virtualWan: string;
  virtualHubs: { name: string; location: string; prefix: string }[];
  /** `hub` indexes `virtualHubs`, `vnet` indexes `vnets`. */
  hubConnections: { name: string; hub: number; vnet: number }[];
  /** Things the plan couldn't allocate, which the export leaves out. */
  omitted: string[];
}

export function buildIacModel(plan: PlanSpec, result: PlanResult, naming: NamingOptions = DEFAULT_NAMING): IacModel {
  const opts = normalizeNaming(naming);
  const primaryLocation = plan.regions[0]?.location ?? 'eastus2';
  const firstVwan = plan.regions.find((r) => r.topology === 'vwan')?.location ?? primaryLocation;
  const model: IacModel = {
    planName: plan.name,
    naming: opts,
    primaryLocation,
    resourceGroup: resourceName(nameBase(opts.app, opts, primaryLocation), 'rg'),
    vnets: [],
    peerings: [],
    virtualWan: resourceName(nameBase(opts.app, opts, firstVwan), 'vwan'),
    virtualHubs: [],
    hubConnections: [],
    omitted: [],
  };
  const hubVnets: number[] = [];

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

    const addVnet = (v: VnetResult, fallbackApp: string): number | null => {
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
        subnets.push({ name, prefix: formatCidr(s.cidr), delegation: delegationForName(s.name) });
      }
      const prefixes = v.ranges.flatMap((c, k) => {
        if (!c) model.omitted.push(`address range ${k + 1} of VNet ${v.name}`);
        return c ? [formatCidr(c)] : [];
      });
      model.vnets.push({ name: resourceName(base, 'vnet'), base, location, prefixes, subnets });
      return model.vnets.length - 1;
    };

    if (region.topology === 'vwan') {
      let hubIndex: number | null = null;
      if (r.hub.cidr) {
        const parsed = parsePlannerName(r.hub.name, location);
        const base = uniqueBase(parsed.app || 'hub', location, parsed.instance ?? opts.instance);
        hubIndex = model.virtualHubs.push({ name: resourceName(base, 'vhub'), location, prefix: formatCidr(r.hub.cidr) }) - 1;
      } else {
        model.omitted.push(`virtual hub ${r.hub.name}`);
      }
      r.spokes.forEach((spoke, j) => {
        const vnet = addVnet(spoke, region.spokes[j].role ?? 'spoke');
        if (vnet !== null && hubIndex !== null)
          model.hubConnections.push({ name: resourceName(model.vnets[vnet].base, 'conn'), hub: hubIndex, vnet });
      });
    } else {
      const hub = addVnet(r.hub, 'hub');
      if (hub !== null) hubVnets.push(hub);
      r.spokes.forEach((spoke, j) => {
        const vnet = addVnet(spoke, region.spokes[j].role ?? 'spoke');
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

/** The reusable Bicep template: every input is a parameter. */
export function toBicep(): string {
  return `${commentBlock('//', [
    'Azure Landing Zone network: VNets and subnets, VNet peerings, and an',
    'optional Virtual WAN with virtual hubs and hub connections.',
    'Generated by ALZ CIDR Planner.',
    '',
    'Reusable: every input is a parameter. Supply values with a .bicepparam file:',
    '',
    '  az group create --name <resource group> --location <location>',
    '  az deployment group create --resource-group <resource group> --parameters alz-network.<env>.bicepparam',
  ])}
// ------------------------------------------------------------ Types

type subnetType = {
  name: string
  addressPrefix: string
  @description('Service to delegate the subnet to, for example Microsoft.Network/dnsResolvers.')
  delegation: string?
}

type vnetType = {
  name: string
  location: string
  addressPrefixes: string[]
  subnets: subnetType[]
}

type peeringType = {
  @description('Name of the peering on the local VNet.')
  name: string
  @description('Local VNet name.')
  vnet: string
  @description('Remote VNet name (in the same resource group).')
  remoteVnet: string
  allowVirtualNetworkAccess: bool?
  allowForwardedTraffic: bool?
  allowGatewayTransit: bool?
  useRemoteGateways: bool?
}

type virtualWanType = {
  name: string
  location: string
  type: ('Basic' | 'Standard')?
}

type virtualHubType = {
  name: string
  location: string
  addressPrefix: string
  sku: ('Basic' | 'Standard')?
}

type hubConnectionType = {
  name: string
  @description('Virtual hub name.')
  virtualHub: string
  @description('VNet name to connect.')
  vnet: string
}

// ------------------------------------------------------------ Parameters

@description('Tags applied to every VNet, Virtual WAN and virtual hub.')
param tags object = {}

@description('Virtual networks and their subnets.')
param vnets vnetType[]

@description('VNet peerings, one direction each. Defaults: network access and forwarded traffic allowed; no gateway transit.')
param peerings peeringType[] = []

@description('Virtual WAN; required when virtualHubs is not empty.')
param virtualWan virtualWanType?

@description('Virtual WAN hubs.')
param virtualHubs virtualHubType[] = []

@description('Connections from virtual hubs to VNets.')
param hubConnections hubConnectionType[] = []

// ------------------------------------------------------------ Resources

resource virtualNetworks 'Microsoft.Network/virtualNetworks@2024-05-01' = [for v in vnets: {
  name: v.name
  location: v.location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: v.addressPrefixes
    }
    subnets: [for s in v.subnets: {
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

@batchSize(1)
resource vnetPeerings 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = [for p in peerings: {
  #disable-next-line use-parent-property
  name: '\${p.vnet}/\${p.name}'
  properties: {
    remoteVirtualNetwork: {
      id: resourceId('Microsoft.Network/virtualNetworks', p.remoteVnet)
    }
    allowVirtualNetworkAccess: p.?allowVirtualNetworkAccess ?? true
    allowForwardedTraffic: p.?allowForwardedTraffic ?? true
    allowGatewayTransit: p.?allowGatewayTransit ?? false
    useRemoteGateways: p.?useRemoteGateways ?? false
  }
  dependsOn: [
    virtualNetworks
  ]
}]

resource wan 'Microsoft.Network/virtualWans@2024-05-01' = if (virtualWan != null) {
  name: virtualWan!.name
  location: virtualWan!.location
  tags: tags
  properties: {
    type: virtualWan.?type ?? 'Standard'
  }
}

resource hubs 'Microsoft.Network/virtualHubs@2024-05-01' = [for h in virtualHubs: {
  name: h.name
  location: h.location
  tags: tags
  properties: {
    addressPrefix: h.addressPrefix
    sku: h.?sku ?? 'Standard'
    virtualWan: {
      id: resourceId('Microsoft.Network/virtualWans', virtualWan!.name)
    }
  }
  dependsOn: [
    wan
  ]
}]

@batchSize(1)
resource connections 'Microsoft.Network/virtualHubs/hubVirtualNetworkConnections@2024-05-01' = [for c in hubConnections: {
  #disable-next-line use-parent-property
  name: '\${c.virtualHub}/\${c.name}'
  properties: {
    remoteVirtualNetwork: {
      id: resourceId('Microsoft.Network/virtualNetworks', c.vnet)
    }
  }
  dependsOn: [
    hubs
    virtualNetworks
  ]
}]
`;
}

/** This plan's values for the Bicep template. */
export function toBicepParams(model: IacModel): string {
  const env = model.naming.environment;
  const out: string[] = [
    variablesHeader(model, '//', IAC_FILE_NAME.bicep, [
      `  az group create --name ${model.resourceGroup} --location ${model.primaryLocation}`,
      `  az deployment group create --resource-group ${model.resourceGroup} --parameters ${variablesFileName('bicep', env)}`,
    ]),
    `using './${IAC_FILE_NAME.bicep}'`,
    '',
    'param tags = {',
    `  environment: ${bq(env)}`,
    `  workload: ${bq(model.naming.app)}`,
    "  // owner: 'network-team@contoso.com'",
    "  // costCenter: '12345'",
    '}',
    '',
    'param vnets = [',
  ];
  for (const v of model.vnets) {
    out.push(
      '  {',
      `    name: ${bq(v.name)}`,
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
  out.push(']', '');

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

  if (model.virtualHubs.length) {
    out.push(
      '',
      'param virtualWan = {',
      `  name: ${bq(model.virtualWan)}`,
      `  location: ${bq(model.virtualHubs[0].location)}`,
      "  type: 'Standard'",
      '}',
      '',
      'param virtualHubs = [',
    );
    for (const h of model.virtualHubs) {
      out.push('  {', `    name: ${bq(h.name)}`, `    location: ${bq(h.location)}`, `    addressPrefix: ${bq(h.prefix)}`, "    sku: 'Standard'", '  }');
    }
    out.push(']', '', 'param hubConnections = [');
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

/**
 * The reusable Terraform configuration: every input is a variable. As a
 * Terragrunt module it leaves out the provider block and subscription_id,
 * which Terragrunt's root.hcl generates.
 */
export function toTerraform(options: { terragrunt?: boolean } = {}): string {
  const usage = options.terragrunt
    ? [
        'Terragrunt module: the provider and backend are generated by root.hcl,',
        'and every input comes from the inputs block of live/<env>/alz-network/terragrunt.hcl.',
      ]
    : ['Reusable: every input is a variable. Supply values with a .tfvars file:', '', '  terraform init', '  terraform apply -var-file=<env>.tfvars'];
  const provider = options.terragrunt
    ? ''
    : `
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}
`;
  const subscription = options.terragrunt
    ? ''
    : `
variable "subscription_id" {
  type        = string
  description = "Subscription to deploy the network into."
}
`;

  return `${commentBlock('#', [
    'Azure Landing Zone network: VNets and subnets, VNet peerings, and an',
    'optional Virtual WAN with virtual hubs and hub connections.',
    'Generated by ALZ CIDR Planner.',
    '',
    ...usage,
  ])}
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}
${provider}
# ------------------------------------------------------------ Variables
${subscription}
variable "resource_group_name" {
  type        = string
  description = "Resource group for every resource in this configuration."
}

variable "resource_group_location" {
  type        = string
  description = "Location of the resource group."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to the resource group, every VNet, the Virtual WAN and virtual hubs."
  default     = {}
}

variable "vnets" {
  description = "Virtual networks keyed by name, each with its subnets keyed by name."
  type = map(object({
    location      = string
    address_space = list(string)
    subnets = optional(map(object({
      address_prefixes = list(string)
      delegation       = optional(string)
    })), {})
  }))

  validation {
    condition = alltrue(flatten([
      for vnet in values(var.vnets) : concat(
        [for prefix in vnet.address_space : can(cidrnetmask(prefix))],
        [for subnet in values(vnet.subnets) : [for prefix in subnet.address_prefixes : can(cidrnetmask(prefix))]],
      )
    ]))
    error_message = "Every VNet address_space and subnet address_prefixes entry must be a valid IPv4 CIDR."
  }
}

variable "peerings" {
  description = "VNet peerings, one direction each, keyed by a unique id. vnet and remote_vnet are keys of var.vnets."
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
    name     = string
    location = string
    type     = optional(string, "Standard")
  })
  default = null
}

variable "virtual_hubs" {
  description = "Virtual WAN hubs keyed by name."
  type = map(object({
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

# ------------------------------------------------------------ Resources

locals {
  # One entry per subnet, keyed "<vnet>/<subnet>".
  subnets = merge({}, [
    for vnet_name, vnet in var.vnets : {
      for subnet_name, subnet in vnet.subnets : "\${vnet_name}/\${subnet_name}" => {
        vnet             = vnet_name
        name             = subnet_name
        address_prefixes = subnet.address_prefixes
        delegation       = subnet.delegation
      }
    }
  ]...)
}

resource "azurerm_resource_group" "network" {
  name     = var.resource_group_name
  location = var.resource_group_location
  tags     = var.tags
}

resource "azurerm_virtual_network" "this" {
  for_each = var.vnets

  name                = each.key
  location            = each.value.location
  resource_group_name = azurerm_resource_group.network.name
  address_space       = each.value.address_space
  tags                = var.tags
}

resource "azurerm_subnet" "this" {
  for_each = local.subnets

  name                 = each.value.name
  resource_group_name  = azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.this[each.value.vnet].name
  address_prefixes     = each.value.address_prefixes

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

resource "azurerm_virtual_network_peering" "this" {
  for_each = var.peerings

  name                         = each.value.name
  resource_group_name          = azurerm_resource_group.network.name
  virtual_network_name         = azurerm_virtual_network.this[each.value.vnet].name
  remote_virtual_network_id    = azurerm_virtual_network.this[each.value.remote_vnet].id
  allow_virtual_network_access = each.value.allow_virtual_network_access
  allow_forwarded_traffic      = each.value.allow_forwarded_traffic
  allow_gateway_transit        = each.value.allow_gateway_transit
  use_remote_gateways          = each.value.use_remote_gateways
}

resource "azurerm_virtual_wan" "this" {
  count = var.virtual_wan == null ? 0 : 1

  name                = var.virtual_wan.name
  location            = var.virtual_wan.location
  resource_group_name = azurerm_resource_group.network.name
  type                = var.virtual_wan.type
  tags                = var.tags
}

resource "azurerm_virtual_hub" "this" {
  for_each = var.virtual_hubs

  name                = each.key
  location            = each.value.location
  resource_group_name = azurerm_resource_group.network.name
  virtual_wan_id      = azurerm_virtual_wan.this[0].id
  address_prefix      = each.value.address_prefix
  sku                 = each.value.sku
  tags                = var.tags

  lifecycle {
    precondition {
      condition     = var.virtual_wan != null
      error_message = "virtual_hubs needs virtual_wan to be set."
    }
  }
}

resource "azurerm_virtual_hub_connection" "this" {
  for_each = var.hub_connections

  name                      = each.value.name
  virtual_hub_id            = azurerm_virtual_hub.this[each.value.virtual_hub].id
  remote_virtual_network_id = azurerm_virtual_network.this[each.value.vnet].id
}
`;
}

/** This plan's values for the Terraform configuration. */
export function toTfvars(model: IacModel): string {
  return [
    variablesHeader(model, '#', IAC_FILE_NAME.terraform, [
      '  terraform init',
      `  terraform apply -var-file=${variablesFileName('terraform', model.naming.environment)}`,
    ]).trimEnd(),
    '',
    '# Replace with the subscription to deploy into (az account show --query id -o tsv).',
    'subscription_id = "00000000-0000-0000-0000-000000000000"',
    '',
    ...terraformValues(model),
  ].join('\n') + '\n';
}

/**
 * The plan's values as HCL attributes: the body of a .tfvars file, or of a
 * Terragrunt inputs block. Everything except subscription_id.
 */
function terraformValues(model: IacModel): string[] {
  const env = model.naming.environment;
  const out: string[] = [
    ...aligned('', [
      ['resource_group_name', tq(model.resourceGroup)],
      ['resource_group_location', tq(model.primaryLocation)],
    ]),
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
  ];
  for (const v of model.vnets) {
    out.push(`  ${tq(v.name)} = {`);
    out.push(
      ...aligned('    ', [
        ['location', tq(v.location)],
        ['address_space', `[${v.prefixes.map(tq).join(', ')}]`],
      ]),
    );
    if (v.subnets.length === 0) {
      out.push('    subnets       = {}');
    } else {
      out.push('    subnets = {');
      out.push(
        ...aligned(
          '      ',
          v.subnets.map((s): [string, string] => {
            const fields = [`address_prefixes = [${tq(s.prefix)}]`];
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

  if (model.virtualHubs.length) {
    out.push('', 'virtual_wan = {');
    out.push(
      ...aligned('  ', [
        ['name', tq(model.virtualWan)],
        ['location', tq(model.virtualHubs[0].location)],
        ['type', '"Standard"'],
      ]),
    );
    out.push('}', '', 'virtual_hubs = {');
    for (const h of model.virtualHubs) {
      out.push(`  ${tq(h.name)} = {`);
      out.push(
        ...aligned('    ', [
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

/** Shared settings: remote state in Azure Storage and the azurerm provider, both from environment variables. */
export function toTerragruntRoot(): string {
  return `${commentBlock('#', [
    'Shared Terragrunt settings, included by every live/<env>/<stack>/terragrunt.hcl.',
    'Generated by ALZ CIDR Planner.',
    '',
    'State is kept in an Azure Storage account named by environment variables:',
    '  ARM_SUBSCRIPTION_ID        subscription to deploy into (also used by the provider)',
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

# The azurerm provider reads the subscription from ARM_SUBSCRIPTION_ID.
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "azurerm" {
  features {}
}
EOF
}
`;
}

/** One environment's stack: the module source plus this plan's values as inputs. */
export function toTerragruntLive(model: IacModel): string {
  const env = model.naming.environment || 'example';
  return `${variablesHeader(model, '#', 'modules/alz-network', [
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
root.hcl                     shared remote state (Azure Storage) and azurerm provider
modules/alz-network/main.tf  reusable module; every input is a variable
${live}/terragrunt.hcl
                             this environment: the module source and its inputs
\`\`\`

## Deploy

\`\`\`sh
az login
export ARM_SUBSCRIPTION_ID=<subscription id>
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

/** The files for a format: a reusable template plus this plan's values (and, for Terragrunt, the stack layout). */
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
        { name: variablesFileName('bicep', env), content: toBicepParams(model), description: 'values for this plan' },
      ];
    case 'terraform':
      return [
        { name: IAC_FILE_NAME.terraform, content: toTerraform(), description: 'reusable template' },
        { name: variablesFileName('terraform', env), content: toTfvars(model), description: 'values for this plan' },
      ];
    case 'terragrunt':
      return [
        { name: 'root.hcl', content: toTerragruntRoot(), description: 'shared state and provider' },
        { name: 'modules/alz-network/main.tf', content: toTerraform({ terragrunt: true }), description: 'reusable module' },
        { name: `${terragruntLiveDir(env)}/terragrunt.hcl`, content: toTerragruntLive(model), description: 'values for this plan' },
        { name: 'README.md', content: toTerragruntReadme(model), description: 'how to deploy' },
      ];
  }
}
