// The plan model (what the user edits) and the computed allocation (what we show).

import {
  type AllocRequest,
  type AllocResult,
  type Blocked,
  type Cidr,
  allocate,
  blockSize,
  contains,
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
  /**
   * The VNet address range the subnet belongs to: 0 or missing for the main
   * range, n for `VnetSpec.ranges[n - 1]`. `offset` is relative to that range.
   * Missing on an automatically placed subnet means any range, main first.
   */
  range?: number;
  /** Put in the hub by the "hub" platform layout; replaced when the region's platform layout changes. */
  platform?: boolean;
}

/** A free block the visual editor has divided out, relative to the base of its address range. */
export interface Split {
  offset: number;
  prefix: number;
  /** As `SubnetSpec.range`; missing means the main range. */
  range?: number;
}

/** An extra address range of a VNet, beside its main one (Azure VNets can have several). */
export interface RangeSpec {
  prefix: number;
  fixed?: string;
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
  /** The main address range: its size, or a pinned CIDR. */
  prefix: number;
  fixed?: string;
  /** Extra address ranges, placed in the region after every VNet's main range. Not for virtual hubs. */
  ranges?: RangeSpec[];
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

/** Address space the plan must keep clear: on-premises, other clouds, partner networks. */
export interface ExcludedRange {
  cidr: string;
  label?: string;
}

export interface PlanSpec {
  version: 1;
  name: string;
  root: string;
  regions: RegionSpec[];
  /** Kept clear of every VNet. Regions are placed around them, but a pinned region may enclose one. */
  excluded?: ExcludedRange[];
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
  /** Every address range, main first (`cidr` is the main one); null where one couldn't be allocated. */
  ranges: (Cidr | null)[];
  subnets: SubnetResult[];
  /** Free space in all of the VNet's ranges. */
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
  /** Free space in the root, not counting excluded ranges. */
  free: Cidr[];
  /** The plan's valid excluded ranges. */
  excluded: Blocked[];
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

/** Parse the excluded ranges, reporting any that aren't valid CIDRs. */
function parseExcluded(list: ExcludedRange[], issues: Issue[]): Blocked[] {
  return list.flatMap((e, i) => {
    const label = e.label?.trim() || `excluded range ${i + 1}`;
    if (!e.cidr.trim()) return [];
    const parsed = parseCidr(e.cidr);
    if (parsed.ok) return [{ cidr: parsed.cidr, label }];
    issues.push(error(`Excluded range "${label}": ${parsed.error}`));
    return [];
  });
}

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
  const excluded = parseExcluded(plan.excluded ?? [], issues);
  const allocs = root ? allocate(root, requests, excluded, { mayEnclose: true }) : null;
  const regions = plan.regions.map((r, i) =>
    computeRegion(r, take(allocs?.[i], regionIssues[i]), regionIssues[i], excluded),
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

  const taken = [...allocated(regions), ...excluded.map((e) => e.cidr)];
  return { root, issues, regions, free: root ? freeBlocks(root, taken) : [], excluded };
}

function computeRegion(spec: RegionSpec, cidr: Cidr | null, issues: Issue[], excluded: Blocked[]): RegionResult {
  const vnets = [spec.hub, ...spec.spokes];
  const vnetIssues = vnets.map((): Issue[] => []);
  const kinds = vnets.map((_, i): VnetKind => (i > 0 ? 'spoke' : spec.topology === 'vwan' ? 'virtual-hub' : 'hub'));
  const requests = vnets.map((v, i) => toRequest(v.prefix, v.fixed, vnetIssues[i]));
  // Extra address ranges come after every main range, so adding one never moves a VNet.
  const extras = vnets.flatMap((v, i) =>
    kinds[i] === 'virtual-hub'
      ? []
      : (v.ranges ?? []).map((r, k) => {
          const rangeIssues: Issue[] = [];
          return { vnet: i, range: k + 1, issues: rangeIssues, request: toRequest(r.prefix, r.fixed, rangeIssues) };
        }),
  );
  const allocs = cidr ? allocate(cidr, [...requests, ...extras.map((e) => e.request)], excluded) : null;
  const extraCidrs = extras.map((e, j) => {
    const c = take(allocs?.[vnets.length + j], e.issues);
    vnetIssues[e.vnet].push(...e.issues.map((x) => ({ ...x, message: `Address range ${e.range + 1}: ${x.message}` })));
    return c;
  });
  const results = vnets.map((v, i) => {
    const ranges = extras.flatMap((e, j) => (e.vnet === i ? [extraCidrs[j]] : []));
    return computeVnet(v, kinds[i], requests[i].prefix, take(allocs?.[i], vnetIssues[i]), ranges, vnetIssues[i]);
  });

  const used = results.flatMap((v) => v.ranges.filter((c): c is Cidr => c !== null));
  return {
    id: spec.id,
    name: spec.name,
    cidr,
    issues,
    hub: results[0],
    spokes: results.slice(1),
    free: cidr ? freeBlocks(cidr, [...used, ...excluded.map((e) => e.cidr)]) : [],
  };
}

/**
 * Place a VNet's subnets in its address ranges. A pinned subnet goes in the
 * range that holds it, one with a `range` only in that range, and any other
 * first-fit in the main range, then in each extra range in turn.
 */
function allocateSubnets(spec: VnetSpec, ranges: (Cidr | null)[], requests: AllocRequest[]): (AllocResult | undefined)[] {
  const out: (AllocResult | undefined)[] = new Array(requests.length);
  const placed = ranges.flatMap((c, k) => (c ? [k] : []));
  if (placed.length === 0) return out;
  const home = requests.map((req, i): number | null => {
    if (req.fixed) {
      const k = placed.find((k) => contains(ranges[k]!, req.fixed!));
      if (k === undefined) out[i] = { error: `${formatCidr(req.fixed)} is outside ${placed.map((k) => formatCidr(ranges[k]!)).join(', ')}` };
      return k ?? -1;
    }
    return spec.subnets[i].range ?? null;
  });
  // Subnets free to go in any range, still looking for room.
  const roaming = new Set(requests.flatMap((_, i) => (home[i] === null ? [i] : [])));
  placed.forEach((k, n) => {
    const members = requests.flatMap((_, i) => (home[i] === k || roaming.has(i) ? [i] : []));
    const results = allocate(ranges[k]!, members.map((i) => requests[i]));
    const last = n === placed.length - 1;
    members.forEach((i, j) => {
      if (roaming.has(i) && 'error' in results[j] && !last) return;
      out[i] = results[j];
      roaming.delete(i);
    });
  });
  // A subnet in a range that isn't allocated stays unplaced, like one in an
  // unallocated VNet; the range's own issue says why.
  home.forEach((k, i) => {
    if (!out[i] && k !== null && k >= ranges.length) out[i] = { error: `The VNet has no address range ${k + 1}` };
  });
  return out;
}

function computeVnet(
  spec: VnetSpec,
  kind: VnetKind,
  prefix: number,
  cidr: Cidr | null,
  extraRanges: (Cidr | null)[],
  issues: Issue[],
): VnetResult {
  const ranges = [cidr, ...extraRanges];
  const base = { id: spec.id, name: spec.name, cidr, ranges, issues, kind };

  if (kind === 'virtual-hub') {
    if (prefix > VWAN_HUB_MIN_PREFIX)
      issues.push(error(`Virtual WAN hubs need a /${VWAN_HUB_MIN_PREFIX} or larger`));
    else if (prefix > VWAN_HUB_RECOMMENDED_PREFIX)
      issues.push(warning(`Microsoft recommends a /${VWAN_HUB_RECOMMENDED_PREFIX} for Virtual WAN hubs`));
    return { ...base, subnets: [], free: [] };
  }

  const subnetIssues = spec.subnets.map((): Issue[] => []);
  const requests = spec.subnets.map((s, i) => subnetRequest(s, ranges[s.range ?? 0] ?? null, subnetIssues[i]));
  const allocs = allocateSubnets(spec, ranges, requests);
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

  const used = allocated(subnets);
  return { ...base, subnets, free: ranges.flatMap((r) => (r ? freeBlocks(r, used) : [])) };
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
