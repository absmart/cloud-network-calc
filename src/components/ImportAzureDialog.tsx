import { useEffect, useMemo, useState } from 'react';
import { importAzureNetwork } from '../lib/importAzure';
import { formatCidr } from '../lib/ipv4';
import { type PlanSpec, computePlan, countIssues } from '../lib/planner';
import { AzureExportInput, LoadFileButton } from './AzureExportInput';

const DEFAULT_NAME = 'Imported Azure network';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Paste or load an export of an existing Azure network and open it as a new design. */
export function ImportAzureDialog(props: { onImport: (plan: PlanSpec) => void; onClose: () => void }) {
  const { onClose } = props;
  const [input, setInput] = useState('');
  const [name, setName] = useState(DEFAULT_NAME);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = useMemo(() => {
    if (!input.trim()) return null;
    try {
      const imported = importAzureNetwork(input);
      return { ...imported, result: computePlan(imported.plan) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [input]);

  const counts = preview && 'result' in preview ? countIssues(preview.result) : null;

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog import-azure"
        role="dialog"
        aria-modal="true"
        aria-label="Import from Azure"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="row">
          <h2>Import from Azure</h2>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted">
          Bring an existing network into the planner to check it against Azure rules and plan what comes next. Run one of these
          commands in Azure Cloud Shell or a signed-in terminal, then paste the output below or load it from a file. Nothing is sent
          anywhere: the output is read in this browser.
        </p>

        <AzureExportInput value={input} onChange={setInput} />

        {preview && 'error' in preview && (
          <ul className="issues">
            <li className="error">{preview.error}</li>
          </ul>
        )}
        {preview && 'result' in preview && (
          <>
            <div className="table-scroll import-preview">
              <table>
                <thead>
                  <tr>
                    <th>Region</th>
                    <th>Range</th>
                    <th>Hub</th>
                    <th className="num">Spokes</th>
                    <th className="num">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.plan.regions.map((region, i) => {
                    const r = preview.result.regions[i];
                    const { errors, warnings } = countIssues(r);
                    return (
                      <tr key={region.id}>
                        <td>{region.name}</td>
                        <td>
                          <code>{region.fixed}</code>
                        </td>
                        <td>
                          {region.hub.name} <code>{region.hub.fixed}</code>
                          <span className="muted"> {region.topology === 'vwan' ? 'Virtual WAN hub' : 'hub VNet'}</span>
                        </td>
                        <td className="num">{region.spokes.length}</td>
                        <td className={`num status ${errors ? 'error' : warnings ? 'warning' : 'ok'}`}>
                          {errors || warnings ? `${errors} errors · ${warnings} warnings` : 'none'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="issues">
              {preview.notes.map((n, i) => (
                <li key={i} className={n.level === 'warning' ? 'warning' : 'info'}>
                  {n.message}
                </li>
              ))}
              {counts && (counts.errors > 0 || counts.warnings > 0) && (
                <li className={counts.errors ? 'error' : 'warning'}>
                  The planner finds {plural(counts.errors, 'error')} and {plural(counts.warnings, 'warning')} in this network
                  {preview.result.root ? ` (root ${formatCidr(preview.result.root)})` : ''}; they're shown on each region after
                  importing.
                </li>
              )}
            </ul>
          </>
        )}

        <div className="row footer">
          <LoadFileButton onLoad={setInput} />
          <label className="import-name">
            Design name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!preview || !('plan' in preview)}
            onClick={() => preview && 'plan' in preview && props.onImport({ ...preview.plan, name: name.trim() || DEFAULT_NAME })}
          >
            Open as new design
          </button>
        </div>
      </div>
    </div>
  );
}
