// Import an existing Azure network (VNets, subnets, peerings and Virtual WAN
// hubs) from JSON the user exports with the Azure CLI, Azure PowerShell or
// Resource Graph, and turn it into a plan. Everything imported is pinned, so
// the planner validates the real estate instead of re-allocating it.

import { newId } from './defaults';
import { type Cidr, blockSize, contains, formatCidr, overlaps, parseCidr, supernet } from './ipv4';
import type { PlanSpec, RegionSpec, SubnetSpec, VnetSpec } from './planner';
import { regionDisplayName } from './regions';

/**
 * Resource Graph query for every VNet and Virtual WAN hub the user can read,
 * across subscriptions. Run it in the portal's Resource Graph Explorer or with
 * `az graph query -q "<query>" --first 1000 -o json`.
 */
export const AZURE_IMPORT_QUERY = `resources
| where type in~ ('microsoft.network/virtualnetworks', 'microsoft.network/virtualhubs')
| project id, name, type, location, properties`;

export interface ImportNote {
  level: 'info' | 'warning';
  message: string;
}

export interface AzureImport {
  plan: PlanSpec;
  notes: ImportNote[];
}

interface FoundVnet {
  id: string;
  name: string;
  location: string;
  cidr: Cidr;
  subnets: { name: string; cidr: Cidr }[];
  /** Lower-cased resource ids of peered VNets. */
  peers: string[];
}

