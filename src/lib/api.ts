// The operations behind the HTTP API and the MCP server (apiHttp.ts, mcp.ts):
// other apps and agents send a design in and get results, IaC, or a link that
// opens the design in the app. Nothing is stored, so every call carries the
// design it works on.
//
// A design is `{ plan, naming }`, the same payload as a share link. Ids are
// left out of what the API returns and are added to whatever it receives, so
// callers never have to make them up.

import { CLOUDS, cloudOf, isKnownRegion, nextRegion, regionsByGeography, relocate, spokeTemplates, newPlan } from './cloud';
import { compareWithAws } from './compareAws';
import { compareWithAzure } from './compareAzure';
import type { Comparison } from './compare';
import { migratePlan, newId } from './defaults';
import { type IacFile, type IacFormat, buildIacModel, generateIacFiles, zipRoot } from './iac';
import { awsZipRoot, buildAwsModel, generateAwsFiles } from './awsIac';
import { importAwsNetwork } from './importAws';
import { type ImportNote, importAzureNetwork } from './importAzure';
import { type Cidr, formatCidr } from './ipv4';
import { DEFAULT_NAMING, type NamingOptions } from './naming';
import { placementOf } from './placement';
import {
  type Cloud,
  type Issue,
  type PlanSpec,
  type RegionSpec,
  type SubnetSpec,
  type VnetResult,
  type VnetSpec,
  computePlan,
  countIssues,
} from './planner';
import { decodeDesign, isShareFragment, shareUrl } from './shareLink';
import { createZip } from './zip';

/** A design as the API takes and returns it. */
export interface Design {
  plan: PlanSpec;
  naming: NamingOptions;
}

/** A bad request: the message says what to fix. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

export const CLOUD_NAMES: Cloud[] = ['azure', 'aws'];
export const IAC_FORMATS: IacFormat[] = ['bicep', 'terraform', 'terragrunt'];

export function readCloud(value: unknown, fallback?: Cloud): Cloud {
  if ((value === undefined || value === null || value === '') && fallback) return fallback;
  if (value === 'azure' || value === 'aws') return value;
  throw new ApiError(`cloud must be "azure" or "aws".`);
}

// ---------------------------------------------------------------------------
// Reading a design

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks a plan's shape, adds missing ids and defaults, and lists every problem with its path. */
function readPlan(value: unknown): PlanSpec {
  const problems: string[] = [];
  const need = (ok: boolean, path: string, what: string) => {
    if (!ok) problems.push(`${path} ${what}`);
    return ok;
  };
  const prefixOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 32;
  const optionalString = (o: Json, key: string, path: string) =>
    o[key] === undefined || need(typeof o[key] === 'string', `${path}.${key}`, 'must be a string');

  const subnetOf = (v: unknown, path: string): SubnetSpec => {
    if (!need(isObject(v), path, 'must be an object')) return v as SubnetSpec;
    const s = v as Json;
    need(typeof s.name === 'string' && !!s.name.trim(), `${path}.name`, 'must be a non-empty string');
    need(prefixOk(s.prefix), `${path}.prefix`, 'must be a whole number from 0 to 32');
    optionalString(s, 'fixed', path);
    for (const key of ['offset', 'range', 'hosts'])
      if (s[key] !== undefined) need(Number.isInteger(s[key]) && (s[key] as number) >= 0, `${path}.${key}`, 'must be a whole number');
    return { ...(s as unknown as SubnetSpec), id: typeof s.id === 'string' && s.id ? s.id : newId() };
  };

  const vnetOf = (v: unknown, path: string): VnetSpec => {
    if (!need(isObject(v), path, 'must be an object')) return v as VnetSpec;
    const n = v as Json;
    need(typeof n.name === 'string' && !!n.name.trim(), `${path}.name`, 'must be a non-empty string');
    need(prefixOk(n.prefix), `${path}.prefix`, 'must be a whole number from 0 to 32');
    for (const key of ['fixed', 'role', 'subscription', 'resourceGroup']) optionalString(n, key, path);
    const subnets = n.subnets === undefined ? [] : n.subnets;
    if (!need(Array.isArray(subnets), `${path}.subnets`, 'must be a list')) return v as VnetSpec;
    if (n.ranges !== undefined && need(Array.isArray(n.ranges), `${path}.ranges`, 'must be a list'))
      (n.ranges as unknown[]).forEach((r, i) => {
        if (need(isObject(r), `${path}.ranges[${i}]`, 'must be an object'))
          need(prefixOk((r as Json).prefix), `${path}.ranges[${i}].prefix`, 'must be a whole number from 0 to 32');
      });
    if (n.splits !== undefined) need(Array.isArray(n.splits), `${path}.splits`, 'must be a list');
    return {
      ...(n as unknown as VnetSpec),
      id: typeof n.id === 'string' && n.id ? n.id : newId(),
      subnets: (subnets as unknown[]).map((s, i) => subnetOf(s, `${path}.subnets[${i}]`)),
    };
  };

  const regionOf = (v: unknown, path: string): RegionSpec => {
    if (!need(isObject(v), path, 'must be an object')) return v as RegionSpec;
    const r = v as Json;
    need(typeof r.location === 'string' && !!r.location.trim(), `${path}.location`, 'must be a region name such as "eastus2" or "us-east-1"');
    need(prefixOk(r.prefix), `${path}.prefix`, 'must be a whole number from 0 to 32');
    optionalString(r, 'fixed', path);
    const topology = r.topology ?? 'hub-spoke';
    need(topology === 'hub-spoke' || topology === 'vwan', `${path}.topology`, 'must be "hub-spoke" or "vwan"');
    const spokes = r.spokes === undefined ? [] : r.spokes;
    need(Array.isArray(spokes), `${path}.spokes`, 'must be a list');
    return {
      ...(r as unknown as RegionSpec),
      id: typeof r.id === 'string' && r.id ? r.id : newId(),
      name: typeof r.name === 'string' && r.name.trim() ? r.name : String(r.location ?? ''),
      topology: topology as RegionSpec['topology'],
      hub: vnetOf(r.hub, `${path}.hub`),
      spokes: Array.isArray(spokes) ? spokes.map((s, i) => vnetOf(s, `${path}.spokes[${i}]`)) : [],
    };
  };

  if (!isObject(value)) throw new ApiError('The design has no plan object.');
  const p = value;
  need(p.version === undefined || p.version === 1, 'plan.version', 'must be 1');
  need(p.cloud === undefined || p.cloud === 'azure' || p.cloud === 'aws', 'plan.cloud', 'must be "azure" or "aws"');
  need(typeof p.root === 'string', 'plan.root', 'must be a CIDR string such as "10.0.0.0/8"');
  optionalString(p, 'name', 'plan');
  need(p.placement === undefined || ['single', 'alz', 'alz-platform'].includes(p.placement as string), 'plan.placement', 'must be "single", "alz" or "alz-platform"');
  if (p.excluded !== undefined && need(Array.isArray(p.excluded), 'plan.excluded', 'must be a list'))
    (p.excluded as unknown[]).forEach((e, i) =>
      need(isObject(e) && typeof e.cidr === 'string', `plan.excluded[${i}].cidr`, 'must be a CIDR string'),
    );
  const regions = need(Array.isArray(p.regions), 'plan.regions', 'must be a list')
    ? (p.regions as unknown[]).map((r, i) => regionOf(r, `plan.regions[${i}]`))
    : [];
  if (problems.length) throw new ApiError(`The plan isn't valid: ${problems[0]}.`, 400, problems);
  return migratePlan({
    ...(p as unknown as PlanSpec),
    version: 1,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Untitled design',
    regions,
  });
}

