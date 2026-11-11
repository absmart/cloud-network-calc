// The HTTP API, independent of where it is hosted: a request in, a response
// out. api/index.ts hands it the Azure Functions requests under /api.

import {
  ApiError,
  addRegion,
  addSpoke,
  checkDesign,
  compareDesign,
  designLink,
  exportDesign,
  exportZip,
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
import { handleMcpBody } from './mcp';
import { openApiDocument } from './openapi';

export interface ApiRequest {
  method: string;
  /** The path after /api, e.g. "/designs/check". */
  path: string;
  query: URLSearchParams;
  /** Request header lookup, case-insensitive. */
  header: (name: string) => string | null;
  body: string;
  /** The app's address, for links that open a design (e.g. https://example.net/). */
  appUrl: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/** Larger requests are refused; CLI output for a big estate is a few MB at most. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const CORS = {
  // Nothing is stored and no cookies are used, so any site may call the API.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Max-Age': '86400',
};

const json = (status: number, value: unknown): ApiResponse => ({
  status,
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(value, null, 2),
});

const text = (value: string, type = 'text/plain'): ApiResponse => ({
  status: 200,
  headers: { ...CORS, 'Content-Type': `${type}; charset=utf-8` },
  body: value,
});

const notAllowed = (allow: string): ApiResponse => ({
  status: 405,
  headers: { ...CORS, Allow: allow, 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ error: `Use ${allow}.` }),
});

function parseBody(body: string): unknown {
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError('The request body must be JSON.');
  }
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

/** The design in a body: the body itself, or its `design` member. Text bodies may be a share link. */
function bodyDesign(body: string) {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return readDesign(trimmed);
  const parsed = parseBody(body);
  const wrapped = field(parsed, 'design');
  return readDesign(wrapped !== undefined ? wrapped : parsed);
}

/** Text from a body field that may also have been sent as JSON. */
const asText = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value));

type Route = (req: ApiRequest) => Promise<ApiResponse> | ApiResponse;

const ROUTES: Record<string, { GET?: Route; POST?: Route }> = {
  '/': {
    GET: (req) =>
      json(200, {
        name: 'Cloud network planner API',
        description: 'Create, check, import, export and share network designs. Nothing is stored; every call carries its design.',
        openapi: `${req.appUrl}api/openapi.json`,
        mcp: `${req.appUrl}api/mcp`,
        designFormat: `${req.appUrl}api/design-format`,
      }),
  },
  '/openapi.json': { GET: (req) => json(200, openApiDocument(req.appUrl)) },
  '/design-format': { GET: () => text(DESIGN_FORMAT, 'text/markdown') },
  '/regions': { GET: (req) => json(200, listRegions(readCloud(req.query.get('cloud'), 'azure'))) },
  '/spoke-templates': { GET: (req) => json(200, spokeTemplateKeys(readCloud(req.query.get('cloud'), 'azure'))) },
  '/import-commands': {
    GET: (req) => json(200, readCloud(req.query.get('cloud'), 'azure') === 'aws' ? AWS_IMPORT_COMMANDS : AZURE_IMPORT_COMMANDS),
  },
  '/designs/new': {
    GET: async (req) => json(200, await newDesign(readCloud(req.query.get('cloud'), 'azure'), req.appUrl, req.query.get('name') ?? undefined)),
    POST: async (req) => {
      const body = parseBody(req.body);
      const name = field(body, 'name');
      return json(200, await newDesign(readCloud(field(body, 'cloud'), 'azure'), req.appUrl, typeof name === 'string' ? name : undefined));
    },
  },
  '/designs/check': { POST: async (req) => json(200, checkDesign(await bodyDesign(req.body))) },
  '/designs/read': { POST: async (req) => json(200, portable(await bodyDesign(req.body))) },
  '/designs/link': {
    POST: async (req) => json(200, { link: await designLink(await bodyDesign(req.body), req.appUrl) }),
  },
  '/designs/export': {
    POST: async (req) => {
      const format = readFormat(req.query.get('format') ?? field(parseBody(req.body), 'format'));
      const exported = exportDesign(await bodyDesign(req.body), format);
      const wantsZip = req.query.get('zip') === 'true' || (req.header('accept') ?? '').includes('application/zip');
      if (!wantsZip) return json(200, exported);
      return {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${exported.root}.zip"`,
        },
        body: exportZip(exported),
      };
    },
  },
  '/designs/add-region': {
    POST: async (req) => {
      const location = field(parseBody(req.body), 'location');
      return json(200, await addRegion(await bodyDesign(req.body), req.appUrl, typeof location === 'string' ? location : undefined));
    },
  },
  '/designs/add-spoke': {
    POST: async (req) => {
      const body = parseBody(req.body);
      const name = field(body, 'name');
      return json(
        200,
        await addSpoke(
          await bodyDesign(req.body),
          req.appUrl,
          asText(field(body, 'region')),
          asText(field(body, 'template')),
          typeof name === 'string' ? name : undefined,
        ),
      );
    },
  },
  '/designs/compare': {
    POST: async (req) => {
      const deployed = asText(field(parseBody(req.body), 'deployed'));
      return json(200, compareDesign(await bodyDesign(req.body), deployed));
    },
  },
  '/import': {
    POST: async (req) =>
      json(
        200,
        await importNetwork(readCloud(req.query.get('cloud'), 'azure'), req.body, req.appUrl, req.query.get('name') ?? undefined),
      ),
  },
  '/mcp': {
    POST: async (req) => {
      const answer = await handleMcpBody(req.body, req.appUrl);
      if (answer === null) return { status: 202, headers: { ...CORS }, body: '' };
      return json(200, answer);
    },
    // A stateless server offers no event stream (GET) or session to end (DELETE).
  },
};

/** Answer one request to the API. Never throws. */
export async function handleApiRequest(req: ApiRequest): Promise<ApiResponse> {
  if (req.method === 'OPTIONS') return { status: 204, headers: { ...CORS }, body: '' };
  const path = `/${req.path.replace(/^\/+|\/+$/g, '')}`;
  const route = ROUTES[path];
  if (!route) return json(404, { error: `No API at ${path}. See ${req.appUrl}api/openapi.json.` });
  const handler = route[req.method as 'GET' | 'POST'];
  if (!handler) return notAllowed(Object.keys(route).join(', '));
  if (new TextEncoder().encode(req.body).length > MAX_BODY_BYTES)
    return json(413, { error: `The request is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.` });
  try {
    return await handler(req);
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, { error: e.message, ...(e.details.length > 1 ? { details: e.details } : {}) });
    return json(500, { error: `Something went wrong: ${(e as Error).message}` });
  }
}

/**
 * The app's address as the caller sees it. Static Web Apps passes the
 * original URL in x-ms-original-url; behind other hosts, the request URL.
 */
export function appUrlOf(requestUrl: string, header: (name: string) => string | null, configured?: string): string {
  if (configured?.trim()) return configured.trim().replace(/\/?$/, '/');
  const original = header('x-ms-original-url');
  const url = new URL(original || requestUrl);
  const host = header('x-forwarded-host');
  const proto = header('x-forwarded-proto');
  if (!original && host) return `${proto || url.protocol.replace(':', '')}://${host.split(',')[0].trim()}/`;
  return `${url.origin}/`;
}
