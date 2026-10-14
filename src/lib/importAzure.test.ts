import { describe, expect, it } from 'vitest';
import { platformLayoutOf, setPlatformLayout } from './defaults';
import { importAzureNetwork } from './importAzure';
import { formatCidr } from './ipv4';
import { computePlan, countIssues } from './planner';

const sub = '/subscriptions/0000/resourceGroups/rg-net/providers/Microsoft.Network';
const vnetId = (name: string) => `${sub}/virtualNetworks/${name}`;

/** A VNet as Resource Graph and the ARM REST API return it. */
const armVnet = (name: string, location: string, prefixes: string[], subnets: [string, string][], peers: string[] = []) => ({
  id: vnetId(name),
  name,
  type: 'microsoft.network/virtualnetworks',
  location,
  properties: {
    addressSpace: { addressPrefixes: prefixes },
    subnets: subnets.map(([n, p]) => ({ name: n, properties: { addressPrefix: p } })),
    virtualNetworkPeerings: peers.map((p) => ({
      name: `to-${p}`,
      properties: { remoteVirtualNetwork: { id: vnetId(p) } },
    })),
  },
});

const vhub = (name: string, location: string, prefix: string) => ({
  id: `${sub}/virtualHubs/${name}`,
  name,
  type: 'microsoft.network/virtualhubs',
  location,
  properties: { addressPrefix: prefix, virtualWan: { id: `${sub}/virtualWans/vwan` } },
});

const graphOutput = {
  count: 6,
  data: [
    armVnet('spoke-a', 'eastus2', ['10.0.4.0/24'], [['app', '10.0.4.0/26'], ['data', '10.0.4.64/27']], ['hub']),
    armVnet(
      'hub',
      'eastus2',
      ['10.0.0.0/22', 'fd00:db8::/48'],
      [
        ['GatewaySubnet', '10.0.2.0/27'],
        ['AzureFirewallSubnet', '10.0.2.64/26'],
      ],
      ['spoke-a'],
    ),
    armVnet('spoke-b', 'eastus2', ['10.0.8.0/24'], [['app', '10.0.8.0/24']]),
    vhub('vhub-weu', 'westeurope', '10.1.0.0/23'),
    armVnet('lz-weu', 'westeurope', ['10.1.4.0/24'], [['app', '10.1.4.0/25']]),
    { id: `${sub}/networkSecurityGroups/nsg`, name: 'nsg', type: 'microsoft.network/networksecuritygroups' },
  ],
  skip_token: null,
};

const describeRegion = (plan: ReturnType<typeof importAzureNetwork>['plan']) => {
  const result = computePlan(plan);
  return result.regions.map((r) => ({
    region: `${r.name} ${formatCidr(r.cidr!)}`,
    hub: `${r.hub.name} ${formatCidr(r.hub.cidr!)}`,
    spokes: r.spokes.map((s) => `${s.name} ${formatCidr(s.cidr!)} [${s.subnets.map((n) => `${n.name} ${formatCidr(n.cidr!)}`).join(', ')}]`),
  }));
};

