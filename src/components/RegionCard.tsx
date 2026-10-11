import { VWAN_HUB_RECOMMENDED_PREFIX } from '../lib/azure';
import { SPOKE_TEMPLATES, type SpokeTemplate, makeHub, relocateRegion } from '../lib/defaults';
import { findRegion, regionsByGeography } from '../lib/regions';
import type { RegionResult, RegionSpec, Topology, VnetSpec } from '../lib/planner';
import { AllocationBar, CidrBadge, Issues, PinInput, PrefixSelect } from './common';
import { VnetCard } from './VnetCard';

export function RegionCard(props: {
  spec: RegionSpec;
  result: RegionResult;
  minPrefix: number;
  /** Locations taken by the plan's other regions → that region's name. */
  usedLocations: Map<string, string>;
  onChange: (spec: RegionSpec) => void;
  onRemove: () => void;
}) {
  const { spec, result, onChange } = props;
  const regionPrefix = result.cidr?.prefix ?? spec.prefix;

  const setTopology = (topology: Topology) => {
    // Swap in a hub of the right shape. A virtual hub keeps the old hub's size
    // if that's at least the recommended /23.
    const hub = makeHub(spec.location, topology);
    if (topology === 'vwan') hub.prefix = Math.min(spec.hub.prefix, VWAN_HUB_RECOMMENDED_PREFIX);
    onChange({ ...spec, topology, hub });
  };

  const updateSpoke = (index: number, vnet: VnetSpec) =>
    onChange({ ...spec, spokes: spec.spokes.map((s, i) => (i === index ? vnet : s)) });

  const vnetResults = [result.hub, ...result.spokes];
  const pairedLocation = findRegion(spec.location)?.paired;
  const paired = pairedLocation ? findRegion(pairedLocation) : undefined;

  return (
    <article className="region" id={`region-${spec.id}`}>
      <header className="row">
        <input
          className="region-name"
          value={spec.name}
          onChange={(e) => onChange({ ...spec, name: e.target.value })}
        />
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
          <PrefixSelect
            value={spec.prefix}
            min={props.minPrefix}
            max={24}
            disabled={!!spec.fixed?.trim()}
            onChange={(prefix) => onChange({ ...spec, prefix })}
          />
        </label>
        <label>
          Pin
          <PinInput value={spec.fixed} onChange={(fixed) => onChange({ ...spec, fixed })} />
        </label>
        <label>
          Topology
          <select value={spec.topology} onChange={(e) => setTopology(e.target.value as Topology)}>
            <option value="hub-spoke">Hub &amp; spoke</option>
            <option value="vwan">Virtual WAN</option>
          </select>
        </label>
        <CidrBadge cidr={result.cidr} />
        <button className="icon" title="Remove region" onClick={props.onRemove}>
          ✕
        </button>
      </header>
      <Issues issues={result.issues} />

      <AllocationBar
        parent={result.cidr}
        free={result.free}
        segments={vnetResults.map((v) => ({
          id: v.id,
          label: v.name,
          cidr: v.cidr,
          tone: v.kind === 'spoke' ? 'spoke' : 'hub',
        }))}
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
