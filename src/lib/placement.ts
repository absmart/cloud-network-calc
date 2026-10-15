// Where the IaC export puts each network: a subscription and a resource group.
// A plan picks a layout, modelled on common Azure Landing Zone designs, which
// suggests a placement for every VNet and virtual hub; any of them can be
// overridden on the VNet itself.

import { type NamingOptions, nameBase, normalizeNaming, parsePlannerName, regionCode, resourceName } from './naming';
import type { PlacementLayout, RegionSpec, VnetSpec } from './planner';

export interface Placement {
  /** A logical subscription name the variables file maps to an ID, or an ID itself. */
  subscription: string;
  resourceGroup: string;
}

export const PLACEMENT_LAYOUTS: Record<PlacementLayout, { label: string; description: string }> = {
  single: {
    label: 'One subscription',
    description: 'Everything in one subscription and one resource group.',
  },
  alz: {
    label: 'Azure Landing Zones',
    description:
      'The ALZ platform subscriptions (connectivity for hubs and Virtual WAN, identity, management and security) plus one subscription per landing zone, as subscription vending creates them. A resource group per network and region.',
  },
  'alz-platform': {
    label: 'ALZ, one platform subscription',
    description:
      'A single platform subscription for hubs, Virtual WAN and platform networks (the ALZ option for smaller estates), plus one subscription per landing zone.',
  },
};

/** Whether a subscription key is already a subscription ID. */
export const isSubscriptionId = (key: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);

/** The resource group for an <app> in a location, in the plan's naming convention. */
const groupName = (app: string, naming: NamingOptions, location: string, instance?: string) =>
  resourceName(nameBase(app, naming, location, instance ?? naming.instance), 'rg');

/** The network's own subscription key and resource group when it is a landing zone of its own. */
function ownPlacement(vnet: VnetSpec, location: string, naming: NamingOptions): Placement {
  const { app, instance } = parsePlannerName(vnet.name, location);
  const name = app || 'landing-zone';
  return {
    subscription: [name, regionCode(location), instance].filter(Boolean).join('-'),
    resourceGroup: groupName(name, naming, location, instance),
  };
}

/**
 * Where a layout puts a region's hub (`kind` 'hub' or 'virtual-hub') or a
 * spoke, before any override. `primaryLocation` is the plan's first region,
 * home of the single resource group in the 'single' layout.
 */
export function suggestedPlacement(
  layout: PlacementLayout,
  region: RegionSpec,
  vnet: VnetSpec,
  kind: 'hub' | 'virtual-hub' | 'spoke',
  naming: NamingOptions,
  primaryLocation: string,
): Placement {
  const opts = normalizeNaming(naming);
  const location = region.location;
  if (layout === 'single') return { subscription: 'main', resourceGroup: groupName(opts.app, opts, primaryLocation) };

  const role = kind === 'spoke' ? (vnet.role ?? 'landing-zone') : 'connectivity';
  if (role === 'landing-zone') return ownPlacement(vnet, location, opts);
  const subscription = layout === 'alz-platform' ? 'platform' : role;
  return { subscription, resourceGroup: groupName(role, opts, location) };
}

/** A network's placement: its own override, else the layout's suggestion. */
export function placementOf(
  layout: PlacementLayout,
  region: RegionSpec,
  vnet: VnetSpec,
  kind: 'hub' | 'virtual-hub' | 'spoke',
  naming: NamingOptions,
  primaryLocation: string,
): Placement {
  const suggested = suggestedPlacement(layout, region, vnet, kind, naming, primaryLocation);
  return {
    subscription: vnet.subscription?.trim() || suggested.subscription,
    resourceGroup: vnet.resourceGroup?.trim() || suggested.resourceGroup,
  };
}
