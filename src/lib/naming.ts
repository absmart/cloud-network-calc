// Region short codes (eastus2 → eus2), used in the planner's VNet names
// (hub-eus2-vnet), and resource naming for exported IaC:
// <app>-<environment><region><int>-<resourcetype>, for example hub-prdeus201-vnet.

export interface NamingOptions {
  /** <app> for shared resources: the resource group and the Virtual WAN. */
  app: string;
  environment: string;
  /** Default <int>; a VNet whose name carries a number (corp-eus2-001-vnet) keeps that number. */
  instance: string;
}

export const DEFAULT_NAMING: NamingOptions = { app: 'network', environment: 'prd', instance: '01' };

/** Short region codes used in names. Locations not listed fall back to the full location name. */
const REGION_CODES: Record<string, string> = {
  australiacentral: 'auc',
  australiacentral2: 'auc2',
  australiaeast: 'aue',
  australiasoutheast: 'ause',
  austriaeast: 'ate',
  belgiumcentral: 'bec',
  brazilsouth: 'brs',
  brazilsoutheast: 'brse',
  canadacentral: 'cac',
  canadaeast: 'cae',
  centralindia: 'inc',
  centralus: 'cus',
  chilecentral: 'clc',
  denmarkeast: 'dke',
  eastasia: 'ea',
  eastus: 'eus',
  eastus2: 'eus2',
  francecentral: 'frc',
  francesouth: 'frs',
  germanynorth: 'gn',
  germanywestcentral: 'gwc',
  indiasouthcentral: 'insc',
  indonesiacentral: 'idc',
  israelcentral: 'ilc',
  italynorth: 'itn',
  japaneast: 'jpe',
  japanwest: 'jpw',
  jioindiacentral: 'jinc',
  jioindiawest: 'jinw',
  koreacentral: 'krc',
  koreasouth: 'krs',
  malaysiawest: 'myw',
  mexicocentral: 'mxc',
  newzealandnorth: 'nzn',
  northcentralus: 'ncus',
  northeurope: 'neu',
  norwayeast: 'nwe',
  norwaywest: 'nww',
  polandcentral: 'plc',
  qatarcentral: 'qac',
  southafricanorth: 'san',
  southafricawest: 'saw',
  southcentralus: 'scus',
  southeastasia: 'sea',
  southindia: 'ins',
  spaincentral: 'spc',
  swedencentral: 'sdc',
  switzerlandnorth: 'szn',
  switzerlandwest: 'szw',
  uaecentral: 'uac',
  uaenorth: 'uan',
  uksouth: 'uks',
  ukwest: 'ukw',
  westcentralus: 'wcus',
  westeurope: 'weu',
  westindia: 'inw',
  westus: 'wus',
  westus2: 'wus2',
  westus3: 'wus3',
};

export const regionCode = (location: string) => REGION_CODES[location] ?? clean(location);

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function normalizeNaming(options: NamingOptions): NamingOptions {
  return {
    app: clean(options.app) || DEFAULT_NAMING.app,
    environment: clean(options.environment),
    instance: options.instance.replace(/\D/g, '') || DEFAULT_NAMING.instance,
  };
}

/**
 * Split a planner name such as "corp-eus2-001-vnet" or "nva-outside-snet"
 * into an <app> ("corp", "nvaoutside") and an optional instance ("001"),
 * dropping the resource-type suffix and the region (as a code, or as the
 * full location name). Older plans' prefixed names ("vnet-corp-eastus2-001")
 * parse the same way.
 */
export function parsePlannerName(name: string, location: string): { app: string; instance?: string } {
  const types = ['vnet', 'vhub', 'snet', 'vwan'];
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length > 1 && types.includes(tokens.at(-1)!)) tokens.pop();
  else if (types.includes(tokens[0])) tokens.shift();
  const rest = tokens.filter((t) => t !== location && t !== regionCode(location));
  const instance = rest.length > 1 && /^\d+$/.test(rest.at(-1)!) ? rest.pop() : undefined;
  return { app: rest.join(''), instance };
}

/** <app>-<environment><region><int>, the part every resource type shares. */
export const nameBase = (app: string, options: NamingOptions, location: string, instance = options.instance) =>
  `${app}-${options.environment}${regionCode(location)}${instance}`;

export const resourceName = (base: string, type: string) => `${base}-${type}`;
