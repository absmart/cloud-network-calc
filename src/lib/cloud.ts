// What differs between an Azure and an AWS plan, in one place: words, regions,
// templates and rules. Everything else in the planner is shared.

import {
  AWS_LARGEST_PREFIX,
  AWS_REGIONS,
  awsRegionCode,
  awsRegionDisplayName,
  findAwsRegion,
  isAwsInfrastructureSubnet,
} from './aws';
import { presetForName } from './azure';
import {
  AWS_SPOKE_TEMPLATES,
  awsDefaultPlan,
  awsPartnerOf,
  makeAwsRegion,
  nextUnusedAwsLocation,
  relocateAwsRegion,
} from './awsDefaults';
import { SPOKE_TEMPLATES, defaultPlan, makeRegion, nextUnusedLocation, platformLayoutOf, relocateRegion } from './defaults';
import { regionCode } from './naming';
import type { Cloud, PlanSpec, RegionSpec, VnetSpec } from './planner';
import { AZURE_REGIONS, findRegion, regionDisplayName } from './regions';
import { smallestSubnetPrefix } from './sizing';

export const cloudOf = (plan: PlanSpec): Cloud => plan.cloud ?? 'azure';

export interface CloudInfo {
  label: string;
  /** What a virtual network is called: VNet or VPC. */
  network: string;
  /** What a region's hub VPC/VNet is called. */
  hub: string;
  /** What a landing zone spoke is called. */
  landingZone: string;
  smallestSubnetPrefix: number;
  /** The largest virtual network (shortest prefix) the cloud allows, if it limits it. */
  largestNetworkPrefix: number;
  /** Whether the IaC export supports the cloud. (Comparing with what's deployed is Azure-only.) */
  hasExport: boolean;
}

export const CLOUDS: Record<Cloud, CloudInfo> = {
  azure: {
    label: 'Azure',
    network: 'VNet',
    hub: 'Hub VNet',
    landingZone: 'Landing zone',
    smallestSubnetPrefix: smallestSubnetPrefix('azure'),
    largestNetworkPrefix: 8,
    hasExport: true,
  },
  aws: {
    label: 'AWS',
    network: 'VPC',
    hub: 'Inspection VPC',
    landingZone: 'Workload',
    smallestSubnetPrefix: smallestSubnetPrefix('aws'),
    largestNetworkPrefix: AWS_LARGEST_PREFIX,
    hasExport: true,
  },
};

export interface RegionChoice {
  location: string;
  displayName: string;
  geography: string;
}

/** The cloud's regions, grouped by geography in list order. */
export function regionsByGeography(cloud: Cloud): [string, RegionChoice[]][] {
  const groups = new Map<string, RegionChoice[]>();
  for (const r of cloud === 'aws' ? AWS_REGIONS : AZURE_REGIONS) groups.set(r.geography, [...(groups.get(r.geography) ?? []), r]);
  return [...groups];
}

export const regionName = (cloud: Cloud, location: string) =>
  cloud === 'aws' ? awsRegionDisplayName(location) : regionDisplayName(location);

/** Short code used in planner names: eastus2 → eus2, us-east-1 → use1. */
export const regionShortCode = (cloud: Cloud, location: string) =>
  cloud === 'aws' ? awsRegionCode(location) : regionCode(location);

export const isKnownRegion = (cloud: Cloud, location: string) =>
  cloud === 'aws' ? !!findAwsRegion(location) : !!findRegion(location);

/** Azure's paired region, or the usual AWS disaster-recovery partner. */
export const partnerRegion = (cloud: Cloud, location: string): string | null =>
  cloud === 'aws' ? awsPartnerOf(location) : (findRegion(location)?.paired ?? null);

/** A new example plan for the cloud. */
export const newPlan = (cloud: Cloud): PlanSpec => (cloud === 'aws' ? awsDefaultPlan() : defaultPlan());

/** The next region to add to a plan: its location and layout follow the plan's cloud and last region. */
export function nextRegion(plan: PlanSpec): RegionSpec {
  if (cloudOf(plan) === 'aws') return makeAwsRegion(nextUnusedAwsLocation(plan));
  const last = plan.regions.at(-1);
  return makeRegion(nextUnusedLocation(plan), last?.topology ?? 'hub-spoke', last ? platformLayoutOf(last) : 'separate');
}

export const relocate = (cloud: Cloud, region: RegionSpec, location: string): RegionSpec =>
  cloud === 'aws' ? relocateAwsRegion(region, location) : relocateRegion(region, location);

/** The cloud's spoke templates, as [key, label, make] in menu order. */
export function spokeTemplates(cloud: Cloud): { key: string; label: string; make: (location: string) => VnetSpec }[] {
  const templates: Record<string, { label: string; make: (location: string) => VnetSpec }> =
    cloud === 'aws' ? AWS_SPOKE_TEMPLATES : SPOKE_TEMPLATES;
  return Object.entries(templates).map(([key, t]) => ({ key, ...t }));
}

/** Infrastructure subnets, drawn in the "special" colour: Azure's reserved-name subnets, AWS's TGW and firewall subnets. */
export const isSpecialSubnet = (cloud: Cloud, name: string) =>
  cloud === 'aws' ? isAwsInfrastructureSubnet(name) : !!presetForName(name);
