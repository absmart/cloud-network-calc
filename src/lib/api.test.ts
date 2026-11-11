import { describe, expect, it } from 'vitest';
import { ApiError, addRegion, addSpoke, checkDesign, compareDesign, exportDesign, importNetwork, newDesign, readDesign } from './api';
import { type ApiRequest, appUrlOf, handleApiRequest } from './apiHttp';
import { defaultPlan } from './defaults';
import { MCP_TOOLS, handleMcpBody } from './mcp';
import { DEFAULT_NAMING } from './naming';
import { shareUrl } from './shareLink';

const APP = 'https://planner.example.net/';

/** A small hand-written Azure design, as an agent would write it: no ids. */
const handWritten = {
  plan: {
    version: 1,
    name: 'Agent design',
    root: '10.20.0.0/16',
    regions: [
      {
        location: 'westeurope',
        prefix: 20,
        hub: { name: 'hub-weu-vnet', prefix: 24, subnets: [{ name: 'AzureFirewallSubnet', prefix: 26 }] },
        spokes: [{ name: 'corp-weu-001-vnet', prefix: 24, subnets: [{ name: 'app-snet', prefix: 26 }] }],
      },
    ],
  },
};

const request = (method: string, path: string, body: unknown = '', query = ''): ApiRequest => ({
  method,
  path,
  query: new URLSearchParams(query),
  header: () => null,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  appUrl: APP,
});

const bodyOf = (res: { body: string | Uint8Array }) => JSON.parse(res.body as string);

describe('reading designs', () => {
  it('accepts a hand-written plan without ids and fills in defaults', async () => {
    const design = await readDesign(handWritten);
    const region = design.plan.regions[0];
    expect(region.id).toBeTruthy();
    expect(region.name).toBe('westeurope');
    expect(region.topology).toBe('hub-spoke');
    expect(region.hub.subnets[0].id).toBeTruthy();
    expect(region.spokes[0].role).toBe('landing-zone');
    expect(design.naming).toEqual(DEFAULT_NAMING);
  });

  it('accepts a bare plan, JSON text, a one-design backup and a share link', async () => {
    const plan = defaultPlan();
    expect((await readDesign(plan)).plan.root).toBe(plan.root);
    expect((await readDesign(JSON.stringify({ plan }))).plan.root).toBe(plan.root);
    expect((await readDesign({ app: 'alz-cidr-planner', designs: [{ name: 'x', plan }] })).plan.regions).toHaveLength(2);
    const link = await shareUrl(APP, { ...plan, name: 'Linked' }, { ...DEFAULT_NAMING, environment: 'dev' });
    const linked = await readDesign(link);
    expect(linked.plan.name).toBe('Linked');
    expect(linked.naming.environment).toBe('dev');
  });

  it('lists every problem with its path', async () => {
    const bad = { plan: { root: 5, regions: [{ location: 'eastus2', prefix: 40, hub: { prefix: 24 } }] } };
    const error = await readDesign(bad).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.details).toEqual([
      'plan.root must be a CIDR string such as "10.0.0.0/8"',
      'plan.regions[0].prefix must be a whole number from 0 to 32',
      'plan.regions[0].hub.name must be a non-empty string',
    ]);
    await expect(readDesign('not json')).rejects.toThrow(/JSON object or a share link/);
    await expect(readDesign({ designs: [{}, {}] })).rejects.toThrow(/2 designs/);
  });
});

