// Terraform export for AWS plans (hashicorp/aws 6.x). Like the Azure export,
// a generated root main.tf has one provider per AWS account (provider blocks
// can't come from a variable) and calls generic modules; every plan value is
// in the variables file. aws 6.x takes a `region` on each resource, so one
// provider per account reaches every region.

import { awsRegionCode } from './aws';
import { type IacFile, type IacFormat } from './iac';
import { formatCidr } from './ipv4';
import { type NamingOptions, DEFAULT_NAMING, normalizeNaming, parsePlannerName } from './naming';
import { isAccountId, placementOf } from './placement';
import type { PlanResult, PlanSpec, RegionSpec, VnetResult, VnetSpec } from './planner';

export interface AwsSubnet {
  name: string;
  plannerName: string;
  cidr: string;
  /** Availability Zone (us-east-1a), from the planner name's zone suffix, if it has one. */
  zone: string | null;
}

export interface AwsVpc {
  name: string;
  plannerId: string;
  plannerName: string;
  account: string;
  region: string;
  /** Primary CIDR first, then secondary CIDRs. */
  cidrs: string[];
  subnets: AwsSubnet[];
  /** Transit Gateway it attaches to (by name), through its tgw-* subnets; null if it has none. */
  transitGateway: string | null;
  attachmentSubnets: string[];
  /** The inspection VPC's attachment keeps flows symmetric across AZs. */
  applianceMode: boolean;
}

export interface AwsTransitGateway {
  name: string;
  account: string;
  region: string;
  asn: number;
  /** The region's block, routed over peerings from other regions. */
  regionCidr: string;
}

export interface AwsModel {
  planName: string;
  naming: NamingOptions;
  primaryRegion: string;
  /** Account keys in first-use order; each maps to an account ID in the variables file. */
  accounts: string[];
  vpcs: AwsVpc[];
  transitGateways: AwsTransitGateway[];
  /** Between Transit Gateways in the same account; `from`/`to` index transitGateways. */
  peerings: { name: string; from: number; to: number }[];
  omitted: string[];
}

/** <app>-<environment>-<region>-<int>, with AWS region codes. */
const base = (app: string, naming: NamingOptions, region: string, instance = naming.instance) =>
  [app, naming.environment, awsRegionCode(region), instance].filter(Boolean).join('-');

/** First private ASN for Transit Gateways; each region's gets the next. */
const FIRST_ASN = 64512;

