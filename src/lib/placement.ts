// Where the IaC export puts each network: an Azure subscription and resource
// group, or an AWS account. A plan picks a layout, modelled on Azure Landing
// Zones or AWS's Landing Zone Accelerator, which suggests a placement for
// every network; any of them can be overridden on the network itself.

import { awsRegionCode } from './aws';

import { type NamingOptions, nameBase, normalizeNaming, parsePlannerName, regionCode, resourceName } from './naming';
import type { Cloud, PlacementLayout, RegionSpec, VnetSpec } from './planner';

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

/** Whether an account key is already an AWS account ID. */
export const isAccountId = (key: string) => /^\d{12}$/.test(key);

/** AWS placement layouts. AWS has no resource groups; 'alz-platform' isn't offered and works as 'alz'. */
export const AWS_PLACEMENT_LAYOUTS: Partial<Record<PlacementLayout, { label: string; description: string }>> = {
  single: {
    label: 'One account',
    description: 'Every VPC and Transit Gateway in one AWS account.',
  },
  alz: {
    label: 'Landing Zone Accelerator',
    description:
      'A network account for the Transit Gateways and the inspection, egress and endpoints VPCs, shared with one account per workload VPC through AWS Resource Access Manager, as the Landing Zone Accelerator lays it out.',
  },
};

/** The layouts offered for a cloud. */
export const placementLayouts = (cloud: Cloud) => (cloud === 'aws' ? AWS_PLACEMENT_LAYOUTS : PLACEMENT_LAYOUTS);

/** The resource group for an <app> in a location, in the plan's naming convention. */
const groupName = (app: string, naming: NamingOptions, location: string, instance?: string) =>
  resourceName(nameBase(app, naming, location, instance ?? naming.instance), 'rg');

/** The network's own subscription (or account) key and resource group when it is a landing zone of its own. */
function ownPlacement(vnet: VnetSpec, location: string, naming: NamingOptions, cloud: Cloud): Placement {
  const code = cloud === 'aws' ? awsRegionCode(location) : regionCode(location);
  const { app, instance } = parsePlannerName(vnet.name, cloud === 'aws' ? code : location);
  const name = app || 'landing-zone';
  return {
    subscription: [name, code, instance].filter(Boolean).join('-'),
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
  cloud: Cloud = 'azure',
): Placement {
  const opts = normalizeNaming(naming);
  const location = region.location;
  if (cloud === 'aws') {
    // One account, or the LZA network account plus an account per workload VPC.
    if (layout === 'single') return { subscription: 'main', resourceGroup: '' };
    const workload = kind === 'spoke' && (vnet.role ?? 'landing-zone') === 'landing-zone';
    return workload ? { ...ownPlacement(vnet, location, opts, cloud), resourceGroup: '' } : { subscription: 'network', resourceGroup: '' };
  }
  if (layout === 'single') return { subscription: 'main', resourceGroup: groupName(opts.app, opts, primaryLocation) };

  const role = kind === 'spoke' ? (vnet.role ?? 'landing-zone') : 'connectivity';
  if (role === 'landing-zone') return ownPlacement(vnet, location, opts, cloud);
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
  cloud: Cloud = 'azure',
): Placement {
  const suggested = suggestedPlacement(layout, region, vnet, kind, naming, primaryLocation, cloud);
  return {
    subscription: vnet.subscription?.trim() || suggested.subscription,
    resourceGroup: vnet.resourceGroup?.trim() || suggested.resourceGroup,
  };
}