describe('importAzureNetwork', () => {
  it('imports Resource Graph output as a pinned plan without issues', () => {
    const { plan, notes } = importAzureNetwork(JSON.stringify(graphOutput));
    expect(plan.root).toBe('10.0.0.0/15');
    expect(plan.regions.map((r) => [r.location, r.topology, r.fixed])).toEqual([
      ['eastus2', 'hub-spoke', '10.0.0.0/16'],
      ['westeurope', 'vwan', '10.1.0.0/16'],
    ]);
    expect(describeRegion(plan)).toEqual([
      {
        region: 'East US 2 10.0.0.0/16',
        hub: 'hub 10.0.0.0/22',
        spokes: [
          'spoke-a 10.0.4.0/24 [app 10.0.4.0/26, data 10.0.4.64/27]',
          'spoke-b 10.0.8.0/24 [app 10.0.8.0/24]',
        ],
      },
      {
        region: 'West Europe 10.1.0.0/16',
        hub: 'vhub-weu 10.1.0.0/23',
        spokes: ['lz-weu 10.1.4.0/24 [app 10.1.4.0/25]'],
      },
    ]);
    expect(computePlan(plan).regions[0].hub.subnets.map((s) => `${s.name} ${formatCidr(s.cidr!)}`)).toEqual([
      'GatewaySubnet 10.0.2.0/27',
      'AzureFirewallSubnet 10.0.2.64/26',
    ]);
    expect(countIssues(computePlan(plan))).toEqual({ errors: 0, warnings: 0 });
    expect(notes.map((n) => n.message)).toEqual([
      'Imported 4 VNets and 1 Virtual WAN hub in 2 regions; root range 10.0.0.0/15',
      'East US 2: not peered to hub: spoke-b',
    ]);
  });

  it('imports spokes as landing zones, so changing the platform layout keeps them', () => {
    const { plan } = importAzureNetwork(JSON.stringify(graphOutput));
    const region = plan.regions[0];
    expect(region.spokes.every((s) => s.role === 'landing-zone')).toBe(true);
    const switched = setPlatformLayout(region, platformLayoutOf(region) === 'combined' ? 'separate' : 'combined');
    expect(switched.spokes.map((s) => s.name)).toEqual(expect.arrayContaining(['spoke-a', 'spoke-b']));
  });

  it('reads `az network vnet list` output and keeps every address range', () => {
    const cli = [
      {
        id: vnetId('app'),
        name: 'app',
        location: 'northeurope',
        type: 'Microsoft.Network/virtualNetworks',
        addressSpace: { addressPrefixes: ['10.9.0.0/24', '10.8.0.0/24'] },
        subnets: [
          { name: 'a', addressPrefix: '10.8.0.0/25' },
          { name: 'b', addressPrefix: '10.8.0.128/25' },
          { name: 'c', addressPrefix: '10.9.0.0/25' },
          { name: 'stray', addressPrefix: '10.7.0.0/28' },
        ],
        virtualNetworkPeerings: [],
      },
    ];
    const { plan, notes } = importAzureNetwork(JSON.stringify(cli));
    const hub = plan.regions[0].hub;
    expect(hub).toMatchObject({ name: 'app', fixed: '10.9.0.0/24', ranges: [{ prefix: 24, fixed: '10.8.0.0/24' }] });
    expect(hub.subnets.map((s) => [s.name, s.offset, s.range])).toEqual([
      ['a', 0, 1],
      ['b', 128, 1],
      ['c', 0, undefined],
    ]);
    // 10.8.x and 10.9.x take a /15; widening to a /16 couldn't hold both.
    expect(plan.regions[0].fixed).toBe('10.8.0.0/15');
    const result = computePlan(plan);
    expect(result.regions[0].hub.subnets.map((s) => formatCidr(s.cidr!))).toEqual(['10.8.0.0/25', '10.8.0.128/25', '10.9.0.0/25']);
    expect(countIssues(result).errors).toBe(0);
    expect(notes.map((n) => n.message)).toContain("app: stray (10.7.0.0/28) not in the VNet's address space, left out");
  });

  it('reads Get-AzVirtualNetwork output and flags truncated subnets', () => {
    const ps = [
      {
        Name: 'hub-vnet',
        Location: 'East US',
        Id: vnetId('hub-vnet'),
        AddressSpace: { AddressPrefixes: ['172.16.0.0/22'] },
        Subnets: [{ Name: 'GatewaySubnet', AddressPrefix: ['172.16.0.0/27'] }],
        VirtualNetworkPeerings: [],
      },
      {
        Name: 'spoke',
        Location: 'eastus',
        Id: vnetId('spoke'),
        AddressSpace: { AddressPrefixes: ['172.16.4.0/24'] },
        Subnets: ['Microsoft.Azure.Commands.Network.Models.PSSubnet'],
        VirtualNetworkPeerings: [],
      },
    ];
    const { plan, notes } = importAzureNetwork(JSON.stringify(ps));
    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]).toMatchObject({ location: 'eastus', name: 'East US', fixed: '172.16.0.0/16' });
    expect(plan.regions[0].hub.name).toBe('hub-vnet');
    expect(plan.regions[0].spokes.map((s) => [s.name, s.subnets.length])).toEqual([['spoke', 0]]);
    expect(notes.map((n) => n.message)).toContain(
      'spoke: subnet details are missing (with ConvertTo-Json, pass -Depth 10)',
    );
  });

  it('warns when it has to guess the hub', () => {
    const { plan, notes } = importAzureNetwork(
      JSON.stringify([armVnet('one', 'eastus2', ['10.0.0.0/24'], []), armVnet('two', 'eastus2', ['10.0.1.0/24'], [])]),
    );
    expect(plan.regions[0].hub.name).toBe('one');
    expect(notes.map((n) => n.message)).toContain(
      'East US 2: no hub VNet found (no gateway or firewall subnet, no peerings); one is used as the hub',
    );
  });

  it('keeps a region block tight when a /16 would take in another region', () => {
    const { plan } = importAzureNetwork(
      JSON.stringify([
        armVnet('a', 'eastus2', ['10.0.0.0/24'], []),
        armVnet('b', 'centralus', ['10.0.1.0/24'], []),
      ]),
    );
    expect(plan.regions.map((r) => r.fixed)).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
    expect(plan.root).toBe('10.0.0.0/23');
    expect(countIssues(computePlan(plan)).errors).toBe(0);
  });

  it('leaves overlapping VNets pinned so the planner reports them', () => {
    const { plan } = importAzureNetwork(
      JSON.stringify([armVnet('a', 'eastus2', ['10.0.0.0/24'], []), armVnet('b', 'eastus2', ['10.0.0.0/25'], [])]),
    );
    const issues = computePlan(plan).regions[0].spokes[0].issues.map((i) => i.message);
    expect(issues).toEqual(['10.0.0.0/25 overlaps 10.0.0.0/24']);
  });

  it('reads several documents pasted one after another, and warns about further pages', () => {
    const vnets = [armVnet('lz', 'westeurope', ['10.1.4.0/24'], [['a]{"', '10.1.4.0/25']])];
    const page = { count: 1, data: [vhub('vhub-weu', 'westeurope', '10.1.0.0/23')], skip_token: 'abc' };
    const { plan, notes } = importAzureNetwork(
      `${JSON.stringify(vnets, null, 2)}\nThe command requires the extension virtual-wan. Install it now? (Y/n): y\n${JSON.stringify(page)}\n`,
    );
    expect(notes.map((n) => n.message)).toContain('Text that isn’t JSON (such as CLI messages) was skipped');
    expect(plan.regions[0]).toMatchObject({ topology: 'vwan', hub: { name: 'vhub-weu' } });
    expect(plan.regions[0].spokes[0].subnets[0].name).toBe('a]{"');
    expect(notes.map((n) => n.level)).toContain('warning');
    expect(notes.some((n) => n.message.includes('only the first page'))).toBe(true);
  });

  it('rejects input it cannot use', () => {
    expect(() => importAzureNetwork('not json')).toThrow('The text is not valid JSON.');
    expect(() => importAzureNetwork('[] WARNING: something')).toThrow('No virtual networks or Virtual WAN hubs were found.');
    expect(() => importAzureNetwork('[{"a": 1}')).toThrow('The text is not valid JSON.');
    expect(() => importAzureNetwork('{"data": []}')).toThrow('No virtual networks or Virtual WAN hubs were found.');
  });
});
