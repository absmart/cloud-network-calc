import { type Blocked, type Cidr, blockSize, endOf, formatCidr } from '../lib/ipv4';
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
  /** `excluded` is drawn hatched and doesn't count as allocated. */
  tone: 'region' | 'hub' | 'platform' | 'spoke' | 'subnet' | 'special' | 'excluded';
  /** Overrides the tone's colour. */
  color?: string;
}

export function AllocationBar({ parent, segments, free }: { parent: Cidr | null; segments: Segment[]; free: Cidr[] }) {
  if (!parent) return null;
  const total = blockSize(parent.prefix);
  // The part of a segment inside the bar; an excluded range can stick out of it.
  const visible = (c: Cidr) => {
    const start = Math.max(c.base, parent.base);
    return { start, size: Math.max(0, Math.min(endOf(c), endOf(parent)) - start) };
  };
  const used = segments.reduce((n, s) => n + (s.cidr && s.tone !== 'excluded' ? visible(s.cidr).size : 0), 0);
  // `free` already leaves out allocated and excluded space. What is neither is
  // excluded space outside the allocated blocks (a region may enclose some).
  const freeSize = free.reduce((n, f) => n + visible(f).size, 0);
  const excluded = Math.max(0, total - used - freeSize);
  const largestFree = [...free].sort((a, b) => a.prefix - b.prefix).slice(0, 4);
  return (
    <div className="bar-wrap">
      <div className="bar">
        {segments.map((s) => {
          if (!s.cidr) return null;
          const { start, size } = visible(s.cidr);
          if (size === 0) return null;
          const left = ((start - parent.base) / total) * 100;
          const width = (size / total) * 100;
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
        {((used / total) * 100).toFixed(1)}% allocated · {freeSize.toLocaleString()} addresses free
        {excluded > 0 && <> · {excluded.toLocaleString()} excluded</>}
        {largestFree.length > 0 && (
          <> · largest free blocks: {largestFree.map(formatCidr).join(', ')}</>
        )}
      </div>
    </div>
  );
}

/** Bar segments for the plan's excluded ranges. */
export const excludedSegments = (excluded: Blocked[]): Segment[] =>
  excluded.map((e, i) => ({ id: `excluded-${i}`, label: `Excluded: ${e.label}`, cidr: e.cidr, tone: 'excluded' }));