function readNaming(value: unknown): NamingOptions {
  if (value === undefined || value === null) return { ...DEFAULT_NAMING };
  if (!isObject(value)) throw new ApiError('naming must be an object with app, environment and instance.');
  const naming = { ...DEFAULT_NAMING };
  for (const key of ['app', 'environment', 'instance'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string') throw new ApiError(`naming.${key} must be a string.`);
    naming[key] = value[key] as string;
  }
  return naming;
}

/**
 * Read a design from what a caller sent: `{ plan, naming }`, a bare plan, a
 * saved design or a backup file with one design (as JSON or as text), or a
 * share link to the app.
 */
export async function readDesign(input: unknown): Promise<Design> {
  if (typeof input === 'string') {
    const text = input.trim();
    const hash = text.includes('#') ? text.slice(text.indexOf('#')) : text;
    if (isShareFragment(hash)) {
      try {
        return await decodeDesign(hash);
      } catch (e) {
        throw new ApiError((e as Error).message);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError('The design must be a JSON object or a share link to the app (…#d=…).');
    }
    return readDesign(parsed);
  }
  if (!isObject(input)) throw new ApiError('Send a design: { "plan": { … }, "naming": { … } }, a plan, or a share link.');
  if (Array.isArray(input.designs)) {
    if (input.designs.length !== 1)
      throw new ApiError(`The backup holds ${input.designs.length} designs; send one design at a time.`);
    return readDesign(input.designs[0]);
  }
  if ('plan' in input) return { plan: readPlan(input.plan), naming: readNaming(input.naming) };
  if ('regions' in input || 'root' in input) return { plan: readPlan(input), naming: { ...DEFAULT_NAMING } };
  throw new ApiError('The design has no plan. Send { "plan": { … } } with root and regions.');
}

/** The design as the API returns it: without ids, which the app regenerates. */
export function portable(design: Design): Design {
  return JSON.parse(JSON.stringify(design, (key, value) => (key === 'id' ? undefined : value)));
}

// ---------------------------------------------------------------------------
// Operations

const cidr = (c: Cidr | null) => (c ? formatCidr(c) : null);

export interface Problem {
  level: Issue['level'];
  /** Where it is: the plan, a region, a network or a subnet, by name. */
  where: string;
  message: string;
}

export interface CheckedSubnet {
  name: string;
  cidr: string | null;
  usable: number;
  issues: Issue[];
}

export interface CheckedNetwork {
  name: string;
  kind: VnetResult['kind'];
  role?: string;
  cidr: string | null;
  ranges: (string | null)[];
  subscription: string;
  resourceGroup?: string;
  free: string[];
  issues: Issue[];
  subnets: CheckedSubnet[];
}

export interface CheckedRegion {
  name: string;
  location: string;
  topology: RegionSpec['topology'];
  cidr: string | null;
  free: string[];
  issues: Issue[];
  networks: CheckedNetwork[];
}

export interface CheckResult {
  name: string;
  cloud: Cloud;
  /** True when the design has no errors (it may still have warnings). */
  valid: boolean;
  errors: number;
  warnings: number;
  /** Every issue in the design, flattened. */
  problems: Problem[];
  root: string | null;
  excluded: string[];
  free: string[];
  issues: Issue[];
  regions: CheckedRegion[];
}

/** Allocate the design's address space and validate it against its cloud's rules. */
export function checkDesign({ plan, naming }: Design): CheckResult {
  const result = computePlan(plan);
  const cloud = cloudOf(plan);
  const problems: Problem[] = result.issues.map((i) => ({ ...i, where: 'plan' }));
  const regions = result.regions.map((region, ri): CheckedRegion => {
    const spec = plan.regions[ri];
    problems.push(...region.issues.map((i) => ({ ...i, where: spec.name })));
    const vnets = [region.hub, ...region.spokes];
    const specs = [spec.hub, ...spec.spokes];
    return {
      name: spec.name,
      location: spec.location,
      topology: spec.topology,
      cidr: cidr(region.cidr),
      free: region.free.map(formatCidr),
      issues: region.issues,
      networks: vnets.map((vnet, vi): CheckedNetwork => {
        const vspec = specs[vi];
        const where = `${spec.name} › ${vspec.name}`;
        problems.push(...vnet.issues.map((i) => ({ ...i, where })));
        const placement = placementOf(plan.placement ?? 'single', spec, vspec, vnet.kind, naming, plan.regions[0].location, cloud);
        return {
          name: vspec.name,
          kind: vnet.kind,
          ...(vi > 0 ? { role: vspec.role ?? 'landing-zone' } : {}),
          cidr: cidr(vnet.cidr),
          ranges: vnet.ranges.map(cidr),
          subscription: placement.subscription,
          ...(cloud === 'azure' ? { resourceGroup: placement.resourceGroup } : {}),
          free: vnet.free.map(formatCidr),
          issues: vnet.issues,
          subnets: vnet.subnets.map((s, si): CheckedSubnet => {
            problems.push(...s.issues.map((i) => ({ ...i, where: `${where} › ${vspec.subnets[si].name}` })));
            return { name: vspec.subnets[si].name, cidr: cidr(s.cidr), usable: s.usable, issues: s.issues };
          }),
        };
      }),
    };
  });
  const { errors, warnings } = countIssues(result);
  return {
    name: plan.name,
    cloud,
    valid: errors === 0,
    errors,
    warnings,
    problems,
    root: cidr(result.root),
    excluded: result.excluded.map((b) => formatCidr(b.cidr)),
    free: result.free.map(formatCidr),
    issues: result.issues,
    regions,
  };
}

export interface ExportResult {
  cloud: Cloud;
  format: IacFormat;
  /** Folder the files go under when zipped. */
  root: string;
  files: IacFile[];
  /** Errors in the design: the export leaves out what couldn't be allocated. */
  errors: number;
}

export function readFormat(value: unknown): IacFormat {
  if (IAC_FORMATS.includes(value as IacFormat)) return value as IacFormat;
  throw new ApiError('format must be "bicep", "terraform" or "terragrunt".');
}

/** Infrastructure as code for the design, as the app's export would download it. */
export function exportDesign({ plan, naming }: Design, format: IacFormat): ExportResult {
  const cloud = cloudOf(plan);
  if (cloud === 'aws' && format === 'bicep') throw new ApiError('Bicep is for Azure; export AWS designs as "terraform" or "terragrunt".');
  const result = computePlan(plan);
  const files = cloud === 'aws' ? generateAwsFiles(format, plan, result, naming) : generateIacFiles(format, plan, result, naming);
  return { cloud, format, root: cloud === 'aws' ? awsZipRoot(format) : zipRoot(format), files, errors: countIssues(result).errors };
}

/** The export as a zip, with its folders, as the app downloads it. */
export const exportZip = (exported: ExportResult) =>
  createZip(exported.files.map((f) => ({ name: `${exported.root}/${f.name}`, content: f.content })));

export interface DesignWithLink {
  design: Design;
  /** Opens the design in the app. */
  link: string;
  check: Pick<CheckResult, 'valid' | 'errors' | 'warnings' | 'problems'>;
}

const summary = (design: Design) => {
  const { valid, errors, warnings, problems } = checkDesign(design);
  return { valid, errors, warnings, problems };
};

/** A link to the app at `appUrl` that opens the design. */
export const designLink = (design: Design, appUrl: string) => shareUrl(appUrl, design.plan, design.naming);

async function withLink(design: Design, appUrl: string): Promise<DesignWithLink> {
  return { design: portable(design), link: await designLink(design, appUrl), check: summary(design) };
}

/** The app's starting design for a cloud. */
export function newDesign(cloud: Cloud, appUrl: string, name?: string) {
  const plan = newPlan(cloud);
  return withLink({ plan: { ...plan, cloud, name: name?.trim() || plan.name }, naming: { ...DEFAULT_NAMING } }, appUrl);
}

export interface ImportResult extends DesignWithLink {
  notes: ImportNote[];
}

/** A design from what is deployed, read from Azure or AWS CLI output (see AZURE_IMPORT_COMMANDS / AWS_IMPORT_COMMANDS). */
export async function importNetwork(cloud: Cloud, text: string, appUrl: string, name?: string): Promise<ImportResult> {
  if (!text.trim()) throw new ApiError('Send the CLI output to import.');
  const imported = cloud === 'aws' ? importAwsNetwork(text, name || undefined) : importAzureNetwork(text, name || undefined);
  if (imported.plan.regions.length === 0)
    throw new ApiError(imported.notes.map((n) => n.message).join(' ') || 'No networks were found in the input.', 422);
  return { ...(await withLink({ plan: imported.plan, naming: { ...DEFAULT_NAMING } }, appUrl)), notes: imported.notes };
}

/** What differs between the design and what is deployed, from the same CLI output the import reads. */
export function compareDesign({ plan, naming }: Design, text: string): Comparison {
  if (!text.trim()) throw new ApiError('Send the CLI output to compare with.');
  const result = computePlan(plan);
  return cloudOf(plan) === 'aws'
    ? compareWithAws(buildAwsModel(plan, result, naming), text)
    : compareWithAzure(buildIacModel(plan, result, naming), text);
}

/** Add a region at `location`, or at the next unused region (the app's "Add region"). */
export async function addRegion(design: Design, appUrl: string, location?: string): Promise<DesignWithLink> {
  const cloud = cloudOf(design.plan);
  let region = nextRegion(design.plan);
  if (location) {
    if (!isKnownRegion(cloud, location)) throw new ApiError(`"${location}" isn't a known ${CLOUDS[cloud].label} region; see list_regions.`);
    if (design.plan.regions.some((r) => r.location === location)) throw new ApiError(`The plan already has a region in ${location}.`);
    region = relocate(cloud, region, location);
  }
  return withLink({ ...design, plan: { ...design.plan, regions: [...design.plan.regions, region] } }, appUrl);
}

/** The spoke templates for a cloud. */
export const spokeTemplateKeys = (cloud: Cloud) => spokeTemplates(cloud).map((t) => ({ template: t.key, label: t.label }));

/** Add a spoke from one of the app's templates to a region (by location or name). */
export async function addSpoke(
  design: Design,
  appUrl: string,
  region: string,
  template: string,
  name?: string,
): Promise<DesignWithLink> {
  const cloud = cloudOf(design.plan);
  const index = design.plan.regions.findIndex((r) => r.location === region || r.name === region);
  if (index < 0) throw new ApiError(`The plan has no region "${region}".`);
  const found = spokeTemplates(cloud).find((t) => t.key === template);
  if (!found)
    throw new ApiError(`Unknown template "${template}"; use one of ${spokeTemplates(cloud).map((t) => t.key).join(', ')}.`);
  const target = design.plan.regions[index];
  const spoke = found.make(target.location);
  if (name?.trim()) spoke.name = name.trim();
  const regions = design.plan.regions.map((r, i) => (i === index ? { ...r, spokes: [...r.spokes, spoke] } : r));
  return withLink({ ...design, plan: { ...design.plan, regions } }, appUrl);
}

/** The regions a plan for the cloud can use. */
export const listRegions = (cloud: Cloud) =>
  regionsByGeography(cloud).flatMap(([geography, regions]) => regions.map((r) => ({ location: r.location, name: r.displayName, geography })));
