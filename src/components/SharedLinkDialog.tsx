import { useEffect, useMemo } from 'react';
import { computePlan, countIssues } from '../lib/planner';
import type { SharedDesign } from '../lib/shareLink';

/** Shown when the app is opened from a share link: preview the design, then open it or not. */
export function SharedLinkDialog(props: {
  shared: SharedDesign | null;
  error: string | null;
  /** Why opening would lose something, if it would. */
  warning: string | null;
  onOpen: (save: boolean) => void;
  onClose: () => void;
}) {
  const { shared, onClose } = props;
  const counts = useMemo(() => (shared ? countIssues(computePlan(shared.plan)) : null), [shared]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog shared-link" role="dialog" aria-modal="true" aria-label="Shared design" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>Shared design</h2>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {props.error && (
          <ul className="issues">
            <li className="error">{props.error}</li>
          </ul>
        )}
        {shared && counts && (
          <>
            <p>
              The link you opened holds the design <strong>{shared.plan.name || 'Untitled design'}</strong>:{' '}
              <code>{shared.plan.root}</code> with {shared.plan.regions.length} region{shared.plan.regions.length === 1 ? '' : 's'}
              {shared.plan.regions.length > 0 && ` (${shared.plan.regions.map((r) => r.name).join(', ')})`}.
            </p>
            <p className={`status ${counts.errors ? 'error' : counts.warnings ? 'warning' : 'ok'}`}>
              {counts.errors} errors · {counts.warnings} warnings
            </p>
            {props.warning && (
              <ul className="issues">
                <li className="warning">{props.warning}</li>
              </ul>
            )}
          </>
        )}
        <div className="row footer">
          <button onClick={onClose}>{shared ? 'Keep my current plan' : 'Close'}</button>
          {shared && (
            <>
              <button onClick={() => props.onOpen(false)}>Open</button>
              <button className="primary" onClick={() => props.onOpen(true)}>
                Open and save to my designs
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
