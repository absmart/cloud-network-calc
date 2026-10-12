// Starting templates, loosely following the Azure Landing Zone reference
// architecture: a connectivity hub per region, platform spokes (identity,
// management and security: separate, combined or in the hub), and corp and
// online landing zone spokes.

import { VWAN_HUB_RECOMMENDED_PREFIX } from './azure';
import { blockSize } from './ipv4';
import type { PlanSpec, PlatformLayout, RegionSpec, SubnetSpec, Topology, VnetRole, VnetSpec } from './planner';
import { regionCode } from './naming';
import { AZURE_REGIONS, findRegion, regionDisplayName } from './regions';

export const newId = () => Math.random().toString(36).slice(2, 10);

export const subnet = (name: string, prefix: number): SubnetSpec => ({ id: newId(), name, prefix });

/** A subnet at a fixed offset from the start of its VNet. */
const placed = (name: string, prefix: number, offset: number): SubnetSpec => ({ ...subnet(name, prefix), offset });

const vnet = (name: string, prefix: number, subnets: SubnetSpec[], role?: VnetRole): VnetSpec => ({
  id: newId(),
  name,
  ...(role && { role }),
  prefix,
  subnets,
});

export type SpokeTemplate = 'identity' | 'management' | 'security' | 'platform' | 'corp' | 'online' | 'empty';

export const SPOKE_TEMPLATES: Record<SpokeTemplate, { label: string; make: (loc: string) => VnetSpec }> = {
  identity: {
    label: 'Identity (platform)',
    make: (loc) => vnet(`identity-${regionCode(loc)}-vnet`, 24, [subnet('identity-snet', 27)], 'identity'),
  },
  management: {
    label: 'Management (platform)',
    make: (loc) => vnet(`management-${regionCode(loc)}-vnet`, 24, [subnet('management-snet', 26)], 'management'),
  },
  security: {
    label: 'Security (platform)',
    make: (loc) => vnet(`security-${regionCode(loc)}-vnet`, 24, [subnet('security-snet', 26)], 'security'),
  },
  platform: {
    label: 'Platform: identity + management + security',
    make: (loc) =>
      vnet(
        `platform-${regionCode(loc)}-vnet`,
        24,
        [subnet('identity-snet', 26), subnet('management-snet', 26), subnet('security-snet', 26)],
        'platform',
      ),
  },
  corp: {
    label: 'Corp landing zone',
    make: (loc) =>
      vnet(
        `corp-${regionCode(loc)}-001-vnet`,
        22,
        [subnet('app-snet', 24), subnet('data-snet', 24), subnet('pe-snet', 26)],
        'landing-zone',
      ),
  },
  online: {
    label: 'Online landing zone',
    make: (loc) =>
      vnet(`online-${regionCode(loc)}-001-vnet`, 23, [subnet('appgw-snet', 24), subnet('web-snet', 25)], 'landing-zone'),
  },
  empty: {
    label: 'Empty spoke',
    make: (loc) => vnet(`spoke-${regionCode(loc)}-vnet`, 24, [], 'landing-zone'),
  },
};

const PLATFORM_TEMPLATES: Record<Exclude<PlatformLayout, 'hub'>, SpokeTemplate[]> = {
  separate: ['identity', 'management', 'security'],
  combined: ['platform'],
};

/**
 * Platform subnets for the "hub" layout, at offsets in the hub's fourth /24,
 * which the default /22 hub leaves free.
 */
const HUB_PLATFORM_SUBNETS: [name: string, prefix: number, offset: number][] = [
  ['identity-snet', 26, 768],
  ['management-snet', 26, 768 + 64],
  ['security-snet', 26, 768 + 128],
];

export const isPlatformVnet = (v: VnetSpec) => !!v.role && v.role !== 'landing-zone';

export function platformLayoutOf(region: RegionSpec): PlatformLayout {
  if (region.hub.subnets.some((s) => s.platform)) return 'hub';
  return region.spokes.some((v) => v.role === 'platform') ? 'combined' : 'separate';
}

/**
 * Add the platform subnets to a hub at their usual offsets. One whose slot
 * doesn't fit the hub, or is taken by a placed subnet, is placed automatically.
 */
function withPlatformSubnets(hub: VnetSpec): VnetSpec {
  const taken = hub.subnets.filter((s) => s.offset !== undefined).map((s) => [s.offset!, s.offset! + blockSize(s.prefix)]);
  const added = HUB_PLATFORM_SUBNETS.map(([name, prefix, offset]): SubnetSpec => {
    const end = offset + blockSize(prefix);
    const fits = end <= blockSize(hub.prefix) && !taken.some(([start, stop]) => offset < stop && start < end);
    return { ...subnet(name, prefix), platform: true, ...(fits && { offset }) };
  });
  return { ...hub, subnets: [...hub.subnets, ...added] };
}

/**
 * Switch a region between separate identity/management/security VNets, one
 * combined platform VNet, and platform subnets in the hub. Replaces the
 * platform spokes and hub platform subnets (any edits to them are lost);
 * landing zone spokes and the hub's other subnets are kept. A Virtual WAN hub
 * can't hold subnets, so "hub" falls back to separate VNets there.
 */
export function setPlatformLayout(region: RegionSpec, layout: PlatformLayout): RegionSpec {
  const hub = { ...region.hub, subnets: region.hub.subnets.filter((s) => !s.platform) };
  const landingZones = region.spokes.filter((v) => !isPlatformVnet(v));
  if (layout === 'hub' && region.topology === 'hub-spoke')
    return { ...region, hub: withPlatformSubnets(hub), spokes: landingZones };
  const platform = PLATFORM_TEMPLATES[layout === 'hub' ? 'separate' : layout].map((t) =>
    SPOKE_TEMPLATES[t].make(region.location),
  );
  return { ...region, hub, spokes: [...platform, ...landingZones] };
}

