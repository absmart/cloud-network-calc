// The design format, explained for agents and API callers (MCP tool
// `design_format`, GET /api/design-format).

export const DESIGN_FORMAT = `# Network design format

A design is JSON: { "plan": { … }, "naming": { … } }. Ids are optional; the app adds them.
The fastest start is new_design (POST /api/designs/new), then edit the plan it returns.

## plan
- version: 1
- cloud: "azure" (default) or "aws"
- name: the design's name
- root: the address space every region comes from, e.g. "10.0.0.0/8"
- placement: optional, "single" (default), "alz" or "alz-platform" (Azure) — which subscriptions/accounts the export deploys to
- excluded: optional [{ "cidr": "192.168.0.0/16", "label": "On-premises" }], kept clear of every network
- regions: list of regions

## region
- location: Azure location ("eastus2") or AWS region ("us-east-1"); see list_regions
- name: display name (defaults to location)
- prefix: size of the regional block, e.g. 16 for a /16
- fixed: optional pinned CIDR for the block, e.g. "10.1.0.0/16"
- topology: "hub-spoke" (default) or "vwan" (Azure Virtual WAN; the hub is then a virtual hub with no subnets)
- hub: a network (the hub VNet, the Virtual WAN hub, or the AWS inspection VPC)
- spokes: list of networks

## network (VNet / VPC)
- name: e.g. "corp-eus2-001-vnet"; exported names are rebuilt from it
- prefix: size of the main address range, e.g. 24
- fixed: optional pinned CIDR for the main range
- ranges: optional extra address ranges [{ "prefix": 24, "fixed"?: "…" }] (not for virtual hubs)
- role (spokes only): "landing-zone" (default), "platform", "identity", "management", "security", "egress", "endpoints"
- subscription / resourceGroup: optional overrides of where the export deploys it (AWS uses subscription as the account key)
- subnets: list of subnets

## subnet
- name: Azure reserved names (GatewaySubnet, AzureFirewallSubnet, AzureBastionSubnet, RouteServerSubnet, …) get Azure's rules; on AWS a name ending in -a/-b/-c sets the Availability Zone
- prefix: size, e.g. 26
- fixed: optional pinned CIDR
- offset: optional position, in addresses from the start of its network's range
- range: optional, which range offset refers to (0 or missing = main, n = ranges[n-1])
- hosts: optional number of addresses it needs; the check warns when the subnet is too small

## naming (optional)
{ "app": "network", "environment": "prd", "instance": "01" } — exported names are <app>-<environment>-<region>-<instance>-<type>.

## How addresses are allocated
At each level (root → regions, region → hub then spokes, network → subnets), pinned blocks are placed first, then the rest
first-fit in list order on their natural alignment. Appending never moves existing blocks, so list order matters.
Problems never stop the check: they come back as errors and warnings (check_design).

## Moving designs to and from the app
Every call that returns a design also returns a link; opening it loads the design in the app (after the user confirms).
The app's share link and a design exported from its Designs dialog can be sent back to any tool that takes a design.
`;
