import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { AllocationBar, Issues, regionColor } from './components/common';
import { RegionCard } from './components/RegionCard';
import { SummaryTable } from './components/SummaryTable';
import { RegionOverview } from './components/RegionOverview';
import {
  REGION_PREFIX,
  defaultPlan,
  makeRegion,
  migratePlan,
  nextUnusedLocation,
  platformLayoutOf,
} from './lib/defaults';
import { formatCidr } from './lib/ipv4';
import { type PlanSpec, type RegionSpec, computePlan, countIssues } from './lib/planner';

const STORAGE_KEY = 'alz-cidr-planner:plan';
const ALL = 'all';

function loadPlan(): PlanSpec {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const plan = JSON.parse(raw);
      if (plan?.version === 1) return migratePlan(plan);
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

  // Which region tab is open: a region id, or ALL. Falls back to the first
  // region if the selected one was removed.
  const [selected, setSelected] = useState<string>(() => plan.regions[0]?.id ?? ALL);
  const activeTab = selected === ALL || plan.regions.some((r) => r.id === selected) ? selected : (plan.regions[0]?.id ?? ALL);

  const updateRegion = (index: number, region: RegionSpec) =>
    setPlan({ ...plan, regions: plan.regions.map((r, i) => (i === index ? region : r)) });

  const addRegion = () => {
    // New regions follow the last region's topology and platform layout, each with its own hub.
    const last = plan.regions.at(-1);
    const region = makeRegion(
      nextUnusedLocation(plan),
      last?.topology ?? 'hub-spoke',
      last ? platformLayoutOf(last) : 'separate',
    );
    setPlan({ ...plan, regions: [...plan.regions, region] });
    setSelected(region.id);
  };

  const reset = () => {
    if (window.confirm('Replace the current plan with the default example?')) {
      const fresh = defaultPlan();
      setPlan(fresh);
      setSelected(fresh.regions[0].id);
    }
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
          segments={result.regions.map((r, i) => ({
            id: r.id,
            label: r.name,
            cidr: r.cidr,
            tone: 'region',
            color: regionColor(i),
          }))}
        />
        {view === 'design' && (
          <nav className="region-tabs" aria-label="Regions">
            {plan.regions.map((region, i) => {
              const r = result.regions[i];
              const { errors, warnings } = countIssues(r);
              return (
                <button
                  key={region.id}
                  className={activeTab === region.id ? 'active' : ''}
                  style={{ '--region-color': regionColor(i) } as CSSProperties}
                  onClick={() => setSelected(region.id)}
                >
                  <span className="swatch" />
                  <span className="tab-name">{region.name}</span>
                  <code>{r.cidr ? formatCidr(r.cidr) : 'unallocated'}</code>
                  {(errors > 0 || warnings > 0) && (
                    <span className={`tab-issues ${errors ? 'error' : 'warning'}`} title={`${errors} errors · ${warnings} warnings`}>
                      {errors || warnings}
                    </span>
                  )}
                </button>
              );
            })}
            <button className={activeTab === ALL ? 'active all' : 'all'} onClick={() => setSelected(ALL)}>
              All regions
            </button>
            <button className="add" onClick={addRegion} title={`Add a /${REGION_PREFIX} region with its own hub`}>
              + Add region
            </button>
          </nav>
        )}
      </header>

      <main>
        {view === 'table' ? (
          <SummaryTable result={result} />
        ) : (
          <>
            <RegionOverview plan={plan} result={result} selected={activeTab} onSelect={setSelected} />
            {plan.regions.map((region, i) =>
              activeTab !== ALL && activeTab !== region.id ? null : (
                <RegionCard
                  key={region.id}
                  spec={region}
                  result={result.regions[i]}
                  color={regionColor(i)}
                  minPrefix={result.root?.prefix ?? 8}
                  usedLocations={new Map(plan.regions.filter((_, j) => j !== i).map((r) => [r.location, r.name]))}
                  onChange={(r) => updateRegion(i, r)}
                  onRemove={() => setPlan({ ...plan, regions: plan.regions.filter((_, j) => j !== i) })}
                />
              ),
            )}
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
