// Share a design as a link. The plan and naming options are compressed into
// the URL fragment (#d=...), which browsers never send to the server, so a
// shared design stays as private as the link itself.

import { migratePlan, newId } from './defaults';
import { isPlan } from './designs';
import { DEFAULT_NAMING, type NamingOptions } from './naming';
import type { PlanSpec, RegionSpec, VnetSpec } from './planner';

const FRAGMENT_KEY = 'd';

export interface SharedDesign {
  plan: PlanSpec;
  naming: NamingOptions;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Ids are random, so they barely compress; links leave them out and opening adds fresh ones. */
const withoutIds = (_key: string, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) && 'id' in value
    ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id'))
    : value;

const withVnetIds = (v: VnetSpec): VnetSpec => ({ ...v, id: newId(), subnets: v.subnets.map((s) => ({ ...s, id: newId() })) });

const withIds = (plan: PlanSpec): PlanSpec => ({
  ...plan,
  regions: plan.regions.map(
    (r): RegionSpec => ({ ...r, id: newId(), hub: withVnetIds(r.hub), spokes: r.spokes.map(withVnetIds) }),
  ),
});

/** The fragment (without the leading #) that carries a design. */
export async function encodeDesign(plan: PlanSpec, naming: NamingOptions): Promise<string> {
  const json = JSON.stringify({ v: 1, plan, naming }, withoutIds);
  const packed = await transform(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return `${FRAGMENT_KEY}=${toBase64Url(packed)}`;
}

/** A full link to the app at `location` (its fragment replaced) that opens the design. */
export async function shareUrl(location: string, plan: PlanSpec, naming: NamingOptions): Promise<string> {
  return `${location.split('#')[0]}#${await encodeDesign(plan, naming)}`;
}

/** Whether a URL fragment (with or without the #) carries a shared design. */
export const isShareFragment = (hash: string) => hash.replace(/^#/, '').startsWith(`${FRAGMENT_KEY}=`);

/** Read a design back from a fragment made by `encodeDesign`. Throws with a readable message if it can't. */
export async function decodeDesign(hash: string): Promise<SharedDesign> {
  const broken = new Error('This link is incomplete or damaged, so its design can’t be opened.');
  let data: { v?: unknown; plan?: unknown; naming?: Partial<NamingOptions> };
  try {
    const packed = fromBase64Url(hash.replace(/^#/, '').slice(FRAGMENT_KEY.length + 1));
    const json = new TextDecoder().decode(await transform(packed, new DecompressionStream('deflate-raw')));
    data = JSON.parse(json);
  } catch {
    throw broken;
  }
  if (data?.v !== 1 || !isPlan(data.plan)) throw broken;
  return { plan: withIds(migratePlan(data.plan)), naming: { ...DEFAULT_NAMING, ...(data.naming ?? {}) } };
}
