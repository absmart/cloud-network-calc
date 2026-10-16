// Sizing help: how big a subnet or VNet needs to be, and how much more fits.

import { AWS_SMALLEST_PREFIX } from './aws';
import { AZURE_RESERVED_IPS, SMALLEST_SUBNET_PREFIX } from './azure';
import { type Cidr, blockSize } from './ipv4';
import type { Cloud } from './planner';

/** Usable addresses in a subnet of this size. Azure and AWS both keep 5 of every subnet. */
export const usableAddresses = (prefix: number) => Math.max(0, blockSize(prefix) - AZURE_RESERVED_IPS);

/** The smallest subnet a cloud allows: a /29 in Azure, a /28 in AWS. */
export const smallestSubnetPrefix = (cloud: Cloud = 'azure') => (cloud === 'aws' ? AWS_SMALLEST_PREFIX : SMALLEST_SUBNET_PREFIX);

/** The smallest subnet with room for `hosts` addresses: the 5 reserved ones on top, and never below the cloud's minimum. */
export function prefixForHosts(hosts: number, cloud: Cloud = 'azure'): number {
  let prefix = smallestSubnetPrefix(cloud);
  while (prefix > 0 && usableAddresses(prefix) < hosts) prefix--;
  return prefix;
}

/**
 * The smallest block that holds blocks of these sizes. Aligned power-of-two
 * blocks placed largest first always pack without gaps, so the total size,
 * rounded up to a power of two, is enough.
 */
export function prefixHolding(prefixes: number[]): number | null {
  if (prefixes.length === 0) return null;
  const total = prefixes.reduce((n, p) => n + blockSize(p), 0);
  let prefix = 32;
  while (prefix > 0 && blockSize(prefix) < total) prefix--;
  return prefix;
}

/** How many aligned blocks of the given size fit in free space (as returned by `freeBlocks`, already aligned). */
export function capacity(free: Cidr[], prefix: number): number {
  return free.reduce((n, f) => n + (f.prefix <= prefix ? 2 ** (prefix - f.prefix) : 0), 0);
}