export function buildAwsModel(plan: PlanSpec, result: PlanResult, naming: NamingOptions = DEFAULT_NAMING): AwsModel {
  const opts = normalizeNaming(naming);
  const primaryRegion = plan.regions[0]?.location ?? 'us-east-1';
  const layout = plan.placement === 'alz-platform' ? 'alz' : (plan.placement ?? 'single');
  const model: AwsModel = {
    planName: plan.name,
    naming: opts,
    primaryRegion,
    accounts: [],
    vpcs: [],
    transitGateways: [],
    peerings: [],
    omitted: [],
  };
  const useAccount = (key: string) => {
    if (!model.accounts.includes(key)) model.accounts.push(key);
    return key;
  };
  const usedBases = new Set<string>();
  const uniqueBase = (app: string, region: string, instance: string) => {
    let n = Number(instance);
    let b = base(app, opts, region, instance);
    while (usedBases.has(b)) b = base(app, opts, region, String(++n).padStart(instance.length, '0'));
    usedBases.add(b);
    return b;
  };

  plan.regions.forEach((region: RegionSpec, i) => {
    const r = result.regions[i];
    if (!r.cidr) {
      model.omitted.push(`region ${region.name}`);
      return;
    }
    const code = awsRegionCode(region.location);
    const vpcsHere: number[] = [];

    const addVpc = (v: VnetResult, spec: VnetSpec, kind: 'hub' | 'spoke') => {
      if (!v.cidr) {
        model.omitted.push(`VPC ${v.name}`);
        return;
      }
      const parsed = parsePlannerName(v.name, code);
      const vpcBase = uniqueBase(parsed.app || (kind === 'hub' ? 'inspection' : 'vpc'), region.location, parsed.instance ?? opts.instance);
      const subnets: AwsSubnet[] = [];
      for (const s of v.subnets) {
        if (!s.cidr) {
          model.omitted.push(`subnet ${v.name}/${s.name || '(unnamed)'}`);
          continue;
        }
        const letter = s.name.match(/-([a-z])$/i)?.[1]?.toLowerCase();
        subnets.push({ name: `${vpcBase}-${s.name}`, plannerName: s.name, cidr: formatCidr(s.cidr), zone: letter ? `${region.location}${letter}` : null });
      }
      const cidrs = v.ranges.flatMap((c, k) => {
        if (!c) model.omitted.push(`CIDR block ${k + 1} of VPC ${v.name}`);
        return c ? [formatCidr(c)] : [];
      });
      const attachmentSubnets = subnets.filter((s) => /^tgw(-|$)/i.test(s.plannerName)).map((s) => s.name);
      const account = useAccount(placementOf(layout, region, spec, kind, opts, primaryRegion, 'aws').subscription);
      vpcsHere.push(
        model.vpcs.push({
          name: `${vpcBase}-vpc`,
          plannerId: v.id,
          plannerName: v.name,
          account,
          region: region.location,
          cidrs,
          subnets,
          transitGateway: null,
          attachmentSubnets,
          applianceMode: kind === 'hub',
        }) - 1,
      );
    };

    addVpc(r.hub, region.hub, 'hub');
    r.spokes.forEach((s, j) => addVpc(s, region.spokes[j], 'spoke'));

    // A Transit Gateway per region with VPCs to attach, in the hub's account.
    const attaching = vpcsHere.filter((k) => model.vpcs[k].attachmentSubnets.length > 0);
    if (attaching.length === 0) return;
    const hubAccount = model.vpcs[vpcsHere[0]]?.account ?? useAccount('main');
    const tgw: AwsTransitGateway = {
      name: `${base(opts.app, opts, region.location)}-tgw`,
      account: hubAccount,
      region: region.location,
      asn: FIRST_ASN + model.transitGateways.length,
      regionCidr: formatCidr(r.cidr),
    };
    model.transitGateways.push(tgw);
    for (const k of attaching) model.vpcs[k].transitGateway = tgw.name;
    for (const k of vpcsHere.filter((k) => !attaching.includes(k)))
      model.omitted.push(`Transit Gateway attachment of VPC ${model.vpcs[k].plannerName} (no tgw-* subnets)`);
  });

  // Peer every region's Transit Gateway with every other's (full mesh), in one account.
  model.transitGateways.forEach((a, i) =>
    model.transitGateways.slice(i + 1).forEach((b, k) => {
      const j = i + 1 + k;
      if (a.account !== b.account) {
        model.omitted.push(`peering between ${a.name} and ${b.name} (Transit Gateways in different accounts)`);
        return;
      }
      model.peerings.push({ name: `${a.name.replace(/-tgw$/, '')}-to-${awsRegionCode(b.region)}-peer`, from: i, to: j });
    }),
  );
  return model;
}

// ------------------------------------------------------------ HCL helpers

const tq = (s: string) =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/([$%])\{/g, (_, sigil: string) => `${sigil}${sigil}{`)}"`;

function aligned(indent: string, pairs: [string, string][]): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${k.padEnd(width)} = ${v}`);
}

const commentBlock = (lines: string[]) => lines.map((l) => (l ? `# ${l}` : '#')).join('\n') + '\n';

const PLACEHOLDER_ACCOUNT = '000000000000';

/** A provider alias for each account key: letters, digits and underscores, starting with a letter, unique. */
export function accountAliases(accounts: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of accounts) {
    let alias = key.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'account';
    if (!/^[a-z]/.test(alias)) alias = `account_${alias}`;
    let unique = alias;
    for (let n = 2; used.has(unique); n++) unique = `${alias}_${n}`;
    used.add(unique);
    out.set(key, unique);
  }
  return out;
}

const AWS_REQUIREMENT = `terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}`;

// ------------------------------------------------------------ Root

