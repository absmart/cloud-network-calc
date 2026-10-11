import { useEffect, useMemo, useState } from 'react';
import { IAC_FILE_NAME, type IacFormat, buildIacModel, generateIac } from '../lib/iac';
import { DEFAULT_NAMING, type NamingOptions } from '../lib/naming';
import { type PlanResult, type PlanSpec, countIssues } from '../lib/planner';

const FORMAT_LABEL: Record<IacFormat, string> = { bicep: 'Bicep', terraform: 'Terraform' };
const NAMING_KEY = 'alz-cidr-planner:naming';

function loadNaming(): NamingOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(NAMING_KEY) ?? 'null');
    if (saved) return { ...DEFAULT_NAMING, ...saved };
  } catch {
    // Use the defaults.
  }
  return DEFAULT_NAMING;
}

/** Shows the plan as Bicep or Terraform, ready to copy or download. */
export function ExportDialog(props: { plan: PlanSpec; result: PlanResult; onClose: () => void }) {
  const [format, setFormat] = useState<IacFormat>('bicep');
  const [naming, setNaming] = useState<NamingOptions>(loadNaming);
  const [copied, setCopied] = useState(false);
  const code = useMemo(
    () => generateIac(format, props.plan, props.result, naming),
    [format, props.plan, props.result, naming],
  );
  const example = useMemo(() => {
    const m = buildIacModel(props.plan, props.result, naming);
    return [m.vnets[0]?.name, m.vnets[0]?.subnets.find((s) => s.name.endsWith('-snet'))?.name, m.resourceGroup]
      .filter(Boolean)
      .join(', ');
  }, [props.plan, props.result, naming]);

  useEffect(() => {
    try {
      localStorage.setItem(NAMING_KEY, JSON.stringify(naming));
    } catch {
      // Not remembered; fine.
    }
  }, [naming]);
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
        <div className="row naming">
          <span className="muted">
            Names: <code>&lt;app&gt;-&lt;environment&gt;&lt;region&gt;&lt;int&gt;-&lt;type&gt;</code>
          </span>
          <label title="App used for the resource group and Virtual WAN; VNets and subnets take their app from their own name">
            Shared app
            <input value={naming.app} onChange={(e) => setNaming({ ...naming, app: e.target.value })} />
          </label>
          <label>
            Environment
            <input value={naming.environment} onChange={(e) => setNaming({ ...naming, environment: e.target.value })} />
          </label>
          <label title="Used unless a VNet's name already ends in a number, like vnet-corp-eastus2-001">
            Instance
            <input value={naming.instance} onChange={(e) => setNaming({ ...naming, instance: e.target.value })} />
          </label>
          <button onClick={() => setNaming(DEFAULT_NAMING)}>Defaults</button>
        </div>
        <p className="muted">
          For example: <code>{example}</code>. Azure-required subnet names such as GatewaySubnet are kept.
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
