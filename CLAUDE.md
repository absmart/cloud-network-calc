# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ALZ CIDR Planner: a static, client-only React 18 + TypeScript + Vite app for planning IPv4 address space for Azure Landing Zone networks (root range → regional /16s → hub and spoke VNets → subnets), validating it against Azure rules, and exporting Bicep / Terraform / Terragrunt. There is no backend; all state lives in browser `localStorage`. `README.md` is the user-facing feature spec. Keep it in sync when behaviour changes.

## Commands

```powershell
npm install
npm run dev                          # Vite dev server, http://localhost:5173
npm test                             # vitest run (all *.test.ts in src/lib)
npx vitest run src/lib/planner.test.ts           # one file
npx vitest run -t "hub-to-hub"                   # tests whose name matches
npm run build                        # tsc (type-check, strict + noUnusedLocals/Parameters) then vite build → dist/
npm run update-regions               # refresh src/lib/azure-regions.json from `az account list-locations` (needs a logged-in Azure CLI)
```

There is no linter or formatter configured. `tsc` in `npm run build` is the only static check. `noUnusedLocals`/`noUnusedParameters` will fail the build.

To produce real IaC samples for checking with `az bicep build` or `terraform validate`, set `IAC_OUT_DIR` before running the tests. This enables a test in `iac.test.ts` that writes hub-spoke and vWAN samples in every format (PowerShell: `$env:IAC_OUT_DIR='out'; npm test`).

## Deploy

