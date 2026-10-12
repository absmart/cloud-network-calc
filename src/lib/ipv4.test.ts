import { describe, expect, it } from 'vitest';
import {
  allocate,
  availableBlocks,
  formatCidr,
  formatIp,
  freeBlocks,
  parseCidr,
  parseIp,
  rangeToCidrs,
  supernet,
} from './ipv4';

const c = (s: string) => {
  const r = parseCidr(s);
  if (!r.ok) throw new Error(r.error);
  return r.cidr;
};

const allocated = (results: ReturnType<typeof allocate>) =>
  results.map((r) => ('cidr' in r ? formatCidr(r.cidr) : r.error));

describe('parsing', () => {
  it('round-trips addresses', () => {
    expect(formatIp(parseIp('10.1.2.3')!)).toBe('10.1.2.3');
    expect(formatIp(parseIp('255.255.255.255')!)).toBe('255.255.255.255');
  });

  it('rejects bad input', () => {
    expect(parseIp('10.1.2')).toBeNull();
    expect(parseIp('10.1.2.256')).toBeNull();
    expect(parseCidr('10.0.0.0/33').ok).toBe(false);
    expect(parseCidr('10.0.0.0').ok).toBe(false);
  });

  it('suggests the aligned network when host bits are set', () => {
    const r = parseCidr('10.0.1.0/16');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('10.0.0.0/16');
  });
});

describe('allocate', () => {
  it('packs first-fit on natural alignment', () => {
    const results = allocate(c('10.0.0.0/23'), [27, 26, 26, 26, 28, 28].map((prefix) => ({ prefix })));
    expect(allocated(results)).toEqual([
      '10.0.0.0/27',
      '10.0.0.64/26',
      '10.0.0.128/26',
      '10.0.0.192/26',
      '10.0.0.32/28',
      '10.0.0.48/28',
    ]);
  });

  it('places pinned ranges first and allocates around them', () => {
    const results = allocate(c('10.0.0.0/16'), [{ prefix: 24 }, { prefix: 24, fixed: c('10.0.0.0/24') }]);
    expect(allocated(results)).toEqual(['10.0.1.0/24', '10.0.0.0/24']);
  });

  it('reports overflow, oversize and pin conflicts', () => {
    const results = allocate(c('10.0.0.0/24'), [
      { prefix: 25 },
      { prefix: 25 },
      { prefix: 25 },
      { prefix: 23 },
      { prefix: 26, fixed: c('10.0.1.0/26') },
    ]);
    const out = allocated(results);
    expect(out[2]).toMatch(/No room/);
    expect(out[3]).toMatch(/larger than its parent/);
    expect(out[4]).toMatch(/outside/);
  });
});

describe('available blocks', () => {
  it('lists aligned blocks of a size that avoid taken ranges', () => {
    const taken = [c('10.0.0.0/16'), c('10.2.0.0/15')];
    expect(availableBlocks(c('10.0.0.0/13'), 16, taken).map(formatCidr)).toEqual([
      '10.1.0.0/16',
      '10.4.0.0/16',
      '10.5.0.0/16',
      '10.6.0.0/16',
      '10.7.0.0/16',
    ]);
  });

  it('stops at the limit and rejects sizes larger than the parent', () => {
    expect(availableBlocks(c('10.0.0.0/8'), 24, [], 3).map(formatCidr)).toEqual([
      '10.0.0.0/24',
      '10.0.1.0/24',
      '10.0.2.0/24',
    ]);
    expect(availableBlocks(c('10.0.0.0/16'), 8, [])).toEqual([]);
  });
});

describe('free space', () => {
  it('splits a range into aligned blocks', () => {
    expect(rangeToCidrs(parseIp('10.0.0.32')!, parseIp('10.0.1.0')!).map(formatCidr)).toEqual([
      '10.0.0.32/27',
      '10.0.0.64/26',
      '10.0.0.128/25',
    ]);
  });

  it('lists gaps between allocations', () => {
    expect(freeBlocks(c('10.0.0.0/22'), [c('10.0.1.0/24')]).map(formatCidr)).toEqual([
      '10.0.0.0/24',
      '10.0.2.0/23',
    ]);
  });
});

describe('supernet', () => {
  it('finds the smallest block covering every range', () => {
    expect(formatCidr(supernet([c('10.0.4.0/24')]))).toBe('10.0.4.0/24');
    expect(formatCidr(supernet([c('10.0.0.0/24'), c('10.0.1.0/24')]))).toBe('10.0.0.0/23');
    expect(formatCidr(supernet([c('10.0.1.0/24'), c('10.0.2.0/24')]))).toBe('10.0.0.0/22');
    expect(formatCidr(supernet([c('10.0.0.0/8'), c('192.168.0.0/16')]))).toBe('0.0.0.0/0');
  });
});
