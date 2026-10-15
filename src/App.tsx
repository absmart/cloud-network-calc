import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { AllocationBar, Issues, excludedSegments, regionColor } from './components/common';
import { ExcludedRanges } from './components/ExcludedRanges';
import { CompareAzureDialog } from './components/CompareAzureDialog';
import { DesignsDialog } from './components/DesignsDialog';
import { ExportDialog } from './components/ExportDialog';
import { ImportAzureDialog } from './components/ImportAzureDialog';
import { Menu } from './components/Menu';
import { SharedLinkDialog } from './components/SharedLinkDialog';
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
import {
  type SavedDesign,
  createDesign,
  duplicateDesign,
  hasUnsavedChanges,
  renameDesign,
  updateDesign,
} from './lib/designs';
import { record, redo, startHistory, undo } from './lib/history';
import { formatCidr } from './lib/ipv4';
import { type PlanSpec, type RegionSpec, computePlan, countIssues } from './lib/planner';
import { type SharedDesign, decodeDesign, isShareFragment, shareUrl } from './lib/shareLink';
import { STORAGE_KEYS, loadNaming, readJson, writeJson } from './lib/storage';

const ALL = 'all';

function loadPlan(): PlanSpec {
  const plan = readJson<PlanSpec>(STORAGE_KEYS.plan);
  return plan?.version === 1 ? migratePlan(plan) : defaultPlan();
}

