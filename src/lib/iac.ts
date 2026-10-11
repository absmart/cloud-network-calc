// Infrastructure-as-code export: turns the computed plan into a Bicep or
// Terraform (azurerm) file. Both are built from the same intermediate model,
// so they always describe the same network.

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

export type IacFormat = 'bicep' | 'terraform';

export const IAC_FILE_NAME: Record<IacFormat, string> = {
  bicep: 'alz-network.bicep',
  terraform: 'main.tf',
};

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
  prefix: string;
  subnets: IacSubnet[];
}

interface IacModel {
  planName: string;
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
      model.vnets.push({ name: resourceName(base, 'vnet'), base, location, prefix: formatCidr(v.cidr), subnets });
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

function header(model: IacModel, comment: string, usage: string[]): string {
  const lines = [
    `ALZ network: ${model.planName}`,
    `Generated by ALZ CIDR Planner on ${new Date().toISOString().slice(0, 10)}.`,
    'Names follow <app>-<environment><region><int>-<resourcetype>.',
    '',
    ...usage,
  ];
  if (model.omitted.length) {
    lines.push('', 'Not allocated in the plan, so left out of this file:', ...model.omitted.map((o) => `  - ${o}`));
  }
  return lines.map((l) => (l ? `${comment} ${l}` : comment)).join('\n') + '\n';
}

// ---------------------------------------------------------------- Bicep

const bq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$\{/g, '\\${')}'`;

export function toBicep(model: IacModel): string {
  const out: string[] = [];
  out.push(
    header(model, '//', [
      'Deploys every VNet, subnet, peering and Virtual WAN hub in the plan into one resource group:',
      '',
      `  az group create --name ${model.resourceGroup} --location ${model.primaryLocation}`,
      `  az deployment group create --resource-group ${model.resourceGroup} --template-file ${IAC_FILE_NAME.bicep}`,
    ]),
  );

  out.push('var vnets = [');
  for (const v of model.vnets) {
    out.push('  {');
    out.push(`    name: ${bq(v.name)}`);
    out.push(`    location: ${bq(v.location)}`);
    out.push(`    addressPrefix: ${bq(v.prefix)}`);
    if (v.subnets.length === 0) {
      out.push('    subnets: []');
    } else {
      out.push('    subnets: [');
      for (const s of v.subnets) {
        out.push('      {');
        out.push(`        name: ${bq(s.name)}`);
        out.push(`        addressPrefix: ${bq(s.prefix)}`);
        out.push(`        delegation: ${bq(s.delegation ?? '')}`);
        out.push('      }');
      }
      out.push('    ]');
    }
    out.push('  }');
  }
  out.push(']', '');

  out.push(`resource virtualNetworks 'Microsoft.Network/virtualNetworks@2024-05-01' = [for v in vnets: {
  name: v.name
  location: v.location
  properties: {
    addressSpace: {
      addressPrefixes: [
        v.addressPrefix
      ]
    }
    subnets: [for s in v.subnets: {
      name: s.name
      properties: {
        addressPrefix: s.addressPrefix
        delegations: empty(s.delegation) ? [] : [
          {
            name: 'delegation'
            properties: {
              serviceName: s.delegation
            }
          }
        ]
      }
    }]
  }
}]
`);

  if (model.peerings.length) {
    out.push('// vnet and remote index into vnets.');
    out.push('var peeringConfigs = [');
    for (const p of model.peerings) {
      out.push('  {');
      out.push(`    name: ${bq(p.name)}`);
      out.push(`    vnet: ${p.from}`);
      out.push(`    remote: ${p.to}`);
      out.push('  }');
    }
    out.push(']', '');
    out.push(`@batchSize(1)
resource peerings 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = [for p in peeringConfigs: {
  parent: virtualNetworks[p.vnet]
  name: p.name
  properties: {
    remoteVirtualNetwork: {
      id: virtualNetworks[p.remote].id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
  }
}]
`);
  }

  if (model.virtualHubs.length) {
    out.push(`resource virtualWan 'Microsoft.Network/virtualWans@2024-05-01' = {
  name: ${bq(model.virtualWan)}
  location: ${bq(model.virtualHubs[0].location)}
  properties: {
    type: 'Standard'
  }
}
`);
    out.push('var virtualHubs = [');
    for (const h of model.virtualHubs) {
      out.push('  {');
      out.push(`    name: ${bq(h.name)}`);
      out.push(`    location: ${bq(h.location)}`);
      out.push(`    addressPrefix: ${bq(h.prefix)}`);
      out.push('  }');
    }
    out.push(']', '');
    out.push(`resource hubs 'Microsoft.Network/virtualHubs@2024-05-01' = [for h in virtualHubs: {
  name: h.name
  location: h.location
  properties: {
    addressPrefix: h.addressPrefix
    virtualWan: {
      id: virtualWan.id
    }
  }
}]
`);
    if (model.hubConnections.length) {
      out.push('// hub indexes into virtualHubs, vnet into vnets.');
      out.push('var hubConnections = [');
      for (const c of model.hubConnections) {
        out.push('  {');
        out.push(`    name: ${bq(c.name)}`);
        out.push(`    hub: ${c.hub}`);
        out.push(`    vnet: ${c.vnet}`);
        out.push('  }');
      }
      out.push(']', '');
      out.push(`@batchSize(1)
resource connections 'Microsoft.Network/virtualHubs/hubVirtualNetworkConnections@2024-05-01' = [for c in hubConnections: {
  parent: hubs[c.hub]
  name: c.name
  properties: {
    remoteVirtualNetwork: {
      id: virtualNetworks[c.vnet].id
    }
  }
}]
`);
    }
  }

  return out.join('\n');
}

