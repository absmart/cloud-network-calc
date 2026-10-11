import { type Cidr, blockSize, formatCidr } from '../lib/ipv4';
import type { Issue } from '../lib/planner';

export function PrefixSelect(props: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (prefix: number) => void;
}) {
  // Keep the current value selectable even if the parent shrank below it;
  // the allocator reports the problem instead.
  const min = Math.min(props.min, props.value);
  const max = Math.max(props.max, props.value);
  const options: number[] = [];
  for (let p = min; p <= max; p++) options.push(p);
  return (
    <select
      className="prefix"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(Number(e.target.value))}
    >
      {options.map((p) => (
        <option key={p} value={p}>
          /{p} · {blockSize(p).toLocaleString()}
        </option>
      ))}
    </select>
  );
}

export function PinInput(props: {
  value: string | undefined;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="pin"
      placeholder={props.placeholder ?? 'auto'}
      title="Pin to a specific CIDR (leave empty to allocate automatically)"
      value={props.value ?? ''}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function CidrBadge({ cidr }: { cidr: Cidr | null }) {
  return <code className={cidr ? 'cidr' : 'cidr unallocated'}>{cidr ? formatCidr(cidr) : 'unallocated'}</code>;
}

export function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="issues">
      {issues.map((issue, i) => (
        <li key={i} className={issue.level}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** One accent colour per region, readable with white text in light and dark themes. */
const REGION_COLORS = ['#5b5fc7', '#0f7b6c', '#c4651c', '#b4009e', '#2e7d32', '#a4262c', '#0f6cbd', '#8a6d00'];

export const regionColor = (index: number) => REGION_COLORS[index % REGION_COLORS.length];

export interface Segment {
  id: string;
  label: string;
  cidr: Cidr | null;
  tone: 'region' | 'hub' | 'platform' | 'spoke' | 'subnet' | 'special';
  /** Overrides the tone's colour. */
  color?: string;
}

export function AllocationBar({ parent, segments, free }: { parent: Cidr | null; segments: Segment[]; free: Cidr[] }) {
  if (!parent) return null;
  const total = blockSize(parent.prefix);
  const used = segments.reduce((n, s) => n + (s.cidr ? blockSize(s.cidr.prefix) : 0), 0);
  const largestFree = [...free].sort((a, b) => a.prefix - b.prefix).slice(0, 4);
  return (
    <div className="bar-wrap">
      <div className="bar">
        {segments.map((s) => {
          if (!s.cidr) return null;
          const left = ((s.cidr.base - parent.base) / total) * 100;
          const width = (blockSize(s.cidr.prefix) / total) * 100;
          return (
            <div
              key={s.id}
              className={`seg seg-${s.tone}`}
              style={{ left: `${left}%`, width: `${width}%`, background: s.color }}
              title={`${s.label}\n${formatCidr(s.cidr)}`}
            >
              <span>{s.label}</span>
            </div>
          );
        })}
      </div>
      <div className="bar-caption">
        {((used / total) * 100).toFixed(1)}% allocated · {(total - used).toLocaleString()} addresses free
        {largestFree.length > 0 && (
          <> · largest free blocks: {largestFree.map(formatCidr).join(', ')}</>
        )}
      </div>
    </div>
  );
}
