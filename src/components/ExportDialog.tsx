import { useEffect, useMemo, useState } from 'react';
import { awsZipRoot, buildAwsModel, generateAwsFiles } from '../lib/awsIac';
import { cloudOf } from '../lib/cloud';
import { type IacFormat, buildIacModel, generateIacFiles, zipRoot } from '../lib/iac';
import { PlacementPanel } from './PlacementPanel';
import { DEFAULT_NAMING, type NamingOptions } from '../lib/naming';
import { STORAGE_KEYS, loadNaming, writeJson } from '../lib/storage';
import { type PlanResult, type PlanSpec, countIssues } from '../lib/planner';
import { downloadFile as save } from '../lib/download';
import { createZip } from '../lib/zip';

const FORMAT_LABEL: Record<IacFormat, string> = { bicep: 'Bicep', terraform: 'Terraform', terragrunt: 'Terragrunt' };

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Shows the plan as Bicep, Terraform or Terragrunt (Terraform or Terragrunt for AWS), ready to copy or download. */
export function ExportDialog(props: {
  plan: PlanSpec;
  result: PlanResult;
  /** Saves placement choices (subscriptions, resource groups, accounts) back into the plan. */
  onPlanChange: (plan: PlanSpec) => void;
  onClose: () => void;
}) {
  const aws = cloudOf(props.plan) === 'aws';
  const formats: IacFormat[] = aws ? ['terraform', 'terragrunt'] : ['bicep', 'terraform', 'terragrunt'];
  const [format, setFormat] = useState<IacFormat>(formats[0]);
  const [naming, setNaming] = useState<NamingOptions>(loadNaming);
  const [copied, setCopied] = useState(false);
  const [fileIndex, setFileIndex] = useState(0);
  const files = useMemo(
    () => (aws ? generateAwsFiles : generateIacFiles)(format, props.plan, props.result, naming),
    [aws, format, props.plan, props.result, naming],
  );
  const file = files[fileIndex] ?? files[0];
  // Modules and Terragrunt stacks live in folders, so they download together as a zip.
  const inFolders = files.some((f) => f.name.includes('/'));
  const root = aws ? awsZipRoot(format) : zipRoot(format);
  const zip = () => createZip(files.map((f) => ({ name: `${root}/${f.name}`, content: f.content })));

  // Counts and an example name for the dialog text.
  const summary = useMemo(() => {
    if (aws) {
      const m = buildAwsModel(props.plan, props.result, naming);
      return {
        placements: m.accounts.length,
        groups: 0,
        example: [m.vpcs[0]?.name, m.vpcs[0]?.subnets[0]?.name, m.transitGateways[0]?.name].filter(Boolean).join(', '),
      };
    }
    const m = buildIacModel(props.plan, props.result, naming);
    return {
      placements: m.subscriptions.length,
      groups: m.resourceGroups.length,
      example: [m.vnets[0]?.name, m.vnets[0]?.subnets.find((s) => s.name.endsWith('-snet'))?.name, m.resourceGroups[0]?.name]
        .filter(Boolean)
        .join(', '),
    };
  }, [aws, props.plan, props.result, naming]);

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
            {formats.map((f) => (
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
        {aws ? (
          <p className="muted">
            Covers every region, VPC, secondary CIDR and subnet (in its Availability Zone), a Transit Gateway per region with
            each VPC attached through its tgw-* subnets, and peering between the regions' Transit Gateways with routes for each
            region's block. The modules are generic and this plan's values go in the variables file. main.tf has an aws provider
            (6.x) per account, assuming the role you name in each, and Transit Gateways are shared with other accounts through AWS
            RAM. Firewalls, NAT gateways and VPC route tables aren't included.
            {format === 'terragrunt' &&
              ' Terragrunt adds a root.hcl for S3 remote state, with this plan as the inputs of live/<env>/aws-network.'}{' '}
            It downloads as a .zip.
          </p>
        ) : (
          <p className="muted">
            Covers every region, VNet, subnet and peering in the current plan
            {props.plan.regions.some((r) => r.topology === 'vwan') ? ', plus the Virtual WAN and its hubs' : ''}. Hub &amp; spoke
            hubs are peered with their spokes and with each other. The template is generic, with every input a parameter or
            variable; this plan's values go in the variables file, so the same template can be reused for other plans and
            environments. One deployment covers every subscription:{' '}
            {format === 'bicep'
              ? 'Bicep deploys at a management group above them, with modules per subscription and resource group, and downloads as a .zip.'
              : 'Terraform (azurerm) has a provider alias per subscription in main.tf, calling generic modules, and downloads as a .zip.'}
            {format === 'terragrunt' &&
              ' Terragrunt adds a root.hcl for remote state and the provider, with this plan as the inputs of live/<env>/alz-network; it downloads as a .zip that keeps the folders.'}
          </p>
        )}
        <div className="row naming">
          <span className="muted">
            Names: <code>&lt;app&gt;-&lt;environment&gt;-&lt;region&gt;-&lt;int&gt;-&lt;type&gt;</code>
          </span>
          <label
            title={
              aws
                ? 'App used for the Transit Gateways; VPCs and subnets take their app from their own name'
                : 'App used for the resource group and Virtual WAN; VNets and subnets take their app from their own name'
            }
          >
            Shared app
            <input value={naming.app} onChange={(e) => setNaming({ ...naming, app: e.target.value })} />
          </label>
          <label>
            Environment
            <input value={naming.environment} onChange={(e) => setNaming({ ...naming, environment: e.target.value })} />
          </label>
          <label title="Used unless a network's name already carries a number, like corp-eus2-001-vnet">
            Instance
            <input value={naming.instance} onChange={(e) => setNaming({ ...naming, instance: e.target.value })} />
          </label>
          <button onClick={() => setNaming(DEFAULT_NAMING)}>Defaults</button>
        </div>
        <p className="muted">
          For example: <code>{summary.example}</code>.{' '}
          {aws ? 'Names are Name tags; AWS gives each resource its own ID.' : 'Azure-required subnet names such as GatewaySubnet are kept.'}
        </p>
        <PlacementPanel
          plan={props.plan}
          naming={naming}
          subscriptionCount={summary.placements}
          resourceGroupCount={summary.groups}
          onChange={props.onPlanChange}
        />
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
            <button className="primary" onClick={() => save(`${root}.zip`, zip(), 'application/zip')}>
              Download {root}.zip ({files.length} files)
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