// ------------------------------------------------------------ Terraform

// HCL escapes interpolation as $${ and %%{. (A replacer function avoids JS's own `$$` handling.)
const tq = (s: string) =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/([$%])\{/g, (_, sigil: string) => `${sigil}${sigil}{`)}"`;

/** Map keys must be unique; VNet names usually are, but suffix any repeats. */
function uniqueKeys(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    return count === 1 ? n : `${n}-${count}`;
  });
}

export function toTerraform(model: IacModel): string {
  const vnetKeys = uniqueKeys(model.vnets.map((v) => v.name));
  const hubKeys = uniqueKeys(model.virtualHubs.map((h) => h.name));
  const out: string[] = [];

  out.push(
    header(model, '#', [
      'Deploys every VNet, subnet, peering and Virtual WAN hub in the plan into one resource group:',
      '',
      '  terraform init',
      '  terraform apply -var="subscription_id=<subscription id>"',
    ]),
  );

  out.push(`terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

variable "subscription_id" {
  type        = string
  description = "Subscription to deploy the network into."
}

variable "resource_group_name" {
  type    = string
  default = ${tq(model.resourceGroup)}
}

variable "resource_group_location" {
  type    = string
  default = ${tq(model.primaryLocation)}
}
`);

  out.push('locals {');
  out.push('  vnets = {');
  model.vnets.forEach((v, i) => {
    out.push(`    ${tq(vnetKeys[i])} = {`);
    out.push(`      name          = ${tq(v.name)}`);
    out.push(`      location      = ${tq(v.location)}`);
    out.push(`      address_space = [${tq(v.prefix)}]`);
    out.push('    }');
  });
  out.push('  }', '');

  out.push('  subnets = {');
  model.vnets.forEach((v, i) =>
    v.subnets.forEach((s) => {
      out.push(`    ${tq(`${vnetKeys[i]}/${s.name}`)} = {`);
      out.push(`      vnet             = ${tq(vnetKeys[i])}`);
      out.push(`      name             = ${tq(s.name)}`);
      out.push(`      address_prefixes = [${tq(s.prefix)}]`);
      out.push(`      delegation       = ${s.delegation ? tq(s.delegation) : 'null'}`);
      out.push('    }');
    }),
  );
  out.push('  }', '');

  // Peering and connection names are unique per parent, so keys include the parent.
  out.push('  peerings = {');
  for (const p of model.peerings) {
    out.push(`    ${tq(`${vnetKeys[p.from]}/${p.name}`)} = {`);
    out.push(`      name   = ${tq(p.name)}`);
    out.push(`      vnet   = ${tq(vnetKeys[p.from])}`);
    out.push(`      remote = ${tq(vnetKeys[p.to])}`);
    out.push('    }');
  }
  out.push('  }');

  if (model.virtualHubs.length) {
    out.push('', '  virtual_hubs = {');
    model.virtualHubs.forEach((h, i) => {
      out.push(`    ${tq(hubKeys[i])} = {`);
      out.push(`      name           = ${tq(h.name)}`);
      out.push(`      location       = ${tq(h.location)}`);
      out.push(`      address_prefix = ${tq(h.prefix)}`);
      out.push('    }');
    });
    out.push('  }', '');
    out.push('  hub_connections = {');
    for (const c of model.hubConnections) {
      out.push(`    ${tq(`${hubKeys[c.hub]}/${c.name}`)} = {`);
      out.push(`      name = ${tq(c.name)}`);
      out.push(`      hub  = ${tq(hubKeys[c.hub])}`);
      out.push(`      vnet = ${tq(vnetKeys[c.vnet])}`);
      out.push('    }');
    }
    out.push('  }');
  }
  out.push('}', '');

  out.push(`resource "azurerm_resource_group" "network" {
  name     = var.resource_group_name
  location = var.resource_group_location
}

resource "azurerm_virtual_network" "this" {
  for_each = local.vnets

  name                = each.value.name
  location            = each.value.location
  resource_group_name = azurerm_resource_group.network.name
  address_space       = each.value.address_space
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
  for_each = local.peerings

  name                         = each.value.name
  resource_group_name          = azurerm_resource_group.network.name
  virtual_network_name         = azurerm_virtual_network.this[each.value.vnet].name
  remote_virtual_network_id    = azurerm_virtual_network.this[each.value.remote].id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = true
}
`);

  if (model.virtualHubs.length) {
    out.push(`resource "azurerm_virtual_wan" "this" {
  name                = ${tq(model.virtualWan)}
  location            = ${tq(model.virtualHubs[0].location)}
  resource_group_name = azurerm_resource_group.network.name
}

resource "azurerm_virtual_hub" "this" {
  for_each = local.virtual_hubs

  name                = each.value.name
  location            = each.value.location
  resource_group_name = azurerm_resource_group.network.name
  virtual_wan_id      = azurerm_virtual_wan.this.id
  address_prefix      = each.value.address_prefix
}

resource "azurerm_virtual_hub_connection" "this" {
  for_each = local.hub_connections

  name                      = each.value.name
  virtual_hub_id            = azurerm_virtual_hub.this[each.value.hub].id
  remote_virtual_network_id = azurerm_virtual_network.this[each.value.vnet].id
}
`);
  }

  return out.join('\n');
}

export function generateIac(
  format: IacFormat,
  plan: PlanSpec,
  result: PlanResult,
  naming: NamingOptions = DEFAULT_NAMING,
): string {
  const model = buildIacModel(plan, result, naming);
  return format === 'bicep' ? toBicep(model) : toTerraform(model);
}
