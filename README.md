# ALZ CIDR Planner

A browser app for planning IP address space for Azure Landing Zone network designs. What changed and when is in [CHANGELOG.md](CHANGELOG.md).

- **Root address space → regions → VNets → subnets.** You set a size (prefix length) for each block and the app places it in the next free aligned slot. You can also pin any block to a specific CIDR for brownfield ranges.
- **Multiple regions, each with a /16 and its own hub.** The default root `10.0.0.0/12` holds 16 regional /16s. Each /16 picks its Azure region from a dropdown grouped by geography. Regions already used by another /16 are greyed out, and each region shows its Azure paired region. "Add region" picks East US 2 for a plan's first region and the Azure pair of the first region for the second (East US 2 → Central US). After that it picks the pair of an existing region, then another region in the same geography. The region list is a snapshot of what your subscription offers; refresh it with `npm run update-regions` (requires a logged-in Azure CLI). A Regions overview table lists every region's range and hub range. If the root runs out of space, the app suggests the smallest wider root that fits. VNet names use short region codes (`hub-eus2-vnet` for East US 2, `corp-cus-001-vnet` for Central US), and changing a region's location renames its VNets to match.
- **Excluded ranges** for address space the plan must keep clear, such as on-premises, other clouds or partner networks. Each has a CIDR and a note on what uses it. No VNet is placed in one, and a pinned VNet that overlaps one is an error. Regions go round any excluded range as large as themselves or larger; a region may enclose a smaller one, and its VNets then go round it. Excluded space shows hatched on the bars and isn't counted as free.
- **Sizing help and headroom.**
  - In a VNet's List editor, type how many **hosts** a subnet needs and it gets the smallest size that holds them, counting Azure's 5 reserved addresses and the /29 minimum. The count is kept, and the planner warns if the subnet is later made too small.
  - A VNet too small for its subnets says which size would hold them, with a button to resize it.
  - The Regions overview shows how many more /16 regions fit in the root, and for each region how many more spokes of its landing zone sizes fit.