describe('operations', () => {
  it('checks a design and reports allocated CIDRs and problems by location', async () => {
    const result = checkDesign(await readDesign(handWritten));
    expect(result.valid).toBe(true);
    expect(result.root).toBe('10.20.0.0/16');
    const [hub, spoke] = result.regions[0].networks;
    expect(result.regions[0].cidr).toBe('10.20.0.0/20');
    expect(hub).toMatchObject({ name: 'hub-weu-vnet', kind: 'hub', cidr: '10.20.0.0/24', subscription: 'main' });
    expect(hub.subnets[0]).toMatchObject({ name: 'AzureFirewallSubnet', cidr: '10.20.0.0/26' });
    expect(spoke).toMatchObject({ role: 'landing-zone', cidr: '10.20.1.0/24' });

    const tooSmall = structuredClone(handWritten);
    tooSmall.plan.regions[0].hub.subnets[0].prefix = 28;
    const checked = checkDesign(await readDesign(tooSmall));
    expect(checked.valid).toBe(false);
    expect(checked.problems.some((p) => p.where === 'westeurope › hub-weu-vnet › AzureFirewallSubnet' && p.level === 'error')).toBe(true);
  });

  it('exports every format, and refuses Bicep for AWS', async () => {
    const design = await readDesign(handWritten);
    expect(exportDesign(design, 'bicep').files.map((f) => f.name)).toContain('alz-network.bicep');
    expect(exportDesign(design, 'terraform').root).toBe('alz-network-terraform');
    const aws = (await newDesign('aws', APP)).design;
    expect(() => exportDesign(aws, 'bicep')).toThrow(/Bicep is for Azure/);
    expect(exportDesign(aws, 'terraform').files.map((f) => f.name)).toContain('main.tf');
  });

  it('returns new and edited designs with a link that opens them', async () => {
    const created = await newDesign('azure', APP, 'From an agent');
    expect(created.design.plan.name).toBe('From an agent');
    expect(JSON.stringify(created.design)).not.toContain('"id"');
    expect(created.link.startsWith(`${APP}#d=`)).toBe(true);
    expect((await readDesign(created.link)).plan.name).toBe('From an agent');

    const withRegion = await addRegion(created.design, APP, 'westeurope');
    expect(withRegion.design.plan.regions.map((r) => r.location)).toEqual(['eastus2', 'centralus', 'westeurope']);
    await expect(addRegion(created.design, APP, 'eastus2')).rejects.toThrow(/already has a region/);
    await expect(addRegion(created.design, APP, 'atlantis')).rejects.toThrow(/isn't a known Azure region/);

    const withSpoke = await addSpoke(created.design, APP, 'eastus2', 'corp', 'payments-eus2-001-vnet');
    expect(withSpoke.design.plan.regions[0].spokes.at(-1)?.name).toBe('payments-eus2-001-vnet');
    await expect(addSpoke(created.design, APP, 'eastus2', 'nope')).rejects.toThrow(/Unknown template/);
  });

  it('imports CLI output and compares a design with it', async () => {
    const output = JSON.stringify([
      {
        name: 'hub',
        location: 'eastus2',
        id: '/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/hub',
        properties: { addressSpace: { addressPrefixes: ['10.9.0.0/24'] }, subnets: [{ name: 'GatewaySubnet', properties: { addressPrefix: '10.9.0.0/27' } }] },
      },
    ]);
    const imported = await importNetwork('azure', output, APP, 'Estate');
    expect(imported.design.plan.name).toBe('Estate');
    expect(imported.design.plan.regions[0].hub.fixed).toBe('10.9.0.0/24');
    expect(imported.link.startsWith(`${APP}#d=`)).toBe(true);
    await expect(importNetwork('azure', '[]', APP)).rejects.toThrow();

    const comparison = compareDesign(await readDesign(imported.design), output);
    expect(comparison.networks.length).toBeGreaterThan(0);
  });
});

describe('HTTP API', () => {
  it('routes requests and reports errors as JSON', async () => {
    const check = await handleApiRequest(request('POST', '/designs/check', { design: handWritten }));
    expect(check.status).toBe(200);
    expect(check.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(bodyOf(check).valid).toBe(true);

    expect((await handleApiRequest(request('GET', '/nowhere'))).status).toBe(404);
    expect((await handleApiRequest(request('GET', '/designs/check'))).status).toBe(405);
    expect((await handleApiRequest(request('OPTIONS', '/designs/check'))).status).toBe(204);
    const bad = await handleApiRequest(request('POST', '/designs/check', '{"plan": {}}'));
    expect(bad.status).toBe(400);
    expect(bodyOf(bad).error).toMatch(/plan.root/);
  });

  it('exports as JSON or a zip', async () => {
    const files = await handleApiRequest(request('POST', '/designs/export', handWritten, 'format=terraform'));
    expect(bodyOf(files).files.length).toBeGreaterThan(2);
    const zip = await handleApiRequest(request('POST', '/designs/export', handWritten, 'format=bicep&zip=true'));
    expect(zip.headers['Content-Type']).toBe('application/zip');
    expect((zip.body as Uint8Array).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect((await handleApiRequest(request('POST', '/designs/export', handWritten, 'format=pdf'))).status).toBe(400);
  });

  it('reads a share link sent as plain text', async () => {
    const link = await shareUrl(APP, defaultPlan(), DEFAULT_NAMING);
    const read = await handleApiRequest(request('POST', '/designs/read', link));
    expect(bodyOf(read).plan.regions).toHaveLength(2);
  });

  it('describes itself', async () => {
    const doc = bodyOf(await handleApiRequest(request('GET', '/openapi.json')));
    expect(doc.servers[0].url).toBe(`${APP}api`);
    expect(Object.keys(doc.paths)).toContain('/designs/export');
    expect(bodyOf(await handleApiRequest(request('GET', '/'))).mcp).toBe(`${APP}api/mcp`);
    const page = await handleApiRequest(request('GET', '/docs'));
    expect(page.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain(`${APP}api/mcp`);
    expect(page.body).toContain('<code>POST /api/designs/export</code>');
    expect(page.body).toContain('<code>add_spoke</code>');
  });

  it('finds the app address behind Static Web Apps or a proxy', () => {
    const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
    expect(appUrlOf('http://internal:7071/api/mcp', headers({ 'x-ms-original-url': 'https://app.example/api/mcp' }))).toBe('https://app.example/');
    expect(appUrlOf('http://internal:7071/api/mcp', headers({ 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'https' }))).toBe('https://proxy.example/');
    expect(appUrlOf('http://localhost:7071/api', headers({}))).toBe('http://localhost:7071/');
    expect(appUrlOf('http://x/api', headers({}), 'https://configured.example')).toBe('https://configured.example/');
  });
});

describe('MCP server', () => {
  const rpc = async (message: unknown) => (await handleMcpBody(JSON.stringify(message), APP)) as Record<string, any>;

  it('initializes, negotiating the protocol version', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeDefined();
    const future = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    expect(future.result.protocolVersion).toBe('2025-11-25');
    expect(await handleMcpBody(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), APP)).toBeNull();
  });

  it('lists tools and calls them', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));

    const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_design', arguments: { design: handWritten } } });
    expect(call.result.isError).toBeUndefined();
    expect(call.result.structuredContent.valid).toBe(true);
    expect(JSON.parse(call.result.content[0].text).root).toBe('10.20.0.0/16');

    const regions = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_regions', arguments: { cloud: 'aws' } } });
    expect(regions.result.structuredContent.items.some((r: { location: string }) => r.location === 'us-east-1')).toBe(true);
  });

  it('returns bad input as a tool error the model can read, and unknown methods as JSON-RPC errors', async () => {
    const bad = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_design', arguments: { design: handWritten, format: 'pdf' } } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/format must be/);
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })).error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'sampling/whatever' })).error.code).toBe(-32601);
    expect((await handleMcpBody('{', APP)) as Record<string, any>).toMatchObject({ error: { code: -32700 } });
  });

  it('is served over HTTP at /mcp', async () => {
    const res = await handleApiRequest(request('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(bodyOf(res)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect((await handleApiRequest(request('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202);
    expect((await handleApiRequest(request('GET', '/mcp'))).status).toBe(405);
  });
});
