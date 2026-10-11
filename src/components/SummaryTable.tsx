import { type CSSProperties, useState } from 'react';
import { AZURE_RESERVED_IPS } from '../lib/azure';
import { type Cidr, blockSize, endOf, formatCidr, formatIp } from '../lib/ipv4';
import type { PlanResult } from '../lib/planner';
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
      rows.push({ ...base, key: vnet.id, level: 'VNet', vnet: vnet.name, name: vnet.name, cidr: vnet.cidr });
      for (const s of vnet.subnets) {
        rows.push({ ...base, key: s.id, level: 'Subnet', vnet: vnet.name, name: s.name, cidr: s.cidr });
      }
    }
  });
  return rows;
}

const usable = (row: Row) =>
  row.cidr && row.level === 'Subnet' ? Math.max(0, blockSize(row.cidr.prefix) - AZURE_RESERVED_IPS) : null;

function toCsv(rows: Row[]): string {
  const header = ['Level', 'Region', 'VNet', 'Name', 'CIDR', 'First', 'Last', 'Addresses', 'Usable'];
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) =>
    [
      r.level,
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
  const rows = flatten(result);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toCsv(rows));
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
