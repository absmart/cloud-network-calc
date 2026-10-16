// Comparing a plan with what is deployed, for either cloud: match each planned
// network to a deployed one, then report what differs, what is missing, and
// what exists only in the cloud. compareAzure.ts and compareAws.ts turn their
// cloud's export into these shapes and supply the cloud-specific checks.

import type { ImportNote } from './importAzure';
import { type Cidr, overlaps, parseCidr } from './ipv4';

export type DiffStatus = 'different' | 'only-deployed' | 'not-deployed' | 'same';

export type NetworkKind = 'vnet' | 'virtual-hub' | 'vpc' | 'transit-gateway';

export interface NetworkDiff {
  status: DiffStatus;
  kind: NetworkKind;
  /** The planner's name and the name the IaC export gives it. */
  planned?: { name: string; exportedName: string; location: string };
  /** `group` is the resource group (Azure) or account ID (AWS), where known. */
  deployed?: { name: string; location: string; group: string };
  /** How a planned network was matched to a deployed one. */
  matchedBy?: 'name' | 'address space' | 'region';
  /** For a network only in the cloud: whether it overlaps the plan's address space. */
  conflict?: boolean;
  differences: string[];
}

export interface Comparison {
  networks: NetworkDiff[];
  counts: Record<DiffStatus, number>;
  notes: ImportNote[];
}

/** A planned or deployed network, in one shape for matching. */
export interface Side {
  /** Planner name (planned) or the cloud's name (deployed). */
  name: string;
  /** For a planned network, the name the IaC export gives it. */
  exportedName?: string;
  /** Lower-cased names it can be matched by. */
  names: string[];
  kind: NetworkKind;
  location: string;
  prefixes: string[];
  subnets: { name: string; names: string[]; prefix: string; zone?: string | null }[];
}

export interface DeployedSide extends Side {
  id: string;
  /** Resource group (Azure) or account ID (AWS), for display. */
  group: string;
}

export const STATUS_ORDER: DiffStatus[] = ['different', 'only-deployed', 'not-deployed', 'same'];

export const lower = (names: string[]) => [...new Set(names.filter(Boolean).map((n) => n.toLowerCase()))];

const cidrOf = (text: string): Cidr | null => {
  const parsed = parseCidr(text);
  return parsed.ok ? parsed.cidr : null;
};

export const anyOverlap = (a: string[], b: string[]) =>
  a.some((x) =>
    b.some((y) => {
      const cx = cidrOf(x);
      const cy = cidrOf(y);
      return !!cx && !!cy && overlaps(cx, cy);
    }),
  );

/** Address ranges and subnets that differ; `cloud` names the cloud in the messages. */
export function rangeAndSubnetDifferences(planned: Side, deployed: Side, cloud: string, rangeWord: string): string[] {
  const out: string[] = [];
  // Mid-sentence: "address range", but "CIDR block" keeps its acronym.
  const midSentence = /^[A-Z][a-z]/.test(rangeWord) ? rangeWord[0].toLowerCase() + rangeWord.slice(1) : rangeWord;
  for (const p of planned.prefixes) if (!deployed.prefixes.includes(p)) out.push(`${rangeWord} ${p} isn't in ${cloud}`);
  for (const p of deployed.prefixes) if (!planned.prefixes.includes(p)) out.push(`${cloud} also has ${midSentence} ${p}`);

  const matched = new Set<number>();
  for (const s of planned.subnets) {
    const i = deployed.subnets.findIndex((d, j) => !matched.has(j) && d.names.some((n) => s.names.includes(n)));
    if (i < 0) {
      out.push(`Subnet ${s.name} (${s.prefix}) isn't in ${cloud}`);
      continue;
    }
    matched.add(i);
    const d = deployed.subnets[i];
    if (d.prefix !== s.prefix) out.push(`Subnet ${s.name}: planned ${s.prefix}, ${cloud} has ${d.prefix}`);
    if (s.zone && d.zone && s.zone !== d.zone) out.push(`Subnet ${s.name}: planned in ${s.zone}, ${cloud} has it in ${d.zone}`);
  }
  deployed.subnets.forEach((d, j) => {
    if (!matched.has(j)) out.push(`${cloud} also has subnet ${d.name} (${d.prefix})`);
  });
  return out;
}

/**
 * Match planned networks to deployed ones of the same kind: by exported or
 * planner name, then by overlapping address space in the same location (or,
 * for networks without address space, by location alone). `differences`
 * lists what differs in a matched pair.
 */
export function compareSides<P extends Side, D extends DeployedSide>(
  planned: P[],
  deployed: D[],
  differences: (planned: P, deployed: D) => string[],
  notes: ImportNote[],
  omitted: string[],
): Comparison {
  const pairs = new Map<P, D>();
  const taken = new Set<string>();
  const how = new Map<P, NetworkDiff['matchedBy']>();
  const pick = (p: P, test: (d: D) => boolean, by: NetworkDiff['matchedBy']) => {
    const d = deployed.find((d) => !taken.has(d.id) && d.kind === p.kind && test(d));
    if (d) {
      pairs.set(p, d);
      taken.add(d.id);
      how.set(p, by);
    }
  };
  for (const p of planned) pick(p, (d) => d.names.some((n) => p.names.includes(n)), 'name');
  for (const p of planned)
    if (!pairs.has(p)) {
      if (p.prefixes.length) pick(p, (d) => d.location === p.location && anyOverlap(p.prefixes, d.prefixes), 'address space');
      else pick(p, (d) => d.location === p.location, 'region');
    }

  const plannedPrefixes = planned.flatMap((p) => p.prefixes.map((prefix) => ({ prefix, name: p.name })));
  const networks: NetworkDiff[] = [
    ...planned.map((p): NetworkDiff => {
      const d = pairs.get(p);
      const plannedInfo = { name: p.name, exportedName: p.exportedName ?? p.name, location: p.location };
      if (!d) return { status: 'not-deployed', kind: p.kind, planned: plannedInfo, differences: [] };
      const diff = differences(p, d);
      return {
        status: diff.length ? 'different' : 'same',
        kind: p.kind,
        planned: plannedInfo,
        deployed: { name: d.name, location: d.location, group: d.group },
        matchedBy: how.get(p),
        differences: diff,
      };
    }),
    ...deployed
      .filter((d) => !taken.has(d.id))
      .map((d): NetworkDiff => {
        const clashes = plannedPrefixes.filter((p) => anyOverlap([p.prefix], d.prefixes));
        return {
          status: 'only-deployed',
          kind: d.kind,
          deployed: { name: d.name, location: d.location, group: d.group },
          conflict: clashes.length > 0,
          differences: clashes.map((c) => `Overlaps planned ${c.prefix} (${c.name})`),
        };
      }),
  ];
  networks.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  if (omitted.length) notes.push({ level: 'info', message: `Not compared, because the plan doesn't allocate them: ${omitted.join(', ')}` });
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, networks.filter((n) => n.status === s).length])) as Record<
    DiffStatus,
    number
  >;
  return { networks, counts, notes };
}
