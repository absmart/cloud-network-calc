import { useEffect, useMemo, useState } from 'react';
import { buildAwsModel } from '../lib/awsIac';
import { CLOUDS, cloudOf } from '../lib/cloud';
import type { DiffStatus, NetworkDiff } from '../lib/compare';
import { compareWithAws } from '../lib/compareAws';
import { compareWithAzure } from '../lib/compareAzure';
import { buildIacModel } from '../lib/iac';
import type { PlanResult, PlanSpec } from '../lib/planner';
import { loadNaming } from '../lib/storage';
import { AzureExportInput, LoadFileButton } from './AzureExportInput';

/** Status labels; 'only-deployed' names the cloud. */
const statusLabels = (cloud: string): Record<DiffStatus, { label: string; count: string; tone: string }> => ({
  different: { label: 'Different', count: 'different', tone: 'warning' },
  'only-deployed': { label: `Only in ${cloud}`, count: `only in ${cloud}`, tone: 'info' },
  'not-deployed': { label: 'Not deployed', count: 'not deployed', tone: 'info' },
  same: { label: 'Matches', count: 'matching', tone: 'ok' },
});

/** Check the plan against an export of what is deployed in its cloud. */
export function CompareAzureDialog(props: { plan: PlanSpec; result: PlanResult; onClose: () => void }) {
  const { onClose } = props;
  const cloud = cloudOf(props.plan);
  const aws = cloud === 'aws';
  const cloudName = CLOUDS[cloud].label;
  const STATUS = statusLabels(cloudName);
  const tone = (n: NetworkDiff) => (n.conflict ? 'error' : STATUS[n.status].tone);
  const [input, setInput] = useState('');
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const naming = useMemo(loadNaming, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const comparison = useMemo(() => {
    if (!input.trim()) return null;
    try {
      return aws
        ? compareWithAws(buildAwsModel(props.plan, props.result, naming), input)
        : compareWithAzure(buildIacModel(props.plan, props.result, naming), input);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [aws, props.plan, props.result, naming, input]);

  const shown =
    comparison && 'networks' in comparison
      ? comparison.networks.filter((n) => !onlyDifferences || n.status !== 'same')
      : [];

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog import-azure compare-azure"
        role="dialog"
        aria-modal="true"
        aria-label={`Compare with ${cloudName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="row">
          <h2>Compare with {cloudName}</h2>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted">
          Check what is deployed against this plan. Run one of these commands, then paste the output below or load it from a file;
          it is read in this browser and sent nowhere. Networks are matched by the names the IaC export gives them (naming{' '}
          <code>
            {naming.app}-{naming.environment}-…-{naming.instance}
          </code>
          , set in Export IaC) or their planner names, and otherwise by overlapping address space in the same region
          {aws ? '; Transit Gateways by name, then by region.' : '.'}
        </p>

        <AzureExportInput value={input} onChange={setInput} cloud={cloud} />

        {comparison && 'error' in comparison && (
          <ul className="issues">
            <li className="error">{comparison.error}</li>
          </ul>
        )}
        {comparison && 'networks' in comparison && (
          <>
            <div className="row compare-summary">
              {(Object.keys(STATUS) as DiffStatus[]).map((s) => (
                <span
                  key={s}
                  className={`chip ${s === 'only-deployed' && comparison.networks.some((n) => n.conflict) ? 'error' : STATUS[s].tone}`}
                >
                  {comparison.counts[s]} {STATUS[s].count}
                </span>
              ))}
              <label>
                <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
                Only differences
              </label>
            </div>
            <div className="table-scroll import-preview compare-results">
              {shown.length === 0 ? (
                <p className="muted empty">Everything that was compared matches the plan.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Planned</th>
                      <th>In {cloudName}</th>
                      <th>Differences</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((n, i) => (
                      <tr key={i}>
                        <td className={`status ${tone(n)}`}>
                          {n.conflict ? 'Overlaps the plan' : STATUS[n.status].label}
                        </td>
                        <td>
                          {n.planned ? (
                            <>
                              {n.planned.name}
                              <div className="muted">
                                {n.planned.exportedName} · {n.planned.location}
                              </div>
                            </>
                          ) : (
                            <span className="muted">–</span>
                          )}
                        </td>
                        <td>
                          {n.deployed ? (
                            <>
                              {n.deployed.name}
                              <div className="muted">
                                {n.deployed.group || (aws ? 'unknown account' : 'unknown resource group')} · {n.deployed.location}
                                {n.matchedBy && n.matchedBy !== 'name' && ` · matched by ${n.matchedBy}`}
                              </div>
                            </>
                          ) : (
                            <span className="muted">–</span>
                          )}
                        </td>
                        <td>
                          {n.differences.length > 0 && (
                            <ul className="differences">
                              {n.differences.map((d) => (
                                <li key={d}>{d}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {comparison.notes.length > 0 && (
              <ul className="issues">
                {comparison.notes.map((n, i) => (
                  <li key={i} className={n.level === 'warning' ? 'warning' : 'info'}>
                    {n.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="row footer">
          <LoadFileButton onLoad={setInput} />
        </div>
      </div>
    </div>
  );
}
