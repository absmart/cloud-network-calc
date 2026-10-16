// Starting layout for AWS plans, after the network design of AWS's Landing
// Zone Accelerator and Security Reference Architecture: per region, a Transit
// Gateway hub with a central inspection VPC (Network Firewall), an egress VPC,
// a shared interface endpoints VPC, and workload VPCs. Every VPC lays its
// subnets out once per Availability Zone, with a dedicated /28 per AZ for its
// Transit Gateway attachment.

import { AWS_REGIONS, awsRegionCode, awsRegionDisplayName, findAwsRegion } from './aws';
import { newId, placed, relocateRegion, vnet } from './defaults';
import { blockSize } from './ipv4';
import type { PlanSpec, RegionSpec, SubnetSpec, VnetSpec } from './planner';

/** Availability Zone letters the templates use in a region (up to three). */
export const awsZones = (location: string) => findAwsRegion(location)?.zones ?? ['a', 'b', 'c'];

/** One subnet of a tier per Availability Zone (private-a, private-b, ...), side by side from `start`. */
const perZone = (location: string, tier: string, prefix: number, start: number): SubnetSpec[] =>
  awsZones(location).map((zone, i) => placed(`${tier}-${zone}`, prefix, start + i * blockSize(prefix)));

/** The region's hub: the inspection VPC, with Transit Gateway attachment and Network Firewall subnets. */
export const makeAwsHub = (location: string): VnetSpec =>
  vnet(`inspection-${awsRegionCode(location)}-vpc`, 24, [
    ...perZone(location, 'tgw', 28, 0),
    ...perZone(location, 'firewall', 28, 64),
  ]);

export type AwsSpokeTemplate = 'egress' | 'endpoints' | 'workload' | 'workload-public' | 'empty';

export const AWS_SPOKE_TEMPLATES: Record<AwsSpokeTemplate, { label: string; make: (location: string) => VnetSpec }> = {
  egress: {
    label: 'Egress VPC (/24): public subnets for NAT gateways',
    make: (loc) =>
      vnet(`egress-${awsRegionCode(loc)}-vpc`, 24, [...perZone(loc, 'public', 26, 0), ...perZone(loc, 'tgw', 28, 192)], 'egress'),
  },
  endpoints: {
    label: 'Shared endpoints VPC (/24): interface endpoints, Route 53 Resolver',
    make: (loc) =>
      vnet(
        `endpoints-${awsRegionCode(loc)}-vpc`,
        24,
        [...perZone(loc, 'endpoints', 26, 0), ...perZone(loc, 'tgw', 28, 192)],
        'endpoints',
      ),
  },
  workload: {
    label: 'Workload VPC (/22): private and data subnets',
    make: (loc) =>
      vnet(
        `workload-${awsRegionCode(loc)}-001-vpc`,
        22,
        [...perZone(loc, 'private', 24, 0), ...perZone(loc, 'data', 26, 768), ...perZone(loc, 'tgw', 28, 960)],
        'landing-zone',
      ),
  },
  'workload-public': {
    label: 'Internet-facing workload VPC (/22): public and private subnets',
    make: (loc) =>
      vnet(
        `web-${awsRegionCode(loc)}-001-vpc`,
        22,
        [...perZone(loc, 'public', 26, 0), ...perZone(loc, 'tgw', 28, 192), ...perZone(loc, 'private', 24, 256)],
        'landing-zone',
      ),
  },
  empty: {
    label: 'Empty VPC (/24)',
    make: (loc) => vnet(`spoke-${awsRegionCode(loc)}-vpc`, 24, [], 'landing-zone'),
  },
};

export function makeAwsRegion(location: string): RegionSpec {
  return {
    id: newId(),
    name: awsRegionDisplayName(location),
    location,
    prefix: 16,
    topology: 'hub-spoke',
    hub: makeAwsHub(location),
    spokes: (['egress', 'endpoints', 'workload'] as const).map((t) => AWS_SPOKE_TEMPLATES[t].make(location)),
  };
}

export const FIRST_AWS_REGION = 'us-east-1';

/**
 * Common disaster-recovery partners. AWS has no region pairs of its own, so
 * these are conventions: the other US coast, a neighbour in Europe or Asia.
 */
const AWS_PARTNERS: Record<string, string> = {
  'us-east-1': 'us-west-2',
  'us-west-2': 'us-east-1',
  'us-east-2': 'us-west-2',
  'us-west-1': 'us-east-1',
  'ca-central-1': 'ca-west-1',
  'ca-west-1': 'ca-central-1',
  'eu-west-1': 'eu-central-1',
  'eu-central-1': 'eu-west-1',
  'eu-west-2': 'eu-west-1',
  'eu-west-3': 'eu-central-1',
  'eu-north-1': 'eu-central-1',
  'ap-southeast-1': 'ap-northeast-1',
  'ap-northeast-1': 'ap-northeast-3',
  'ap-northeast-3': 'ap-northeast-1',
  'ap-southeast-2': 'ap-southeast-4',
  'ap-southeast-4': 'ap-southeast-2',
  'ap-south-1': 'ap-south-2',
  'ap-south-2': 'ap-south-1',
};

export const awsPartnerOf = (location: string) => AWS_PARTNERS[location] ?? null;

/**
 * The location for the next AWS region: us-east-1 first, then the DR partner
 * of the latest region, else another region in the same geography, else any.
 */
export function nextUnusedAwsLocation(plan: PlanSpec): string {
  const used = new Set(plan.regions.map((r) => r.location));
  const free = (location: string | null | undefined): location is string =>
    !!location && !used.has(location) && !!findAwsRegion(location);
  if (plan.regions.length === 0 && free(FIRST_AWS_REGION)) return FIRST_AWS_REGION;
  const existing = [...plan.regions].reverse().map((r) => findAwsRegion(r.location));
  for (const r of existing) if (r && free(awsPartnerOf(r.location))) return awsPartnerOf(r.location)!;
  const geography = existing.find(Boolean)?.geography;
  const candidates = AWS_REGIONS.filter((r) => free(r.location));
  return (candidates.find((r) => r.geography === geography) ?? candidates[0])?.location ?? FIRST_AWS_REGION;
}

export const relocateAwsRegion = (region: RegionSpec, location: string) =>
  relocateRegion(region, location, awsRegionCode, awsRegionDisplayName);

export function awsDefaultPlan(): PlanSpec {
  return {
    version: 1,
    name: 'Example AWS network',
    cloud: 'aws',
    // A /12 has room for 16 regional /16s.
    root: '10.0.0.0/12',
    regions: [makeAwsRegion(FIRST_AWS_REGION), makeAwsRegion('us-west-2')],
  };
}
