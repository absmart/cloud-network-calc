import type { ReactNode } from 'react';
import { AZURE_RESERVED_IPS, SMALLEST_SUBNET_PREFIX, presetForName } from '../lib/azure';
import { blockSize, contains, endOf, formatCidr, formatIp } from '../lib/ipv4';
import { type Leaf, ancestor, assign, autoPack, divide, join, release, subnetsUnder, vnetLeaves } from '../lib/layout';
import type { VnetResult, VnetSpec } from '../lib/planner';
import { Issues } from './common';

/**
 * Split/join table modelled on visualsubnetcalc.com. Each row is a leaf block
 * of the VNet. "Divide" halves a row; the bars on the right are the parent
 * blocks, and clicking one joins everything beneath it.
 */
export function VisualSubnetEditor(props: {
  spec: VnetSpec;
  result: VnetResult;
  datalistId: string;
  onChange: (spec: VnetSpec) => void;
}) {
  const { spec, result, onChange } = props;
  const vnet = result.cidr;
  if (!vnet) return <p className="note">This VNet has no address range yet. Fix the issues above to edit its subnets.</p>;

  const leaves = vnetLeaves(spec, result);
  const deepest = Math.max(...leaves.map((l) => l.cidr.prefix));
  const joinColumns = deepest - vnet.prefix;
  const unplaced = result.subnets.filter((s) => !s.cidr);
  const hasLayout = spec.subnets.some((s) => s.offset !== undefined) || (spec.splits?.length ?? 0) > 0;

  const renameSubnet = (index: number, name: string) =>
    onChange({ ...spec, subnets: spec.subnets.map((s, i) => (i === index ? { ...s, name } : s)) });

  const joinCells = (leaf: Leaf): ReactNode[] => {
    const cells: ReactNode[] = [];
    if (deepest > leaf.cidr.prefix) {
      cells.push(<td key="fill" className="join-fill" colSpan={deepest - leaf.cidr.prefix} />);
    }
    // Deepest parent first (left), the whole VNet last (right). A parent's
    // cell is emitted on its first leaf row and spans all of its leaves.
    for (let p = leaf.cidr.prefix - 1; p >= vnet.prefix; p--) {
      const node = ancestor(leaf.cidr, p);
      if (node.base !== leaf.cidr.base) continue;
      const span = leaves.filter((l) => contains(node, l.cidr)).length;
      const blocked = subnetsUnder(leaves, node).length > 1;
      cells.push(
        <td key={p} rowSpan={span} className={`join depth-${(p - vnet.prefix) % 6}`}>
          <button
            disabled={blocked}
            title={
              blocked
                ? `${formatCidr(node)} holds more than one subnet; remove all but one to join`
                : `Join into ${formatCidr(node)}`
            }
            onClick={() => onChange(join(spec, result, leaves, node))}
          >
            /{p}
          </button>
        </td>,
      );
    }
    return cells;
  };

  return (
    <div className="visual">
      <div className="table-scroll">
        <table className="vsc">
          <thead>
            <tr>
              <th>Block</th>
              <th>Range</th>
              <th className="num">Usable</th>
              <th>Subnet</th>
              <th />
              {joinColumns > 0 && (
                <th colSpan={joinColumns} className="join-head">
                  Join
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {leaves.map((leaf) => {
              const index = leaf.subnet;
              const s = index !== null ? spec.subnets[index] : null;
              const r = index !== null ? result.subnets[index] : null;
              const tone = !s ? 'free' : presetForName(s.name) ? 'special' : 'subnet';
              return (
                <tr key={formatCidr(leaf.cidr)} className={`leaf leaf-${tone}`}>
                  <td>
                    <code>{formatCidr(leaf.cidr)}</code>
                  </td>
                  <td className="muted">
                    {formatIp(leaf.cidr.base)} – {formatIp(endOf(leaf.cidr) - 1)}
                  </td>
                  <td className="num">{Math.max(0, blockSize(leaf.cidr.prefix) - AZURE_RESERVED_IPS).toLocaleString()}</td>
                  <td className="leaf-name">
                    <div className="row">
                      <input
                        className="name"
                        list={props.datalistId}
                        placeholder="Free: type a name to create a subnet"
                        value={s?.name ?? ''}
                        onChange={(e) =>
                          index !== null
                            ? renameSubnet(index, e.target.value)
                            : e.target.value && onChange(assign(spec, result, leaf, e.target.value))
                        }
                      />
                      {index !== null && (
                        <button
                          className="icon"
                          title="Remove subnet (keeps the block as free space)"
                          onClick={() => onChange(release(spec, result, index))}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {r && <Issues issues={r.issues} />}
                  </td>
                  <td>
                    <button
                      className="divide"
                      disabled={leaf.cidr.prefix >= SMALLEST_SUBNET_PREFIX}
                      title={`Split into two /${leaf.cidr.prefix + 1} blocks`}
                      onClick={() => onChange(divide(spec, result, leaf))}
                    >
                      Divide
                    </button>
                  </td>
                  {joinCells(leaf)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {unplaced.length > 0 && (
        <div className="unplaced">
          <strong>Not placed:</strong>
          {unplaced.map((s) => (
            <div key={s.id}>
              {s.name || '(unnamed)'} <Issues issues={s.issues} />
            </div>
          ))}
        </div>
      )}

      <div className="row footer">
        <button disabled={!hasLayout} onClick={() => onChange(autoPack(spec))} title="Discard the visual layout and pack subnets first-fit">
          Auto-pack
        </button>
        <span className="muted">
          Divide a block, type a name to turn it into a subnet, click a bar on the right to join.
        </span>
      </div>
    </div>
  );
}
