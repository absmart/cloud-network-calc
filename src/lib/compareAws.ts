// Compare an AWS plan with what is deployed: the AWS CLI output the importer
// reads, checked against the AWS export model (the plan as it would deploy).

import type { AwsModel } from './awsIac';
import { type Comparison, type DeployedSide, type Side, compareSides, lower, rangeAndSubnetDifferences } from './compare';
import { readAwsNetwork } from './importAws';
import { formatCidr } from './ipv4';
import { isAccountId } from './placement';

interface AwsSide extends Side {
  /** Planned: an account key or ID; deployed: the account ID. */
  account: string;
  /** Planned: whether the export attaches it to a Transit Gateway; deployed: whether it is attached. */
  attached: boolean;
}

function plannedSides(model: AwsModel): AwsSide[] {
  return [
    ...model.vpcs.map(
      (v): AwsSide => ({
        name: v.plannerName,
        exportedName: v.name,
        names: lower([v.name, v.plannerName]),
        kind: 'vpc',
        location: v.region,
        account: v.account,
        attached: v.transitGateway !== null,
        prefixes: v.cidrs,
        subnets: v.subnets.map((s) => ({ name: s.plannerName, names: lower([s.name, s.plannerName]), prefix: s.cidr, zone: s.zone })),
      }),
    ),
    ...model.transitGateways.map(
      (t): AwsSide => ({
        name: t.name,
        exportedName: t.name,
        names: lower([t.name]),
        kind: 'transit-gateway',
        location: t.region,
        account: t.account,
        attached: false,
        prefixes: [],
        subnets: [],
      }),
    ),
  ];
}

function awsDifferences(planned: AwsSide, deployed: AwsSide): string[] {
  const out: string[] = [];
  if (planned.location !== deployed.location) out.push(`Region: planned ${planned.location}, AWS has ${deployed.location}`);
  // An account key (like "network") can't be checked; a 12-digit account ID can.
  if (isAccountId(planned.account) && deployed.account && planned.account !== deployed.account)
    out.push(`Account: planned ${planned.account}, AWS has ${deployed.account}`);
  if (planned.kind === 'vpc') {
    if (planned.attached && !deployed.attached) out.push("Not attached to a Transit Gateway in AWS");
    if (!planned.attached && deployed.attached) out.push('AWS attaches it to a Transit Gateway; the plan has no tgw-* subnets for one');
  }
  return [...out, ...rangeAndSubnetDifferences(planned, deployed, 'AWS', 'CIDR block')];
}

/**
 * Compare an AWS plan (as its export model, so names are the exported Name
 * tags) with AWS CLI output. VPCs are matched by Name tag or planner name,
 * then by overlapping CIDR blocks in the same region; Transit Gateways by
 * Name tag, then by region. Throws, like the importer, if there are no VPCs.
 */
export function compareWithAws(model: AwsModel, input: string): Comparison {
  const { vpcs, subnets, transitGateways, attached, notes } = readAwsNetwork(input);
  const deployed: (AwsSide & DeployedSide)[] = [
    ...[...vpcs.values()].map((v) => ({
      id: v.id,
      group: v.owner,
      account: v.owner,
      attached: attached.has(v.id),
      name: v.name,
      names: lower([v.name, v.id]),
      kind: 'vpc' as const,
      location: v.region,
      prefixes: v.cidrs.map(formatCidr),
      subnets: subnets
        .filter((s) => s.vpc === v.id)
        .map((s) => ({ name: s.name, names: lower([s.name]), prefix: formatCidr(s.cidr), zone: s.zone || null })),
    })),
    ...transitGateways.map((t) => ({
      id: t.id,
      group: t.owner,
      account: t.owner,
      attached: false,
      name: t.name,
      names: lower([t.name, t.id]),
      kind: 'transit-gateway' as const,
      location: t.region,
      prefixes: [],
      subnets: [],
    })),
  ];
  return compareSides(plannedSides(model), deployed, awsDifferences, notes, model.omitted);
}