interface FoundHub {
  id: string;
  name: string;
  location: string;
  cidr: Cidr;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A property of an Azure resource, looked up without regard to case (Azure
 * PowerShell uses PascalCase) on the object itself or, for ARM and Resource
 * Graph output, under `properties`.
 */
function field(obj: unknown, name: string): unknown {
  if (!isObject(obj)) return undefined;
  const own = fieldOwn(obj, name);
  if (own !== undefined) return own;
  const props = fieldOwn(obj, 'properties');
  return isObject(props) ? fieldOwn(props, name) : undefined;
}

function fieldOwn(obj: Json, name: string): unknown {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) if (k.toLowerCase() === key) return v;
  return undefined;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** "East US 2" and "eastus2" are the same location. */
const normalizeLocation = (location: string) => location.toLowerCase().replace(/\s+/g, '');

/** Every resource object in the input, whatever wrapper it came in. */
function resources(data: unknown): Json[] {
  if (Array.isArray(data)) return data.flatMap(resources);
  if (!isObject(data)) return [];
  // Resource Graph (`data`), ARM REST lists (`value`).
  for (const wrapper of ['data', 'value']) {
    const inner = fieldOwn(data, wrapper);
    if (Array.isArray(inner)) return inner.flatMap(resources);
  }
  return [data];
}

function kindOf(resource: Json): 'vnet' | 'hub' | null {
  const type = text(field(resource, 'type')).toLowerCase();
  if (type === 'microsoft.network/virtualnetworks') return 'vnet';
  if (type === 'microsoft.network/virtualhubs') return 'hub';
  if (type) return null;
  // Azure PowerShell output has no type; recognise it by shape.
  if (field(resource, 'addressSpace') !== undefined) return 'vnet';
  if (field(resource, 'virtualWan') !== undefined) return 'hub';
  return null;
}

/** IPv4 prefixes of a list, with notes for any that can't be used. IPv6 is skipped silently. */
function ipv4Prefixes(values: unknown[], where: string, notes: ImportNote[]): Cidr[] {
  const out: Cidr[] = [];
  for (const value of values) {
    const s = text(value);
    if (!s || s.includes(':')) continue;
    const parsed = parseCidr(s);
    if (parsed.ok) out.push(parsed.cidr);
    else notes.push({ level: 'warning', message: `${where}: "${s}" left out (${parsed.error})` });
  }
  return out;
}

function readVnet(resource: Json, notes: ImportNote[]): FoundVnet | null {
  const name = text(field(resource, 'name')) || 'unnamed-vnet';
  const location = normalizeLocation(text(field(resource, 'location')));
  if (!location) {
    notes.push({ level: 'warning', message: `${name} has no location and was left out` });
    return null;
  }

  const prefixes = ipv4Prefixes(list(field(field(resource, 'addressSpace'), 'addressPrefixes')), name, notes);
  if (prefixes.length === 0) {
    notes.push({ level: 'warning', message: `${name} has no IPv4 address space and was left out` });
    return null;
  }

  const subnets: FoundVnet['subnets'] = [];
  let truncated = false;
  for (const s of list(field(resource, 'subnets'))) {
    if (!isObject(s)) {
      truncated = true;
      continue;
    }
    const subnetName = text(field(s, 'name')) || 'unnamed-snet';
    const where = `${name}/${subnetName}`;
    const cidrs = ipv4Prefixes([...list(field(s, 'addressPrefix')), ...list(field(s, 'addressPrefixes'))], where, notes);
    const unique = cidrs.filter((c, i) => cidrs.findIndex((d) => formatCidr(d) === formatCidr(c)) === i);
    if (unique.length === 0) continue;
    if (unique.length > 1)
      notes.push({
        level: 'warning',
        message: `${where} has several address ranges; only ${formatCidr(unique[0])} is imported`,
      });
    subnets.push({ name: subnetName, cidr: unique[0] });
  }
  if (truncated)
    notes.push({
      level: 'warning',
      message: `${name}: subnet details are missing (with ConvertTo-Json, pass -Depth 10)`,
    });

  // A plan VNet has one range: keep the one holding the most subnets.
  const inside = (c: Cidr) => subnets.filter((s) => contains(c, s.cidr)).length;
  const cidr = prefixes.reduce((best, c) => (inside(c) > inside(best) ? c : best));
  if (prefixes.length > 1) {
    const others = prefixes.filter((c) => c !== cidr).map(formatCidr);
    const dropped = subnets.filter((s) => !contains(cidr, s.cidr)).map((s) => s.name);
    notes.push({
      level: 'warning',
      message:
        `${name} has several address ranges; only ${formatCidr(cidr)} is imported (left out: ${others.join(', ')}` +
        (dropped.length ? `, with subnets ${dropped.join(', ')})` : ')'),
    });
  }

  const peers = list(field(resource, 'virtualNetworkPeerings'))
    .map((p) => text(field(field(p, 'remoteVirtualNetwork'), 'id')).toLowerCase())
    .filter(Boolean);

  return {
    id: text(field(resource, 'id')).toLowerCase() || newId(),
    name,
    location,
    cidr,
    subnets: subnets.filter((s) => contains(cidr, s.cidr)),
    peers,
  };
}

function readHub(resource: Json, notes: ImportNote[]): FoundHub | null {
  const name = text(field(resource, 'name')) || 'unnamed-vhub';
  const location = normalizeLocation(text(field(resource, 'location')));
  const [cidr] = ipv4Prefixes(list(field(resource, 'addressPrefix')), name, notes);
  if (!location || !cidr) {
    notes.push({ level: 'warning', message: `Virtual hub ${name} has no location or address prefix and was left out` });
    return null;
  }
  return { id: text(field(resource, 'id')).toLowerCase() || newId(), name, location, cidr };
}

/** Subnets that only a connectivity hub has. */
const HUB_SUBNETS = new Set(['gatewaysubnet', 'azurefirewallsubnet', 'azurefirewallmanagementsubnet', 'routeserversubnet']);

const toVnetSpec = (v: FoundVnet, landingZone: boolean): VnetSpec => ({
  id: newId(),
  name: v.name,
  // Imported spokes are never "platform", so changing the platform layout can't replace them.
  ...(landingZone && { role: 'landing-zone' as const }),
  prefix: v.cidr.prefix,
  fixed: formatCidr(v.cidr),
  subnets: v.subnets.map(
    (s): SubnetSpec => ({ id: newId(), name: s.name, prefix: s.cidr.prefix, offset: s.cidr.base - v.cidr.base }),
  ),
});

const byAddress = <T extends { cidr: Cidr }>(a: T, b: T) => a.cidr.base - b.cidr.base || a.cidr.prefix - b.cidr.prefix;

/** Pick the hub VNet of a hub & spoke region: the one with gateway or firewall subnets, then the most peered. */
function pickHub(vnets: FoundVnet[], regionName: string, notes: ImportNote[]): FoundVnet {
  const ids = new Set(vnets.map((v) => v.id));
  const hasHubSubnet = (v: FoundVnet) => v.subnets.some((s) => HUB_SUBNETS.has(s.name.toLowerCase()));
  const peerCount = (v: FoundVnet) => v.peers.filter((p) => ids.has(p)).length;
  const score = (v: FoundVnet) => (hasHubSubnet(v) ? 1000 : 0) + peerCount(v);
  const hub = vnets.reduce((best, v) => (score(v) > score(best) ? v : best));

  const lookalikes = vnets.filter(hasHubSubnet);
  if (lookalikes.length > 1)
    notes.push({
      level: 'warning',
      message: `${regionName}: several VNets look like hubs (${lookalikes.map((v) => v.name).join(', ')}); ${hub.name} is used as the hub and the others as spokes`,
    });
  else if (score(hub) === 0 && vnets.length > 1)
    notes.push({
      level: 'warning',
      message: `${regionName}: no hub VNet found (no gateway or firewall subnet, no peerings); ${hub.name} is used as the hub`,
    });
  return hub;
}

function buildRegion(location: string, vnets: FoundVnet[], hubs: FoundHub[], notes: ImportNote[]): RegionSpec {
  const name = regionDisplayName(location);
  vnets.sort(byAddress);
  hubs.sort(byAddress);
  if (hubs.length > 1)
    notes.push({
      level: 'warning',
      message: `${name}: only one Virtual WAN hub per region is supported; ${hubs[0].name} is imported (left out: ${hubs
        .slice(1)
        .map((h) => h.name)
        .join(', ')})`,
    });

  if (hubs.length > 0) {
    const vhub = hubs[0];
    return {
      id: newId(),
      name,
      location,
      prefix: 0,
      topology: 'vwan',
      hub: { id: newId(), name: vhub.name, prefix: vhub.cidr.prefix, fixed: formatCidr(vhub.cidr), subnets: [] },
      spokes: vnets.map((v) => toVnetSpec(v, true)),
    };
  }

  const hub = pickHub(vnets, name, notes);
  const spokes = vnets.filter((v) => v !== hub);
  if (hub.peers.length > 0) {
    const unpeered = spokes.filter((v) => !hub.peers.includes(v.id) && !v.peers.includes(hub.id));
    if (unpeered.length)
      notes.push({
        level: 'info',
        message: `${name}: not peered to ${hub.name}: ${unpeered.map((v) => v.name).join(', ')}`,
      });
  }
  return {
    id: newId(),
    name,
    location,
    prefix: 0,
    topology: 'hub-spoke',
    hub: toVnetSpec(hub, false),
    spokes: spokes.map((v) => toVnetSpec(v, true)),
  };
}

/**
 * Turn exported Azure network JSON into a plan. Accepts Resource Graph output
 * (see AZURE_IMPORT_QUERY), `az network vnet list` / `az network vhub list`,
 * `Get-AzVirtualNetwork | ConvertTo-Json -Depth 10`, ARM REST list responses,
 * or an array mixing any of these. Throws with a readable message if nothing
 * usable is found.
 */
export function importAzureNetwork(input: string, name = 'Imported Azure network'): AzureImport {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    throw new Error('The text is not valid JSON.');
  }

