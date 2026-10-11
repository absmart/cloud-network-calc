// Azure networking rules that affect address planning.
// Sources: Azure Virtual Network, Firewall, Bastion, VPN/ExpressRoute Gateway,
// Route Server, DNS Private Resolver and Virtual WAN documentation.

import { type Cidr, overlaps, contains, parseCidr } from './ipv4';

/** Azure reserves the first four and the last address in every subnet. */
export const AZURE_RESERVED_IPS = 5;

/** The smallest subnet Azure allows. */
export const SMALLEST_SUBNET_PREFIX = 29;

/** Virtual WAN hubs need at least a /24; Microsoft recommends a /23. */
export const VWAN_HUB_MIN_PREFIX = 24;
export const VWAN_HUB_RECOMMENDED_PREFIX = 23;

export interface SubnetPreset {
  /** Display name in the "add subnet" menu. */
  label: string;
  /** Subnet name to create. */
  name: string;
  /** Whether Azure requires exactly this subnet name. */
  reservedName: boolean;
  /** Largest prefix length (smallest subnet) Azure accepts. */
  minPrefix: number;
  defaultPrefix: number;
  /** Belongs in the connectivity hub rather than in a spoke. */
  hubOnly: boolean;
  note: string;
}

export const SUBNET_PRESETS: SubnetPreset[] = [
  {
    label: 'GatewaySubnet',
    name: 'GatewaySubnet',
    reservedName: true,
    minPrefix: 29,
    defaultPrefix: 27,
    hubOnly: true,
    note: 'VPN / ExpressRoute gateways. /27 or larger is recommended.',
  },
  {
    label: 'AzureFirewallSubnet',
    name: 'AzureFirewallSubnet',
    reservedName: true,
    minPrefix: 26,
    defaultPrefix: 26,
    hubOnly: true,
    note: 'Azure Firewall requires a /26.',
  },
  {
    label: 'AzureFirewallManagementSubnet',
    name: 'AzureFirewallManagementSubnet',
    reservedName: true,
    minPrefix: 26,
    defaultPrefix: 26,
    hubOnly: true,
    note: 'Needed for forced tunnelling and Basic SKU. Requires a /26.',
  },
  {
    label: 'AzureBastionSubnet',
    name: 'AzureBastionSubnet',
    reservedName: true,
    minPrefix: 26,
    defaultPrefix: 26,
    hubOnly: false,
    note: 'Azure Bastion requires a /26 or larger.',
  },
  {
    label: 'RouteServerSubnet',
    name: 'RouteServerSubnet',
    reservedName: true,
    minPrefix: 26,
    defaultPrefix: 26,
    hubOnly: true,
    note: 'Azure Route Server requires a /26 or larger.',
  },
  {
    label: 'DNS Private Resolver (inbound)',
    name: 'snet-dns-inbound',
    reservedName: false,
    minPrefix: 28,
    defaultPrefix: 28,
    hubOnly: false,
    note: 'Delegated to Microsoft.Network/dnsResolvers. /28 minimum.',
  },
  {
    label: 'DNS Private Resolver (outbound)',
    name: 'snet-dns-outbound',
    reservedName: false,
    minPrefix: 28,
    defaultPrefix: 28,
    hubOnly: false,
    note: 'Delegated to Microsoft.Network/dnsResolvers. /28 minimum.',
  },
  {
    label: 'Application Gateway v2',
    name: 'snet-appgw',
    reservedName: false,
    minPrefix: 26,
    defaultPrefix: 24,
    hubOnly: false,
    note: 'Application Gateway v2: /24 recommended to allow autoscale.',
  },
  {
    label: 'Private endpoints',
    name: 'snet-pe',
    reservedName: false,
    minPrefix: 29,
    defaultPrefix: 26,
    hubOnly: false,
    note: 'Private endpoints for PaaS services.',
  },
];

export const RESERVED_NAME_PRESETS = SUBNET_PRESETS.filter((p) => p.reservedName);

export function presetForName(name: string): SubnetPreset | undefined {
  return RESERVED_NAME_PRESETS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
}

const cidrs = (list: string[]) =>
  list.map((s) => {
    const r = parseCidr(s);
    if (!r.ok) throw new Error(`bad constant ${s}`);
    return r.cidr;
  });

/** Private address space suitable for VNets (RFC 1918 + RFC 6598 shared space). */
const PRIVATE_SPACE = cidrs(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']);

/** Ranges Azure does not allow in a VNet address space. */
const FORBIDDEN_SPACE: [Cidr, string][] = cidrs([
  '224.0.0.0/4',
  '255.255.255.255/32',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '168.63.129.16/32',
]).map((c, i) => [c, ['multicast', 'broadcast', 'loopback', 'link-local', 'Azure platform (168.63.129.16)'][i]]);

export function isPrivate(c: Cidr): boolean {
  return PRIVATE_SPACE.some((p) => contains(p, c));
}

export function forbiddenOverlap(c: Cidr): string | null {
  const hit = FORBIDDEN_SPACE.find(([f]) => overlaps(f, c));
  return hit ? hit[1] : null;
}
