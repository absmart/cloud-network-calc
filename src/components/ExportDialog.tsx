import { useEffect, useMemo, useState } from 'react';
import { IAC_FILE_NAME, type IacFormat, generateIac } from '../lib/iac';
import { type PlanResult, type PlanSpec, countIssues } from '../lib/planner';

const FORMAT_LABEL: Record<IacFormat, string> = { bicep: 'Bicep', terraform: 'Terraform' };

/** Shows the plan as Bicep or Terraform, ready to copy or download. */
export function ExportDialog(props: { plan: PlanSpec; result: PlanResult; onClose: () => void }) {
  const [format, setFormat] = useState<IacFormat>('bicep');
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => generateIac(format, props.plan, props.result), [format, props.plan, props.result]);
  const { errors } = countIssues(props.result);
  const { onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = IAC_FILE_NAME[format];
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Export IaC" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>Export infrastructure as code</h2>
          <div className="tabs">
            {(Object.keys(FORMAT_LABEL) as IacFormat[]).map((f) => (
              <button key={f} className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
          <button className="icon" title="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted">
          Covers every region, VNet, subnet and peering in the current plan
          {props.plan.regions.some((r) => r.topology === 'vwan') ? ', plus the Virtual WAN and its hubs' : ''}.
          Hub &amp; spoke hubs are peered with their spokes and with each other.
        </p>
        {errors > 0 && (
          <ul className="issues">
            <li className="error">
              The plan has {errors} error{errors > 1 ? 's' : ''}. Anything that isn't allocated is left out, and listed at the top of
              the file.
            </li>
          </ul>
        )}
        <pre className="code">{code}</pre>
        <div className="row footer">
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button className="primary" onClick={download}>
            Download {IAC_FILE_NAME[format]}
          </button>
        </div>
      </div>
    </div>
  );
}
