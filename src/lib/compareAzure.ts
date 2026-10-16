// Compare a plan with what is deployed in Azure: the same exported JSON the
// importer reads, checked against the IaC model (the plan as it would deploy).

import { type Comparison, type DeployedSide, type Side, compareSides, lower, rangeAndSubnetDifferences } from './compare';
import type { IacModel } from './iac';
import { readAzureNetwork } from './importAzure';
import { formatCidr } from './ipv4';
import { isSubscriptionId } from './placement';

export type { Comparison, DiffStatus, NetworkDiff } from './compare';

interface AzureSide extends Side {
  /** Planned: a subscription key or ID; deployed: the subscription ID. */
  subscription: string;
  resourceGroup: string;
}

function plannedSides(model: IacModel): AzureSide[] {
  return [
    ...model.vnets.map(
      (v): AzureSide => ({
        name: v.plannerName,
        exportedName: v.name,
        names: lower([v.name, v.plannerName]),
        kind: 'vnet',
        location: v.location,
        subscription: v.subscription,
        resourceGroup: v.resourceGroup,
        prefixes: v.prefixes,
        subnets: v.subnets.map((s) => ({ name: s.plannerName, names: lower([s.name, s.plannerName]), prefix: s.prefix })),
      }),
    ),
    ...model.virtualHubs.map(
      (h): AzureSide => ({
        name: h.plannerName,
        exportedName: h.name,
        names: lower([h.name, h.plannerName]),
        kind: 'virtual-hub',
        location: h.location,
        subscription: h.subscription,
        resourceGroup: h.resourceGroup,
        prefixes: [h.prefix],
        subnets: [],
      }),
    ),
  ];
}

function azureDifferences(planned: AzureSide, deployed: AzureSide): string[] {
  const out: string[] = [];
  if (planned.location !== deployed.location) out.push(`Location: planned ${planned.location}, Azure has ${deployed.location}`);
  // A subscription key (like "connectivity") can't be checked; a subscription ID can.
  if (isSubscriptionId(planned.subscription) && deployed.subscription && planned.subscription.toLowerCase() !== deployed.subscription.toLowerCase())
    out.push(`Subscription: planned ${planned.subscription}, Azure has ${deployed.subscription}`);
  if (deployed.resourceGroup && planned.resourceGroup.toLowerCase() !== deployed.resourceGroup.toLowerCase())
    out.push(`Resource group: planned ${planned.resourceGroup}, Azure has ${deployed.resourceGroup}`);
  return [...out, ...rangeAndSubnetDifferences(planned, deployed, 'Azure', 'Address range')];
}

/**
 * Compare the plan (as its IaC model, so names are the exported ones) with
 * exported Azure network JSON. Planned networks are matched to deployed ones
 * by exported or planner name, then by overlapping address space in the same
 * location. Throws, like the importer, if the JSON holds no networks.
 */
export function compareWithAzure(model: IacModel, input: string): Comparison {
  const { vnets, hubs, notes } = readAzureNetwork(input);
  const deployed: (AzureSide & DeployedSide)[] = [
    ...[...vnets.values()].map((v) => ({
      id: v.id,
      group: v.resourceGroup,
      subscription: v.subscription,
      resourceGroup: v.resourceGroup,
      name: v.name,
      names: lower([v.name]),
      kind: 'vnet' as const,
      location: v.location,
      prefixes: [v.cidr, ...v.extra].map(formatCidr),
      subnets: v.subnets.map((s) => ({ name: s.name, names: lower([s.name]), prefix: formatCidr(s.cidr) })),
    })),
    ...[...hubs.values()].map((h) => ({
      id: h.id,
      group: h.resourceGroup,
      subscription: h.subscription,
      resourceGroup: h.resourceGroup,
      name: h.name,
      names: lower([h.name]),
      kind: 'virtual-hub' as const,
      location: h.location,
      prefixes: [formatCidr(h.cidr)],
      subnets: [],
    })),
  ];
  return compareSides(plannedSides(model), deployed, azureDifferences, notes, model.omitted);
}
