// IPv4 / CIDR helpers. Addresses are plain numbers (0 .. 2^32-1); we avoid
// bitwise operators because they work on signed 32-bit integers.

export interface Cidr {
  base: number;
  prefix: number;
}

export type ParseResult = { ok: true; cidr: Cidr } | { ok: false; error: string };

export interface AllocRequest {
  prefix: number;
  fixed?: Cidr;
}

export type AllocResult = { cidr: Cidr } | { error: string };

export const blockSize = (prefix: number) => 2 ** (32 - prefix);

/** Exclusive end address. */
export const endOf = (c: Cidr) => c.base + blockSize(c.prefix);

export function parseIp(text: string): number | null {
  const parts = text.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function formatIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
}

export const formatCidr = (c: Cidr) => `${formatIp(c.base)}/${c.prefix}`;

export function parseCidr(text: string): ParseResult {
  const m = text.trim().match(/^([\d.]+)\/(\d{1,2})$/);
  if (!m) return { ok: false, error: 'Expected the form a.b.c.d/nn' };
  const base = parseIp(m[1]);
  if (base === null) return { ok: false, error: `"${m[1]}" is not a valid IPv4 address` };
  const prefix = Number(m[2]);
  if (prefix > 32) return { ok: false, error: `/${prefix} is not a valid prefix length` };
  const size = blockSize(prefix);
  if (base % size !== 0) {
    const aligned = { base: base - (base % size), prefix };
    return { ok: false, error: `Host bits are set; did you mean ${formatCidr(aligned)}?` };
  }
  return { ok: true, cidr: { base, prefix } };
}

export const contains = (outer: Cidr, inner: Cidr) =>
  inner.base >= outer.base && endOf(inner) <= endOf(outer);

export const overlaps = (a: Cidr, b: Cidr) => a.base < endOf(b) && b.base < endOf(a);

/** The smallest single block that contains every one of `cidrs` (which must not be empty). */
export function supernet(cidrs: Cidr[]): Cidr {
  const start = Math.min(...cidrs.map((c) => c.base));
  const end = Math.max(...cidrs.map(endOf));
  let prefix = Math.min(...cidrs.map((c) => c.prefix));
  while (prefix > 0 && start - (start % blockSize(prefix)) + blockSize(prefix) < end) prefix--;
  return { base: start - (start % blockSize(prefix)), prefix };
}

/** Split the half-open range [start, end) into the fewest aligned CIDR blocks. */
export function rangeToCidrs(start: number, end: number): Cidr[] {
  const out: Cidr[] = [];
  while (start < end) {
    let prefix = 0;
    while (prefix < 32 && (start % blockSize(prefix) !== 0 || start + blockSize(prefix) > end)) {
      prefix++;
    }
    out.push({ base: start, prefix });
    start += blockSize(prefix);
  }
  return out;
}

/** Unallocated space inside `parent`, as aligned CIDR blocks in address order. */
export function freeBlocks(parent: Cidr, used: Cidr[]): Cidr[] {
  const sorted = used.filter((u) => overlaps(parent, u)).sort((a, b) => a.base - b.base);
  const out: Cidr[] = [];
  let cursor = parent.base;
  for (const u of sorted) {
    if (u.base > cursor) out.push(...rangeToCidrs(cursor, u.base));
    cursor = Math.max(cursor, endOf(u));
  }
  if (cursor < endOf(parent)) out.push(...rangeToCidrs(cursor, endOf(parent)));
  return out;
}

/**
 * Aligned blocks of the given prefix inside `parent` that don't overlap
 * `taken`, in address order, up to `limit` of them.
 */
export function availableBlocks(parent: Cidr, prefix: number, taken: Cidr[], limit = 256): Cidr[] {
  const out: Cidr[] = [];
  if (prefix < parent.prefix || prefix > 32) return out;
  const step = blockSize(prefix);
  for (let base = parent.base; base + step <= endOf(parent) && out.length < limit; base += step) {
    const candidate = { base, prefix };
    const clash = taken.find((t) => overlaps(t, candidate));
    if (!clash) out.push(candidate);
    // Skip straight past a large taken block.
    else if (endOf(clash) > base + step) base = Math.ceil(endOf(clash) / step) * step - step;
  }
  return out;
}

/** Address space nothing may be placed in, such as an on-premises range. */
export interface Blocked {
  cidr: Cidr;
  label: string;
}

/**
 * Place child blocks inside `parent`. Pinned (`fixed`) requests are placed
 * first; the rest go first-fit in request order on their natural alignment,
 * so appending a new request never moves the existing ones. Blocks keep out
 * of `blocked` space: automatic ones go round it and a pinned one overlapping
 * it is an error. With `mayEnclose`, a block may still hold blocked space
 * smaller than itself (a region around an excluded /24, which its VNets then
 * avoid), but not overlap blocked space as large as itself or larger.
 */
export function allocate(
  parent: Cidr,
  requests: AllocRequest[],
  blocked: Blocked[] = [],
  { mayEnclose = false } = {},
): AllocResult[] {
  const results: AllocResult[] = new Array(requests.length);
  const used: Cidr[] = [];
  const barriers = blocked.filter((b) => overlaps(parent, b.cidr));
  const barrierIn = (c: Cidr) => barriers.find((b) => overlaps(b.cidr, c) && !(mayEnclose && c.prefix < b.cidr.prefix));

  requests.forEach((req, i) => {
    const fixed = req.fixed;
    if (!fixed) return;
    if (!contains(parent, fixed)) {
      results[i] = { error: `${formatCidr(fixed)} is outside ${formatCidr(parent)}` };
      return;
    }
    const excluded = barrierIn(fixed);
    if (excluded) {
      results[i] = { error: `${formatCidr(fixed)} overlaps excluded range ${formatCidr(excluded.cidr)} (${excluded.label})` };
      return;
    }
    const clash = used.find((u) => overlaps(u, fixed));
    if (clash) {
      results[i] = { error: `${formatCidr(fixed)} overlaps ${formatCidr(clash)}` };
      return;
    }
    used.push(fixed);
    results[i] = { cidr: fixed };
  });

  requests.forEach((req, i) => {
    if (req.fixed) return;
    if (req.prefix < parent.prefix) {
      results[i] = { error: `A /${req.prefix} is larger than its parent ${formatCidr(parent)}` };
      return;
    }
    const step = blockSize(req.prefix);
    const end = endOf(parent);
    let addr = parent.base;
    while (addr + step <= end) {
      const candidate = { base: addr, prefix: req.prefix };
      const clash = used.find((u) => overlaps(u, candidate)) ?? barrierIn(candidate)?.cidr;
      if (!clash) {
        used.push(candidate);
        results[i] = { cidr: candidate };
        return;
      }
      addr = Math.ceil(endOf(clash) / step) * step;
    }
    results[i] = { error: `No room left for a /${req.prefix} in ${formatCidr(parent)}` };
  });

  return results;
}
