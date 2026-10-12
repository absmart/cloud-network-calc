import { useEffect, useMemo, useState } from 'react';
import { type IacFormat, TERRAGRUNT_ROOT, buildIacModel, generateIacFiles } from '../lib/iac';
import { DEFAULT_NAMING, type NamingOptions } from '../lib/naming';
import { STORAGE_KEYS, loadNaming, writeJson } from '../lib/storage';
import { type PlanResult, type PlanSpec, countIssues } from '../lib/planner';
import { downloadFile as save } from '../lib/download';
import { createZip } from '../lib/zip';

const FORMAT_LABEL: Record<IacFormat, string> = { bicep: 'Bicep', terraform: 'Terraform', terragrunt: 'Terragrunt' };

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Shows the plan as Bicep, Terraform or Terragrunt, ready to copy or download. */
export function ExportDialog(props: { plan: PlanSpec; result: PlanResult; onClose: () => void }) {
  const [format, setFormat] = useState<IacFormat>('bicep');
  const [naming, setNaming] = useState<NamingOptions>(loadNaming);
  const [copied, setCopied] = useState(false);
  const [fileIndex, setFileIndex] = useState(0);
  const files = useMemo(
    () => generateIacFiles(format, props.plan, props.result, naming),
    [format, props.plan, props.result, naming],
  );
  const file = files[fileIndex] ?? files[0];
  // Terragrunt's files live in folders, so they download together as a zip.
  const inFolders = files.some((f) => f.name.includes('/'));
  const zip = () => createZip(files.map((f) => ({ name: `${TERRAGRUNT_ROOT}/${f.name}`, content: f.content })));
  const example = useMemo(() => {
    const m = buildIacModel(props.plan, props.result, naming);
    return [m.vnets[0]?.name, m.vnets[0]?.subnets.find((s) => s.name.endsWith('-snet'))?.name, m.resourceGroup]
      .filter(Boolean)
      .join(', ');
  }, [props.plan, props.result, naming]);

  useEffect(() => {
    writeJson(STORAGE_KEYS.naming, naming);
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
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Export IaC" onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>Export infrastructure as code</h2>
          <div className="tabs">
            {(Object.keys(FORMAT_LABEL) as IacFormat[]).map((f) => (
              <button
                key={f}
                className={format === f ? 'active' : ''}
                onClick={() => {
                  setFormat(f);
                  setFileIndex(0);
                }}
              >
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
          Hub &amp; spoke hubs are peered with their spokes and with each other. The template is generic, with every input a
          parameter or variable; this plan's values go in the variables file, so the same template can be reused for other plans
          and environments.
          {format === 'terragrunt' &&
            ' Terragrunt adds a root.hcl for remote state and the provider, with this plan as the inputs of live/<env>/alz-network; it downloads as a .zip that keeps the folders.'}
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
          <label title="Used unless a VNet's name already carries a number, like corp-eus2-001-vnet">
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
        <div className="file-tabs" role="tablist">
          {files.map((f, i) => (
            <button
              key={f.name}
              role="tab"
              aria-selected={file === f}
              className={file === f ? 'active' : ''}
              onClick={() => setFileIndex(i)}
            >
              {f.name}
              <span className="muted">{f.description}</span>
            </button>
          ))}
        </div>
        <pre className="code">{file.content}</pre>
        <div className="row footer">
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button onClick={() => save(baseName(file.name), file.content)}>Download {baseName(file.name)}</button>
          {inFolders ? (
            <button className="primary" onClick={() => save(`${TERRAGRUNT_ROOT}.zip`, zip(), 'application/zip')}>
              Download {TERRAGRUNT_ROOT}.zip ({files.length} files)
            </button>
          ) : (
            <button className="primary" onClick={() => files.forEach((f) => save(f.name, f.content))}>
              Download all ({files.length} files)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