/** The root configuration: a provider and three module calls per account. Depends only on the account keys. */
export function toAwsTerraform(accounts: string[]): string {
  const aliases = accountAliases(accounts);
  const providers = accounts.map(
    (key) => `provider "aws" {
  alias  = ${tq(aliases.get(key)!)}
  region = var.default_region

  dynamic "assume_role" {
    for_each = var.deployment_role_name == null ? [] : [var.deployment_role_name]
    content {
      role_arn = "arn:aws:iam::\${var.accounts[${tq(key)}]}:role/\${assume_role.value}"
    }
  }

  default_tags {
    tags = var.tags
  }
}`,
  );
  const calls = (fn: (key: string, alias: string, k: string) => string) =>
    accounts.map((key) => fn(key, aliases.get(key)!, tq(key))).join('\n\n');
  const outputs = (module: string, output: string) =>
    accounts.map((key) => `    module.${module}_${aliases.get(key)!}.${output},`).join('\n');
  const transitModules = accounts.map((key) => `module.transit_${aliases.get(key)!}`).join(', ');

  return `${commentBlock([
    'AWS network: VPCs with secondary CIDRs and subnets per Availability Zone,',
    'a Transit Gateway per region with VPC attachments, shared across accounts',
    'with AWS RAM, and Transit Gateway peering between regions.',
    'Generated by ALZ CIDR Planner.',
    '',
    'Supply values with a .tfvars file:',
    '',
    '  terraform init',
    '  terraform apply -var-file=<env>.tfvars',
    '',
    'The aws provider deploys to one account per provider, so this file has a',
    "provider alias and three module calls for each of this plan's accounts:",
    `${accounts.join(', ')}.`,
    'For another account, add a provider and its module calls. Every other value',
    'comes from the variables, and modules/ is generic.',
  ])}
${AWS_REQUIREMENT}

# ------------------------------------------------------------ Providers

# One per account. With deployment_role_name set, each assumes that role in its
# account (from the credentials you run Terraform with, such as the
# management account); with null, they all use your credentials as they are.
${providers.join('\n\n')}

# ------------------------------------------------------------ Variables

variable "accounts" {
  type        = map(string)
  description = "AWS account IDs, by the keys the other variables use. Needs every key the provider blocks name."
}

variable "default_region" {
  type        = string
  description = "Region the providers start in; every resource names its own region."
}

variable "deployment_role_name" {
  type        = string
  description = "IAM role to assume in each account, such as OrganizationAccountAccessRole or AWSControlTowerExecution; null to use your credentials directly."
  default     = null
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource, through the providers' default_tags."
  default     = {}
}

variable "vpcs" {
  description = "VPCs keyed by Name tag. account is a key of var.accounts; transit_gateway a key of var.transit_gateways."
  type = map(object({
    account     = string
    region      = string
    cidr_blocks = list(string)
    subnets = optional(map(object({
      cidr_block        = string
      availability_zone = optional(string)
    })), {})
    transit_gateway    = optional(string)
    attachment_subnets = optional(list(string), [])
    appliance_mode     = optional(bool, false)
  }))

  validation {
    condition = alltrue(flatten([
      for vpc in values(var.vpcs) : concat(
        [for cidr in vpc.cidr_blocks : can(cidrnetmask(cidr))],
        [for subnet in values(vpc.subnets) : can(cidrnetmask(subnet.cidr_block))],
      )
    ]))
    error_message = "Every VPC cidr_blocks entry and subnet cidr_block must be a valid IPv4 CIDR."
  }
}

variable "transit_gateways" {
  description = "Transit Gateways keyed by Name tag, one per region."
  type = map(object({
    account         = string
    region          = string
    amazon_side_asn = number
    region_cidr     = string
  }))
  default = {}
}

variable "transit_gateway_peerings" {
  description = "Peerings between Transit Gateways in the same account, keyed by Name tag."
  type = map(object({
    transit_gateway      = string
    peer_transit_gateway = string
  }))
  default = {}
}

# ------------------------------------------------------------ Modules

locals {
  # Accounts that attach VPCs to each Transit Gateway from outside its own account; it's shared with them.
  share_with = {
    for name, tgw in var.transit_gateways : name => distinct([
      for vpc in values(var.vpcs) : var.accounts[vpc.account]
      if vpc.transit_gateway == name && vpc.account != tgw.account
    ])
  }

  vpc_ids = merge(
${outputs('vpcs', 'vpc_ids')}
  )
  subnet_ids = merge(
${outputs('vpcs', 'subnet_ids')}
  )
  transit_gateway_ids = merge(
${outputs('transit', 'transit_gateway_ids')}
  )
}

# VPCs, secondary CIDRs and subnets, per account.
${calls(
  (_key, alias, k) => `module "vpcs_${alias}" {
  source    = "./modules/vpcs"
  providers = { aws = aws.${alias} }

  vpcs = { for name, vpc in var.vpcs : name => vpc if vpc.account == ${k} }
}`,
)}

# Transit Gateways, their sharing, and peerings between regions, per account.
${calls(
  (_key, alias, k) => `module "transit_${alias}" {
  source    = "./modules/transit"
  providers = { aws = aws.${alias} }

  transit_gateways = {
    for name, tgw in var.transit_gateways : name => merge(tgw, { share_with = local.share_with[name] })
    if tgw.account == ${k}
  }
  peerings = {
    for name, p in var.transit_gateway_peerings : name => p
    if var.transit_gateways[p.transit_gateway].account == ${k}
  }
}`,
)}

# VPC attachments, per account, once the Transit Gateways are shared.
${calls(
  (_key, alias, k) => `module "attachments_${alias}" {
  source    = "./modules/attachments"
  providers = { aws = aws.${alias} }

  attachments = {
    for name, vpc in var.vpcs : name => {
      region             = vpc.region
      vpc_id             = local.vpc_ids[name]
      subnet_ids         = [for s in vpc.attachment_subnets : local.subnet_ids["\${name}/\${s}"]]
      transit_gateway_id = local.transit_gateway_ids[vpc.transit_gateway]
      appliance_mode     = vpc.appliance_mode
    } if vpc.account == ${k} && vpc.transit_gateway != null
  }

  depends_on = [${transitModules}]
}`,
)}
`;
}

