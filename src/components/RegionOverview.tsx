import { blockSize } from '../lib/ipv4';
import type { PlanResult, PlanSpec } from '../lib/planner';
import { regionDisplayName } from '../lib/regions';
import { CidrBadge } from './common';

/** One row per region: its address range and its own hub. */
export function RegionOverview({ plan, result }: { plan: PlanSpec; result: PlanResult }) {
  if (!plan.regions.length) return null;
  return (
    <section className="overview">
      <h2>Regions</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Region</th>
              <th>Location</th>
              <th>Region range</th>
              <th>Hub</th>
              <th>Hub range</th>
              <th className="num">Spokes</th>
              <th className="num">Free addresses</th>
            </tr>
          </thead>
          <tbody>
            {plan.regions.map((spec, i) => {
              const r = result.regions[i];
              const free = r.free.reduce((n, c) => n + blockSize(c.prefix), 0);
              return (
                <tr key={spec.id}>
                  <td>
                    <a href={`#region-${spec.id}`}>{spec.name}</a>
                  </td>
                  <td>{regionDisplayName(spec.location)}</td>
                  <td>
                    <CidrBadge cidr={r.cidr} />
                  </td>
                  <td>
                    {spec.hub.name}
                    <span className="muted"> ({spec.topology === 'vwan' ? 'Virtual WAN' : 'hub VNet'})</span>
                  </td>
                  <td>
                    <CidrBadge cidr={r.hub.cidr} />
                  </td>
                  <td className="num">{spec.spokes.length}</td>
                  <td className="num">{r.cidr ? free.toLocaleString() : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
