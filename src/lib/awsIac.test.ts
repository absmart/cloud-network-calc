import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountAliases, buildAwsModel, generateAwsFiles, toAwsTfvars } from './awsIac';
import { awsDefaultPlan } from './awsDefaults';
import { DEFAULT_NAMING } from './naming';
import { type PlanSpec, computePlan } from './planner';

const modelOf = (plan: PlanSpec) => buildAwsModel(plan, computePlan(plan), DEFAULT_NAMING);
const lza = (): PlanSpec => ({ ...awsDefaultPlan(), placement: 'alz' });

describe('AWS export', () => {
  it('models VPCs, subnets per Availability Zone, a Transit Gateway per region and peering between them', () => {
    const m = modelOf(awsDefaultPlan());
    expect(m.accounts).toEqual(['main']);
    expect(m.vpcs.map((v) => v.name)).toEqual([
      'inspection-prd-use1-01-vpc',
      'egress-prd-use1-01-vpc',
      'endpoints-prd-use1-01-vpc',
      'workload-prd-use1-001-vpc',
      'inspection-prd-usw2-01-vpc',
      'egress-prd-usw2-01-vpc',
      'endpoints-prd-usw2-01-vpc',
      'workload-prd-usw2-001-vpc',
    ]);
    const workload = m.vpcs[3];
    expect(workload).toMatchObject({ region: 'us-east-1', cidrs: ['10.0.4.0/22'], transitGateway: 'network-prd-use1-01-tgw', applianceMode: false });
    expect(workload.subnets[0]).toEqual({
      name: 'workload-prd-use1-001-private-a',
      plannerName: 'private-a',
      cidr: '10.0.4.0/24',
      zone: 'us-east-1a',
    });
    expect(workload.attachmentSubnets).toEqual([
      'workload-prd-use1-001-tgw-a',
      'workload-prd-use1-001-tgw-b',
      'workload-prd-use1-001-tgw-c',
    ]);
    // The inspection VPC's attachment uses appliance mode.
    expect(m.vpcs[0].applianceMode).toBe(true);
    expect(m.transitGateways).toEqual([
      { name: 'network-prd-use1-01-tgw', account: 'main', region: 'us-east-1', asn: 64512, regionCidr: '10.0.0.0/16' },
      { name: 'network-prd-usw2-01-tgw', account: 'main', region: 'us-west-2', asn: 64513, regionCidr: '10.1.0.0/16' },
    ]);
    expect(m.peerings).toEqual([{ name: 'network-prd-use1-01-to-usw2-peer', from: 0, to: 1 }]);
    expect(m.omitted).toEqual([]);
  });

  it('puts the hub, egress and endpoints VPCs in a network account and each workload in its own with the LZA layout', () => {
    const m = modelOf(lza());
    expect(m.accounts).toEqual(['network', 'workload-use1-001', 'workload-usw2-001']);
    expect(m.vpcs.map((v) => `${v.name} ${v.account}`).slice(0, 4)).toEqual([
      'inspection-prd-use1-01-vpc network',
      'egress-prd-use1-01-vpc network',
      'endpoints-prd-use1-01-vpc network',
      'workload-prd-use1-001-vpc workload-use1-001',
    ]);
    expect(m.transitGateways.map((t) => t.account)).toEqual(['network', 'network']);
  });

  it('generates a root with a provider and three module calls per account, and generic modules', () => {
    const files = generateAwsFiles('terraform', lza(), computePlan(lza()), DEFAULT_NAMING);
    expect(files.map((f) => f.name)).toEqual([
      'main.tf',
      'modules/vpcs/main.tf',
      'modules/transit/main.tf',
      'modules/attachments/main.tf',
      'prd.tfvars',
    ]);
    const root = files[0].content;
    expect([...root.matchAll(/^ {2}alias {2}= "([a-z0-9_]+)"$/gm)].map((x) => x[1])).toEqual([
      'network',
      'workload_use1_001',
      'workload_usw2_001',
    ]);
    expect(root).toContain('role_arn = "arn:aws:iam::${var.accounts["workload-use1-001"]}:role/${assume_role.value}"');
    for (const m of ['vpcs', 'transit', 'attachments']) expect(root).toContain(`module "${m}_workload_use1_001" {`);
    // No plan values in the root or the modules.
    for (const f of files.slice(0, -1)) expect(f.content).not.toMatch(/10\.0\.|us-east-1|use1-01|private-a/);
    // The same accounts give the same root.
    expect(generateAwsFiles('terraform', awsDefaultPlan(), computePlan(awsDefaultPlan()))[0].content).not.toBe(root);
    expect(accountAliases(['123456789012', 'a-b', 'a_b'])).toEqual(
      new Map([
        ['123456789012', 'account_123456789012'],
        ['a-b', 'a_b'],
        ['a_b', 'a_b_2'],
      ]),
    );
  });

  it('puts the plan in the variables file, keeping account IDs and marking placeholders', () => {
    const plan = lza();
    plan.regions[0].spokes[2].subscription = '123456789012';
    const tfvars = toAwsTfvars(modelOf(plan));
    expect(tfvars).toContain('"network"           = "000000000000" # replace with the account ID');
    expect(tfvars).toContain('"123456789012"      = "123456789012"\n');
    expect(tfvars).toContain('default_region       = "us-east-1"');
    expect(tfvars).toContain('"workload-prd-use1-001-private-a" = { cidr_block = "10.0.4.0/24", availability_zone = "us-east-1a" }');
    expect(tfvars).toContain('appliance_mode     = true');
    expect(tfvars).toContain('"network-prd-use1-01-to-usw2-peer" = {');
  });

  it('lays out a Terragrunt stack with an S3 backend around the same module', () => {
    const files = generateAwsFiles('terragrunt', awsDefaultPlan(), computePlan(awsDefaultPlan()));
    expect(files.map((f) => f.name)).toEqual([
      'root.hcl',
      'modules/aws-network/main.tf',
      'modules/aws-network/modules/vpcs/main.tf',
      'modules/aws-network/modules/transit/main.tf',
      'modules/aws-network/modules/attachments/main.tf',
      'live/prd/aws-network/terragrunt.hcl',
      'README.md',
    ]);
    expect(files[0].content).toContain('backend = "s3"');
    expect(files[5].content).toContain('source = "${get_parent_terragrunt_dir("root")}/modules//aws-network"');
  });

  // Set IAC_OUT_DIR to write AWS samples for `terraform validate`.
  it.runIf(!!process.env.IAC_OUT_DIR)('writes AWS sample files', () => {
    for (const [name, plan] of [
      ['aws-single', awsDefaultPlan()],
      ['aws-lza', lza()],
    ] as const) {
      for (const format of ['terraform', 'terragrunt'] as const) {
        for (const file of generateAwsFiles(format, plan, computePlan(plan))) {
          const path = join(process.env.IAC_OUT_DIR!, name, format, file.name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, file.content);
        }
      }
    }
  });
});