// ------------------------------------------------------------ Modules

export const AWS_TERRAFORM_MODULES = {
  vpcs: 'modules/vpcs/main.tf',
  transit: 'modules/transit/main.tf',
  attachments: 'modules/attachments/main.tf',
} as const;

export function toAwsTerraformModules(): Record<string, string> {
  const header = (what: string) => commentBlock([`${what} Called by the root main.tf, generated by ALZ CIDR Planner.`]);
  return {
    [AWS_TERRAFORM_MODULES.vpcs]: `${header("One account's VPCs, secondary CIDRs and subnets, in any regions.")}
${AWS_REQUIREMENT}

variable "vpcs" {
  description = "The root's var.vpcs entries in this account."
  type = map(object({
    region      = string
    cidr_blocks = list(string)
    subnets = optional(map(object({
      cidr_block        = string
      availability_zone = optional(string)
    })), {})
  }))
}

locals {
  # Secondary CIDRs keyed "<vpc>/<cidr>", and subnets keyed "<vpc>/<subnet>".
  secondary_cidrs = merge({}, [
    for name, vpc in var.vpcs : {
      for cidr in slice(vpc.cidr_blocks, 1, length(vpc.cidr_blocks)) : "\${name}/\${cidr}" => {
        vpc        = name
        region     = vpc.region
        cidr_block = cidr
      }
    }
  ]...)
  subnets = merge({}, [
    for vpc_name, vpc in var.vpcs : {
      for subnet_name, subnet in vpc.subnets : "\${vpc_name}/\${subnet_name}" => merge(subnet, {
        vpc    = vpc_name
        name   = subnet_name
        region = vpc.region
      })
    }
  ]...)
}

resource "aws_vpc" "this" {
  for_each = var.vpcs

  region               = each.value.region
  cidr_block           = each.value.cidr_blocks[0]
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = each.key }
}

resource "aws_vpc_ipv4_cidr_block_association" "secondary" {
  for_each = local.secondary_cidrs

  region     = each.value.region
  vpc_id     = aws_vpc.this[each.value.vpc].id
  cidr_block = each.value.cidr_block
}

resource "aws_subnet" "this" {
  for_each = local.subnets

  region            = each.value.region
  vpc_id            = aws_vpc.this[each.value.vpc].id
  cidr_block        = each.value.cidr_block
  availability_zone = each.value.availability_zone
  tags              = { Name = each.value.name }

  # Subnets in a secondary CIDR need it associated first.
  depends_on = [aws_vpc_ipv4_cidr_block_association.secondary]
}

output "vpc_ids" {
  value = { for name, vpc in aws_vpc.this : name => vpc.id }
}

output "subnet_ids" {
  value = { for key, subnet in aws_subnet.this : key => subnet.id }
}
`,
    [AWS_TERRAFORM_MODULES.transit]: `${header("One account's Transit Gateways, shared with other accounts, and peered between regions.")}
${AWS_REQUIREMENT}

variable "transit_gateways" {
  description = "Transit Gateways in this account, each with the account IDs to share it with."
  type = map(object({
    region          = string
    amazon_side_asn = number
    region_cidr     = string
    share_with      = list(string)
  }))
}

variable "peerings" {
  description = "Peerings from Transit Gateways in this account to others in it."
  type = map(object({
    transit_gateway      = string
    peer_transit_gateway = string
  }))
  default = {}
}

locals {
  shares = { for name, tgw in var.transit_gateways : name => tgw if length(tgw.share_with) > 0 }
  principals = merge({}, [
    for name, tgw in local.shares : {
      for account in tgw.share_with : "\${name}/\${account}" => { transit_gateway = name, account = account }
    }
  ]...)
}

resource "aws_ec2_transit_gateway" "this" {
  for_each = var.transit_gateways

  region                          = each.value.region
  amazon_side_asn                 = each.value.amazon_side_asn
  auto_accept_shared_attachments  = "enable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  tags                            = { Name = each.key }
}

# Shared through AWS RAM. Inside an AWS Organization with RAM sharing enabled,
# member accounts get the share without accepting it.
resource "aws_ram_resource_share" "this" {
  for_each = local.shares

  region                    = each.value.region
  name                      = "\${each.key}-share"
  allow_external_principals = false
}

resource "aws_ram_resource_association" "this" {
  for_each = local.shares

  region             = each.value.region
  resource_arn       = aws_ec2_transit_gateway.this[each.key].arn
  resource_share_arn = aws_ram_resource_share.this[each.key].arn
}

resource "aws_ram_principal_association" "this" {
  for_each = local.principals

  region             = var.transit_gateways[each.value.transit_gateway].region
  principal          = each.value.account
  resource_share_arn = aws_ram_resource_share.this[each.value.transit_gateway].arn
}

resource "aws_ec2_transit_gateway_peering_attachment" "this" {
  for_each = var.peerings

  region                  = var.transit_gateways[each.value.transit_gateway].region
  transit_gateway_id      = aws_ec2_transit_gateway.this[each.value.transit_gateway].id
  peer_transit_gateway_id = aws_ec2_transit_gateway.this[each.value.peer_transit_gateway].id
  peer_region             = var.transit_gateways[each.value.peer_transit_gateway].region
  tags                    = { Name = each.key }
}

resource "aws_ec2_transit_gateway_peering_attachment_accepter" "this" {
  for_each = var.peerings

  region                        = var.transit_gateways[each.value.peer_transit_gateway].region
  transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment.this[each.key].id
  tags                          = { Name = each.key }
}

# Peerings don't propagate routes: send each region's block over its peering, both ways.
resource "aws_ec2_transit_gateway_route" "to_peer" {
  for_each = var.peerings

  region                         = var.transit_gateways[each.value.transit_gateway].region
  destination_cidr_block         = var.transit_gateways[each.value.peer_transit_gateway].region_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment_accepter.this[each.key].transit_gateway_attachment_id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.this[each.value.transit_gateway].association_default_route_table_id
}

resource "aws_ec2_transit_gateway_route" "from_peer" {
  for_each = var.peerings

  region                         = var.transit_gateways[each.value.peer_transit_gateway].region
  destination_cidr_block         = var.transit_gateways[each.value.transit_gateway].region_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment_accepter.this[each.key].transit_gateway_attachment_id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.this[each.value.peer_transit_gateway].association_default_route_table_id
}

output "transit_gateway_ids" {
  value = { for name, tgw in aws_ec2_transit_gateway.this : name => tgw.id }
}
`,
    [AWS_TERRAFORM_MODULES.attachments]: `${header("One account's VPC attachments to Transit Gateways, which may be shared from another account.")}
${AWS_REQUIREMENT}

variable "attachments" {
  description = "VPC attachments keyed by VPC Name tag."
  type = map(object({
    region             = string
    vpc_id             = string
    subnet_ids         = list(string)
    transit_gateway_id = string
    appliance_mode     = bool
  }))
  default = {}
}

resource "aws_ec2_transit_gateway_vpc_attachment" "this" {
  for_each = var.attachments

  region                 = each.value.region
  vpc_id                 = each.value.vpc_id
  subnet_ids             = each.value.subnet_ids
  transit_gateway_id     = each.value.transit_gateway_id
  appliance_mode_support = each.value.appliance_mode ? "enable" : "disable"
  tags                   = { Name = "\${each.key}-attachment" }
}
`,
  };
}

