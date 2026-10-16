// AWS networking rules that affect address planning, and AWS regions.
// Sources: Amazon VPC user guide (VPC CIDR blocks, subnet sizing, secondary
// CIDR restrictions), Transit Gateway and Network Firewall design guidance.

import { type Cidr, contains, overlaps, parseCidr } from './ipv4';

/** AWS reserves the first four and the last address in every subnet. */
export const AWS_RESERVED_IPS = 5;

/** VPC CIDR blocks, and subnets, are /16 to /28. */
export const AWS_LARGEST_PREFIX = 16;
export const AWS_SMALLEST_PREFIX = 28;

/** A VPC has 5 CIDR blocks (one primary, four secondary) by default; the quota can be raised. */
export const AWS_DEFAULT_CIDR_BLOCKS = 5;

export interface AwsSubnetPreset {
  label: string;
  /** Subnet name, before the Availability Zone suffix (private → private-a). */
  name: string;
  defaultPrefix: number;
  note: string;
}

/** Subnet tiers of the AWS layout; each is usually created once per Availability Zone. */
export const AWS_SUBNET_PRESETS: AwsSubnetPreset[] = [
  { label: 'Public', name: 'public', defaultPrefix: 26, note: 'Load balancers and NAT gateways, routed to an internet gateway.' },
  { label: 'Private', name: 'private', defaultPrefix: 24, note: 'Workloads, with outbound internet through NAT or the egress VPC.' },
  { label: 'Data', name: 'data', defaultPrefix: 26, note: 'Databases and caches, no internet route.' },
  {
    label: 'Transit Gateway attachment',
    name: 'tgw',
    defaultPrefix: 28,
    note: 'Dedicated /28 per AZ for the Transit Gateway attachment, as AWS recommends.',
  },
  { label: 'Network Firewall', name: 'firewall', defaultPrefix: 28, note: 'AWS Network Firewall endpoints, one per AZ.' },
  { label: 'Interface endpoints', name: 'endpoints', defaultPrefix: 26, note: 'VPC interface endpoints and Route 53 Resolver endpoints.' },
];

/** Subnet tiers drawn in the "special" colour: infrastructure rather than workloads. */
export const isAwsInfrastructureSubnet = (name: string) => /^(tgw|firewall)(-|$)/i.test(name.trim());

const cidr = (s: string): Cidr => {
  const r = parseCidr(s);
  if (!r.ok) throw new Error(`bad constant ${s}`);
  return r.cidr;
};

/** Ranges AWS doesn't allow in a VPC. */
const AWS_FORBIDDEN: [Cidr, string][] = [
  [cidr('0.0.0.0/8'), 'this-network (0.0.0.0/8)'],
  [cidr('127.0.0.0/8'), 'loopback'],
  [cidr('169.254.0.0/16'), 'link-local (used by AWS for instance metadata and DNS)'],
  [cidr('224.0.0.0/4'), 'multicast'],
  [cidr('255.255.255.255/32'), 'broadcast'],
];

export function awsForbiddenOverlap(c: Cidr): string | null {
  return AWS_FORBIDDEN.find(([f]) => overlaps(f, c))?.[1] ?? null;
}

/** 172.17.0.0/16 is Docker's default bridge network, which some AWS services use. */
export const DOCKER_BRIDGE = cidr('172.17.0.0/16');

/**
 * AWS restricts which secondary CIDR blocks a VPC can add, by the range its
 * primary block is in: a VPC in one RFC 1918 block can't add another.
 * Returns why `secondary` isn't allowed, or null.
 */
export function awsSecondaryCidrError(primary: Cidr, secondary: Cidr): string | null {
  const blocks: [Cidr, string][] = [
    [cidr('10.0.0.0/8'), '10.0.0.0/8'],
    [cidr('172.16.0.0/12'), '172.16.0.0/12'],
    [cidr('192.168.0.0/16'), '192.168.0.0/16'],
  ];
  const home = blocks.find(([b]) => contains(b, primary));
  const other = blocks.find(([b]) => contains(b, secondary));
  if (home && other && home !== other)
    return `AWS doesn't allow a ${other[1]} secondary CIDR in a VPC whose primary CIDR is in ${home[1]}`;
  return null;
}

