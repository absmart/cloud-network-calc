import { useId, useState } from 'react';
import { RESERVED_NAME_PRESETS, SMALLEST_SUBNET_PREFIX, SUBNET_PRESETS, presetForName } from '../lib/azure';
import { newId } from '../lib/defaults';
import { blockSize, contains, endOf, formatCidr, formatIp } from '../lib/ipv4';
import { addRange, applyRangeView, rangeView, removeRange } from '../lib/layout';
import type { RangeSpec, SubnetSpec, VnetResult, VnetRole, VnetSpec } from '../lib/planner';
import { AllocationBar, CidrBadge, Issues, PinInput, PrefixSelect } from './common';
import { VisualSubnetEditor } from './VisualSubnetEditor';
import { prefixForHosts, prefixHolding, usableAddresses } from '../lib/sizing';

const KIND_LABEL = { hub: 'Hub VNet', 'virtual-hub': 'Virtual WAN hub', spoke: 'Spoke' } as const;

const ROLE_LABEL: Record<VnetRole, string> = {
  platform: 'Platform',
  identity: 'Identity',
  management: 'Management',
  security: 'Security',
  'landing-zone': 'Landing zone',
};

export function VnetCard(props: {
  spec: VnetSpec;
  result: VnetResult;
  minPrefix: number;
  onChange: (spec: VnetSpec) => void;
  onRemove?: () => void;
}) {
  const { spec, result, onChange } = props;
  const datalistId = useId();
  const [mode, setMode] = useState<'visual' | 'list'>('visual');
  const isVirtualHub = result.kind === 'virtual-hub';
  const vnetPrefix = result.cidr?.prefix ?? spec.prefix;

  // The smallest VNet that holds its subnets as sized, offered when the VNet is
  // smaller (single-range VNets only; spokes larger than their subnets are room to grow).
  const fit = prefixHolding(spec.subnets.map((s) => s.prefix));

  const updateRange = (index: number, patch: Partial<RangeSpec>) =>
    onChange({ ...spec, ranges: (spec.ranges ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  const updateSubnet = (index: number, patch: Partial<SubnetSpec>) =>
    onChange({ ...spec, subnets: spec.subnets.map((s, i) => (i === index ? { ...s, ...patch } : s)) });

  const addSubnet = (presetIndex: string) => {
    const preset = SUBNET_PRESETS[Number(presetIndex)];
    const subnet: SubnetSpec = preset
      ? { id: newId(), name: preset.name, prefix: preset.defaultPrefix }
      : { id: newId(), name: `subnet${spec.subnets.length + 1}-snet`, prefix: 26 };
    onChange({ ...spec, subnets: [...spec.subnets, subnet] });
  };

  return (
    <section className={`vnet vnet-${result.kind}${spec.role && spec.role !== 'landing-zone' ? ' vnet-platform' : ''}`}>
      <header className="row">
        <span className="kind">
          {result.kind === 'spoke' ? ROLE_LABEL[spec.role ?? 'landing-zone'] : KIND_LABEL[result.kind]}
        </span>
        <input className="name" value={spec.name} onChange={(e) => onChange({ ...spec, name: e.target.value })} />
        <PrefixSelect
          value={spec.prefix}
          min={props.minPrefix}
          max={SMALLEST_SUBNET_PREFIX}
          disabled={!!spec.fixed?.trim()}
          onChange={(prefix) => onChange({ ...spec, prefix })}
        />
        <PinInput value={spec.fixed} onChange={(fixed) => onChange({ ...spec, fixed })} />
        <CidrBadge cidr={result.cidr} />
        {props.onRemove && (
          <button className="icon" title="Remove VNet" onClick={props.onRemove}>
            ✕
          </button>
        )}
      </header>
      {!isVirtualHub &&
        (spec.ranges ?? []).map((range, i) => (
          <div className="row extra-range" key={i}>
            <span className="kind">Range {i + 2}</span>
            <PrefixSelect
              value={range.prefix}
              min={props.minPrefix}
              max={SMALLEST_SUBNET_PREFIX}
              disabled={!!range.fixed?.trim()}
              onChange={(prefix) => updateRange(i, { prefix })}
            />
            <PinInput value={range.fixed} onChange={(fixed) => updateRange(i, { fixed })} />
            <CidrBadge cidr={result.ranges[i + 1] ?? null} />
            <button
              className="icon"
              title="Remove this address range (its subnets are placed automatically again)"
              onClick={() => onChange(removeRange(spec, i + 1))}
            >
              ✕
            </button>
          </div>
        ))}
      <Issues issues={result.issues} />

      {isVirtualHub ? (
        <p className="note">
          Microsoft-managed hub: address space only, no subnets to plan. Connected spokes must not overlap it.
        </p>
      ) : (
        <>
          {result.ranges.map((range, k) =>
            range ? (
              <AllocationBar
                key={k}
                parent={range}
                free={result.free.filter((f) => contains(range, f))}
                segments={result.subnets
                  .filter((s) => s.cidr && contains(range, s.cidr))
                  .map((s) => ({
                    id: s.id,
                    label: s.name,
                    cidr: s.cidr,
                    tone: presetForName(s.name) ? 'special' : 'subnet',
                  }))}
              />
            ) : null,
          )}
          <div className="tabs mode">
            <button className={mode === 'visual' ? 'active' : ''} onClick={() => setMode('visual')}>
              Visual
            </button>
            <button className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
              List
            </button>
          </div>
          {mode === 'visual' &&
            result.ranges.map((range, k) => {
              const view = rangeView(spec, result, k);
              const several = result.ranges.length > 1;
              // An unallocated main range still gets an editor, which explains why it's empty.
              if (!view && k > 0) return null;
              return (
                <div key={k} className="range-editor">
                  {several && (
                    <h4>
                      Address range {k + 1} {range && <code>{formatCidr(range)}</code>}
                    </h4>
                  )}
                  <VisualSubnetEditor
                    spec={view?.spec ?? spec}
                    result={view?.result ?? result}
                    datalistId={datalistId}
                    onChange={(edited) => onChange(view ? applyRangeView(spec, k, view.spec, edited) : edited)}
                  />
                </div>
              );
            })}
          {mode === 'list' && spec.subnets.length > 0 && (
            <table className="subnets">
              <thead>
                <tr>
                  <th>Subnet</th>
                  <th title="Addresses the subnet needs; sets the size, counting Azure's 5 reserved addresses">Hosts</th>
                  <th>Size</th>
                  <th>Pin</th>
                  <th>CIDR</th>
                  <th>Range</th>
                  <th className="num">Usable</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {spec.subnets.map((s, i) => {
                  const r = result.subnets[i];
                  return (
                    <tr key={s.id} className={r.issues.some((x) => x.level === 'error') ? 'has-error' : ''}>
                      <td>
                        <input
                          className="name"
                          list={datalistId}
                          value={s.name}
                          onChange={(e) => updateSubnet(i, { name: e.target.value })}
                        />
                        <Issues issues={r.issues} />
                      </td>
                      <td>
                        <input
                          className="hosts"
                          type="number"
                          min={0}
                          aria-label={`Hosts needed in ${s.name}`}
                          placeholder={String(usableAddresses(s.prefix))}
                          value={s.hosts ?? ''}
                          onChange={(e) => {
                            const hosts = Math.max(0, Math.floor(Number(e.target.value))) || undefined;
                            // A pinned subnet keeps its size; the planner warns if it's too small.
                            const resize = hosts && !s.fixed?.trim() ? { prefix: prefixForHosts(hosts), offset: undefined } : {};
                            updateSubnet(i, { hosts, ...resize });
                          }}
                        />
                      </td>
                      <td>
                        <PrefixSelect
                          value={s.prefix}
                          min={vnetPrefix}
                          max={SMALLEST_SUBNET_PREFIX}
                          disabled={!!s.fixed?.trim()}
                          onChange={(prefix) => updateSubnet(i, { prefix, offset: undefined })}
                        />
                      </td>
                      <td>
                        <PinInput
                          value={s.fixed}
                          placeholder={s.offset !== undefined ? 'visual' : undefined}
                          onChange={(fixed) => updateSubnet(i, { fixed })}
                        />
                      </td>
                      <td>
                        <CidrBadge cidr={r.cidr} />
                      </td>
                      <td className="muted">
                        {r.cidr ? `${formatIp(r.cidr.base)} – ${formatIp(endOf(r.cidr) - 1)}` : ''}
                      </td>
                      <td className="num">{r.cidr ? r.usable.toLocaleString() : ''}</td>
                      <td>
                        <button
                          className="icon"
                          title="Remove subnet"
                          onClick={() => onChange({ ...spec, subnets: spec.subnets.filter((_, j) => j !== i) })}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <datalist id={datalistId}>
            {RESERVED_NAME_PRESETS.map((p) => (
              <option key={p.name} value={p.name} />
            ))}
          </datalist>
          <div className="row footer">
            <select
              className="add"
              value=""
              onChange={(e) => {
                if (e.target.value !== '') addSubnet(e.target.value);
              }}
            >
              <option value="">+ Add subnet…</option>
              <option value="custom">Custom subnet</option>
              {SUBNET_PRESETS.map((p, i) => (
                <option key={p.name} value={i} title={p.note}>
                  {p.label} (/{p.defaultPrefix})
                </option>
              ))}
            </select>
            <button title="Give the VNet another address range, placed after every VNet's main range" onClick={() => onChange(addRange(spec, spec.prefix))}>
              + Add address range
            </button>
            {result.cidr && (
              <span className="muted">
                {result.ranges.reduce((n, r) => n + (r ? blockSize(r.prefix) : 0), 0).toLocaleString()} addresses in VNet
              </span>
            )}
            {fit !== null && fit < spec.prefix && !spec.ranges?.length && (
              <span className="muted fit-hint">
                The subnets need a /{fit}; the VNet is too small for them.
                {!spec.fixed?.trim() && (
                  <button className="link" onClick={() => onChange({ ...spec, prefix: fit })}>
                    Make it a /{fit}
                  </button>
                )}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
