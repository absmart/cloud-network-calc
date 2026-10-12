// The plan model (what the user edits) and the computed allocation (what we show).

import {
  type AllocRequest,
  type AllocResult,
  type Cidr,
  allocate,
  blockSize,
  formatCidr,
  freeBlocks,
  parseCidr,
} from './ipv4';
import {
  AZURE_RESERVED_IPS,
  SMALLEST_SUBNET_PREFIX,
  VWAN_HUB_MIN_PREFIX,
  VWAN_HUB_RECOMMENDED_PREFIX,
  forbiddenOverlap,
  isPrivate,
  presetForName,
} from './azure';

export type Topology = 'hub-spoke' | 'vwan';

export interface SubnetSpec {
  id: string;
  name: string;
  prefix: number;
  /** Pinned CIDR; empty means "allocate automatically". */
  fixed?: string;
  /**
   * Position within the VNet (address offset from the VNet's base), set by
   * the visual editor. Relative, so the layout survives the VNet moving.
   */
  offset?: number;
  /** Put in the hub by the "hub" platform layout; replaced when the region's platform layout changes. */
  platform?: boolean;
}

/** A free block the visual editor has divided out, relative to the VNet base. */
export interface Split {
  offset: number;
  prefix: number;
}

/** What a spoke is for. Platform roles are swapped when the region's platform layout changes. */
export type VnetRole = 'platform' | 'identity' | 'management' | 'security' | 'landing-zone';

/**
 * Platform landing zones as separate identity/management/security VNets, one
 * combined VNet, or subnets in the hub VNet itself (hub & spoke only).
 */
export type PlatformLayout = 'separate' | 'combined' | 'hub';

export interface VnetSpec {
  id: string;
  name: string;
  /** Spokes only; missing means landing zone. */
  role?: VnetRole;
  prefix: number;
  fixed?: string;
  subnets: SubnetSpec[];
  /** Free-space divisions made in the visual editor. */
  splits?: Split[];
}

export interface RegionSpec {
  id: string;
  name: string;
  location: string;
  prefix: number;
  fixed?: string;
  topology: Topology;
  /** Hub VNet (hub-spoke) or Virtual WAN hub (vwan). */
  hub: VnetSpec;
  spokes: VnetSpec[];
}

export interface PlanSpec {
  version: 1;
  name: string;
  root: string;
  regions: RegionSpec[];
}

export interface Issue {
  level: 'error' | 'warning';
  message: string;
}

export interface NodeResult {
  id: string;
  name: string;
  cidr: Cidr | null;
  issues: Issue[];
}

export interface SubnetResult extends NodeResult {
  usable: number;
}

export type VnetKind = 'hub' | 'virtual-hub' | 'spoke';

export interface VnetResult extends NodeResult {
  kind: VnetKind;
  subnets: SubnetResult[];
  free: Cidr[];
}

export interface RegionResult extends NodeResult {
  hub: VnetResult;
  spokes: VnetResult[];
  free: Cidr[];
}

export interface PlanResult {
  root: Cidr | null;
  issues: Issue[];
  regions: RegionResult[];
  free: Cidr[];
}

const error = (message: string): Issue => ({ level: 'error', message });
const warning = (message: string): Issue => ({ level: 'warning', message });

function toRequest(prefix: number, fixed: string | undefined, issues: Issue[]): AllocRequest {
  if (fixed?.trim()) {
    const parsed = parseCidr(fixed);
    if (parsed.ok) return { prefix: parsed.cidr.prefix, fixed: parsed.cidr };
    issues.push(error(`Pinned range ignored: ${parsed.error}`));
  }
  return { prefix };
}

function subnetRequest(spec: SubnetSpec, vnet: Cidr | null, issues: Issue[]): AllocRequest {
  if (spec.fixed?.trim() || spec.offset === undefined || !vnet) return toRequest(spec.prefix, spec.fixed, issues);
  const size = blockSize(spec.prefix);
  if (spec.offset % size !== 0 || spec.offset + size > blockSize(vnet.prefix)) {
    issues.push(warning('No longer fits its position in the VNet; placed automatically'));
    return { prefix: spec.prefix };
  }
  return { prefix: spec.prefix, fixed: { base: vnet.base + spec.offset, prefix: spec.prefix } };
}

function take(result: AllocResult | undefined, issues: Issue[]): Cidr | null {
  if (!result) return null;
  if ('error' in result) {
    issues.push(error(result.error));
    return null;
  }
  return result.cidr;
}

const allocated = (nodes: NodeResult[]) =>
  nodes.map((n) => n.cidr).filter((c): c is Cidr => c !== null);