The app is hosted on Azure Static Web Apps (`swa-cloud-network-calc` in resource group `rg-cloud-network-calc`, https://ambitious-sea-0d5e2730f.5.azurestaticapps.net). [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the tests, builds and uploads `dist/`, using the repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. A failing test stops the deploy. The workflow can also be run by hand from the Actions tab.

- Work goes on a branch and into `main` through a pull request. The **Tests and build** job (`npm test`, then `npm run build`, which type-checks) is the gate; branch protection on `main` requires it by that name. Each PR then deploys to its own preview environment, and the action comments its URL on the PR. Every push to the PR updates it, and closing or merging the PR removes it. The Free plan allows 3 preview environments at once, and their URLs are public.
- **Auto-merge.** When the check and the preview deploy pass on a PR the repository owner opened from a branch of this repo, the **Merge into main** job rebase-merges it, deletes the branch and starts the production deploy. Draft PRs and PRs labelled `hold` are left alone; marking a draft ready for review runs it again. A merge made with the workflow's `GITHUB_TOKEN` doesn't trigger other workflow runs, which is why that job dispatches the production deploy and removes the preview itself.
- A push to `main` (or the dispatched run) deploys to production, after running the tests and build again.

To deploy by hand from a machine with a logged-in Azure CLI (for example, to deploy something that isn't on `main`):

```bash
npm run build
export SWA_CLI_DEPLOYMENT_TOKEN=$(az staticwebapp secrets list -n swa-cloud-network-calc -g rg-cloud-network-calc --query properties.apiKey -o tsv)
npx --yes @azure/static-web-apps-cli@2.0.2 deploy ./dist --env production
```

## Architecture

All logic is pure functions in `src/lib/`, and that is where every test lives. `src/components/` is thin React UI over it. There is no state library: `App.tsx` holds the plan in `useState`.

**Spec vs. result.** The core split is in `planner.ts`:
- `PlanSpec` → `RegionSpec` → `VnetSpec` → `SubnetSpec` is what the user edits and what gets persisted. Blocks are given as a size (`prefix`), optionally pinned (`fixed` CIDR string), and for subnets optionally an `offset` relative to the VNet base.
- `computePlan(plan)` derives a `PlanResult` tree (actual `Cidr`s, free blocks, `Issue[]` at every level) and is recomputed with `useMemo` on every edit. Never store computed CIDRs back into the spec unless you mean to pin them. Components receive both `spec` and `result` and call `onChange(newSpec)` with immutable updates.

**Allocation** (`ipv4.allocate`): at each level (root → regions, region → hub + spokes, VNet → subnets), pinned requests are placed first, then the rest go first-fit on natural alignment in list order. As a result, appending a block never moves existing ones, and list order matters. Allocation failures become `Issue`s; they are never thrown. The region's hub is always request index 0 ahead of the spokes.

**Clouds.** `PlanSpec.cloud` is `'azure'` (or missing, for older plans) or `'aws'`; `cloudOf(plan)` reads it. `cloud.ts` gathers everything that differs: words and limits (`CLOUDS`), regions (`regionsByGeography`, `regionName`, `regionShortCode`, `partnerRegion`), new plans and regions (`newPlan`, `nextRegion`), templates (`spokeTemplates`) and `relocate`. AWS rules and regions are in `aws.ts`, the AWS layout in `awsDefaults.ts`. `computePlan` applies the plan's cloud's rules (Azure presets and Virtual WAN only for Azure; VPC block limits, secondary CIDR restrictions and quota only for AWS). Components get the cloud from `CloudContext` (`useCloud()`), provided by `App.tsx`.

**AWS export and import.** `awsIac.ts` mirrors the Azure Terraform export for AWS:
- `buildAwsModel` builds the model: VPCs with Name tags, subnets with Availability Zones from their `-a`/`-b` suffix, a Transit Gateway per region in the hub's account, attachments through `tgw-*` subnets, and full-mesh peerings between Transit Gateways in the same account.
- `toAwsTerraform(accounts)` generates the root, with one `aws` provider alias per account (`accountAliases`), each assuming `var.deployment_role_name`, and `vpcs_`/`transit_`/`attachments_<alias>` module calls.
- `toAwsTerraformModules()` holds the generic modules.
- It relies on aws provider 6.x's per-resource `region` argument.

Checking changes to it:
- `terraform validate` works offline after init.
- For `terraform plan`, add an override.tf giving each provider alias mock keys and `skip_credentials_validation`/`skip_requesting_account_id`/`skip_metadata_api_check`, and set `deployment_role_name = null`.

Placement for AWS uses the same `VnetSpec.subscription` field as an account key, with `AWS_PLACEMENT_LAYOUTS` (`single`, `alz` = Landing Zone Accelerator). `importAws.ts` reads AWS CLI output (`AWS_IMPORT_COMMANDS`), sharing `parseDocuments` and `regionBlocks` with the Azure importer. `AzureExportInput` and `ImportAzureDialog` take a `cloud` prop.

**Excluded ranges.** `PlanSpec.excluded` (optional) is parsed into `PlanResult.excluded` (`Blocked[]`). `allocate` takes them as `blocked`: automatic placement goes round them and an overlapping pin is an error. With `mayEnclose` (root → regions only), a block may contain blocked space smaller than itself. Region and VNet allocation pass them too, and `free` at root and region level leaves them out.

**Several address ranges per VNet.** `VnetSpec.prefix`/`fixed` is the main range; `VnetSpec.ranges` holds extra ones. `SubnetSpec.range` and `Split.range` (missing = 0 = main, n = `ranges[n - 1]`) say which range an `offset` is relative to; an auto subnet without `range` fills the main range, then each extra one (`allocateSubnets` in `planner.ts`). Extra ranges are allocation requests after every VNet's main range in the region. `VnetResult.ranges` lists all of them (main first, null if unallocated). The visual editor works on one range at a time through `rangeView`/`applyRangeView` in `layout.ts`, so the tree logic only ever sees one range. Ranges are referenced by index, not id, because share links drop ids.

**Visual subnet editor** (`layout.ts`): it treats a VNet as a binary tree of blocks but never stores a tree. Leaves are derived from the allocated subnets plus free space, refined by the `VnetSpec.splits` the user made. `divide`/`join`/`assign`/`release` first "lock" every auto-placed subnet by writing its current `offset`, so that a visual edit doesn't reshuffle the others. `autoPack` clears offsets and splits. Offsets are relative so the layout follows the VNet if it moves. Absolute `fixed` pins stay absolute.

**Azure rules** live in `azure.ts`: `SUBNET_PRESETS` defines reserved names, minimum and default sizes, hub-only and delegations; it also holds the /29 minimum, 5 reserved IPs, vWAN hub sizes and private/forbidden ranges. `planner.ts` turns these into issues.

**Defaults and templates** (`defaults.ts`): `makeHub` (the hub-spoke hub is a /22 with subnets at fixed offsets: NVA subnets in the first two /24s, Azure services from the third), `SPOKE_TEMPLATES`, the platform layout switch (`setPlatformLayout` replaces only spokes whose `role` isn't `landing-zone` and hub subnets flagged `platform`; the `hub` layout is hub & spoke only, and `setTopology` moves hub platform subnets out to spokes when switching to vWAN), `nextUnusedLocation` (East US 2 first, then Azure pairs, then same geography), and `relocateRegion` (renames VNets carrying the old region code).

**Persistence and migration.** `storage.ts` holds all `localStorage` keys (prefixed `alz-cidr-planner:`) and guarded read/write. `PlanSpec.version` is `1`. Older saved plans are upgraded by `migratePlan` in `defaults.ts`, which is applied on load, on opening a design and on import. Any spec shape change must stay backward compatible through `migratePlan`, because users have plans in browser storage and in exported JSON backups. `designs.ts` handles named saved designs (plan + `NamingOptions`) and the JSON backup format. `parseBackup` accepts a backup, a single design or a bare plan.

**Region data.** `azure-regions.json` is a committed snapshot, because the hosted app can't call Azure. `regions.ts` wraps it. Short region codes (`eastus2` → `eus2`) are a separate hand-maintained table in `naming.ts`; a new region missing there falls back to its full location name.

**IaC export** (`iac.ts`): `buildIacModel(plan, result, naming)` builds one intermediate model (VNets, subnets with delegations, peerings both ways including hub-to-hub, vWAN hubs and connections, plus the unallocated items as `omitted`). Each format renders from that model, so Bicep and Terraform always describe the same network. Templates (`toBicep()`, `toTerraform()`) take no arguments: they are fully parameterized and must not hard-code any plan values. Plan values only go into the variables renderers (`toBicepParams`, `toTfvars`, `toTerragruntLive`). `generateIacFiles` picks the file set per format. The Terragrunt option is zipped by the dependency-free `zip.ts`. Tests assert on exact generated names and counts, so update `iac.test.ts` along with output changes.

One deployment covers every subscription. Bicep is `targetScope = 'managementGroup'` and uses modules (`BICEP_MODULES`, from `toBicepModules()`): resource groups at subscription scope, then the Virtual WAN, then per resource group its VNets and virtual hubs (`network.bicep`), and last peerings and hub connections (`links.bicep`), which need every VNet to exist. Terraform uses `azurerm` (not azapi, by the user's choice for compatibility). azurerm binds a provider to one subscription, and provider blocks and `provider =` can't come from a variable or `for_each`. So `toTerraform(subscriptions)` generates the root `main.tf` with a provider alias (`providerAliases`) plus a `network_<alias>` and `links_<alias>` module call per subscription. That root depends on the subscription keys only; the modules (`TERRAFORM_MODULES`, from `toTerraformModules()`) are generic. The links modules get remote IDs from every network module's outputs, so peerings wait for both VNets. Terragrunt uses the same root and modules under `modules/alz-network/`, so `root.hcl` generates no provider.

Before changing a template, check the samples: `IAC_OUT_DIR=<dir> npm test`, then `az bicep build` / `az bicep build-params`, and `terraform init -backend=false && terraform validate && terraform fmt -check -recursive`. For `terraform plan -var-file=...`, azurerm needs subscription IDs the Azure CLI knows, so substitute a real one for the placeholders. Set `ARM_RESOURCE_PROVIDER_REGISTRATIONS=none` so the plan doesn't register resource providers; it then creates and changes nothing.

**Placement** (`placement.ts`): which subscription and resource group each network deploys into. `PlanSpec.placement` picks a layout (`single`, `alz`, `alz-platform`); `suggestedPlacement` derives each VNet's placement from it and the VNet's role, and `VnetSpec.subscription` / `resourceGroup` override it (`placementOf`). Subscriptions are logical keys that the variables file maps to IDs; a key that is already a subscription ID is used as is. The Virtual WAN goes with the first virtual hub. The importer sets the overrides from the resource IDs it reads.

**Share links** (`shareLink.ts`): `encodeDesign` puts `{ v: 1, plan, naming }` into the URL fragment as `#d=<base64url(deflate-raw(json))>`, using the browser's `CompressionStream` (no dependency). Ids are dropped on encode and regenerated by `decodeDesign`, which also runs `migratePlan`, so the link format is the persisted spec format: spec changes must keep old links readable. `App.tsx` reads the fragment on load and on `hashchange`, clears it with `history.replaceState`, and shows `SharedLinkDialog` before replacing the plan.

**Azure import** (`importAzure.ts`): `importAzureNetwork(json)` turns exported VNets and Virtual WAN hubs (Resource Graph via `AZURE_IMPORT_QUERY`, `az network vnet list`, `Get-AzVirtualNetwork | ConvertTo-Json -Depth 10`, ARM REST lists, several pasted together with stray CLI text skipped; properties are read case-insensitively, flat or under `properties`) into a `PlanSpec` plus `ImportNote[]`. One region per location; a virtual hub makes it vWAN, otherwise the hub is the VNet with gateway/firewall subnets, then the most peered. VNets and region blocks are pinned with `fixed`, subnets with `offset`, so `computePlan` reports overlaps and rule violations in the real estate. Imported spokes get `role: 'landing-zone'` so a platform layout switch never replaces them. A VNet's first Azure address prefix is its main range and the rest become `ranges`. `ImportAzureDialog` shows the `AZURE_IMPORT_COMMANDS`, previews the result and opens it as a new saved design.

**Compare** (`compare.ts`, `compareAzure.ts`, `compareAws.ts`): each cloud reads its export (`readAzureNetwork` / `readAwsNetwork`, shared with the importers) and compares it with its IaC model (`buildIacModel` / `buildAwsModel`), not the spec, so names are the exported ones. That's why the model's networks and subnets carry `plannerId`/`plannerName`. `compareSides` in `compare.ts` does the matching for both: by exported or planner name, then by overlapping address space in the same location (or by region, for Transit Gateways), with statuses `different` / `only-deployed` / `not-deployed` / `same`. Each cloud supplies its own checks: subscription and resource group for Azure; account, Availability Zones and Transit Gateway attachment for AWS. `AzureExportInput` (commands, paste box) and `LoadFileButton` are shared by the import and compare dialogs.

**Naming** (`naming.ts`): the planner shows readable names (`hub-eus2-vnet`, `corp-cus-001-vnet`). Exported names are rebuilt as `<app>-<env>-<region>-<int>-<type>` by `parsePlannerName` → `nameBase` → `resourceName`. Azure-reserved subnet names (e.g. `GatewaySubnet`) pass through unchanged.

## Conventions

- Exact-pinned dependency versions in `package.json`.
- Commit messages: short imperative sentence describing the user-visible change (e.g. "Hyphenate every component of exported names").
- `CHANGELOG.md` lists user-visible changes by date, newest first, under Added / Changed / Fixed, with the pull request linked. Add an entry in the same pull request as the change, and say when a change breaks existing exports or saved data.
