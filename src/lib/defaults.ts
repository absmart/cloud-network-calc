// Starting templates, loosely following the Azure Landing Zone reference
// architecture: a connectivity hub per region, platform spokes (identity,
// management and security, separate or combined), and corp and online
// landing zone spokes.

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

const PLATFORM_TEMPLATES: Record<PlatformLayout, SpokeTemplate[]> = {
  separate: ['identity', 'management', 'security'],
  combined: ['platform'],
};

export const isPlatformVnet = (v: VnetSpec) => !!v.role && v.role !== 'landing-zone';

export function platformLayoutOf(region: RegionSpec): PlatformLayout {
  return region.spokes.some((v) => v.role === 'platform') ? 'combined' : 'separate';
}

/**
 * Switch a region between separate identity/management/security VNets and one
 * combined platform VNet. Replaces the platform spokes (any edits to them are
 * lost); landing zone spokes are kept.
 */
export function setPlatformLayout(region: RegionSpec, layout: PlatformLayout): RegionSpec {
  const platform = PLATFORM_TEMPLATES[layout].map((t) => SPOKE_TEMPLATES[t].make(region.location));
  return { ...region, spokes: [...platform, ...region.spokes.filter((v) => !isPlatformVnet(v))] };
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
  return {
    id: newId(),
    name: regionDisplayName(location),
    location,
    prefix: REGION_PREFIX,
    topology,
    hub: makeHub(location, topology),
    spokes: [...PLATFORM_TEMPLATES[platform], 'corp', 'online'].map((t) =>
      SPOKE_TEMPLATES[t as SpokeTemplate].make(location),
    ),
  };
}

/**
 * A sensible location for the next region: the Azure pair of the most
 * recent region whose pair is still free, else another region in the same
 * geography, else any region not yet used by the plan.
 */
export function nextUnusedLocation(plan: PlanSpec): string {
  const used = new Set(plan.regions.map((r) => r.location));
  const free = (location: string | null | undefined): location is string =>
    !!location && !used.has(location) && !!findRegion(location);
  const existing = [...plan.regions].reverse().map((r) => findRegion(r.location));

  for (const r of existing) if (free(r?.paired)) return r!.paired!;
  const geography = existing.find(Boolean)?.geography;
  const candidates = AZURE_REGIONS.filter((r) => free(r.location));
  return (candidates.find((r) => r.geography === geography) ?? candidates[0])?.location ?? 'eastus2';
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
    regions: [makeRegion('eastus2', 'hub-spoke'), makeRegion('centralus', 'hub-spoke')],
  };
}