- **Several address ranges per VNet**, as Azure allows. **+ Add address range** gives a VNet another range, sized or pinned like the main one. Extra ranges are placed in the region after every VNet's main range, so adding one never moves an existing VNet. Subnets fill the main range first and then the extra ranges, and each range has its own bar and visual editor. Removing a range places its subnets automatically again. The IaC export lists every range in the VNet's address space.
- **Visual subnet editor** for each VNet, inspired by [visualsubnetcalc.com](https://visualsubnetcalc.com/). Every row is a block of the VNet's range:
  - **Divide** splits a row in half.
  - Typing a name turns a free block into a subnet.
  - The coloured bars on the right are the parent blocks; click one to join everything under it.
  
  Positions are stored relative to the VNet, so the layout moves with it. **Auto-pack** throws the layout away and packs subnets first-fit again. The **List** tab keeps the size-based editor.
- **Hub & spoke or Virtual WAN** per region. Hub-spoke hubs come with GatewaySubnet, AzureFirewallSubnet, AzureFirewallManagementSubnet, AzureBastionSubnet and DNS Private Resolver subnets, plus network virtual appliance subnets: outside /24, and inside, HA and management /27s. The NVA subnets take the hub's first two /24s, and the Azure subnets start in the third. Default hubs are a /22. Virtual WAN hubs are checked against the /24 minimum (/23 recommended).
- **Platform networks** per region, either separate, combined or in the hub:
  - separate: identity, management and security VNets, each a /24
  - combined: one platform VNet with an identity, management and security subnet
  - in the hub (hub & spoke only): identity, management and security /27 subnets in the hub VNet's fourth /24, with no platform VNets
  
  Switching replaces only the platform VNets and the hub's platform subnets; corp and online landing zones and the other hub subnets are kept. Changing an in-the-hub region to Virtual WAN moves its platform subnets out to separate VNets, since a virtual hub has no subnets.
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
- **Undo and redo** (↶ ↷, Ctrl+Z and Ctrl+Y or Ctrl+Shift+Z) for every plan edit, including platform layout switches and Auto-pack. Edits within a second of each other, like typing a name, are one step. Opening a design, an import or a share link starts a fresh history.
- **Export IaC** generates Bicep or Terraform that deploys the whole network, across every subscription it uses, in one deployment:
  - a **reusable template**. Every input is a typed parameter or variable, with no names, CIDRs or regions hard-coded, so the same template deploys any plan.
    - Bicep: `alz-network.bicep`, deployed at a management group above the subscriptions (`az deployment mg create`), with modules in `modules/` for resource groups, the Virtual WAN, each resource group's networks, and the peerings and hub connections, which run last. It downloads as `alz-network-bicep.zip`.
    - Terraform (azurerm 4.x): `main.tf` has an `azurerm` provider alias for each of the plan's subscriptions, and calls two generic modules per subscription: `modules/network` (resource groups, VNets and subnets, Virtual WAN and hubs) and `modules/links` (peerings and hub connections, which wait for the VNets they connect). `main.tf` follows the plan's subscriptions and nothing else; for another subscription, add its provider and two module calls. It downloads as `alz-network-terraform.zip`.
  - a **variables file** for the chosen environment, `alz-network.prd.bicepparam` or `prd.tfvars`. It holds this plan's values:
    - the subscriptions, as short names mapped to IDs (placeholders to replace), and the resource groups to create
    - tags
    - VNets and subnets
    - peerings, with their forwarded-traffic and gateway-transit options
    - the Virtual WAN, its hubs (with SKUs) and its hub connections
  
  Copy the variables file for each environment (`dev.tfvars`, ...).
  
  A **Terragrunt** option downloads `alz-network-terragrunt.zip`, which contains:
  - `root.hcl`: azurerm remote state in Azure Storage, set by environment variables `ARM_SUBSCRIPTION_ID` (the state account's subscription), `TG_STATE_RESOURCE_GROUP`, `TG_STATE_STORAGE_ACCOUNT` and `TG_STATE_CONTAINER`
  - `modules/alz-network/`: the same Terraform configuration and modules, with its providers
  - `live/<env>/alz-network/terragrunt.hcl`: this plan as `inputs`
  - a README with the deploy steps
  
  Together they contain:
  - every allocated VNet and subnet, with DNS resolver subnets delegated
  - for hub & spoke: hub↔spoke peerings both ways, plus hub-to-hub peerings between regions
  - for Virtual WAN: the vWAN, its hubs and its spoke connections
  
  Exported names follow `<app>-<environment>-<region>-<int>-<resourcetype>`, for example `hub-prd-eus2-01-vnet`, `corp-prd-eus2-001-vnet` or `identity-prd-eus2-01-snet`. The `<app>` comes from each VNet or subnet's planner name, and the `<region>` codes are defined in `src/lib/naming.ts`. Environment, instance and the shared app (used for the resource group and vWAN) are editable in the dialog. Azure-reserved subnet names such as GatewaySubnet are kept, and the planner itself keeps its readable names.
  
  **Subscriptions and resource groups.** Pick a layout in the dialog, then optionally set any network's subscription or resource group by hand; the choice is saved with the plan.
  - **One subscription** (default): everything in one resource group (`network-prd-eus2-01-rg`).
  - **Azure Landing Zones**: the ALZ platform subscriptions plus one subscription per landing zone, as subscription vending creates them. Hubs and the Virtual WAN go in `connectivity`; identity, management and security spokes in their own subscriptions; each landing zone in its own (`corp-eus2-001`). Resource groups are per network and region, such as `connectivity-prd-eus2-01-rg` or `corp-prd-eus2-001-rg`.
  - **ALZ, one platform subscription**: the same, but hubs and platform networks share a single `platform` subscription.

  A subscription is a short name that the variables file maps to an ID, or an ID itself. Imported networks keep the subscription and resource group they were found in.

  Anything the plan couldn't allocate is listed at the top of the file. To write sample files for `az bicep build` / `terraform validate`, run `IAC_OUT_DIR=<dir> npm test`.

The plan you're working on is kept automatically in your browser's local storage.

## Designs (save and back up)

The **Designs** button keeps multiple named designs:
- **Save** the current plan as a design (or press Ctrl+S), or **Save as new**. A chip next to the plan name shows whether there are unsaved changes.
- **Open**, **Duplicate**, **Rename** or **Delete** saved designs. Opening asks before discarding unsaved changes.
- Each design keeps the full plan (regions, CIDRs, VNets, subnets, layouts) and the IaC naming options.
- **Export** one design, the current plan, or **all** designs to a `.json` backup, and **Import** them again here or in another browser. Saved designs live in this browser only, so export them to keep a real backup.

## AWS networks

The **Azure | AWS** toggle at the left of the top bar picks the cloud. Each design is for one cloud: switching starts a new example plan in the other (asking first if the current one isn't saved), and saved designs, backups and share links keep their cloud. Plans saved before AWS support are Azure.

An AWS plan uses the same planner — regions, excluded ranges, the visual editor, sizing, headroom, undo, designs and share links — with AWS's rules and layout:
- **Starting layout per region**, after the network design of AWS's Landing Zone Accelerator: a Transit Gateway hub with an **inspection VPC** (Transit Gateway attachment and Network Firewall subnets), an **egress VPC** (public subnets for NAT gateways), a **shared endpoints VPC** (interface endpoints, Route 53 Resolver) and a **workload VPC** (private and data subnets). Every VPC lays its subnets out once per Availability Zone (`private-a`, `private-b`, `private-c`) with a dedicated /28 per AZ for its Transit Gateway attachment. **+ Add VPC** offers these plus an internet-facing workload VPC and an empty one, and **Add subnet** adds a tier once per AZ.
- **Rules:** VPC CIDR blocks of /16 to /28, subnets of /28 or larger, 5 reserved addresses per subnet, no link-local, loopback or multicast ranges, the 5-CIDR-block default quota, and AWS's restriction on secondary CIDRs from a different RFC 1918 block than the primary (a 10.x VPC can't add 172.16–31.x or 192.168.x). Overlapping Docker's 172.17.0.0/16 is a warning. Additional address ranges are a VPC's **secondary CIDRs**.
- **Regions:** the commercial AWS regions with short codes for names (`us-east-1` → `use1`) and their Availability Zones. New plans start in us-east-1 and us-west-2; the next region added is the latest region's usual disaster-recovery partner, else one in the same geography.

**Export IaC** for an AWS plan generates **Terraform** (hashicorp/aws 6.x) or a **Terragrunt** stack (S3 state), as a zip:
- `main.tf` has an `aws` provider per account (provider blocks can't come from a variable), each assuming `deployment_role_name` (for example `OrganizationAccountAccessRole` or `AWSControlTowerExecution`) in its account, or using your credentials as they are when it's null. aws 6.x sets the region on each resource, so one provider per account covers every region.
- Generic modules, called per account: `modules/vpcs` (VPCs, secondary CIDRs, subnets in their Availability Zones, taken from the `-a`/`-b`/`-c` name suffix), `modules/transit` (a Transit Gateway per region, shared with other accounts through AWS RAM, and peerings between regions with a route for each region's block), and `modules/attachments` (each VPC's Transit Gateway attachment through its `tgw-*` subnets; the inspection VPC's with appliance mode).
- **Accounts:** choose **One account** or **Landing Zone Accelerator** — a `network` account for the Transit Gateways and the inspection, egress and endpoints VPCs, plus one account per workload VPC — and set any VPC's account by hand. Accounts are short names the variables file maps to 12-digit IDs, or IDs themselves.
- Firewalls, NAT gateways, internet gateways and VPC route tables aren't included.

**⋯ → Import from AWS** reads the output of a command run in AWS CloudShell (bash) or PowerShell that lists VPCs, subnets, Transit Gateways and their attachments in every region of an account (run it per account and paste the outputs together), or plain `aws ec2 describe-*` output for one region. Default VPCs are skipped. Each region's hub is the VPC whose Transit Gateway attachment uses appliance mode, else one with firewall subnets or "inspection" in its name. Everything is pinned where it is, and each VPC keeps its account as its placement.

Compare is Azure-only for now.

## Share link

**⋯ → Copy share link** copies a link that opens the current plan, with its IaC naming options. The design is compressed into the part of the link after `#`, which browsers never send to a server, so nothing is uploaded: anyone with the link has the design, and nobody else does. The default plan makes a link of about 700 characters. Opening a link shows what it holds and asks before replacing the current plan; **Open and save to my designs** also keeps it as a saved design. The design is then removed from the address bar, so a reload doesn't offer it again.

## Compare with Azure

**⋯ → Compare with Azure** checks the current plan against what is deployed. It takes the same command output as the import (below), read in the browser and sent nowhere. Each planned VNet and Virtual WAN hub is matched to a deployed one by the name the IaC export gives it (using the naming options set in Export IaC) or by its planner name, and failing that by overlapping address space in the same location. The result lists:
- **Different**: address ranges, location, or subnets that don't match, or that exist on only one side
- **Only in Azure**: deployed networks the plan doesn't have, marked **Overlaps the plan** when they clash with planned address space
- **Not deployed**: planned networks with nothing in Azure yet
- **Matches**: hidden unless you untick "Only differences"

## Import from Azure

**⋯ → Import from Azure** brings an existing network into the planner, to check it against the Azure rules and plan what comes next. The app can't call Azure, so you export the network yourself and paste or load the output. It is read in the browser and sent nowhere. The dialog has a command to copy for each of these:
- **Azure CLI · Resource Graph**: VNets and Virtual WAN hubs across every subscription you can read (`az graph query`, needs the `resource-graph` extension). Over 1,000 results come in pages; paste every page together.
- **Azure CLI**: `az network vnet list` and `az network vhub list` for the current subscription (`vhub` needs the `virtual-wan` extension).
- **Azure PowerShell**: `Get-AzVirtualNetwork` and `Get-AzVirtualHub`, converted with `ConvertTo-Json -Depth 10`.

Output from several commands or subscriptions can be pasted together. CLI messages mixed in, such as extension prompts, are skipped. A preview lists the regions found, notes on anything that was guessed or left out, and the planner's errors and warnings. **Open as new design** opens the network and saves it as a design.

How the network is turned into a plan:
- Each Azure location is a region. A Virtual WAN hub there makes it a Virtual WAN region. Otherwise the hub is the VNet with a gateway or firewall subnet, failing that the one with the most peerings, and the other VNets are spokes.
- Everything is pinned where it is: region ranges (a /16 where that doesn't take in another region's VNets, otherwise the smallest range covering the region), VNets and subnet positions. The root range is the smallest range covering all regions. Overlaps and rule breaks in the real network show up as the planner's usual errors.
- A VNet with several address ranges keeps them all: the first one Azure lists is its main range and the others are extra ranges, each holding its own subnets. Imported spokes are landing zones, so changing a region's platform layout never replaces them.

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
