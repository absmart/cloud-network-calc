import { describe, expect, it } from 'vitest';
import { AWS_IMPORT_COMMANDS, importAwsNetwork } from './importAws';
import { formatCidr } from './ipv4';
import { computePlan, countIssues } from './planner';

const tags = (name: string) => [{ Key: 'Name', Value: name }];
const vpc = (id: string, name: string, cidrs: string[], owner = '111111111111', extra: object = {}) => ({
  VpcId: id,
  OwnerId: owner,
  CidrBlock: cidrs[0],
  CidrBlockAssociationSet: cidrs.map((c) => ({ CidrBlock: c, CidrBlockState: { State: 'associated' } })),
  IsDefault: false,
  Tags: tags(name),
  ...extra,
});
const subnet = (vpcId: string, name: string, cidr: string, az: string) => ({
  SubnetId: `subnet-${name}`,
  VpcId: vpcId,
  CidrBlock: cidr,
  AvailabilityZone: az,
  SubnetArn: `arn:aws:ec2:${az.slice(0, -1)}:111111111111:subnet/subnet-${name}`,
  Tags: tags(name),
});
const attachment = (vpcId: string, appliance = false) => ({
  TransitGatewayAttachmentId: `tgw-attach-${vpcId}`,
  TransitGatewayId: 'tgw-1',
  VpcId: vpcId,
  Options: { ApplianceModeSupport: appliance ? 'enable' : 'disable' },
});

/** What the all-regions command prints for one region. */
const useast1 = {
  Region: 'us-east-1',
  Vpcs: [
    vpc('vpc-w', 'app1-use1-vpc', ['10.0.4.0/22', '10.0.64.0/24'], '222222222222'),
    vpc('vpc-i', 'firewalls', ['10.0.0.0/24']),
    vpc('vpc-e', 'egress-use1-vpc', ['10.0.1.0/24']),
    vpc('vpc-d', 'default', ['172.31.0.0/16'], '111111111111', { IsDefault: true }),
  ],
  Subnets: [
    subnet('vpc-i', 'tgw-a', '10.0.0.0/28', 'us-east-1a'),
    subnet('vpc-i', 'fw-a', '10.0.0.64/28', 'us-east-1a'),
    subnet('vpc-w', 'private-a', '10.0.4.0/24', 'us-east-1a'),
    subnet('vpc-w', 'extra-a', '10.0.64.0/26', 'us-east-1a'),
    subnet('vpc-e', 'public-a', '10.0.1.0/26', 'us-east-1a'),
  ],
  TransitGateways: [{ TransitGatewayId: 'tgw-1', TransitGatewayArn: 'arn:aws:ec2:us-east-1:111111111111:transit-gateway/tgw-1' }],
  TransitGatewayVpcAttachments: [attachment('vpc-w'), attachment('vpc-i', true)],
};

describe('importAwsNetwork', () => {
  it('imports the all-regions command output as a pinned AWS plan', () => {
    const { plan, notes } = importAwsNetwork(JSON.stringify(useast1));
    expect(plan.cloud).toBe('aws');
    expect(plan.root).toBe('10.0.0.0/16');
    const region = plan.regions[0];
    expect(region).toMatchObject({ location: 'us-east-1', name: 'US East (N. Virginia)', fixed: '10.0.0.0/16' });
    // The VPC with the appliance-mode attachment is the inspection hub, whatever it's called.
    expect(region.hub).toMatchObject({ name: 'firewalls', fixed: '10.0.0.0/24', subscription: '111111111111' });
    expect(region.spokes.map((s) => [s.name, s.role, s.subscription])).toEqual([
      ['egress-use1-vpc', 'egress', '111111111111'],
      ['app1-use1-vpc', 'landing-zone', '222222222222'],
    ]);
    expect(region.spokes[1].ranges).toEqual([{ prefix: 24, fixed: '10.0.64.0/24' }]);
    expect(region.spokes[1].subnets.map((s) => [s.name, s.offset, s.range])).toEqual([
      ['private-a', 0, undefined],
      ['extra-a', 0, 1],
    ]);
    const result = computePlan(plan);
    expect(countIssues(result)).toEqual({ errors: 0, warnings: 0 });
    expect(result.regions[0].spokes[1].subnets.map((s) => formatCidr(s.cidr!))).toEqual(['10.0.4.0/24', '10.0.64.0/26']);
    expect(notes.map((n) => n.message)).toEqual([
      'Imported 3 VPCs and 1 Transit Gateway in 1 region across 2 accounts; root range 10.0.0.0/16',
      '1 default VPC skipped',
      'US East (N. Virginia): not attached to a Transit Gateway: egress-use1-vpc',
    ]);
  });

  it('reads plain describe output, taking regions from subnets, and several regions pasted together', () => {
    const plain = [
      JSON.stringify({ Vpcs: [vpc('vpc-a', 'web-usw2-vpc', ['10.1.0.0/24'])] }),
      JSON.stringify({ Subnets: [subnet('vpc-a', 'private-a', '10.1.0.0/26', 'us-west-2a')] }),
      'An error occurred (UnauthorizedOperation) when calling the DescribeTransitGateways operation',
    ].join('\n');
    const { plan, notes } = importAwsNetwork(`${JSON.stringify(useast1)}\n${plain}`);
    expect(plan.regions.map((r) => `${r.location} ${r.fixed}`)).toEqual(['us-east-1 10.0.0.0/16', 'us-west-2 10.1.0.0/16']);
    expect(notes.map((n) => n.message)).toContain('Text that isn’t JSON (such as CLI messages) was skipped');
    expect(notes.map((n) => n.message)).toContain("US West (Oregon): no inspection VPC found; web-usw2-vpc is shown in the hub's place");
  });

  it('reads PowerShell output, where a single item is not an array', () => {
    const ps = { ...useast1, Vpcs: vpc('vpc-i', 'inspection-use1-vpc', ['10.0.0.0/24']), TransitGatewayVpcAttachments: attachment('vpc-i', true) };
    const { plan } = importAwsNetwork(JSON.stringify(ps, null, 2));
    expect(plan.regions[0].hub.name).toBe('inspection-use1-vpc');
  });

  it('leaves out VPCs it cannot place, and rejects input without VPCs', () => {
    const { notes } = importAwsNetwork(
      JSON.stringify([{ Vpcs: [vpc('vpc-x', 'lonely', ['10.9.0.0/24'])] }, useast1]),
    );
    expect(notes.map((n) => n.message)).toContain(
      "lonely was left out: its region isn't known (it has no subnets; use the all-regions command)",
    );
    expect(() => importAwsNetwork('{"Vpcs": []}')).toThrow('No VPCs were found (default VPCs are skipped).');
    expect(() => importAwsNetwork('nope')).toThrow('The text is not valid JSON.');
  });

  it('offers commands for CloudShell, PowerShell and a single region', () => {
    expect(AWS_IMPORT_COMMANDS.map((c) => c.id)).toEqual(['all-regions', 'powershell', 'one-region']);
    expect(AWS_IMPORT_COMMANDS[0].command).toContain('--query TransitGatewayVpcAttachments --output json');
  });
});
