# Changelog

User-visible changes to the ALZ CIDR Planner, newest first. Dates are when the change was made (US Central time). Since 14 October 2026, every change reaches production through a pull request.

## 2026-10-16: PR [#6](https://github.com/absmart/cloud-network-calc/pull/6)

### Added
- **AWS export.** Export IaC for AWS plans generates Terraform (hashicorp/aws 6.x) or a Terragrunt stack:
  - an `aws` provider per account, assuming a deployment role in each
  - generic modules for VPCs and subnets per Availability Zone, Transit Gateways per region (shared through AWS RAM and peered between regions), and VPC attachments
  - account placement: one account, or the Landing Zone Accelerator's network account plus an account per workload
- **Import from AWS.** Turn an existing AWS network into a new AWS design from AWS CLI output (CloudShell, PowerShell or one region). The inspection VPC is recognised, default VPCs are skipped, and each VPC keeps its account.

## 2026-10-15: PR [#5](https://github.com/absmart/cloud-network-calc/pull/5)

### Added
- **AWS networks.** An **Azure | AWS** toggle in the top bar; each design is for one cloud, and switching starts a new plan in the other. AWS plans get:
  - a Transit Gateway layout per region: inspection, egress, shared endpoints and workload VPCs, with subnets laid out once per Availability Zone and a /28 per AZ for Transit Gateway attachments
  - AWS rules: VPC blocks /16 to /28, /28 minimum subnets, the secondary CIDR restrictions and quota
  - the AWS region list with Availability Zones
  - everything else the planner does, from excluded ranges to share links

  Export, Import and Compare stay Azure-only for now.

## 2026-10-14 (evening): PRs [#2](https://github.com/absmart/cloud-network-calc/pull/2) and [#3](https://github.com/absmart/cloud-network-calc/pull/3)

### Added
- **Excluded ranges.** List address space the plan must keep clear, such as on-premises, other clouds or partner networks.
  - No VNet is placed in an excluded range, and a pinned VNet that overlaps one is an error.
  - A region may enclose a smaller excluded range, and its VNets go round it.
  - Excluded space shows hatched on the bars and isn't counted as free.
- **Sizing help.** In a VNet's List editor, enter how many hosts a subnet needs, and it gets the smallest size that fits (counting Azure's 5 reserved addresses). The planner warns if the subnet is later made too small. A VNet too small for its subnets offers a one-click resize.
- **Headroom.** The Regions overview shows how many more /16 regions fit in the root range, and how many more spokes of each region's landing zone sizes fit.
- **Subscriptions and resource groups in the export.** Choose a layout in the Export dialog, then optionally set any network's subscription or resource group by hand:
  - One subscription
  - Azure Landing Zones: connectivity, identity, management and security subscriptions, plus one per landing zone
  - ALZ with one platform subscription

  Imported networks keep the subscription and resource group they were found in.

### Changed
- **Breaking for anyone deploying earlier exports.** The IaC export now deploys every subscription in one deployment:
  - **Bicep** deploys at management-group scope (`az deployment mg create`), with modules for resource groups, the Virtual WAN, networks, and peerings.
  - **Terraform** has an `azurerm` provider alias per subscription in `main.tf`, calling generic `network` and `links` modules.
  - Both now download as a zip.
  - The variables files gained `subscriptions` and `resource_groups`.
- Compare with Azure also reports a different resource group, and a different subscription when the plan names one by ID.
- Pull requests now merge automatically once their tests, build and preview deploy pass, unless they're drafts or labelled `hold`. Production then deploys.

## 2026-10-14 (early): PR [#1](https://github.com/absmart/cloud-network-calc/pull/1)

### Added
- **Share links.** Copy a link that opens the current design and its naming options. The design is compressed into the link after `#`, so it's never uploaded. Opening a link asks before replacing the current plan.
- **Undo and redo** (Ctrl+Z, Ctrl+Y) for every plan edit, including platform layout switches and Auto-pack.
- **Several address ranges per VNet**, as Azure allows, each with its own bar and visual editor. Extra ranges never move existing VNets, and the export lists every range.
- **Compare with Azure.** Paste Azure CLI or PowerShell output, and the plan is checked against what's deployed. The report lists:
  - VNets that differ in address ranges, location or subnets
  - planned networks not deployed yet
  - networks only in Azure, flagged when they overlap the plan

### Changed
- Share link, Import from Azure, Compare with Azure and Reset moved into a "⋯" menu in the top bar.
- Importing a VNet with several address ranges now keeps them all. Before, only one was kept.
- Each pull request deploys to its own preview environment. Changes reach production by merging.

## 2026-10-12

### Added
- **Import from Azure.** Turn an existing network into a new design, from Resource Graph, `az network vnet list` or `Get-AzVirtualNetwork` output.
  - Everything is pinned where it is, so the planner reports overlaps and rule breaks in the real network.
  - Hubs are recognised by gateway or firewall subnets and peerings.
  - Extension prompts and other CLI text pasted along with the output are skipped.

### Fixed
- The deploy pipeline's GitHub Actions run on Node 24, as Node 20 is deprecated.

## 2026-10-11

### Added
- **Designs.** Save, open, duplicate, rename and delete named designs, and back them up to and restore them from a `.json` file. Ctrl+S saves.
- **Terragrunt export.** A zipped stack with remote state in Azure Storage.
- **Platform subnets in the hub.** A platform layout that puts identity, management and security subnets in the hub VNet instead of separate VNets.
- **Hosting on Azure Static Web Apps,** deployed on every push.

### Changed
- New plans start in East US 2, with its Azure pair (Central US) as the second region.
- Exported names hyphenate every component: `<app>-<environment>-<region>-<int>-<type>`.
- Identity, management and security subnets default to /27.

## 2026-10-10

### Added
- **First release.** Plan IPv4 space for Azure Landing Zones: root range → regional /16s → hub and spoke VNets → subnets, checked against Azure's rules.
- Regions chosen from Azure's list of locations, shown as colour-coded tabs, with East US 2 and Central US by default.
- Hub & spoke or Virtual WAN per region. Hubs come with the Azure service subnets, plus NVA outside, inside, HA and management subnets in the first two /24s.
- Separate or combined platform networks (identity, management and security) per region.
- A region's range can be edited directly.
- **Bicep and Terraform export,** with fully parameterized, reusable templates and a variables file per environment.
- Readable planner names with short region codes (`hub-eus2-vnet`), and exported names in the `<app>-<environment>-<region>-<int>-<type>` convention.
