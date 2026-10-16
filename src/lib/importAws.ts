// Import an existing AWS network (VPCs, subnets, Transit Gateways and their VPC
// attachments) from AWS CLI output, and turn it into an AWS plan. As with the
// Azure importer, everything is pinned where it is, so the planner checks the
// real network against AWS's rules.

import { awsRegionDisplayName } from './aws';
import { newId } from './defaults';
import { type ImportNote, hasMorePages, parseDocuments, regionBlocks } from './importAzure';
import { type Cidr, contains, formatCidr, parseCidr, supernet } from './ipv4';
import type { PlanSpec, RegionSpec, SubnetSpec, VnetRole, VnetSpec } from './planner';

const EACH_REGION = (part: string, query: string) =>
  `\\"${part}\\":$(aws ec2 describe-${query} --region $r --query ${part} --output json)`;

/** Commands that export an AWS network in a shape `importAwsNetwork` reads. */
export const AWS_IMPORT_COMMANDS: { id: string; label: string; scope: string; command: string; hint?: string }[] = [
  {
    id: 'all-regions',
    label: 'AWS CloudShell (bash)',
    scope: 'every region of the account you are signed in to',
    command:
      `for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do echo "{\\"Region\\":\\"$r\\",` +
      [
        EACH_REGION('Vpcs', 'vpcs'),
        EACH_REGION('Subnets', 'subnets'),
        EACH_REGION('TransitGateways', 'transit-gateways'),
        EACH_REGION('TransitGatewayVpcAttachments', 'transit-gateway-vpc-attachments'),
      ].join(',') +
      '}"; done',
    hint: 'Run it once per account, and paste every output together.',
  },
  {
    id: 'powershell',
    label: 'PowerShell (AWS CLI)',
    scope: 'every region of the account you are signed in to',
    command:
      "foreach ($r in (aws ec2 describe-regions --query 'Regions[].RegionName' --output text).Split()) { [pscustomobject]@{ Region = $r; " +
      [
        ['Vpcs', 'vpcs'],
        ['Subnets', 'subnets'],
        ['TransitGateways', 'transit-gateways'],
        ['TransitGatewayVpcAttachments', 'transit-gateway-vpc-attachments'],
      ]
        .map(([part, query]) => `${part} = @(aws ec2 describe-${query} --region $r --query ${part} --output json | ConvertFrom-Json)`)
        .join('; ') +
      ' } | ConvertTo-Json -Depth 10 }',
    hint: 'Run it once per account, and paste every output together.',
  },
  {
    id: 'one-region',
    label: 'AWS CLI, one region',
    scope: 'the current region',
    command:
      'aws ec2 describe-vpcs --output json; aws ec2 describe-subnets --output json; aws ec2 describe-transit-gateways --output json; aws ec2 describe-transit-gateway-vpc-attachments --output json',
    hint: 'Add --region <region> to each command for another region.',
  },
];

