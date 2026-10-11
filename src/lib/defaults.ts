// Starting templates, loosely following the Azure Landing Zone reference
// architecture: a connectivity hub per region plus identity, management,
// corp and online landing zone spokes.

import type { PlanSpec, RegionSpec, SubnetSpec, Topology, VnetSpec } from './planner';
import { AZURE_REGIONS, findRegion, regionDisplayName } from './regions';

export const newId = () => Math.random().toString(36).slice(2, 10);

export const subnet = (name: string, prefix: number): SubnetSpec => ({ id: newId(), name, prefix });

const vnet = (name: string, prefix: number, subnets: SubnetSpec[]): VnetSpec => ({
  id: newId(),
  name,
  prefix,
  subnets,
});

export type SpokeTemplate = 'identity' | 'management' | 'corp' | 'online' | 'empty';

export const SPOKE_TEMPLATES: Record<SpokeTemplate, { label: string; make: (loc: string) => VnetSpec }> = {
  identity: {
    label: 'Identity (platform)',
    make: (loc) => vnet(`vnet-identity-${loc}`, 24, [subnet('snet-domain-controllers', 27)]),
  },
  management: {
    label: 'Management (platform)',
    make: (loc) => vnet(`vnet-management-${loc}`, 24, [subnet('snet-management', 26)]),
  },
  corp: {
    label: 'Corp landing zone',
    make: (loc) =>
      vnet(`vnet-corp-${loc}-001`, 22, [
        subnet('snet-app', 24),
        subnet('snet-data', 24),
        subnet('snet-pe', 26),
      ]),
  },
  online: {
    label: 'Online landing zone',
    make: (loc) =>
      vnet(`vnet-online-${loc}-001`, 23, [subnet('snet-appgw', 24), subnet('snet-web', 25)]),
  },
  empty: {
    label: 'Empty spoke',
    make: (loc) => vnet(`vnet-spoke-${loc}`, 24, []),
  },
};

export function makeHub(location: string, topology: Topology): VnetSpec {
  if (topology === 'vwan') return vnet(`vhub-${location}`, 23, []);
  return vnet(`vnet-hub-${location}`, 22, [
    subnet('GatewaySubnet', 27),
    subnet('AzureFirewallSubnet', 26),
    subnet('AzureFirewallManagementSubnet', 26),
    subnet('AzureBastionSubnet', 26),
    subnet('snet-dns-inbound', 28),
    subnet('snet-dns-outbound', 28),
    // Network virtual appliance (third-party firewall / router) interfaces.
    subnet('snet-nva-outside', 24),
    subnet('snet-nva-inside', 27),
    subnet('snet-nva-ha', 29),
    subnet('snet-nva-mgmt', 28),
  ]);
}

/** Every region gets its own /16 by default. */
export const REGION_PREFIX = 16;

export function makeRegion(location: string, topology: Topology): RegionSpec {
  return {
    id: newId(),
    name: regionDisplayName(location),
    location,
    prefix: REGION_PREFIX,
    topology,
    hub: makeHub(location, topology),
    spokes: (['identity', 'management', 'corp', 'online'] as const).map((t) =>
      SPOKE_TEMPLATES[t].make(location),
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
 * has the default display name) and any VNet names that carry the old location.
 */
export function relocateRegion(region: RegionSpec, location: string): RegionSpec {
  const old = region.location;
  const rename = (name: string) =>
    old ? name.replace(new RegExp(`(^|-)${old}(?=-|$)`, 'g'), `$1${location}`) : name;
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
