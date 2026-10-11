import { useEffect, useMemo, useState } from 'react';
import { AllocationBar, Issues } from './components/common';
import { RegionCard } from './components/RegionCard';
import { SummaryTable } from './components/SummaryTable';
import { RegionOverview } from './components/RegionOverview';
import { REGION_PREFIX, defaultPlan, makeRegion, nextUnusedLocation } from './lib/defaults';
import { formatCidr } from './lib/ipv4';
import { type PlanSpec, type RegionSpec, computePlan, countIssues } from './lib/planner';

const STORAGE_KEY = 'alz-cidr-planner:plan';

function loadPlan(): PlanSpec {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const plan = JSON.parse(raw);
      if (plan?.version === 1) return plan;
    }
  } catch {
    // Fall through to the default plan.
  }
  return defaultPlan();
}

export default function App() {
  const [plan, setPlan] = useState<PlanSpec>(loadPlan);
  const [view, setView] = useState<'design' | 'table'>('design');
  const result = useMemo(() => computePlan(plan), [plan]);
  const counts = countIssues(result);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
    } catch {
      // Storage unavailable; the plan just won't persist.
    }
  }, [plan]);

  const updateRegion = (index: number, region: RegionSpec) =>
    setPlan({ ...plan, regions: plan.regions.map((r, i) => (i === index ? region : r)) });

  const addRegion = () => {
    // New regions follow the last region's topology, each with its own hub.
    const topology = plan.regions.at(-1)?.topology ?? 'hub-spoke';
    setPlan({ ...plan, regions: [...plan.regions, makeRegion(nextUnusedLocation(plan), topology)] });
  };

  const reset = () => {
    if (window.confirm('Replace the current plan with the default example?')) setPlan(defaultPlan());
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <input className="plan-name" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
          <label>
            Root address space
            <input className="root" value={plan.root} onChange={(e) => setPlan({ ...plan, root: e.target.value })} />
          </label>
          <div className="tabs">
            <button className={view === 'design' ? 'active' : ''} onClick={() => setView('design')}>
              Design
            </button>
            <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
              Table
            </button>
          </div>
          <span className={`status ${counts.errors ? 'error' : counts.warnings ? 'warning' : 'ok'}`}>
            {counts.errors} errors · {counts.warnings} warnings
          </span>
          <button onClick={reset}>Reset</button>
        </div>
        <Issues issues={result.issues} />
        <AllocationBar
          parent={result.root}
          free={result.free}
          segments={result.regions.map((r) => ({ id: r.id, label: r.name, cidr: r.cidr, tone: 'region' }))}
        />
      </header>

      <main>
        {view === 'table' ? (
          <SummaryTable result={result} />
        ) : (
          <>
            <RegionOverview plan={plan} result={result} />
            {plan.regions.map((region, i) => (
              <RegionCard
                key={region.id}
                spec={region}
                result={result.regions[i]}
                minPrefix={result.root?.prefix ?? 8}
                usedLocations={new Map(plan.regions.filter((_, j) => j !== i).map((r) => [r.location, r.name]))}
                onChange={(r) => updateRegion(i, r)}
                onRemove={() => setPlan({ ...plan, regions: plan.regions.filter((_, j) => j !== i) })}
              />
            ))}
            <button className="add-region" onClick={addRegion}>
              + Add region (/{REGION_PREFIX} with its own hub)
            </button>
            {result.root && result.free.length > 0 && (
              <p className="muted">
                Unallocated in {formatCidr(result.root)}: {result.free.map(formatCidr).join(', ')}
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
