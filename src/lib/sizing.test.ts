import { describe, expect, it } from 'vitest';
import { defaultPlan } from './defaults';
import { parseCidr } from './ipv4';
import { computePlan } from './planner';
import { capacity, prefixForHosts, prefixHolding, usableAddresses } from './sizing';

const c = (s: string) => {
  const r = parseCidr(s);
  if (!r.ok) throw new Error(r.error);
  return r.cidr;
};

describe('sizing', () => {
  it('sizes a subnet for a number of hosts, counting the 5 reserved addresses', () => {
    expect(usableAddresses(24)).toBe(251);
    expect([0, 3, 4, 11, 12, 59, 60, 251, 252, 1000].map(prefixForHosts)).toEqual([29, 29, 28, 28, 27, 26, 25, 24, 23, 22]);
  });

  it('finds the smallest block that holds a set of blocks', () => {
    expect(prefixHolding([])).toBeNull();
    expect(prefixHolding([24])).toBe(24);
    expect(prefixHolding([25, 26, 26])).toBe(24);
    expect(prefixHolding([24, 26])).toBe(23);
  });

  it('counts how many blocks of a size fit in free space', () => {
    const free = [c('10.0.0.0/23'), c('10.0.2.0/24'), c('10.0.3.128/25')];
    expect(capacity(free, 22)).toBe(0);
    expect(capacity(free, 23)).toBe(1);
    expect(capacity(free, 24)).toBe(3);
    expect(capacity(free, 25)).toBe(7);
  });

  it('warns when a subnet is smaller than the hosts it needs', () => {
    const plan = defaultPlan();
    const spoke = plan.regions[0].spokes[3];
    spoke.subnets = [{ id: 'a', name: 'app-snet', prefix: 25, hosts: 200 }, { id: 'b', name: 'db-snet', prefix: 26, hosts: 59 }];
    const subnets = computePlan(plan).regions[0].spokes[3].subnets;
    expect(subnets.map((s) => s.issues.map((i) => i.message))).toEqual([
      ['Needs 200 hosts, but a /25 has 123 usable addresses; a /24 fits'],
      [],
    ]);
  });
});
