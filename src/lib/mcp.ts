// A stateless MCP server (Streamable HTTP, JSON responses) over the API's
// operations, so agents can create, check, import, export and hand designs
// to the app. Dependency-free: it answers JSON-RPC messages itself, without
// sessions or server-sent events, which a stateless server doesn't need.

import {
  ApiError,
  addRegion,
  addSpoke,
  checkDesign,
  compareDesign,
  designLink,
  exportDesign,
  importNetwork,
  listRegions,
  newDesign,
  portable,
  readCloud,
  readDesign,
  readFormat,
  spokeTemplateKeys,
} from './api';
import { DESIGN_FORMAT } from './apiDocs';
import { AWS_IMPORT_COMMANDS } from './importAws';
import { AZURE_IMPORT_COMMANDS } from './importAzure';

export const MCP_SERVER_INFO = { name: 'cloud-network-planner', title: 'Cloud network planner', version: '1.0.0' };

/** Newest first; the first is offered when the client asks for one we don't know. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Plans IPv4 address space for Azure and AWS hub-and-spoke networks (root range → regional blocks → hub and spoke VNets/VPCs → subnets), validates it, and exports Bicep, Terraform or Terragrunt.
Nothing is stored: every tool takes the design it works on and returns the result. Tools that return a design also return a link that opens it in the web app, where the user can see and edit it; give the user that link.
Start with new_design or import_network, read design_format before writing a plan by hand, and run check_design after every change.`;

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (args: Args, appUrl: string) => unknown;
}

const DESIGN = {
  type: ['object', 'string'],
  description:
    'The design: { "plan": {…}, "naming": {…} } as other tools return it, a bare plan, a design exported from the app, or a share link to the app (…#d=…).',
};
const CLOUD = { type: 'string', enum: ['azure', 'aws'], description: 'The cloud. Default azure.' };
const CLI_OUTPUT = {
  type: 'string',
  description: 'Output of the commands from import_commands (several outputs can be pasted together).',
};
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export const MCP_TOOLS: Tool[] = [
  {
    name: 'design_format',
    title: 'Design format',
    description: 'Explains the JSON design format (plan, regions, networks, subnets, naming) and how addresses are allocated. Read it before writing or editing a plan.',
    inputSchema: { type: 'object', properties: {} },
    run: () => DESIGN_FORMAT,
  },
  {
    name: 'new_design',
    title: 'New design',
    description: "Start a design from the app's default for a cloud: two paired regions, each with a hub and platform spokes. Returns the design, a link that opens it in the app, and its check summary.",
    inputSchema: { type: 'object', properties: { cloud: CLOUD, name: { type: 'string', description: 'Name for the design.' } } },
    run: (a, url) => newDesign(readCloud(a.cloud, 'azure'), url, str(a.name)),
  },
  {
    name: 'check_design',
    title: 'Check design',
    description: 'Allocate the design and validate it against its cloud\'s rules. Returns every network and subnet with its CIDR, free space, placement, and all errors and warnings.',
    inputSchema: { type: 'object', properties: { design: DESIGN }, required: ['design'] },
    run: async (a) => checkDesign(await readDesign(a.design)),
  },
  {
    name: 'export_design',
    title: 'Export infrastructure as code',
    description: 'Generate the files the app exports for the design: Bicep (Azure only), Terraform or Terragrunt. Values that can\'t be allocated are left out, so check the design first.',
    inputSchema: {
      type: 'object',
      properties: { design: DESIGN, format: { type: 'string', enum: ['bicep', 'terraform', 'terragrunt'] } },
      required: ['design', 'format'],
    },
    run: async (a) => exportDesign(await readDesign(a.design), readFormat(a.format)),
  },
  {
    name: 'design_link',
    title: 'Link to open the design in the app',
    description: 'A link that opens the design in the web app. The design travels in the link\'s fragment, which is never sent to the server.',
    inputSchema: { type: 'object', properties: { design: DESIGN }, required: ['design'] },
    run: async (a, url) => ({ link: await designLink(await readDesign(a.design), url) }),
  },
  {
    name: 'read_design',
    title: 'Read a design from the app',
    description: 'Read a design the user brings from the app (a share link or an exported design file\'s JSON) and return it as JSON, ready to edit.',
    inputSchema: { type: 'object', properties: { design: DESIGN }, required: ['design'] },
    run: async (a) => portable(await readDesign(a.design)),
  },
  {
    name: 'add_region',
    title: 'Add region',
    description: 'Add a region with the app\'s default hub and platform spokes, at a location or at the next unused one (Azure: the pair of an existing region first).',
    inputSchema: {
      type: 'object',
      properties: { design: DESIGN, location: { type: 'string', description: 'Region, e.g. "westeurope" or "eu-west-1"; see list_regions.' } },
      required: ['design'],
    },
    run: async (a, url) => addRegion(await readDesign(a.design), url, str(a.location)),
  },
  {
    name: 'add_spoke',
    title: 'Add spoke',
    description: 'Add a spoke network to a region from one of the app\'s templates (see list_spoke_templates).',
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN,
        region: { type: 'string', description: 'The region\'s location or name.' },
        template: { type: 'string', description: 'Template key, e.g. "corp" or "online" (Azure), "workload" (AWS).' },
        name: { type: 'string', description: 'Name for the network; the template names it otherwise.' },
      },
      required: ['design', 'region', 'template'],
    },
    run: async (a, url) => addSpoke(await readDesign(a.design), url, String(a.region ?? ''), String(a.template ?? ''), str(a.name)),
  },
  {
    name: 'import_commands',
    title: 'Commands for importing or comparing',
    description: 'The Azure CLI, PowerShell or AWS CLI commands whose output import_network and compare_design read.',
    inputSchema: { type: 'object', properties: { cloud: CLOUD } },
    run: (a) => (readCloud(a.cloud, 'azure') === 'aws' ? AWS_IMPORT_COMMANDS : AZURE_IMPORT_COMMANDS),
  },
  {
    name: 'import_network',
    title: 'Import deployed networks',
    description: 'Build a design from deployed networks, read from CLI output. Networks are pinned where they are, so check_design reports overlaps and rule violations in the real estate.',
    inputSchema: {
      type: 'object',
      properties: { cloud: CLOUD, cli_output: CLI_OUTPUT, name: { type: 'string', description: 'Name for the design.' } },
      required: ['cli_output'],
    },
    run: (a, url) => importNetwork(readCloud(a.cloud, 'azure'), String(a.cli_output ?? ''), url, str(a.name)),
  },
  {
    name: 'compare_design',
    title: 'Compare with what is deployed',
    description: 'Compare the design with deployed networks from CLI output: what differs, what is missing, and what exists only in the cloud.',
    inputSchema: { type: 'object', properties: { design: DESIGN, cli_output: CLI_OUTPUT }, required: ['design', 'cli_output'] },
    run: async (a) => compareDesign(await readDesign(a.design), String(a.cli_output ?? '')),
  },
  {
    name: 'list_regions',
    title: 'List regions',
    description: 'The regions a design for the cloud can use, with display names and geographies.',
    inputSchema: { type: 'object', properties: { cloud: CLOUD } },
    run: (a) => listRegions(readCloud(a.cloud, 'azure')),
  },
  {
    name: 'list_spoke_templates',
    title: 'List spoke templates',
    description: 'The spoke templates add_spoke can use for the cloud.',
    inputSchema: { type: 'object', properties: { cloud: CLOUD } },
    run: (a) => spokeTemplateKeys(readCloud(a.cloud, 'azure')),
  },
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null } & (
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
);

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/** A tool's result as MCP content: JSON text, plus structured content for objects. */
function toolResult(value: unknown) {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  const text = JSON.stringify(value, null, 2);
  return Array.isArray(value)
    ? { content: [{ type: 'text', text }], structuredContent: { items: value } }
    : { content: [{ type: 'text', text }], structuredContent: value };
}

