// Compare a plan with what is deployed in Azure: the same exported JSON the
// importer reads, checked against the IaC model (the plan as it would deploy).

import type { IacModel } from './iac';
import { type FoundVnet, type ImportNote, readAzureNetwork } from './importAzure';
import { type Cidr, formatCidr, overlaps, parseCidr } from './ipv4';

export type DiffStatus = 'different' | 'only-in-azure' | 'not-deployed' | 'same';

export interface NetworkDiff {
  status: DiffStatus;
  kind: 'vnet' | 'virtual-hub';
  /** The planner's name and the name the IaC export gives it. */
  planned?: { name: string; exportedName: string; location: string };
  deployed?: { name: string; location: string; resourceGroup: string };
  /** How a planned network was matched to a deployed one. */
  matchedBy?: 'name' | 'address space';
  /** For a network only in Azure: whether it overlaps the plan's address space. */
  conflict?: boolean;
  differences: string[];
}

export interface Comparison {
  networks: NetworkDiff[];
  counts: Record<DiffStatus, number>;
  notes: ImportNote[];
}

/** Planned or deployed, in one shape for matching. */
interface Side {
  name: string;
  /** For a planned network, the name the IaC export gives it. */
  exportedName?: string;
  /** Lower-cased names it can be matched by. */
  names: string[];
  kind: 'vnet' | 'virtual-hub';
  location: string;
  prefixes: string[];
  /** Subnet → its CIDR, with the names each can be matched by. */
  subnets: { name: string; names: string[]; prefix: string }[];
}

const STATUS_ORDER: DiffStatus[] = ['different', 'only-in-azure', 'not-deployed', 'same'];

const lower = (names: string[]) => [...new Set(names.map((n) => n.toLowerCase()))];

const cidrOf = (text: string): Cidr | null => {
  const parsed = parseCidr(text);
  return parsed.ok ? parsed.cidr : null;
};

const anyOverlap = (a: string[], b: string[]) =>
  a.some((x) => b.some((y) => {
    const cx = cidrOf(x);
    const cy = cidrOf(y);
    return !!cx && !!cy && overlaps(cx, cy);
  }));


function plannedSides(model: IacModel): Side[] {
  return [
    ...model.vnets.map(
      (v): Side => ({
        name: v.plannerName,
        exportedName: v.name,
        names: lower([v.name, v.plannerName]),
        kind: 'vnet',
        location: v.location,
        prefixes: v.prefixes,
        subnets: v.subnets.map((s) => ({ name: s.plannerName, names: lower([s.name, s.plannerName]), prefix: s.prefix })),
      }),
    ),
    ...model.virtualHubs.map(
      (h): Side => ({
        name: h.plannerName,
        exportedName: h.name,
        names: lower([h.name, h.plannerName]),
        kind: 'virtual-hub',
        location: h.location,
        prefixes: [h.prefix],
        subnets: [],
      }),
    ),
  ];
}

function vnetDifferences(planned: Side, deployed: Side): string[] {
  const out: string[] = [];
  if (planned.location !== deployed.location) out.push(`Location: planned ${planned.location}, Azure has ${deployed.location}`);
  for (const p of planned.prefixes)
    if (!deployed.prefixes.includes(p)) out.push(`Address range ${p} isn't in Azure`);
  for (const p of deployed.prefixes)
    if (!planned.prefixes.includes(p)) out.push(`Azure also has address range ${p}`);

  const matched = new Set<number>();
  for (const s of planned.subnets) {
    const i = deployed.subnets.findIndex((d, j) => !matched.has(j) && d.names.some((n) => s.names.includes(n)));
    if (i < 0) {
      out.push(`Subnet ${s.name} (${s.prefix}) isn't in Azure`);
      continue;
    }
    matched.add(i);
    if (deployed.subnets[i].prefix !== s.prefix)
      out.push(`Subnet ${s.name}: planned ${s.prefix}, Azure has ${deployed.subnets[i].prefix}`);
  }
  deployed.subnets.forEach((d, j) => {
    if (!matched.has(j)) out.push(`Azure also has subnet ${d.name} (${d.prefix})`);
  });
  return out;
}