export interface AwsRegion {
  location: string;
  displayName: string;
  geography: string;
  /** Short code for names: us-east-1 → use1. */
  code: string;
  /** Availability Zones the planner's templates lay subnets out across (at most 3). */
  zones: string[];
}

const region = (location: string, displayName: string, geography: string, code: string, zones = 'abc'): AwsRegion => ({
  location,
  displayName,
  geography,
  code,
  zones: [...zones],
});

/** Commercial AWS regions. us-west-1 offers new accounts two Availability Zones. */
export const AWS_REGIONS: AwsRegion[] = [
  region('us-east-1', 'US East (N. Virginia)', 'United States', 'use1'),
  region('us-east-2', 'US East (Ohio)', 'United States', 'use2'),
  region('us-west-1', 'US West (N. California)', 'United States', 'usw1', 'ab'),
  region('us-west-2', 'US West (Oregon)', 'United States', 'usw2'),
  region('ca-central-1', 'Canada (Central)', 'Canada', 'cac1'),
  region('ca-west-1', 'Canada West (Calgary)', 'Canada', 'caw1'),
  region('mx-central-1', 'Mexico (Central)', 'Mexico', 'mxc1'),
  region('sa-east-1', 'South America (São Paulo)', 'South America', 'sae1'),
  region('eu-west-1', 'Europe (Ireland)', 'Europe', 'euw1'),
  region('eu-west-2', 'Europe (London)', 'Europe', 'euw2'),
  region('eu-west-3', 'Europe (Paris)', 'Europe', 'euw3'),
  region('eu-central-1', 'Europe (Frankfurt)', 'Europe', 'euc1'),
  region('eu-central-2', 'Europe (Zurich)', 'Europe', 'euc2'),
  region('eu-north-1', 'Europe (Stockholm)', 'Europe', 'eun1'),
  region('eu-south-1', 'Europe (Milan)', 'Europe', 'eus1'),
  region('eu-south-2', 'Europe (Spain)', 'Europe', 'eus2'),
  region('il-central-1', 'Israel (Tel Aviv)', 'Middle East', 'ilc1'),
  region('me-south-1', 'Middle East (Bahrain)', 'Middle East', 'mes1'),
  region('me-central-1', 'Middle East (UAE)', 'Middle East', 'mec1'),
  region('af-south-1', 'Africa (Cape Town)', 'Africa', 'afs1'),
  region('ap-east-1', 'Asia Pacific (Hong Kong)', 'Asia Pacific', 'ape1'),
  region('ap-east-2', 'Asia Pacific (Taipei)', 'Asia Pacific', 'ape2'),
  region('ap-south-1', 'Asia Pacific (Mumbai)', 'Asia Pacific', 'aps1'),
  region('ap-south-2', 'Asia Pacific (Hyderabad)', 'Asia Pacific', 'aps2'),
  region('ap-northeast-1', 'Asia Pacific (Tokyo)', 'Asia Pacific', 'apne1', 'acd'),
  region('ap-northeast-2', 'Asia Pacific (Seoul)', 'Asia Pacific', 'apne2'),
  region('ap-northeast-3', 'Asia Pacific (Osaka)', 'Asia Pacific', 'apne3'),
  region('ap-southeast-1', 'Asia Pacific (Singapore)', 'Asia Pacific', 'apse1'),
  region('ap-southeast-2', 'Asia Pacific (Sydney)', 'Asia Pacific', 'apse2'),
  region('ap-southeast-3', 'Asia Pacific (Jakarta)', 'Asia Pacific', 'apse3'),
  region('ap-southeast-4', 'Asia Pacific (Melbourne)', 'Asia Pacific', 'apse4'),
  region('ap-southeast-5', 'Asia Pacific (Malaysia)', 'Asia Pacific', 'apse5'),
  region('ap-southeast-7', 'Asia Pacific (Thailand)', 'Asia Pacific', 'apse7'),
];

export const findAwsRegion = (location: string) => AWS_REGIONS.find((r) => r.location === location);

export const awsRegionCode = (location: string) => findAwsRegion(location)?.code ?? location;

export const awsRegionDisplayName = (location: string) => findAwsRegion(location)?.displayName ?? location;