// ------------------------------------------------------------ Variables

function awsTerraformValues(model: AwsModel): string[] {
  const env = model.naming.environment;
  const out: string[] = [
    'accounts = {',
    ...aligned(
      '  ',
      model.accounts.map((key): [string, string] => [tq(key), tq(isAccountId(key) ? key : PLACEHOLDER_ACCOUNT)]),
    ).map((line, i) => (isAccountId(model.accounts[i]) ? line : `${line} # replace with the account ID`)),
    '}',
    '',
    ...aligned('', [
      ['default_region', tq(model.primaryRegion)],
      ['deployment_role_name', '"OrganizationAccountAccessRole" # or AWSControlTowerExecution; null for your own credentials'],
    ]),
    '',
    'tags = {',
    ...aligned('  ', [
      ['environment', tq(env)],
      ['workload', tq(model.naming.app)],
    ]),
    '}',
    '',
    'vpcs = {',
  ];
  for (const v of model.vpcs) {
    out.push(`  ${tq(v.name)} = {`);
    const fields: [string, string][] = [
      ['account', tq(v.account)],
      ['region', tq(v.region)],
      ['cidr_blocks', `[${v.cidrs.map(tq).join(', ')}]`],
    ];
    if (v.transitGateway) {
      fields.push(['transit_gateway', tq(v.transitGateway)], ['attachment_subnets', `[${v.attachmentSubnets.map(tq).join(', ')}]`]);
      if (v.applianceMode) fields.push(['appliance_mode', 'true']);
    }
    out.push(...aligned('    ', fields));
    if (v.subnets.length === 0) {
      out.push('    subnets = {}');
    } else {
      out.push('    subnets = {');
      out.push(
        ...aligned(
          '      ',
          v.subnets.map((s): [string, string] => {
            const parts = [`cidr_block = ${tq(s.cidr)}`];
            if (s.zone) parts.push(`availability_zone = ${tq(s.zone)}`);
            return [tq(s.name), `{ ${parts.join(', ')} }`];
          }),
        ),
      );
      out.push('    }');
    }
    out.push('  }');
  }
  out.push('}', '', 'transit_gateways = {');
  for (const t of model.transitGateways) {
    out.push(`  ${tq(t.name)} = {`);
    out.push(
      ...aligned('    ', [
        ['account', tq(t.account)],
        ['region', tq(t.region)],
        ['amazon_side_asn', String(t.asn)],
        ['region_cidr', tq(t.regionCidr)],
      ]),
    );
    out.push('  }');
  }
  out.push('}', '', 'transit_gateway_peerings = {');
  for (const p of model.peerings) {
    out.push(`  ${tq(p.name)} = {`);
    out.push(
      ...aligned('    ', [
        ['transit_gateway', tq(model.transitGateways[p.from].name)],
        ['peer_transit_gateway', tq(model.transitGateways[p.to].name)],
      ]),
    );
    out.push('  }');
  }
  out.push('}');
  return out;
}

