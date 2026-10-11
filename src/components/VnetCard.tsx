import { useId, useState } from 'react';
import { RESERVED_NAME_PRESETS, SMALLEST_SUBNET_PREFIX, SUBNET_PRESETS, presetForName } from '../lib/azure';
import { newId } from '../lib/defaults';
import { formatIp, endOf, blockSize } from '../lib/ipv4';
import type { SubnetSpec, VnetResult, VnetRole, VnetSpec } from '../lib/planner';
import { AllocationBar, CidrBadge, Issues, PinInput, PrefixSelect } from './common';
import { VisualSubnetEditor } from './VisualSubnetEditor';

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

  const updateSubnet = (index: number, patch: Partial<SubnetSpec>) =>
    onChange({ ...spec, subnets: spec.subnets.map((s, i) => (i === index ? { ...s, ...patch } : s)) });

  const addSubnet = (presetIndex: string) => {
    const preset = SUBNET_PRESETS[Number(presetIndex)];
    const subnet: SubnetSpec = preset
      ? { id: newId(), name: preset.name, prefix: preset.defaultPrefix }
      : { id: newId(), name: `snet-${spec.subnets.length + 1}`, prefix: 26 };
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
      <Issues issues={result.issues} />

      {isVirtualHub ? (
        <p className="note">
          Microsoft-managed hub: address space only, no subnets to plan. Connected spokes must not overlap it.
        </p>
      ) : (
        <>
          <AllocationBar
            parent={result.cidr}
            free={result.free}
            segments={result.subnets.map((s) => ({
              id: s.id,
              label: s.name,
              cidr: s.cidr,
              tone: presetForName(s.name) ? 'special' : 'subnet',
            }))}
          />
          <div className="tabs mode">
            <button className={mode === 'visual' ? 'active' : ''} onClick={() => setMode('visual')}>
              Visual
            </button>
            <button className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
              List
            </button>
          </div>
          {mode === 'visual' && (
            <VisualSubnetEditor spec={spec} result={result} datalistId={datalistId} onChange={onChange} />
          )}
          {mode === 'list' && spec.subnets.length > 0 && (
            <table className="subnets">
              <thead>
                <tr>
                  <th>Subnet</th>
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
            {result.cidr && (
              <span className="muted">
                {blockSize(result.cidr.prefix).toLocaleString()} addresses in VNet
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
