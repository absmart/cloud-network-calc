import { describe, expect, it } from 'vitest';
import { AWS_SPOKE_TEMPLATES, awsDefaultPlan, makeAwsRegion, nextUnusedAwsLocation, relocateAwsRegion } from './awsDefaults';
import { awsSecondaryCidrError } from './aws';
import { CLOUDS, cloudOf, newPlan, nextRegion, regionsByGeography } from './cloud';
import { defaultPlan } from './defaults';
import { formatCidr } from './ipv4';
import { type PlanSpec, computePlan, countIssues } from './planner';
import { DEFAULT_NAMING } from './naming';
import { decodeDesign, encodeDesign } from './shareLink';
import { prefixForHosts } from './sizing';

const messages = (plan: PlanSpec, spoke: number) =>
  computePlan(plan).regions[0].spokes[spoke].issues.map((i) => i.message);

describe('AWS plans', () => {
  it('start from a Transit Gateway layout that has no issues', () => {
    const plan = awsDefaultPlan();
    expect(cloudOf(plan)).toBe('aws');
    expect(cloudOf(defaultPlan())).toBe('azure');
    const result = computePlan(plan);
    expect(countIssues(result)).toEqual({ errors: 0, warnings: 0 });
    expect(result.regions.map((r) => `${r.name} ${formatCidr(r.cidr!)}`)).toEqual([
      'US East (N. Virginia) 10.0.0.0/16',
      'US West (Oregon) 10.1.0.0/16',
    ]);
    const [use1] = result.regions;
    expect([use1.hub, ...use1.spokes].map((v) => `${v.name} ${formatCidr(v.cidr!)}`)).toEqual([
      'inspection-use1-vpc 10.0.0.0/24',
      'egress-use1-vpc 10.0.1.0/24',
      'endpoints-use1-vpc 10.0.2.0/24',
      'workload-use1-001-vpc 10.0.4.0/22',
    ]);
    // Every tier once per Availability Zone, with a /28 per AZ for the Transit Gateway attachment.
    expect(use1.spokes[2].subnets.map((s) => `${s.name} ${formatCidr(s.cidr!)}`)).toEqual([
      'private-a 10.0.4.0/24',
      'private-b 10.0.5.0/24',
      'private-c 10.0.6.0/24',
      'data-a 10.0.7.0/26',
      'data-b 10.0.7.64/26',
      'data-c 10.0.7.128/26',
      'tgw-a 10.0.7.192/28',
      'tgw-b 10.0.7.208/28',
      'tgw-c 10.0.7.224/28',
    ]);
    expect(use1.hub.subnets.map((s) => s.name)).toEqual(['tgw-a', 'tgw-b', 'tgw-c', 'firewall-a', 'firewall-b', 'firewall-c']);
  });

  it('use only the Availability Zones a region offers', () => {
    expect(makeAwsRegion('us-west-1').hub.subnets.map((s) => s.name)).toEqual(['tgw-a', 'tgw-b', 'firewall-a', 'firewall-b']);
    const plan: PlanSpec = { ...awsDefaultPlan(), regions: [makeAwsRegion('us-west-1')] };
    expect(countIssues(computePlan(plan)).errors).toBe(0);
    // Every template fits its VPC in a three-zone region.
    for (const t of Object.values(AWS_SPOKE_TEMPLATES)) {
      const p: PlanSpec = { ...awsDefaultPlan(), regions: [{ ...makeAwsRegion('us-east-1'), spokes: [t.make('us-east-1')] }] };
      expect(countIssues(computePlan(p))).toEqual({ errors: 0, warnings: 0 });
    }
  });

  it('keep VPC CIDR blocks between /16 and /28, and subnets /28 or larger', () => {
    const plan = awsDefaultPlan();
    plan.regions[0].prefix = 15;
    plan.root = '10.0.0.0/12';
    plan.regions[0].spokes[2].prefix = 16;
    plan.regions[0].spokes[0].prefix = 29;
    plan.regions[0].spokes[1].subnets.push({ id: 'x', name: 'tiny', prefix: 29 });
    expect(messages(plan, 2)).not.toContain('AWS VPC CIDR blocks can be at most a /16; add secondary CIDRs for more space');
    plan.regions[0].spokes[2].prefix = 15;
    expect(messages(plan, 2)).toContain('AWS VPC CIDR blocks can be at most a /16; add secondary CIDRs for more space');
    expect(messages(plan, 0)).toContain('AWS VPC CIDR blocks must be /28 or larger');
    const tiny = computePlan(plan).regions[0].spokes[1].subnets.find((s) => s.name === 'tiny')!;
    expect(tiny.issues.map((i) => i.message)).toContain('AWS subnets must be /28 or larger');
  });

  it('enforce the secondary CIDR rules and quota, and warn about the Docker bridge range', () => {
    const block = (s: string) => {
      const [base, prefix] = s.split('/');
      return { base: base.split('.').reduce((n, o) => n * 256 + Number(o), 0), prefix: Number(prefix) };
    };
    expect(awsSecondaryCidrError(block('10.0.0.0/16'), block('192.168.0.0/24'))).toMatch(/192\.168\.0\.0\/16 secondary/);
    expect(awsSecondaryCidrError(block('172.20.0.0/16'), block('10.1.0.0/24'))).toMatch(/10\.0\.0\.0\/8 secondary/);
    expect(awsSecondaryCidrError(block('192.168.0.0/20'), block('172.16.0.0/24'))).toMatch(/172\.16\.0\.0\/12 secondary/);
    expect(awsSecondaryCidrError(block('10.0.0.0/16'), block('100.64.0.0/24'))).toBeNull();
    expect(awsSecondaryCidrError(block('10.0.0.0/16'), block('10.9.0.0/24'))).toBeNull();

    // In a plan: a region wide enough to hold both private blocks.
    const plan = awsDefaultPlan();
    plan.root = '0.0.0.0/0';
    plan.regions = [{ ...plan.regions[0], fixed: '0.0.0.0/0', prefix: 0 }];
    const vpc = plan.regions[0].spokes[2];
    vpc.fixed = '10.0.4.0/22';
    vpc.ranges = [{ prefix: 24, fixed: '172.20.0.0/24' }, { prefix: 24, fixed: '100.64.0.0/24' }];
    expect(messages(plan, 2)).toEqual([
      "AWS doesn't allow a 172.16.0.0/12 secondary CIDR in a VPC whose primary CIDR is in 10.0.0.0/8",
    ]);
    vpc.ranges = [1, 2, 3, 4, 5].map((n) => ({ prefix: 24, fixed: `10.0.${200 + n}.0/24` }));
    expect(messages(plan, 2)).toEqual(['A VPC has 5 CIDR blocks by default; 6 needs a quota increase']);
    vpc.ranges = [{ prefix: 24, fixed: '172.17.0.0/24' }];
    expect(messages(plan, 2)).toEqual([
      "AWS doesn't allow a 172.16.0.0/12 secondary CIDR in a VPC whose primary CIDR is in 10.0.0.0/8",
      "Overlaps 172.17.0.0/16, Docker's default bridge network, which some AWS services use",
    ]);
  });

  it("don't apply Azure's reserved subnet names or Virtual WAN rules", () => {
    const plan = awsDefaultPlan();
    plan.regions[0].spokes[2].subnets.push({ id: 'g', name: 'GatewaySubnet', prefix: 28 });
    plan.regions[0].topology = 'vwan';
    const result = computePlan(plan);
    expect(result.regions[0].hub.kind).toBe('hub');
    expect(countIssues(result)).toEqual({ errors: 0, warnings: 0 });
  });

  it('size subnets for hosts with the /28 minimum', () => {
    expect([0, 11, 12, 59].map((h) => prefixForHosts(h, 'aws'))).toEqual([28, 28, 27, 26]);
    expect(CLOUDS.aws.smallestSubnetPrefix).toBe(28);
  });

  it('add regions in us-east-1, then its usual partner, then the same geography', () => {
    const plan: PlanSpec = { ...awsDefaultPlan(), regions: [] };
    expect(nextUnusedAwsLocation(plan)).toBe('us-east-1');
    plan.regions.push(makeAwsRegion('us-east-1'));
    expect(nextUnusedAwsLocation(plan)).toBe('us-west-2');
    plan.regions.push(makeAwsRegion('us-west-2'));
    expect(nextUnusedAwsLocation(plan)).toBe('us-east-2');
    expect(nextRegion(plan).location).toBe('us-east-2');
    expect(nextRegion(defaultPlan()).location).not.toMatch(/^us-/);
    expect(regionsByGeography('aws')[0]).toEqual(['United States', expect.arrayContaining([expect.objectContaining({ location: 'us-east-1' })])]);
  });

  it('rename VPCs when a region moves', () => {
    const moved = relocateAwsRegion(makeAwsRegion('us-east-1'), 'eu-west-1');
    expect(moved.name).toBe('Europe (Ireland)');
    expect([moved.hub, ...moved.spokes].map((v) => v.name)).toEqual([
      'inspection-euw1-vpc',
      'egress-euw1-vpc',
      'endpoints-euw1-vpc',
      'workload-euw1-001-vpc',
    ]);
  });

  it('start new plans in the chosen cloud, and keep it through share links', async () => {
    expect(newPlan('aws').cloud).toBe('aws');
    expect(newPlan('azure').cloud).toBeUndefined();
    const shared = await decodeDesign(await encodeDesign(awsDefaultPlan(), DEFAULT_NAMING));
    expect(cloudOf(shared.plan)).toBe('aws');
    expect(countIssues(computePlan(shared.plan))).toEqual({ errors: 0, warnings: 0 });
  });
});