/**
 * Compare the plan (as its IaC model, so names are the exported ones) with
 * exported Azure network JSON. Planned networks are matched to deployed ones
 * by exported or planner name, then by overlapping address space in the same
 * location. Throws, like the importer, if the JSON holds no networks.
 */
export function compareWithAzure(model: IacModel, input: string): Comparison {
  const { vnets, hubs, notes } = readAzureNetwork(input);
  const deployedVnet = (v: FoundVnet): Side & { id: string; resourceGroup: string } => ({
    id: v.id,
    resourceGroup: v.resourceGroup,
    name: v.name,
    names: lower([v.name]),
    kind: 'vnet',
    location: v.location,
    prefixes: [v.cidr, ...v.extra].map(formatCidr),
    subnets: v.subnets.map((s) => ({ name: s.name, names: lower([s.name]), prefix: formatCidr(s.cidr) })),
  });
  const deployed = [
    ...[...vnets.values()].map(deployedVnet),
    ...[...hubs.values()].map((h) => ({
      id: h.id,
      resourceGroup: h.resourceGroup,
      name: h.name,
      names: lower([h.name]),
      kind: 'virtual-hub' as const,
      location: h.location,
      prefixes: [formatCidr(h.cidr)],
      subnets: [],
    })),
  ];
  const planned = plannedSides(model);

  const pairs = new Map<Side, (typeof deployed)[number]>();
  const taken = new Set<string>();
  const pick = (p: Side, test: (d: (typeof deployed)[number]) => boolean) => {
    const d = deployed.find((d) => !taken.has(d.id) && d.kind === p.kind && test(d));
    if (d) {
      pairs.set(p, d);
      taken.add(d.id);
    }
    return !!d;
  };
  const byName = new Set<Side>();
  for (const p of planned) if (pick(p, (d) => d.names.some((n) => p.names.includes(n)))) byName.add(p);
  for (const p of planned)
    if (!pairs.has(p)) pick(p, (d) => d.location === p.location && anyOverlap(p.prefixes, d.prefixes));

  const plannedPrefixes = planned.flatMap((p) => p.prefixes.map((prefix) => ({ prefix, name: p.name })));
  const networks: NetworkDiff[] = [
    ...planned.map((p): NetworkDiff => {
      const d = pairs.get(p);
      const plannedInfo = { name: p.name, exportedName: p.exportedName!, location: p.location };
      if (!d) return { status: 'not-deployed', kind: p.kind, planned: plannedInfo, differences: [] };
      const differences = vnetDifferences(p, d);
      return {
        status: differences.length ? 'different' : 'same',
        kind: p.kind,
        planned: plannedInfo,
        deployed: { name: d.name, location: d.location, resourceGroup: d.resourceGroup },
        matchedBy: byName.has(p) ? 'name' : 'address space',
        differences,
      };
    }),
    ...deployed
      .filter((d) => !taken.has(d.id))
      .map((d): NetworkDiff => {
        const clashes = plannedPrefixes.filter((p) => anyOverlap([p.prefix], d.prefixes));
        return {
          status: 'only-in-azure',
          kind: d.kind,
          deployed: { name: d.name, location: d.location, resourceGroup: d.resourceGroup },
          conflict: clashes.length > 0,
          differences: clashes.map((c) => `Overlaps planned ${c.prefix} (${c.name})`),
        };
      }),
  ];
  networks.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  if (model.omitted.length)
    notes.push({ level: 'info', message: `Not compared, because the plan doesn't allocate them: ${model.omitted.join(', ')}` });
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, networks.filter((n) => n.status === s).length])) as Record<
    DiffStatus,
    number
  >;
  return { networks, counts, notes };
}
