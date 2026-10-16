import { CLOUDS } from '../lib/cloud';
import type { ExcludedRange } from '../lib/planner';
import { useCloud } from './cloudContext';

/** Address space the plan keeps clear of: on-premises, other clouds, partners. */
export function ExcludedRanges(props: { ranges: ExcludedRange[]; onChange: (ranges: ExcludedRange[]) => void }) {
  const { ranges, onChange } = props;
  const cloud = useCloud();
  const update = (index: number, patch: Partial<ExcludedRange>) =>
    onChange(ranges.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <section className="overview excluded-panel">
      <h2>Excluded ranges</h2>
      <div className="table-scroll">
        {ranges.length === 0 ? (
          <p className="muted">
            None. Add on-premises, other cloud or partner ranges here, and no {CLOUDS[cloud].network} will be placed in them. A region may
            still enclose a smaller excluded range; its {CLOUDS[cloud].network}s go around it.
          </p>
        ) : (
          ranges.map((r, i) => (
            <div className="row" key={i}>
              <input
                className="cidr-input"
                aria-label="Excluded CIDR"
                placeholder="10.100.0.0/16"
                value={r.cidr}
                onChange={(e) => update(i, { cidr: e.target.value })}
              />
              <input
                className="label-input"
                aria-label="What uses it"
                placeholder="What uses it, e.g. on-premises"
                value={r.label ?? ''}
                onChange={(e) => update(i, { label: e.target.value })}
              />
              <button className="icon" title="Remove excluded range" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))
        )}
        <div className="row">
          <button onClick={() => onChange([...ranges, { cidr: '', label: '' }])}>+ Add excluded range</button>
        </div>
      </div>
    </section>
  );
}