function variablesHeader(model: AwsModel, usage: string[]): string {
  const lines = [
    `Values for main.tf: AWS network "${model.planName}", ${model.naming.environment || 'example'} environment.`,
    `Generated by ALZ CIDR Planner on ${new Date().toISOString().slice(0, 10)}.`,
    'Replace the placeholder account IDs, and set deployment_role_name to the role',
    'Terraform should assume in each account.',
    '',
    ...usage,
  ];
  if (model.omitted.length) lines.push('', 'Not in this file:', ...model.omitted.map((o) => `  - ${o}`));
  return commentBlock(lines);
}

export function toAwsTfvars(model: AwsModel): string {
  const env = model.naming.environment || 'example';
  return [
    variablesHeader(model, ['  terraform init', `  terraform apply -var-file=${env}.tfvars`]).trimEnd(),
    '',
    ...awsTerraformValues(model),
  ].join('\n') + '\n';
}

// ------------------------------------------------------------ Terragrunt

export const AWS_TERRAGRUNT_ROOT = 'aws-network-terragrunt';

const liveDir = (env: string) => `live/${env || 'example'}/aws-network`;

export function toAwsTerragruntRoot(): string {
  return `${commentBlock([
    'Shared Terragrunt settings, included by every live/<env>/<stack>/terragrunt.hcl.',
    'Generated by ALZ CIDR Planner.',
    '',
    'State is kept in S3, named by environment variables:',
    '  TG_STATE_BUCKET   S3 bucket for state (must exist)',
    '  TG_STATE_REGION   the bucket\'s region',
    'Locking uses S3 lock files, which need Terraform 1.10 or later.',
  ])}
remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    bucket       = get_env("TG_STATE_BUCKET")
    region       = get_env("TG_STATE_REGION")
    key          = "\${path_relative_to_include()}/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

# No generated provider: modules/aws-network/main.tf has an aws provider for
# each account the network uses.
`;
}

