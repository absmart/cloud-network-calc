import { type CSSProperties, useState } from 'react';
import { AZURE_RESERVED_IPS } from '../lib/azure';
import { type Cidr, blockSize, endOf, formatCidr, formatIp } from '../lib/ipv4';
import type { PlanResult } from '../lib/planner';
import { CLOUDS } from '../lib/cloud';
import { useCloud } from './cloudContext';
import { regionColor } from './common';

interface Row {
  key: string;
  regionIndex: number;
  level: 'Region' | 'VNet' | 'Subnet';
  region: string;
  vnet: string;
  name: string;
  cidr: Cidr | null;
}

function flatten(result: PlanResult): Row[] {
  const rows: Row[] = [];
  result.regions.forEach((region, regionIndex) => {
    const base = { regionIndex, region: region.name };
    rows.push({ ...base, key: region.id, level: 'Region', vnet: '', name: region.name, cidr: region.cidr });
    for (const vnet of [region.hub, ...region.spokes]) {
      vnet.ranges.forEach((cidr, k) => {
        const name = k ? `${vnet.name} (range ${k + 1})` : vnet.name;
        rows.push({ ...base, key: k ? `${vnet.id}-${k}` : vnet.id, level: 'VNet', vnet: vnet.name, name, cidr });
      });
      for (const s of vnet.subnets) {
        rows.push({ ...base, key: s.id, level: 'Subnet', vnet: vnet.name, name: s.name, cidr: s.cidr });
      }
    }
  });
  return rows;
}

const usable = (row: Row) =>
  row.cidr && row.level === 'Subnet' ? Math.max(0, blockSize(row.cidr.prefix) - AZURE_RESERVED_IPS) : null;

/** CSV of the rows; `network` is what the cloud calls a virtual network (VNet or VPC). */
function toCsv(rows: Row[], network: string): string {
  const header = ['Level', 'Region', network, 'Name', 'CIDR', 'First', 'Last', 'Addresses', 'Usable'];
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) =>
    [
      r.level === 'VNet' ? network : r.level,
      r.region,
      r.vnet,
      r.name,
      r.cidr ? formatCidr(r.cidr) : '',
      r.cidr ? formatIp(r.cidr.base) : '',
      r.cidr ? formatIp(endOf(r.cidr) - 1) : '',
      r.cidr ? String(blockSize(r.cidr.prefix)) : '',
      String(usable(r) ?? ''),
    ]
      .map(quote)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

export function SummaryTable({ result }: { result: PlanResult }) {
  const network = CLOUDS[useCloud()].network;
  const rows = flatten(result);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toCsv(rows, network));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="summary">
      <div className="row footer">
        <button onClick={copy}>{copied ? 'Copied' : 'Copy as CSV'}</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>CIDR</th>
              <th>First</th>
              <th>Last</th>
              <th className="num">Addresses</th>
              <th className="num">Usable</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`level-${r.level.toLowerCase()}`}
                style={{ '--region-color': regionColor(r.regionIndex) } as CSSProperties}
              >
                <td>{r.name}</td>
                <td>
                  <code>{r.cidr ? formatCidr(r.cidr) : 'unallocated'}</code>
                </td>
                <td>{r.cidr ? formatIp(r.cidr.base) : ''}</td>
                <td>{r.cidr ? formatIp(endOf(r.cidr) - 1) : ''}</td>
                <td className="num">{r.cidr ? blockSize(r.cidr.prefix).toLocaleString() : ''}</td>
                <td className="num">{usable(r)?.toLocaleString() ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
