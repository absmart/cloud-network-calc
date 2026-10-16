import { describe, expect, it } from 'vitest';
import { awsDefaultPlan } from './awsDefaults';
import { type AwsModel, buildAwsModel } from './awsIac';
import { compareWithAws } from './compareAws';
import { DEFAULT_NAMING } from './naming';
import { type PlanSpec, computePlan } from './planner';

const modelOf = (plan: PlanSpec) => buildAwsModel(plan, computePlan(plan), DEFAULT_NAMING);
const OWNER = '111111111111';
const name = (n: string) => [{ Key: 'Name', Value: n }];

/** What the all-regions import command prints for a network deployed exactly as the export describes it. */
function deployedAs(model: AwsModel) {
  const regions = [...new Set(model.vpcs.map((v) => v.region))];
  return regions.map((region) => {
    const vpcs = model.vpcs.filter((v) => v.region === region);
    return {
      Region: region,
      Vpcs: vpcs.map((v) => ({
        VpcId: `vpc-${v.name}`,
        OwnerId: OWNER,
        CidrBlock: v.cidrs[0],
        CidrBlockAssociationSet: v.cidrs.map((c) => ({ CidrBlock: c, CidrBlockState: { State: 'associated' } })),
        IsDefault: false,
        Tags: name(v.name),
      })),
      Subnets: vpcs.flatMap((v) =>
        v.subnets.map((s) => ({
          SubnetId: `subnet-${s.name}`,
          VpcId: `vpc-${v.name}`,
          CidrBlock: s.cidr,
          AvailabilityZone: s.zone ?? `${region}a`,
          Tags: name(s.name),
        })),
      ),
      TransitGateways: model.transitGateways
        .filter((t) => t.region === region)
        .map((t) => ({ TransitGatewayId: `tgw-${t.name}`, OwnerId: OWNER, TransitGatewayArn: `arn:aws:ec2:${region}:${OWNER}:transit-gateway/x`, Tags: name(t.name) })),
      TransitGatewayVpcAttachments: vpcs
        .filter((v) => v.transitGateway)
        .map((v) => ({ VpcId: `vpc-${v.name}`, Options: { ApplianceModeSupport: v.applianceMode ? 'enable' : 'disable' } })),
    };
  });
}

describe('compareWithAws', () => {
  it('finds nothing to report when AWS matches the plan', () => {
    const model = modelOf(awsDefaultPlan());
    const { networks, counts } = compareWithAws(model, JSON.stringify(deployedAs(model)));
    expect(counts).toEqual({ different: 0, 'only-deployed': 0, 'not-deployed': 0, same: 10 });
    expect(networks.find((n) => n.kind === 'vpc')).toMatchObject({
      matchedBy: 'name',
      planned: { name: 'inspection-use1-vpc', exportedName: 'inspection-prd-use1-01-vpc' },
      deployed: { name: 'inspection-prd-use1-01-vpc', group: OWNER },
    });
  });

  it('reports changed, missing and extra VPCs, subnets, CIDR blocks, attachments and Transit Gateways', () => {
    const plan = awsDefaultPlan();
    const id = '123456789012';
    plan.regions[0].spokes[2].subscription = id;
    const model = modelOf(plan);
    const [use1, usw2] = deployedAs(model);
    const workload = use1.Vpcs[3];
    // The workload VPC: another account, an extra CIDR block, a subnet in another AZ, not attached.
    workload.OwnerId = '999999999999';
    workload.CidrBlockAssociationSet.push({ CidrBlock: '10.0.200.0/24', CidrBlockState: { State: 'associated' } });
    use1.Subnets.find((s) => s.Tags[0].Value.endsWith('private-a'))!.AvailabilityZone = 'us-east-1d';
    use1.TransitGatewayVpcAttachments = use1.TransitGatewayVpcAttachments.filter((a) => a.VpcId !== workload.VpcId);
    // The egress VPC renamed in AWS, still found by its CIDR block.
    use1.Vpcs[1].Tags = name('legacy-egress');
    // us-west-2: no Transit Gateway, no endpoints VPC, and an extra VPC overlapping the plan.
    usw2.TransitGateways = [];
    usw2.Vpcs = usw2.Vpcs.filter((v) => !v.Tags[0].Value.startsWith('endpoints'));
    // A VPC in another region, overlapping the plan.
    const euw1 = {
      Region: 'eu-west-1',
      Vpcs: [{ ...usw2.Vpcs[0], VpcId: 'vpc-clash', CidrBlock: '10.1.2.0/25', CidrBlockAssociationSet: [], Tags: name('sandbox') }],
    };

    const { networks, counts } = compareWithAws(model, JSON.stringify([use1, usw2, euw1]));
    expect(counts).toEqual({ different: 1, 'only-deployed': 1, 'not-deployed': 2, same: 7 });
    expect(networks[0]).toMatchObject({ status: 'different', planned: { name: 'workload-use1-001-vpc' } });
    expect(networks[0].differences).toEqual([
      `Account: planned ${id}, AWS has 999999999999`,
      'Not attached to a Transit Gateway in AWS',
      'AWS also has CIDR block 10.0.200.0/24',
      'Subnet private-a: planned in us-east-1a, AWS has it in us-east-1d',
    ]);
    expect(networks.find((n) => n.status === 'only-deployed')).toMatchObject({
      deployed: { name: 'sandbox' },
      conflict: true,
      differences: ['Overlaps planned 10.1.2.0/24 (endpoints-usw2-vpc)'],
    });
    expect(networks.filter((n) => n.status === 'not-deployed').map((n) => [n.kind, n.planned!.name])).toEqual([
      ['vpc', 'endpoints-usw2-vpc'],
      ['transit-gateway', 'network-prd-usw2-01-tgw'],
    ]);
    expect(networks.find((n) => n.deployed?.name === 'legacy-egress')).toMatchObject({ status: 'same', matchedBy: 'address space' });
  });

  it('matches a Transit Gateway by region when its name differs', () => {
    const model = modelOf(awsDefaultPlan());
    const docs = deployedAs(model);
    docs[0].TransitGateways[0].Tags = name('core-tgw');
    const { networks } = compareWithAws(model, JSON.stringify(docs));
    expect(networks.find((n) => n.deployed?.name === 'core-tgw')).toMatchObject({ status: 'same', matchedBy: 'region' });
  });
});