async function callTool(params: Record<string, unknown> | undefined, appUrl: string) {
  const tool = MCP_TOOLS.find((t) => t.name === params?.name);
  if (!tool) throw new ApiError(`Unknown tool "${String(params?.name)}".`, -32602);
  const args = (params?.arguments ?? {}) as Args;
  try {
    return toolResult(await tool.run(args, appUrl));
  } catch (e) {
    // Errors in a call go back to the model as a tool result, so it can fix its input.
    const err = e as Error;
    const details = e instanceof ApiError && e.details.length > 1 ? `\n${e.details.join('\n')}` : '';
    return { content: [{ type: 'text', text: `${err.message}${details}` }], isError: true };
  }
}

/** Answer one JSON-RPC message; null for a notification or a response, which get no answer. */
export async function handleMcpMessage(message: unknown, appUrl: string): Promise<JsonRpcResponse | null> {
  const req = message as JsonRpcRequest;
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    // A client's response to a server request (we make none) gets no answer.
    if (req && typeof req === 'object' && ('result' in req || 'error' in req)) return null;
    return rpcError(req?.id, -32600, 'Invalid request');
  }
  if (req.id === undefined) return null; // notifications/initialized, cancelled, …
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: req.id ?? null, result });
  switch (req.method) {
    case 'initialize': {
      const asked = String(req.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: MCP_TOOLS.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: { title, readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call':
      try {
        return ok(await callTool(req.params, appUrl));
      } catch (e) {
        return rpcError(req.id, -32602, (e as Error).message);
      }
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/**
 * Answer the body of a POST to the MCP endpoint: one message or a batch.
 * Returns null when nothing needs an answer (HTTP 202).
 */
export async function handleMcpBody(body: string, appUrl: string): Promise<unknown | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (Array.isArray(parsed)) {
    const answers = (await Promise.all(parsed.map((m) => handleMcpMessage(m, appUrl)))).filter((a) => a !== null);
    return answers.length ? answers : null;
  }
  return handleMcpMessage(parsed, appUrl);
}