export interface AwsImport {
  plan: PlanSpec;
  notes: ImportNote[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
/** A resource's Name tag, or ''. */
function nameTag(o: unknown): string {
  if (!isObject(o)) return '';
  const tag = list(o.Tags).find((t): t is Json => isObject(t) && text(t.Key) === 'Name');
  return tag ? text(tag.Value) : '';
}

/** The region of a resource from its ARN (arn:aws:ec2:us-east-1:...), if it has one. */
const regionOfArn = (arn: string) => arn.split(':')[3] || '';

export interface FoundVpc {
  id: string;
  name: string;
  owner: string;
  region: string;
  cidrs: Cidr[];
}

export interface FoundSubnet {
  vpc: string;
  name: string;
  cidr: Cidr;
  /** Availability Zone, such as us-east-1a; empty if not given. */
  zone: string;
  region: string;
}

/**
 * Turn AWS CLI output into an AWS plan. Accepts the AWS_IMPORT_COMMANDS
 * output, plain `aws ec2 describe-vpcs` / `describe-subnets` /
 * `describe-transit-gateways` / `describe-transit-gateway-vpc-attachments`
 * output, or several of these pasted together. Default VPCs are skipped.
 * Throws with a readable message if no VPCs are found.
 */
export function importAwsNetwork(input: string, name = 'Imported AWS network'): AwsImport {
  const { vpcs, subnets, transitGateways, attached, notes } = readAwsNetwork(input);
  const tgwCount = transitGateways.length;
  return buildPlan(vpcs, subnets, attached, tgwCount, notes, name);
}

export interface AwsTransitGatewayFound {
  id: string;
  name: string;
  region: string;
  owner: string;
}

/**
 * The VPCs (non-default, keyed by VPC ID), subnets, Transit Gateways and
 * attachments (VPC ID → appliance mode) in AWS CLI output, with notes on
 * anything skipped. Throws if there are no VPCs.
 */
export function readAwsNetwork(input: string): {
  vpcs: Map<string, FoundVpc>;
  subnets: FoundSubnet[];
  transitGateways: AwsTransitGatewayFound[];
  attached: Map<string, { appliance: boolean }>;
  notes: ImportNote[];
} {
  const { docs, skippedText } = parseDocuments(input);
  const notes: ImportNote[] = [];
  if (skippedText) notes.push({ level: 'info', message: 'Text that isn’t JSON (such as CLI messages) was skipped' });
  if (docs.some(hasMorePages))
    notes.push({ level: 'warning', message: 'The output is only the first page (it has a NextToken); run the command without paging' });

  // Every document, and every region wrapper inside an array, read into flat lists.
  const vpcItems: { item: unknown; region: string }[] = [];
  const subnetItems: { item: unknown; region: string }[] = [];
  const tgwItems: { item: unknown; region: string }[] = [];
  const attachmentItems: { item: unknown; region: string }[] = [];
  const visit = (doc: unknown, region = '') => {
    if (Array.isArray(doc)) return doc.forEach((d) => visit(d, region));
    if (!isObject(doc)) return;
    const here = text(doc.Region) || region;
    for (const v of list(doc.Vpcs)) vpcItems.push({ item: v, region: here });
    for (const s of list(doc.Subnets)) subnetItems.push({ item: s, region: here });
    for (const t of list(doc.TransitGateways)) tgwItems.push({ item: t, region: here });
    for (const a of [...list(doc.TransitGatewayVpcAttachments), ...list(doc.TransitGatewayAttachments)])
      attachmentItems.push({ item: a, region: here });
  };
  docs.forEach((d) => visit(d));

  const cidr = (s: unknown): Cidr | null => {
    const parsed = parseCidr(text(s));
    return parsed.ok ? parsed.cidr : null;
  };

  const subnets: FoundSubnet[] = subnetItems.flatMap(({ item, region }) => {
    if (!isObject(item)) return [];
    const c = cidr(item.CidrBlock);
    if (!c) return [];
    const zone = text(item.AvailabilityZone);
    return [
      {
        vpc: text(item.VpcId),
        name: nameTag(item) || text(item.SubnetId) || 'subnet',
        cidr: c,
        zone,
        region: region || regionOfArn(text(item.SubnetArn)) || zone.replace(/[a-z]$/, ''),
      },
    ];
  });

  let defaults = 0;
  const vpcs = new Map<string, FoundVpc>();
  for (const { item, region } of vpcItems) {
    if (!isObject(item)) continue;
    const id = text(item.VpcId);
    if (!id || vpcs.has(id)) continue;
    if (item.IsDefault === true) {
      defaults++;
      continue;
    }
    const associated = list(item.CidrBlockAssociationSet)
      .filter((a) => isObject(a) && (!isObject(a.CidrBlockState) || ['associated', 'associating'].includes(text(a.CidrBlockState.State))))
      .map((a) => cidr((a as Json).CidrBlock))
      .filter((c): c is Cidr => c !== null);
    const primary = cidr(item.CidrBlock);
    const cidrs = primary ? [primary, ...associated.filter((c) => formatCidr(c) !== formatCidr(primary))] : associated;
    const vpcRegion = region || subnets.find((s) => s.vpc === id)?.region || '';
    const vpcName = nameTag(item) || id;
    if (cidrs.length === 0) {
      notes.push({ level: 'warning', message: `${vpcName} has no IPv4 CIDR block and was left out` });
      continue;
    }
    if (!vpcRegion) {
      notes.push({ level: 'warning', message: `${vpcName} was left out: its region isn't known (it has no subnets; use the all-regions command)` });
      continue;
    }
    vpcs.set(id, { id, name: vpcName, owner: text(item.OwnerId), region: vpcRegion, cidrs });
  }
  if (defaults) notes.push({ level: 'info', message: `${defaults} default VPC${defaults === 1 ? '' : 's'} skipped` });
  if (vpcs.size === 0) throw new Error('No VPCs were found (default VPCs are skipped).');

  // Attachments say which VPCs are on a Transit Gateway, and which uses appliance mode (the inspection VPC).
  const attached = new Map<string, { appliance: boolean }>();
  for (const { item } of attachmentItems) {
    if (!isObject(item) || (text(item.ResourceType) && text(item.ResourceType) !== 'vpc')) continue;
    const vpc = text(item.VpcId) || text(item.ResourceId);
    const appliance = isObject(item.Options) && text(item.Options.ApplianceModeSupport) === 'enable';
    if (vpc) attached.set(vpc, { appliance: appliance || attached.get(vpc)?.appliance === true });
  }

  const transitGateways = new Map<string, AwsTransitGatewayFound>();
  for (const { item, region } of tgwItems) {
    if (!isObject(item)) continue;
    const id = text(item.TransitGatewayId);
    if (!id || transitGateways.has(id)) continue;
    transitGateways.set(id, {
      id,
      name: nameTag(item) || id,
      region: region || regionOfArn(text(item.TransitGatewayArn)),
      owner: text(item.OwnerId),
    });
  }
  return { vpcs, subnets, transitGateways: [...transitGateways.values()], attached, notes };
}

/** The plan for what readAwsNetwork found: one region per AWS region, its inspection VPC as the hub. */
function buildPlan(
  vpcs: Map<string, FoundVpc>,
  subnets: FoundSubnet[],
  attached: Map<string, { appliance: boolean }>,
  tgwCount: number,
  notes: ImportNote[],
  name: string,
): AwsImport {
  const roleOf =(v: FoundVpc): VnetRole =>
    /egress/i.test(v.name) ? 'egress' : /endpoint/i.test(v.name) ? 'endpoints' : 'landing-zone';

  const toVpcSpec = (v: FoundVpc, isHub: boolean): VnetSpec => {
    const own = subnets.filter((s) => s.vpc === v.id);
    const outside = own.filter((s) => !v.cidrs.some((c) => contains(c, s.cidr)));
    if (outside.length)
      notes.push({ level: 'warning', message: `${v.name}: ${outside.map((s) => s.name).join(', ')} outside its CIDR blocks, left out` });
    return {
      id: newId(),
      name: v.name,
      ...(!isHub && { role: roleOf(v) }),
      prefix: v.cidrs[0].prefix,
      fixed: formatCidr(v.cidrs[0]),
      ...(v.cidrs.length > 1 && { ranges: v.cidrs.slice(1).map((c) => ({ prefix: c.prefix, fixed: formatCidr(c) })) }),
      ...(v.owner && { subscription: v.owner }),
      subnets: own
        .filter((s) => !outside.includes(s))
        .map((s): SubnetSpec => {
          const k = v.cidrs.findIndex((c) => contains(c, s.cidr));
          return { id: newId(), name: s.name, prefix: s.cidr.prefix, offset: s.cidr.base - v.cidrs[k].base, ...(k > 0 && { range: k }) };
        }),
    };
  };

  // One region per AWS region; its hub is the inspection VPC.
  const byRegion = new Map<string, FoundVpc[]>();
  for (const v of vpcs.values()) byRegion.set(v.region, [...(byRegion.get(v.region) ?? []), v]);
  const blocks = regionBlocks(new Map([...byRegion].map(([region, list]) => [region, list.flatMap((v) => v.cidrs)])));

  const regions: { block: Cidr; region: RegionSpec }[] = [...byRegion].map(([location, found]) => {
    found.sort((a, b) => a.cidrs[0].base - b.cidrs[0].base);
    const looksLikeInspection = (v: FoundVpc) =>
      /inspection/i.test(v.name) || subnets.some((s) => s.vpc === v.id && /firewall/i.test(s.name));
    const hub =
      found.find((v) => attached.get(v.id)?.appliance) ?? found.find(looksLikeInspection) ?? found[0];
    const display = awsRegionDisplayName(location);
    // A region always has a hub; without an inspection VPC, another VPC takes its place.
    if (!attached.get(hub.id)?.appliance && !looksLikeInspection(hub))
      notes.push({ level: 'warning', message: `${display}: no inspection VPC found; ${hub.name} is shown in the hub's place` });
    const unattached = found.filter((v) => !attached.has(v.id));
    if (attached.size && unattached.length)
      notes.push({ level: 'info', message: `${display}: not attached to a Transit Gateway: ${unattached.map((v) => v.name).join(', ')}` });
    return {
      block: blocks.get(location)!,
      region: {
        id: newId(),
        name: display,
        location,
        prefix: 0,
        topology: 'hub-spoke' as const,
        hub: toVpcSpec(hub, true),
        spokes: found.filter((v) => v !== hub).map((v) => toVpcSpec(v, false)),
      },
    };
  });
  regions.sort((a, b) => a.block.base - b.block.base);
  const root = supernet(regions.map((r) => r.block));

  const accounts = new Set([...vpcs.values()].map((v) => v.owner).filter(Boolean));
  notes.unshift({
    level: 'info',
    message:
      `Imported ${vpcs.size} VPC${vpcs.size === 1 ? '' : 's'}` +
      (tgwCount ? ` and ${tgwCount} Transit Gateway${tgwCount === 1 ? '' : 's'}` : '') +
      ` in ${regions.length} region${regions.length === 1 ? '' : 's'}` +
      (accounts.size > 1 ? ` across ${accounts.size} accounts` : '') +
      `; root range ${formatCidr(root)}`,
  });

  return {
    plan: {
      version: 1,
      cloud: 'aws',
      name,
      root: formatCidr(root),
      regions: regions.map(({ block, region }) => ({ ...region, prefix: block.prefix, fixed: formatCidr(block) })),
    },
    notes,
  };
}
