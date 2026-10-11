// Visual subnet layout, in the style of visualsubnetcalc.com: a VNet's range
// is a binary tree of blocks. Its leaves (the table rows) are either a subnet
// or free space; any leaf can be divided in half and any node joined back.
//
// Nothing here is stored as a tree. Leaves are derived from the allocated
// subnets plus the free space around them, refined by the `splits` the user
// made in free space. Edits write subnet `offset`s and `splits` back to the spec.

import { newId } from './defaults';
import { type Cidr, blockSize, contains, formatCidr, freeBlocks, parseCidr } from './ipv4';
import type { SubnetSpec, VnetResult, VnetSpec } from './planner';

export interface Leaf {
  cidr: Cidr;
  /** Index into the VNet's subnets, or null for free space. */
  subnet: number | null;
}

export const halves = (c: Cidr): [Cidr, Cidr] => [
  { base: c.base, prefix: c.prefix + 1 },
  { base: c.base + blockSize(c.prefix + 1), prefix: c.prefix + 1 },
];

/** The enclosing block of `c` with the given (shorter) prefix. */
export const ancestor = (c: Cidr, prefix: number): Cidr => ({
  base: c.base - (c.base % blockSize(prefix)),
  prefix,
});

const sameCidr = (a: Cidr, b: Cidr) => a.base === b.base && a.prefix === b.prefix;

function splitCidrs(spec: VnetSpec, vnet: Cidr): Cidr[] {
  return (spec.splits ?? [])
    .map((s) => ({ base: vnet.base + s.offset, prefix: s.prefix }))
    .filter((c) => c.prefix >= vnet.prefix && c.prefix <= 32 && c.base % blockSize(c.prefix) === 0 && contains(vnet, c));
}

/** Divide the free leaf containing `target` until `target` is a leaf itself. */
function refine(free: Cidr[], target: Cidr): Cidr[] {
  const i = free.findIndex((f) => contains(f, target));
  if (i < 0) return free; // Overlaps a subnet now; ignore the stale split.
  const pieces: Cidr[] = [];
  let leaf = free[i];
  while (leaf.prefix < target.prefix) {
    const [a, b] = halves(leaf);
    if (contains(a, target)) {
      pieces.push(b);
      leaf = a;
    } else {
      pieces.push(a);
      leaf = b;
    }
  }
  pieces.push(leaf);
  return [...free.slice(0, i), ...pieces, ...free.slice(i + 1)];
}

export function vnetLeaves(spec: VnetSpec, result: VnetResult): Leaf[] {
  const vnet = result.cidr;
  if (!vnet) return [];
  const named: Leaf[] = [];
  result.subnets.forEach((s, i) => {
    if (s.cidr) named.push({ cidr: s.cidr, subnet: i });
  });
  let free = freeBlocks(vnet, named.map((l) => l.cidr));
  for (const target of splitCidrs(spec, vnet)) free = refine(free, target);
  return [...named, ...free.map((cidr) => ({ cidr, subnet: null }))].sort((a, b) => a.cidr.base - b.cidr.base);
}

const hasPin = (s: SubnetSpec) => !!s.fixed?.trim() && parseCidr(s.fixed).ok;

/** Move a subnet to `cidr`, keeping an absolute pin absolute. */
function place(s: SubnetSpec, cidr: Cidr, vnet: Cidr): SubnetSpec {
  return hasPin(s)
    ? { ...s, prefix: cidr.prefix, fixed: formatCidr(cidr), offset: undefined }
    : { ...s, prefix: cidr.prefix, fixed: undefined, offset: cidr.base - vnet.base };
}

/** Freeze every automatically placed subnet where it is, so visual edits don't shuffle others. */
function locked(spec: VnetSpec, result: VnetResult, vnet: Cidr): SubnetSpec[] {
  return spec.subnets.map((s, i) => {
    const c = result.subnets[i]?.cidr;
    return c && !hasPin(s) && s.offset === undefined ? { ...s, offset: c.base - vnet.base } : s;
  });
}

function withSplits(spec: VnetSpec, subnets: SubnetSpec[], splits: Cidr[], vnet: Cidr): VnetSpec {
  const unique = splits.filter((c, i) => splits.findIndex((d) => sameCidr(c, d)) === i);
  return { ...spec, subnets, splits: unique.map((c) => ({ offset: c.base - vnet.base, prefix: c.prefix })) };
}

export function divide(spec: VnetSpec, result: VnetResult, leaf: Leaf): VnetSpec {
  const vnet = result.cidr;
  if (!vnet || leaf.cidr.prefix >= 32) return spec;
  const [a, b] = halves(leaf.cidr);
  let subnets = locked(spec, result, vnet);
  const splits = splitCidrs(spec, vnet).filter((s) => !contains(leaf.cidr, s));
  if (leaf.subnet !== null) {
    subnets = subnets.map((s, i) => (i === leaf.subnet ? place(s, a, vnet) : s));
    splits.push(b);
  } else {
    splits.push(a, b);
  }
  return withSplits(spec, subnets, splits, vnet);
}

/** Leaves under `node` that are subnets. Joining is allowed when there is at most one. */
export const subnetsUnder = (leaves: Leaf[], node: Cidr) =>
  leaves.filter((l) => l.subnet !== null && contains(node, l.cidr));

export function join(spec: VnetSpec, result: VnetResult, leaves: Leaf[], node: Cidr): VnetSpec {
  const vnet = result.cidr;
  const named = subnetsUnder(leaves, node);
  if (!vnet || named.length > 1) return spec;
  let subnets = locked(spec, result, vnet);
  const splits = splitCidrs(spec, vnet).filter((s) => !contains(node, s));
  if (named.length === 1) {
    const index = named[0].subnet;
    subnets = subnets.map((s, i) => (i === index ? place(s, node, vnet) : s));
  } else {
    splits.push(node);
  }
  return withSplits(spec, subnets, splits, vnet);
}

/** Turn a free leaf into a new subnet. */
export function assign(spec: VnetSpec, result: VnetResult, leaf: Leaf, name: string): VnetSpec {
  const vnet = result.cidr;
  if (!vnet || leaf.subnet !== null) return spec;
  const subnets = [
    ...locked(spec, result, vnet),
    { id: newId(), name, prefix: leaf.cidr.prefix, offset: leaf.cidr.base - vnet.base },
  ];
  const splits = splitCidrs(spec, vnet).filter((s) => !contains(leaf.cidr, s));
  return withSplits(spec, subnets, splits, vnet);
}

/** Remove a subnet, leaving its block as free space in the same shape. */
export function release(spec: VnetSpec, result: VnetResult, index: number): VnetSpec {
  const vnet = result.cidr;
  if (!vnet) return { ...spec, subnets: spec.subnets.filter((_, i) => i !== index) };
  const subnets = locked(spec, result, vnet).filter((_, i) => i !== index);
  const splits = splitCidrs(spec, vnet);
  const freed = result.subnets[index]?.cidr;
  if (freed) splits.push(freed);
  return withSplits(spec, subnets, splits, vnet);
}

/** Drop all visual placement and pack subnets first-fit again (absolute pins are kept). */
export function autoPack(spec: VnetSpec): VnetSpec {
  return { ...spec, splits: [], subnets: spec.subnets.map((s) => ({ ...s, offset: undefined })) };
}