export function computePlan(plan: PlanSpec): PlanResult {
  const issues: Issue[] = [];
  let root: Cidr | null = null;
  const parsed = parseCidr(plan.root);
  if (!parsed.ok) {
    issues.push(error(`Root range: ${parsed.error}`));
  } else {
    root = parsed.cidr;
    const forbidden = forbiddenOverlap(root);
    if (forbidden) issues.push(error(`Root range overlaps reserved ${forbidden} space`));
    else if (!isPrivate(root))
      issues.push(warning('Root range is not private (RFC 1918 / RFC 6598) address space'));
  }

  const regionIssues = plan.regions.map((): Issue[] => []);
  const requests = plan.regions.map((r, i) => toRequest(r.prefix, r.fixed, regionIssues[i]));
  const allocs = root ? allocate(root, requests) : null;
  const regions = plan.regions.map((r, i) =>
    computeRegion(r, take(allocs?.[i], regionIssues[i]), regionIssues[i]),
  );

  if (root && regions.some((r) => !r.cidr)) {
    const needed = requests.reduce((n, req) => n + blockSize(req.prefix), 0);
    let prefix = root.prefix;
    while (prefix > 0 && blockSize(prefix) < needed) prefix--;
    if (prefix < root.prefix) {
      const grown = { base: root.base - (root.base % blockSize(prefix)), prefix };
      issues.push(
        error(
          `${formatCidr(root)} is too small for ${plan.regions.length} regions; widen it to at least ${formatCidr(grown)}`,
        ),
      );
    }
  }

  const locationCounts = new Map<string, number>();
  for (const r of plan.regions) locationCounts.set(r.location, (locationCounts.get(r.location) ?? 0) + 1);
  plan.regions.forEach((r, i) => {
    if ((locationCounts.get(r.location) ?? 0) > 1)
      regionIssues[i].push(warning(`Another region also uses location "${r.location}"`));
  });

  return { root, issues, regions, free: root ? freeBlocks(root, allocated(regions)) : [] };
}

function computeRegion(spec: RegionSpec, cidr: Cidr | null, issues: Issue[]): RegionResult {
  const vnets = [spec.hub, ...spec.spokes];
  const vnetIssues = vnets.map((): Issue[] => []);
  const requests = vnets.map((v, i) => toRequest(v.prefix, v.fixed, vnetIssues[i]));
  const allocs = cidr ? allocate(cidr, requests) : null;
  const results = vnets.map((v, i) => {
    const kind: VnetKind = i > 0 ? 'spoke' : spec.topology === 'vwan' ? 'virtual-hub' : 'hub';
    return computeVnet(v, kind, requests[i].prefix, take(allocs?.[i], vnetIssues[i]), vnetIssues[i]);
  });

  return {
    id: spec.id,
    name: spec.name,
    cidr,
    issues,
    hub: results[0],
    spokes: results.slice(1),
    free: cidr ? freeBlocks(cidr, allocated(results)) : [],
  };
}

function computeVnet(
  spec: VnetSpec,
  kind: VnetKind,
  prefix: number,
  cidr: Cidr | null,
  issues: Issue[],
): VnetResult {
  const base = { id: spec.id, name: spec.name, cidr, issues, kind };

  if (kind === 'virtual-hub') {
    if (prefix > VWAN_HUB_MIN_PREFIX)
      issues.push(error(`Virtual WAN hubs need a /${VWAN_HUB_MIN_PREFIX} or larger`));
    else if (prefix > VWAN_HUB_RECOMMENDED_PREFIX)
      issues.push(warning(`Microsoft recommends a /${VWAN_HUB_RECOMMENDED_PREFIX} for Virtual WAN hubs`));
    return { ...base, subnets: [], free: [] };
  }

  const subnetIssues = spec.subnets.map((): Issue[] => []);
  const requests = spec.subnets.map((s, i) => subnetRequest(s, cidr, subnetIssues[i]));
  const allocs = cidr ? allocate(cidr, requests) : null;
  const nameCounts = new Map<string, number>();
  for (const s of spec.subnets) {
    const key = s.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const subnets = spec.subnets.map((s, i): SubnetResult => {
    const own = subnetIssues[i];
    const p = requests[i].prefix;
    if (!s.name.trim()) own.push(error('Subnet needs a name'));
    else if ((nameCounts.get(s.name.trim().toLowerCase()) ?? 0) > 1)
      own.push(error(`Duplicate subnet name "${s.name}" in this VNet`));
    if (p > SMALLEST_SUBNET_PREFIX)
      own.push(error(`Azure subnets must be /${SMALLEST_SUBNET_PREFIX} or larger`));

    const preset = presetForName(s.name);
    if (preset) {
      if (s.name !== preset.name) own.push(error(`Azure requires the exact name "${preset.name}"`));
      if (p > preset.minPrefix) own.push(error(`${preset.name} must be /${preset.minPrefix} or larger`));
      else if (p > preset.defaultPrefix)
        own.push(warning(`/${preset.defaultPrefix} or larger is recommended for ${preset.name}`));
      if (preset.hubOnly && kind === 'spoke')
        own.push(warning(`${preset.name} normally lives in the connectivity hub, not a spoke`));
    }

    const subnetCidr = take(allocs?.[i], own);
    return {
      id: s.id,
      name: s.name,
      cidr: subnetCidr,
      issues: own,
      usable: Math.max(0, blockSize(p) - AZURE_RESERVED_IPS),
    };
  });

  return { ...base, subnets, free: cidr ? freeBlocks(cidr, allocated(subnets)) : [] };
}

function regionIssues(region: RegionResult): Issue[] {
  const all = [...region.issues];
  for (const vnet of [region.hub, ...region.spokes]) {
    all.push(...vnet.issues);
    for (const subnet of vnet.subnets) all.push(...subnet.issues);
  }
  return all;
}

export function countIssues(result: PlanResult | RegionResult): { errors: number; warnings: number } {
  const all = 'regions' in result ? [...result.issues, ...result.regions.flatMap(regionIssues)] : regionIssues(result);
  return {
    errors: all.filter((i) => i.level === 'error').length,
    warnings: all.filter((i) => i.level === 'warning').length,
  };
}