/**
 * Swap in a hub of the right shape for the topology. A virtual hub keeps the
 * old hub's size if that's at least the recommended /23. Platform subnets in
 * the old hub move out to separate VNets, since a virtual hub has no subnets.
 */
export function setTopology(region: RegionSpec, topology: Topology): RegionSpec {
  const hub = makeHub(region.location, topology);
  if (topology === 'vwan') hub.prefix = Math.min(region.hub.prefix, VWAN_HUB_RECOMMENDED_PREFIX);
  const next = { ...region, topology, hub };
  return platformLayoutOf(region) === 'hub' && topology === 'vwan' ? setPlatformLayout(next, 'separate') : next;
}

/** Give spokes saved before roles existed a role, inferred from their template name. */
export function migratePlan(plan: PlanSpec): PlanSpec {
  const infer = (v: VnetSpec): VnetSpec =>
    v.role
      ? v
      : { ...v, role: (v.name.match(/^(?:vnet-)?(identity|management|security|platform)-/)?.[1] as VnetRole) ?? 'landing-zone' };
  return { ...plan, regions: plan.regions.map((r) => ({ ...r, spokes: r.spokes.map(infer) })) };
}

export function makeHub(location: string, topology: Topology): VnetSpec {
  if (topology === 'vwan') return vnet(`hub-${regionCode(location)}-vhub`, 23, []);
  // Fixed positions within the /22 hub (offsets from its base, so they follow
  // the hub if it moves). The NVA owns the first two /24s; Azure services
  // start in the third.
  return vnet(`hub-${regionCode(location)}-vnet`, 22, [
    // x.x.0.0/24: NVA outside (untrusted) interfaces.
    placed('nva-outside-snet', 24, 0),
    // x.x.1.0/24: NVA inside, HA and management; the rest is NVA headroom.
    placed('nva-inside-snet', 27, 256),
    placed('nva-ha-snet', 27, 256 + 32),
    placed('nva-mgmt-snet', 27, 256 + 64),
    // x.x.2.0/24: Azure platform services.
    placed('GatewaySubnet', 27, 512),
    placed('dns-inbound-snet', 28, 512 + 32),
    placed('dns-outbound-snet', 28, 512 + 48),
    placed('AzureFirewallSubnet', 26, 512 + 64),
    placed('AzureFirewallManagementSubnet', 26, 512 + 128),
    placed('AzureBastionSubnet', 26, 512 + 192),
  ]);
}

/** Every region gets its own /16 by default. */
export const REGION_PREFIX = 16;

export function makeRegion(location: string, topology: Topology, platform: PlatformLayout = 'separate'): RegionSpec {
  const region: RegionSpec = {
    id: newId(),
    name: regionDisplayName(location),
    location,
    prefix: REGION_PREFIX,
    topology,
    hub: makeHub(location, topology),
    spokes: (['corp', 'online'] as const).map((t) => SPOKE_TEMPLATES[t].make(location)),
  };
  return setPlatformLayout(region, platform);
}

/** The first region of a plan is East US 2 unless that's already taken. */
export const FIRST_REGION = 'eastus2';

/**
 * The location for the next region:
 *   1st region: East US 2;
 *   2nd region: the Azure pair of the first region (East US 2 → Central US);
 *   after that: the pair of the most recent region whose pair is still free,
 *   else another region in the same geography, else any unused region.
 * Each step falls through to the next if its region is already in the plan.
 */
export function nextUnusedLocation(plan: PlanSpec): string {
  const used = new Set(plan.regions.map((r) => r.location));
  const free = (location: string | null | undefined): location is string =>
    !!location && !used.has(location) && !!findRegion(location);
  const existing = [...plan.regions].reverse().map((r) => findRegion(r.location));

  if (plan.regions.length === 0 && free(FIRST_REGION)) return FIRST_REGION;
  if (plan.regions.length === 1) {
    const pair = findRegion(plan.regions[0].location)?.paired;
    if (free(pair)) return pair;
  }
  for (const r of existing) if (free(r?.paired)) return r!.paired!;
  const geography = existing.find(Boolean)?.geography;
  const candidates = AZURE_REGIONS.filter((r) => free(r.location));
  return (candidates.find((r) => r.geography === geography) ?? candidates[0])?.location ?? FIRST_REGION;
}

/**
 * Move a region to another Azure location, renaming the region (if it still
 * has the default display name) and any VNet names that carry the old region
 * code (or, in plans saved before codes were used, the old location name).
 */
export function relocateRegion(region: RegionSpec, location: string): RegionSpec {
  const old = region.location;
  const oldTokens = [...new Set([regionCode(old), old])].filter(Boolean).join('|');
  const rename = (name: string) =>
    oldTokens ? name.replace(new RegExp(`(^|-)(${oldTokens})(?=-|$)`, 'g'), `$1${regionCode(location)}`) : name;
  const renameVnet = (v: VnetSpec): VnetSpec => ({ ...v, name: rename(v.name) });
  return {
    ...region,
    location,
    name: region.name === regionDisplayName(old) ? regionDisplayName(location) : region.name,
    hub: renameVnet(region.hub),
    spokes: region.spokes.map(renameVnet),
  };
}

export function defaultPlan(): PlanSpec {
  return {
    version: 1,
    name: 'Contoso landing zones',
    // A /12 has room for 16 regional /16s.
    root: '10.0.0.0/12',
    // Primary and secondary are an Azure region pair.
    regions: [makeRegion(FIRST_REGION, 'hub-spoke'), makeRegion('centralus', 'hub-spoke')],
  };
}