function toAwsTerragruntLive(model: AwsModel): string {
  const env = model.naming.environment || 'example';
  return `${variablesHeader(model, [
    `  cd ${liveDir(env)}`,
    '  terragrunt apply',
    '',
    'For another environment, copy this folder to live/<env>/aws-network and edit the inputs.',
  ])}
include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "\${get_parent_terragrunt_dir("root")}/modules//aws-network"
}

inputs = {
${awsTerraformValues(model)
  .map((line) => (line ? `  ${line}` : line))
  .join('\n')}
}
`;
}

function toAwsTerragruntReadme(model: AwsModel): string {
  const live = liveDir(model.naming.environment);
  return `# AWS network: Terragrunt

Generated by ALZ CIDR Planner for "${model.planName}".

\`\`\`
root.hcl                     shared remote state (S3)
modules/aws-network/main.tf  an aws provider and three module calls per account
modules/aws-network/modules/ generic vpcs, transit and attachments modules
${live}/terragrunt.hcl
                             this environment: the module source and its inputs
\`\`\`

The network spans ${model.accounts.length} account${model.accounts.length === 1 ? '' : 's'} (${model.accounts.join(', ')}).
Put their IDs in \`accounts\` in the inputs. With \`deployment_role_name\` set, Terraform
assumes that role in each account from the credentials you run it with (for example,
the management account). Transit Gateways are shared through AWS RAM; inside an AWS
Organization with RAM sharing enabled, the shares need no accepting.

## Deploy

\`\`\`sh
export TG_STATE_BUCKET=<state bucket>
export TG_STATE_REGION=<bucket region>

cd ${live}
terragrunt plan
terragrunt apply
\`\`\`
`;
}

/** Folder an AWS format's files are zipped under. */
export const awsZipRoot = (format: IacFormat) => (format === 'terragrunt' ? AWS_TERRAGRUNT_ROOT : 'aws-network-terraform');

export function generateAwsFiles(format: IacFormat, plan: PlanSpec, result: PlanResult, naming: NamingOptions = DEFAULT_NAMING): IacFile[] {
  const model = buildAwsModel(plan, result, naming);
  const env = model.naming.environment || 'example';
  const modules = Object.entries(toAwsTerraformModules());
  if (format === 'terragrunt')
    return [
      { name: 'root.hcl', content: toAwsTerragruntRoot(), description: 'shared remote state' },
      { name: 'modules/aws-network/main.tf', content: toAwsTerraform(model.accounts), description: 'providers and modules per account' },
      ...modules.map(([name, content]) => ({ name: `modules/aws-network/${name}`, content, description: 'module' })),
      { name: `${liveDir(env)}/terragrunt.hcl`, content: toAwsTerragruntLive(model), description: 'values for this plan' },
      { name: 'README.md', content: toAwsTerragruntReadme(model), description: 'how to deploy' },
    ];
  return [
    { name: 'main.tf', content: toAwsTerraform(model.accounts), description: 'providers and modules per account' },
    ...modules.map(([name, content]) => ({ name, content, description: 'module' })),
    { name: `${env}.tfvars`, content: toAwsTfvars(model), description: 'values for this plan' },
  ];
}