export default function App() {
  // The plan with its undo history. Edits go through setPlan; opening a
  // different plan (a design, an import, a share link) starts a new history.
  const [planHistory, setHistory] = useState(() => startHistory(loadPlan()));
  const plan = planHistory.present;
  const setPlan = (next: PlanSpec) => setHistory((h) => record(h, next));
  const replacePlan = (next: PlanSpec) => setHistory(startHistory(next));
  const undoPlan = () => setHistory(undo);
  const redoPlan = () => setHistory(redo);
  const [view, setView] = useState<'design' | 'table'>('design');
  const [exporting, setExporting] = useState(false);
  const [showDesigns, setShowDesigns] = useState(false);
  const [importingAzure, setImportingAzure] = useState(false);
  const [comparingAzure, setComparingAzure] = useState(false);
  // A short confirmation shown at the bottom of the page.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const notify = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  };
  // A design from a share link the app was opened with, waiting to be opened.
  const [incoming, setIncoming] = useState<{ shared: SharedDesign | null; error: string | null } | null>(null);
  const [storageOk, setStorageOk] = useState(true);
  const result = useMemo(() => computePlan(plan), [plan]);
  const counts = countIssues(result);

  // Saved designs, and the one the current plan belongs to (if any).
  const [designs, setDesigns] = useState<SavedDesign[]>(() => readJson<SavedDesign[]>(STORAGE_KEYS.designs) ?? []);
  const [activeDesignId, setActiveDesignId] = useState<string | null>(() => readJson<string>(STORAGE_KEYS.activeDesign));
  const activeDesign = designs.find((d) => d.id === activeDesignId);
  const unsaved = hasUnsavedChanges(activeDesign, plan);

  useEffect(() => {
    setStorageOk(writeJson(STORAGE_KEYS.plan, plan));
  }, [plan]);
  useEffect(() => {
    setStorageOk(writeJson(STORAGE_KEYS.designs, designs));
  }, [designs]);
  useEffect(() => {
    writeJson(STORAGE_KEYS.activeDesign, activeDesign ? activeDesign.id : null);
  }, [activeDesign]);

  /** Save into the open design, or as a new one if none is open. */
  const saveDesign = (asNew = false) => {
    const naming = loadNaming();
    if (activeDesign && !asNew) {
      setDesigns(designs.map((d) => (d.id === activeDesign.id ? updateDesign(d, plan, naming) : d)));
    } else {
      const design = createDesign(plan, naming);
      setDesigns([...designs, design]);
      setActiveDesignId(design.id);
    }
  };

  const openDesign = (id: string) => {
    const design = designs.find((d) => d.id === id);
    if (!design) return;
    const opened = migratePlan(JSON.parse(JSON.stringify(design.plan)));
    replacePlan(opened);
    setActiveDesignId(id);
    setSelected(opened.regions[0]?.id ?? ALL);
    writeJson(STORAGE_KEYS.naming, design.naming);
  };

  const newDesign = () => {
    const fresh = defaultPlan();
    replacePlan(fresh);
    setActiveDesignId(null);
    setSelected(fresh.regions[0].id);
  };

  /** Open an imported Azure network, saved straight away as a new design. */
  const openImported = (imported: PlanSpec) => {
    if (unsaved && !window.confirm('The current plan has unsaved changes. Open the imported network without saving them?')) return;
    const design = createDesign(imported, loadNaming());
    setDesigns([...designs, design]);
    replacePlan(imported);
    setActiveDesignId(design.id);
    setSelected(imported.regions[0]?.id ?? ALL);
    setImportingAzure(false);
  };

  useEffect(() => {
    // Read a share link on load, or when one is pasted into this tab's address bar.
    const readLink = () => {
      const hash = window.location.hash;
      if (!isShareFragment(hash)) return;
      // Drop the design from the address bar so a reload doesn't offer it again.
      history.replaceState(null, '', window.location.pathname + window.location.search);
      decodeDesign(hash).then(
        (shared) => setIncoming({ shared, error: null }),
        (e: Error) => setIncoming({ shared: null, error: e.message }),
      );
    };
    readLink();
    window.addEventListener('hashchange', readLink);
    return () => window.removeEventListener('hashchange', readLink);
  }, []);

  const openShared = (shared: SharedDesign, save: boolean) => {
    replacePlan(shared.plan);
    writeJson(STORAGE_KEYS.naming, shared.naming);
    if (save) {
      const design = createDesign(shared.plan, shared.naming);
      setDesigns([...designs, design]);
      setActiveDesignId(design.id);
    } else {
      setActiveDesignId(null);
    }
    setSelected(shared.plan.regions[0]?.id ?? ALL);
    setIncoming(null);
  };

  const copyShareLink = async () => {
    const url = await shareUrl(window.location.href, plan, loadNaming());
    try {
      await navigator.clipboard.writeText(url);
      notify('Share link copied');
    } catch {
      window.prompt('Copy this link to share the design:', url);
    }
  };

  const renameSavedDesign = (id: string, name: string) => {
    setDesigns(designs.map((d) => (d.id === id ? renameDesign(d, name) : d)));
    // Keep the open plan's title in step, so a rename alone isn't an unsaved change.
    if (id === activeDesignId) setPlan({ ...plan, name });
  };

  useEffect(() => {
    // Ctrl/Cmd+S saves the design instead of the web page. Ctrl/Cmd+Z undoes
    // and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes plan edits, also while typing in
    // the plan's fields, but not in a dialog, whose fields aren't the plan.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        saveDesign();
      } else if ((key === 'z' || key === 'y') && !document.querySelector('.overlay')) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) redoPlan();
        else undoPlan();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
    if (window.confirm('Replace the current plan with the default example? Saved designs are kept.')) newDesign();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <input className="plan-name" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
          <button
            className={`chip save-chip ${activeDesign && !unsaved ? 'saved' : 'unsaved'}`}
            title={activeDesign ? 'Open Designs (Ctrl+S saves)' : 'This plan is not saved as a design yet. Open Designs to save it.'}
            onClick={() => setShowDesigns(true)}
          >
            {activeDesign ? (unsaved ? '● unsaved changes' : '✓ saved') : 'not saved'}
          </button>
          <label>
            Root address space
            <input className="root" value={plan.root} onChange={(e) => setPlan({ ...plan, root: e.target.value })} />
          </label>
          <div className="tabs history">
            <button title="Undo (Ctrl+Z)" aria-label="Undo" disabled={planHistory.past.length === 0} onClick={undoPlan}>
              ↶
            </button>
            <button title="Redo (Ctrl+Y)" aria-label="Redo" disabled={planHistory.future.length === 0} onClick={redoPlan}>
              ↷
            </button>
          </div>
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
          <button onClick={() => setShowDesigns(true)}>Designs{designs.length ? ` (${designs.length})` : ''}</button>
          <button className="primary" onClick={() => setExporting(true)}>
            Export IaC
          </button>
          <Menu
            label="⋯"
            title="More actions"
            items={[
              {
                label: 'Copy share link',
                title: "A link that opens this design, with its naming options. The design is inside the link itself and isn't uploaded anywhere.",
                onSelect: () => void copyShareLink(),
              },
              {
                label: 'Import from Azure…',
                title: 'Load an existing Azure network from Azure CLI or PowerShell output',
                onSelect: () => setImportingAzure(true),
              },
              {
                label: 'Compare with Azure…',
                title: 'Check this plan against what is deployed, from Azure CLI or PowerShell output',
                onSelect: () => setComparingAzure(true),
              },
              { label: 'Reset to the example plan', onSelect: reset, separated: true },
            ]}
          />
        </div>
        <Issues issues={result.issues} />
        <AllocationBar
          parent={result.root}
          free={result.free}
          segments={[
            ...result.regions.map((r, i) => ({
              id: r.id,
              label: r.name,
              cidr: r.cidr,
              tone: 'region' as const,
              color: regionColor(i),
            })),
            ...excludedSegments(result.excluded),
          ]}
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
            <ExcludedRanges ranges={plan.excluded ?? []} onChange={(excluded) => setPlan({ ...plan, excluded })} />
            {plan.regions.map((region, i) =>
              activeTab !== ALL && activeTab !== region.id ? null : (
                <RegionCard
                  key={region.id}
                  spec={region}
                  result={result.regions[i]}
                  color={regionColor(i)}
                  minPrefix={result.root?.prefix ?? 8}
                  root={result.root}
                  excluded={result.excluded}
                  otherRegionCidrs={result.regions.flatMap((r, j) => (j !== i && r.cidr ? [r.cidr] : []))}
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
      {exporting && <ExportDialog plan={plan} result={result} onPlanChange={setPlan} onClose={() => setExporting(false)} />}
      {incoming && (
        <SharedLinkDialog
          shared={incoming.shared}
          error={incoming.error}
          warning={
            activeDesign
              ? unsaved
                ? `Opening it replaces "${activeDesign.name}", which has unsaved changes.`
                : null
              : 'Opening it replaces the current plan, which isn’t saved as a design.'
          }
          onOpen={(save) => incoming.shared && openShared(incoming.shared, save)}
          onClose={() => setIncoming(null)}
        />
      )}
      {comparingAzure && <CompareAzureDialog plan={plan} result={result} onClose={() => setComparingAzure(false)} />}
      {importingAzure && <ImportAzureDialog onImport={openImported} onClose={() => setImportingAzure(false)} />}
      {showDesigns && (
        <DesignsDialog
          plan={plan}
          naming={loadNaming()}
          designs={designs}
          activeId={activeDesign?.id ?? null}
          storageOk={storageOk}
          onSave={() => saveDesign()}
          onSaveAsNew={() => saveDesign(true)}
          onOpen={openDesign}
          onNew={newDesign}
          onRename={renameSavedDesign}
          onDuplicate={(id) => {
            const source = designs.find((d) => d.id === id);
            if (source) setDesigns([...designs, duplicateDesign(source, designs)]);
          }}
          onDelete={(id) => setDesigns(designs.filter((d) => d.id !== id))}
          onImport={(imported) => setDesigns([...designs, ...imported])}
          onClose={() => setShowDesigns(false)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
