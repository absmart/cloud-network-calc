# ALZ CIDR Planner

A browser app for planning IP address space for Azure Landing Zone network designs.

- **Root address space → regions → VNets → subnets.** You set a size (prefix length) for each block and the app places it in the next free aligned slot. You can also pin any block to a specific CIDR for brownfield ranges.
- **Multiple regions, each with a /16 and its own hub.** The default root `10.0.0.0/12` holds 16 regional /16s. Each /16 picks its Azure region from a dropdown grouped by geography. Regions already used by another /16 are greyed out, and each region shows its Azure paired region. "Add region" defaults to the pair of an existing region, then to another region in the same geography. The region list is a snapshot of what your subscription offers; refresh it with `npm run update-regions` (requires a logged-in Azure CLI). A Regions overview table lists every region's range and hub range. If the root runs out of space, the app suggests the smallest wider root that fits. Changing a region's location renames its VNets to match.
- **Visual subnet editor** for each VNet, inspired by [visualsubnetcalc.com](https://visualsubnetcalc.com/). Every row is a block of the VNet's range:
  - **Divide** splits a row in half.
  - Typing a name turns a free block into a subnet.
  - The coloured bars on the right are the parent blocks; click one to join everything under it.
  
  Positions are stored relative to the VNet, so the layout moves with it. **Auto-pack** throws the layout away and packs subnets first-fit again. The **List** tab keeps the size-based editor.
- **Hub & spoke or Virtual WAN** per region. Hub-spoke hubs come with GatewaySubnet, AzureFirewallSubnet, AzureFirewallManagementSubnet, AzureBastionSubnet and DNS Private Resolver subnets, plus network virtual appliance subnets: outside /24, and inside, HA and management /27s. The NVA subnets take the hub's first two /24s, and the Azure subnets start in the third. Default hubs are a /22. Virtual WAN hubs are checked against the /24 minimum (/23 recommended).
- **Platform networks** per region, either separate or combined:
  - separate: identity, management and security VNets, each a /24
  - combined: one platform VNet with an identity, management and security subnet
  
  Switching replaces only the platform VNets; corp and online landing zones are kept.
- **Spoke templates** for identity, management, security, combined platform, corp and online landing zones.
- **Azure validation:**
  - reserved subnet names and their minimum sizes
  - the /29 smallest-subnet limit
  - 5 reserved IPs per subnet in the "usable" count
  - duplicate subnet names
  - hub-only subnets placed in spokes
  - non-private or forbidden root ranges
  - overlaps and overflow
- **Table view** with first and last addresses, plus a "Copy as CSV" button.
- **Export IaC** generates a Bicep (`alz-network.bicep`) or Terraform azurerm 4.x (`main.tf`) file from the current plan, ready to copy or download. It contains:
  - every allocated VNet and subnet, with DNS resolver subnets delegated
  - for hub & spoke: hub↔spoke peerings both ways, plus hub-to-hub peerings between regions
  - for Virtual WAN: the vWAN, its hubs and its spoke connections
  
  Everything deploys into one resource group (default `rg-alz-network`). Anything the plan couldn't allocate is listed at the top of the file. To write sample files for `az bicep build` / `terraform validate`, run `IAC_OUT_DIR=<dir> npm test`.

The plan is saved automatically to your browser's local storage.

## Run

Requires Node.js 18 or later.

```powershell
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for the allocator and the Azure rules
npm run build    # production build in dist/
```

## Layout

- `src/lib/ipv4.ts`: CIDR parsing, the first-fit aligned allocator, and free-space calculation
- `src/lib/azure.ts`: Azure-specific limits and subnet presets
- `src/lib/planner.ts`: the plan model; computes the allocation and the validation issues
- `src/lib/defaults.ts`: the default plan and the hub and spoke templates
- `src/components/`: the React UI
