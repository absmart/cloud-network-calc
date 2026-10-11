// Refresh src/lib/azure-regions.json from the regions available to the
// currently logged-in Azure CLI subscription:  npm run update-regions
//
// The hosted app is static and can't call Azure, so the list is a snapshot
// committed with the source.

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../src/lib/azure-regions.json', import.meta.url));

const locations = JSON.parse(execSync('az account list-locations -o json', { encoding: 'utf8' }));

const regions = locations
  .filter((l) => l.metadata?.regionType === 'Physical')
  // Skip early-access (EUAP) canary and staging regions.
  .filter((l) => !/(euap|stg)$/i.test(l.name))
  .map((l) => ({
    location: l.name,
    displayName: l.displayName,
    geography: l.metadata.geographyGroup ?? 'Other',
    paired: l.metadata.pairedRegion?.[0]?.name ?? null,
  }))
  .sort((a, b) => a.geography.localeCompare(b.geography) || a.displayName.localeCompare(b.displayName));

writeFileSync(out, JSON.stringify(regions, null, 2) + '\n');
console.log(`Wrote ${regions.length} regions to ${out}`);