  const notes: ImportNote[] = [];
  const vnets = new Map<string, FoundVnet>();
  const hubs = new Map<string, FoundHub>();
  for (const resource of resources(data)) {
    const kind = kindOf(resource);
    if (kind === 'vnet') {
      const v = readVnet(resource, notes);
      if (v) vnets.set(v.id, v);
    } else if (kind === 'hub') {
      const h = readHub(resource, notes);
      if (h) hubs.set(h.id, h);
    }
  }
  if (vnets.size === 0 && hubs.size === 0) throw new Error('No virtual networks or Virtual WAN hubs were found.');

  const locations = new Map<string, { vnets: FoundVnet[]; hubs: FoundHub[] }>();
  const group = (location: string) => {
    if (!locations.has(location)) locations.set(location, { vnets: [], hubs: [] });
    return locations.get(location)!;
  };
  for (const v of vnets.values()) group(v.location).vnets.push(v);
  for (const h of hubs.values()) group(h.location).hubs.push(h);

  // A region's block is the smallest one covering its networks, widened to a
  // /16 when that doesn't take in another region's networks.
  const used = (g: { vnets: FoundVnet[]; hubs: FoundHub[] }) => [...g.vnets, ...g.hubs].map((n) => n.cidr);
  const placed = [...locations].map(([location, g]) => {
    let block = supernet(used(g));
    if (block.prefix > 16) {
      const wide = { base: block.base - (block.base % blockSize(16)), prefix: 16 };
      const others = [...locations].filter(([l]) => l !== location).flatMap(([, o]) => used(o));
      if (!others.some((c) => overlaps(c, wide))) block = wide;
    }
    return { block, region: buildRegion(location, g.vnets, g.hubs, notes) };
  });
  placed.sort((a, b) => a.block.base - b.block.base);
  const regions = placed.map(({ block, region }) => ({ ...region, prefix: block.prefix, fixed: formatCidr(block) }));

  const root = supernet(placed.map((p) => p.block));
  notes.unshift({
    level: 'info',
    message: `Imported ${vnets.size} VNet${vnets.size === 1 ? '' : 's'}${
      hubs.size ? ` and ${hubs.size} Virtual WAN hub${hubs.size === 1 ? '' : 's'}` : ''
    } in ${regions.length} region${regions.length === 1 ? '' : 's'}; root range ${formatCidr(root)}`,
  });

  return { plan: { version: 1, name, root: formatCidr(root), regions }, notes };
}
