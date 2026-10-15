import type { CSSProperties } from 'react';
import {
  SPOKE_TEMPLATES,
  type SpokeTemplate,
  isPlatformVnet,
  platformLayoutOf,
  relocateRegion,
  setPlatformLayout,
  setTopology,
} from '../lib/defaults';
import { type Blocked, type Cidr, availableBlocks, blockSize, formatCidr, parseCidr } from '../lib/ipv4';
import { findRegion, regionsByGeography } from '../lib/regions';
import type { PlatformLayout, RegionResult, RegionSpec, Topology, VnetSpec } from '../lib/planner';
import { AllocationBar, Issues, PrefixSelect, type Segment, excludedSegments } from './common';
import { VnetCard } from './VnetCard';

export function RegionCard(props: {
  spec: RegionSpec;
  result: RegionResult;
  minPrefix: number;
  /** The plan's root range, and the ranges the other regions occupy, for "Move to". */
  root: Cidr | null;
  otherRegionCidrs: Cidr[];
  /** The plan's excluded ranges, shown on the bar and kept out of Move to. */
  excluded: Blocked[];
  color: string;
  /** Locations taken by the plan's other regions → that region's name. */
  usedLocations: Map<string, string>;
  onChange: (spec: RegionSpec) => void;
  onRemove: () => void;
}) {
  const { spec, result, onChange } = props;
  const regionPrefix = result.cidr?.prefix ?? spec.prefix;

  // A pinned region (spec.fixed) sits at a CIDR the user chose; otherwise it
  // takes the next free block of its size.
  const pinned = !!spec.fixed?.trim();
  const pin = pinned ? parseCidr(spec.fixed!) : null;
  const currentPrefix = pin?.ok ? pin.cidr.prefix : spec.prefix;
  const freeBlocks = props.root
    ? availableBlocks(props.root, currentPrefix, [
        ...props.otherRegionCidrs,
        // A region may enclose a smaller excluded range, but not sit on a larger one.
        ...props.excluded.filter((e) => e.cidr.prefix <= currentPrefix).map((e) => e.cidr),
      ]).filter(
        (c) => !result.cidr || c.base !== result.cidr.base || c.prefix !== result.cidr.prefix,
      )
    : [];

  /** Resize; a pinned region keeps its start address, aligned down to the new size. */
  const setSize = (prefix: number) => {
    if (!pin?.ok) return onChange({ ...spec, prefix });
    const size = blockSize(prefix);
    onChange({ ...spec, prefix, fixed: formatCidr({ base: pin.cidr.base - (pin.cidr.base % size), prefix }) });
  };

  const platformLayout = platformLayoutOf(spec);
  const updateSpoke = (index: number, vnet: VnetSpec) =>
    onChange({ ...spec, spokes: spec.spokes.map((s, i) => (i === index ? vnet : s)) });

  const vnetResults = [result.hub, ...result.spokes];
  const pairedLocation = findRegion(spec.location)?.paired;
  const paired = pairedLocation ? findRegion(pairedLocation) : undefined;

  return (
    <article className="region" id={`region-${spec.id}`} style={{ '--region-color': props.color } as CSSProperties}>
      <header className="region-banner">
        <div className="row">
          <span className="swatch" />
          <input
            className="region-name"
            value={spec.name}
            onChange={(e) => onChange({ ...spec, name: e.target.value })}
          />
          <span className="region-cidr">
            <input
              className={pinned ? 'pinned' : ''}
              value={pinned ? spec.fixed : result.cidr ? formatCidr(result.cidr) : ''}
              placeholder="auto"
              aria-label="Region CIDR"
              title="The region's address range. Type a CIDR to pin the region there; clear it to place it automatically."
              onChange={(e) => onChange({ ...spec, fixed: e.target.value })}
            />
            {pinned ? (
              <button className="chip" title="Stop pinning; place the region automatically" onClick={() => onChange({ ...spec, fixed: undefined })}>
                pinned ✕
              </button>
            ) : (
              <span className="chip auto" title="Placed automatically in the next free block">
                auto
              </span>
            )}
          </span>
          <span className="region-meta">
            {spec.hub.name} · {spec.spokes.length} spokes · platform {platformLayout === 'hub' ? 'in hub' : platformLayout}
          </span>
          <button className="icon" title="Remove region" onClick={props.onRemove}>
            ✕
          </button>
        </div>
        <div className="row">
          <label>
            Location
            <select value={spec.location} onChange={(e) => onChange(relocateRegion(spec, e.target.value))}>
              {!findRegion(spec.location) && <option value={spec.location}>{spec.location}</option>}
              {regionsByGeography().map(([geography, regions]) => (
                <optgroup key={geography} label={geography}>
                  {regions.map((r) => {
                    const usedBy = props.usedLocations.get(r.location);
                    return (
                      <option key={r.location} value={r.location} disabled={!!usedBy}>
                        {r.displayName}
                        {usedBy ? ` (used by ${usedBy})` : ''}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </label>
          {paired && (
            <span className="muted" title="Azure paired region, commonly used as the secondary ALZ region">
              Pair: {paired.displayName}
              {props.usedLocations.has(paired.location) ? ' ✓' : ''}
            </span>
          )}
          <label>
            Size
            <PrefixSelect value={currentPrefix} min={props.minPrefix} max={24} onChange={setSize} />
          </label>
          <label title="Pin the region to a free block of its size in the root address space">
            Move to
            <select
              value=""
              disabled={freeBlocks.length === 0}
              onChange={(e) => e.target.value && onChange({ ...spec, fixed: e.target.value, prefix: currentPrefix })}
            >
              <option value="">
                {freeBlocks.length ? `${freeBlocks.length}${freeBlocks.length === 256 ? '+' : ''} free /${currentPrefix} blocks…` : `No free /${currentPrefix} blocks`}
              </option>
              {freeBlocks.map((c) => (
                <option key={c.base} value={formatCidr(c)}>
                  {formatCidr(c)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Topology
            <select value={spec.topology} onChange={(e) => onChange(setTopology(spec, e.target.value as Topology))}>
              <option value="hub-spoke">Hub &amp; spoke</option>
              <option value="vwan">Virtual WAN</option>
            </select>
          </label>
          <label title="Separate identity, management and security VNets, one shared platform VNet, or platform subnets in the hub VNet. Switching replaces the platform VNets and hub platform subnets; landing zones are kept.">
            Platform networks
            <select
              value={platformLayout}
              onChange={(e) => onChange(setPlatformLayout(spec, e.target.value as PlatformLayout))}
            >
              <option value="separate">Separate: identity / management / security</option>
              <option value="combined">Combined: one platform VNet</option>
              <option value="hub" disabled={spec.topology === 'vwan'}>
                In the hub: platform subnets in the hub VNet{spec.topology === 'vwan' ? ' (hub & spoke only)' : ''}
              </option>
            </select>
          </label>
        </div>
      </header>
      <Issues issues={result.issues} />

      <AllocationBar
        parent={result.cidr}
        free={result.free}
        segments={vnetResults.flatMap((v, i) =>
          v.ranges.map((cidr, k): Segment => ({
            id: k ? `${v.id}-${k}` : v.id,
            label: k ? `${v.name} (range ${k + 1})` : v.name,
            cidr,
            tone: v.kind !== 'spoke' ? 'hub' : isPlatformVnet(spec.spokes[i - 1]) ? 'platform' : 'spoke',
          })),
        ).concat(excludedSegments(props.excluded))}
      />

      <VnetCard
        spec={spec.hub}
        result={result.hub}
        minPrefix={regionPrefix}
        onChange={(hub) => onChange({ ...spec, hub })}
      />
      {spec.spokes.map((spoke, i) => (
        <VnetCard
          key={spoke.id}
          spec={spoke}
          result={result.spokes[i]}
          minPrefix={regionPrefix}
          onChange={(v) => updateSpoke(i, v)}
          onRemove={() => onChange({ ...spec, spokes: spec.spokes.filter((_, j) => j !== i) })}
        />
      ))}

      <div className="row footer">
        <select
          className="add"
          value=""
          onChange={(e) => {
            const t = e.target.value as SpokeTemplate | '';
            if (t) onChange({ ...spec, spokes: [...spec.spokes, SPOKE_TEMPLATES[t].make(spec.location)] });
          }}
        >
          <option value="">+ Add spoke…</option>
          {(Object.keys(SPOKE_TEMPLATES) as SpokeTemplate[]).map((t) => (
            <option key={t} value={t}>
              {SPOKE_TEMPLATES[t].label}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}
