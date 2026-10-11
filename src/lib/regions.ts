// Azure public cloud regions (location name → display name).

export interface AzureRegion {
  location: string;
  displayName: string;
}

export const AZURE_REGIONS: AzureRegion[] = [
  ['australiaeast', 'Australia East'],
  ['australiasoutheast', 'Australia Southeast'],
  ['brazilsouth', 'Brazil South'],
  ['canadacentral', 'Canada Central'],
  ['canadaeast', 'Canada East'],
  ['centralindia', 'Central India'],
  ['centralus', 'Central US'],
  ['eastasia', 'East Asia'],
  ['eastus', 'East US'],
  ['eastus2', 'East US 2'],
  ['francecentral', 'France Central'],
  ['germanywestcentral', 'Germany West Central'],
  ['italynorth', 'Italy North'],
  ['japaneast', 'Japan East'],
  ['japanwest', 'Japan West'],
  ['koreacentral', 'Korea Central'],
  ['mexicocentral', 'Mexico Central'],
  ['northcentralus', 'North Central US'],
  ['northeurope', 'North Europe'],
  ['norwayeast', 'Norway East'],
  ['polandcentral', 'Poland Central'],
  ['qatarcentral', 'Qatar Central'],
  ['southafricanorth', 'South Africa North'],
  ['southcentralus', 'South Central US'],
  ['southeastasia', 'Southeast Asia'],
  ['spaincentral', 'Spain Central'],
  ['swedencentral', 'Sweden Central'],
  ['switzerlandnorth', 'Switzerland North'],
  ['uaenorth', 'UAE North'],
  ['uksouth', 'UK South'],
  ['ukwest', 'UK West'],
  ['westcentralus', 'West Central US'],
  ['westeurope', 'West Europe'],
  ['westus', 'West US'],
  ['westus2', 'West US 2'],
  ['westus3', 'West US 3'],
].map(([location, displayName]) => ({ location, displayName }));

export function regionDisplayName(location: string): string {
  return AZURE_REGIONS.find((r) => r.location === location)?.displayName ?? location;
}
