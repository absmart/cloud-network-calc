import { useEffect, useRef, useState } from 'react';
import {
  type SavedDesign,
  backupFileName,
  createDesign,
  hasUnsavedChanges,
  parseBackup,
  toBackup,
} from '../lib/designs';
import { downloadFile } from '../lib/download';
import type { NamingOptions } from '../lib/naming';
import type { PlanSpec } from '../lib/planner';

const formatTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** Save, open and back up named designs. */
export function DesignsDialog(props: {
  plan: PlanSpec;
  /** Current IaC naming options, saved alongside the plan. */
  naming: NamingOptions;
  designs: SavedDesign[];
  activeId: string | null;
  storageOk: boolean;
  onSave: () => void;
  onSaveAsNew: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onImport: (designs: SavedDesign[]) => void;
  onClose: () => void;
}) {
  const { designs, onClose } = props;
  const active = designs.find((d) => d.id === props.activeId);
  const unsaved = hasUnsavedChanges(active, props.plan);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Leaving the current plan loses unsaved edits, so check first. */
  const confirmLeave = () =>
    !unsaved || window.confirm('The current design has unsaved changes. Continue without saving them?');

  const exportDesigns = (list: SavedDesign[]) =>
    downloadFile(backupFileName(list), JSON.stringify(toBackup(list), null, 2), 'application/json');

  const importFile = async (file: File) => {
    try {
      const imported = parseBackup(await file.text());
      props.onImport(imported);
      setMessage({ kind: 'ok', text: `Imported ${imported.length} design${imported.length > 1 ? 's' : ''} from ${file.name}.` });
    } catch (e) {
      setMessage({ kind: 'error', text: `Couldn't import ${file.name}: ${(e as Error).message}` });
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog designs" role="dialog" aria-modal="true" aria-label="Designs" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>Designs</h2>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted">
          Save the current plan as a named design to keep several designs side by side. Designs are stored in this browser; export
          them to a .json file to back them up or move them to another machine.
        </p>
        {!props.storageOk && (
          <ul className="issues">
            <li className="error">This browser isn't allowing the app to store data, so designs won't be kept. Export them to a file instead.</li>
          </ul>
        )}

        <section className="current-design">
          <div>
            <strong>{props.plan.name || 'Untitled design'}</strong>
            <span className={`save-state ${unsaved ? 'unsaved' : 'saved'}`}>
              {active ? (unsaved ? 'Unsaved changes' : `Saved ${formatTime(active.savedAt)}`) : 'Not saved yet'}
            </span>
          </div>
          <div className="row">
            <button className="primary" onClick={props.onSave} disabled={!!active && !unsaved}>
              {active ? 'Save' : 'Save design'}
            </button>
            {active && <button onClick={props.onSaveAsNew}>Save as new</button>}
            <button onClick={() => confirmLeave() && props.onNew()}>New design</button>
            <button
              title="Download the current plan, saved or not, as a .json file"
              onClick={() => exportDesigns([createDesign(props.plan, props.naming)])}
            >
              Export current
            </button>
          </div>
        </section>

        {message && (
          <ul className="issues">
            <li className={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</li>
          </ul>
        )}

        <div className="table-scroll design-list">
          {designs.length === 0 ? (
            <p className="muted empty">No saved designs yet. Save the current plan to start a library.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Root</th>
                  <th className="num">Regions</th>
                  <th>Saved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {designs.map((d) => (
                  <tr key={d.id} className={d.id === props.activeId ? 'selected' : ''}>
                    <td>
                      <input
                        className="design-name"
                        value={d.name}
                        aria-label="Design name"
                        onChange={(e) => props.onRename(d.id, e.target.value)}
                      />
                      {d.id === props.activeId && <span className="chip">open</span>}
                    </td>
                    <td>
                      <code>{d.plan.root}</code>
                    </td>
                    <td className="num">{d.plan.regions.length}</td>
                    <td className="muted">{formatTime(d.savedAt)}</td>
                    <td className="actions">
                      <button
                        onClick={() => {
                          if (d.id === props.activeId || confirmLeave()) {
                            props.onOpen(d.id);
                            onClose();
                          }
                        }}
                      >
                        Open
                      </button>
                      <button onClick={() => props.onDuplicate(d.id)}>Duplicate</button>
                      <button onClick={() => exportDesigns([d])}>Export</button>
                      <button
                        className="danger"
                        onClick={() => window.confirm(`Delete the design "${d.name}"? This can't be undone.`) && props.onDelete(d.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="row footer">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = '';
            }}
          />
          <button onClick={() => fileInput.current?.click()}>Import from file…</button>
          <button className="primary" disabled={designs.length === 0} onClick={() => exportDesigns(designs)}>
            Export all ({designs.length})
          </button>
        </div>
      </div>
    </div>
  );
}
