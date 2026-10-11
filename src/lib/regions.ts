// Azure regions available to the subscription, snapshotted from the Azure CLI
// by `npm run update-regions` (see scripts/update-regions.mjs).

import regions from './azure-regions.json';

export interface AzureRegion {
  location: string;
  displayName: string;
  geography: string;
  /** Azure's paired region for disaster recovery, if it has one. */
  paired: string | null;
}

export const AZURE_REGIONS: AzureRegion[] = regions;

export function findRegion(location: string): AzureRegion | undefined {
  return AZURE_REGIONS.find((r) => r.location === location);
}

export function regionDisplayName(location: string): string {
  return findRegion(location)?.displayName ?? location;
}

/** Regions grouped by geography, in snapshot order. */
export function regionsByGeography(): [string, AzureRegion[]][] {
  const groups = new Map<string, AzureRegion[]>();
  for (const r of AZURE_REGIONS) groups.set(r.geography, [...(groups.get(r.geography) ?? []), r]);
  return [...groups];
}
