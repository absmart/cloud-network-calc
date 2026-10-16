import { REGION_PREFIX } from '../lib/defaults';
import { blockSize, formatCidr } from '../lib/ipv4';
import { capacity } from '../lib/sizing';
import type { PlanResult, PlanSpec, RegionSpec } from '../lib/planner';
import { regionName, regionShortCode } from '../lib/cloud';
import type { CSSProperties } from 'react';
import { useCloud } from './cloudContext';
import { CidrBadge, regionColor } from './common';

/** Spoke sizes to report room for: the region's landing zone sizes (largest first, at most two), else /22 and /24. */
function headroomSizes(region: RegionSpec): number[] {
  const sizes = [...new Set(region.spokes.filter((v) => v.role === 'landing-zone' || !v.role).map((v) => v.prefix))].sort((a, b) => a - b);
  return sizes.length ? sizes.slice(0, 2) : [22, 24];
}

/** One row per region: its address range and its own hub. Click a row's name to open that region. */
export function RegionOverview({
  plan,
  result,
  selected,
  onSelect,
}: {
  plan: PlanSpec;
  result: PlanResult;
  selected: string;
  onSelect: (regionId: string) => void;
}) {
  const cloud = useCloud();
  if (!plan.regions.length) return null;
  return (
    <section className="overview">
      <h2>Regions</h2>
      {result.root && (
        <p className="muted headroom">
          Room for {capacity(result.free, REGION_PREFIX)} more /{REGION_PREFIX} region
          {capacity(result.free, REGION_PREFIX) === 1 ? '' : 's'} in {formatCidr(result.root)}.
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Region</th>
              <th>Location</th>
              <th>Region range</th>
              <th>Hub</th>
              <th>Hub range</th>
              <th className="num">{cloud === 'aws' ? 'VPCs' : 'Spokes'}</th>
              <th className="num">Free addresses</th>
              <th title="How many more spokes of these sizes fit in the free space">Room for</th>
            </tr>
          </thead>
          <tbody>
            {plan.regions.map((spec, i) => {
              const r = result.regions[i];
              const free = r.free.reduce((n, c) => n + blockSize(c.prefix), 0);
              return (
                <tr
                  key={spec.id}
                  className={selected === spec.id ? 'selected' : ''}
                  style={{ '--region-color': regionColor(i) } as CSSProperties}
                >
                  <td>
                    <button className="link" onClick={() => onSelect(spec.id)}>
                      <span className="swatch" />
                      {spec.name}
                    </button>
                  </td>
                  <td>
                    {regionName(cloud, spec.location)} <code className="muted">{regionShortCode(cloud, spec.location)}</code>
                  </td>
                  <td>
                    <CidrBadge cidr={r.cidr} />
                  </td>
                  <td>
                    {spec.hub.name}
                    <span className="muted"> ({cloud === 'aws' ? 'inspection VPC' : spec.topology === 'vwan' ? 'Virtual WAN' : 'hub VNet'})</span>
                  </td>
                  <td>
                    <CidrBadge cidr={r.hub.cidr} />
                  </td>
                  <td className="num">{spec.spokes.length}</td>
                  <td className="num">{r.cidr ? free.toLocaleString() : ''}</td>
                  <td className="muted">
                    {r.cidr && headroomSizes(spec).map((p) => `${capacity(r.free, p)} × /${p}`).join(' · ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
