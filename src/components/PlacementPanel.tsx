import { cloudOf } from '../lib/cloud';
import type { NamingOptions } from '../lib/naming';
import { placementLayouts, suggestedPlacement } from '../lib/placement';
import type { PlacementLayout, PlanSpec, VnetSpec } from '../lib/planner';

/**
 * Which subscription and resource group (Azure) or account (AWS) each network
 * deploys into: a layout, plus per-network overrides.
 */
export function PlacementPanel(props: {
  plan: PlanSpec;
  naming: NamingOptions;
  subscriptionCount: number;
  resourceGroupCount: number;
  onChange: (plan: PlanSpec) => void;
}) {
  const { plan, naming, onChange } = props;
  const cloud = cloudOf(plan);
  const aws = cloud === 'aws';
  const layouts = placementLayouts(cloud);
  // AWS offers no 'alz-platform'; it works as 'alz'.
  const layout: PlacementLayout = aws && plan.placement === 'alz-platform' ? 'alz' : (plan.placement ?? 'single');
  const unit = aws ? 'account' : 'subscription';
  const primaryLocation = plan.regions[0]?.location ?? 'eastus2';
  const overrides = plan.regions.reduce(
    (n, r) => n + [r.hub, ...r.spokes].filter((v) => v.subscription?.trim() || v.resourceGroup?.trim()).length,
    0,
  );

  /** Apply `patch` to a region's hub (vnet -1) or one of its spokes. */
  const updateVnet = (region: number, vnet: number, patch: Partial<VnetSpec>) =>
    onChange({
      ...plan,
      regions: plan.regions.map((r, i) =>
        i !== region
          ? r
          : vnet < 0
            ? { ...r, hub: { ...r.hub, ...patch } }
            : { ...r, spokes: r.spokes.map((s, j) => (j === vnet ? { ...s, ...patch } : s)) },
      ),
    });

  const clearOverrides = () =>
    onChange({
      ...plan,
      regions: plan.regions.map((r) => {
        const clear = (v: VnetSpec): VnetSpec => ({ ...v, subscription: undefined, resourceGroup: undefined });
        return { ...r, hub: clear(r.hub), spokes: r.spokes.map(clear) };
      }),
    });

  return (
    <div className="placement">
      <div className="row">
        <label>
          {aws ? 'Accounts' : 'Subscriptions'}
          <select value={layout} onChange={(e) => onChange({ ...plan, placement: e.target.value as PlacementLayout })}>
            {(Object.keys(layouts) as PlacementLayout[]).map((l) => (
              <option key={l} value={l}>
                {layouts[l]!.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {props.subscriptionCount} {unit}
          {props.subscriptionCount === 1 ? '' : 's'}
          {!aws && ` · ${props.resourceGroupCount} resource group${props.resourceGroupCount === 1 ? '' : 's'}`}
          {overrides > 0 && ` · ${overrides} set by hand`}
        </span>
      </div>
      <p className="muted">{layouts[layout]?.description}</p>
      <details>
        <summary>{aws ? 'Account per network' : 'Subscription and resource group per network'}</summary>
        <p className="muted">
          Leave a field empty to follow the layout (shown greyed). {aws ? 'An account' : 'A subscription'} is a short name the
          variables file maps to an ID, or {aws ? 'a 12-digit account ID' : 'a subscription ID'} itself.{' '}
          {aws
            ? "Each region's Transit Gateway goes with its inspection VPC."
            : 'The Virtual WAN goes with the first virtual hub.'}
          {overrides > 0 && (
            <button className="link" onClick={clearOverrides}>
              Clear the {overrides} set by hand
            </button>
          )}
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Region</th>
                <th>Network</th>
                <th>{aws ? 'Account' : 'Subscription'}</th>
                {!aws && <th>Resource group</th>}
              </tr>
            </thead>
            <tbody>
              {plan.regions.flatMap((region, i) =>
                [region.hub, ...region.spokes].map((vnet, k) => {
                  const kind = k > 0 ? 'spoke' : region.topology === 'vwan' ? 'virtual-hub' : 'hub';
                  const suggested = suggestedPlacement(layout, region, vnet, kind, naming, primaryLocation, cloud);
                  return (
                    <tr key={vnet.id}>
                      <td className="muted">{k === 0 ? region.name : ''}</td>
                      <td>{vnet.name}</td>
                      <td>
                        <input
                          aria-label={`${aws ? 'Account' : 'Subscription'} for ${vnet.name}`}
                          placeholder={suggested.subscription}
                          value={vnet.subscription ?? ''}
                          onChange={(e) => updateVnet(i, k - 1, { subscription: e.target.value || undefined })}
                        />
                      </td>
                      {!aws && (
                        <td>
                          <input
                            aria-label={`Resource group for ${vnet.name}`}
                            placeholder={suggested.resourceGroup}
                            value={vnet.resourceGroup ?? ''}
                            onChange={(e) => updateVnet(i, k - 1, { resourceGroup: e.target.value || undefined })}
                          />
                        </td>
                      )}
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
