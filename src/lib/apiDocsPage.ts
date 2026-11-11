// A readable HTML page of the API's documentation (GET /api/docs), built from
// the OpenAPI document, the MCP tools and the design format, so it never
// drifts from them. Self-contained: no scripts or outside assets.

import { DESIGN_FORMAT } from './apiDocs';
import { MCP_TOOLS } from './mcp';
import { openApiDocument } from './openapi';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Operation {
  summary?: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: { enum?: string[]; type?: string }; description?: string }[];
  requestBody?: { content?: Record<string, unknown>; description?: string };
}

export function apiDocsPage(appUrl: string): string {
  const doc = openApiDocument(appUrl);
  const base = `${appUrl}api`;
  const routes = Object.entries(doc.paths as Record<string, Record<string, Operation>>).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => {
      const params = (op.parameters ?? [])
        .map((p) => {
          const values = p.schema?.enum ? ` (${p.schema.enum.join(' | ')})` : '';
          return `<code>${escape(p.name)}</code>${p.required ? '' : '?'}${escape(values)}`;
        })
        .join(', ');
      const body = op.requestBody ? Object.keys(op.requestBody.content ?? {}).join(' or ') : '';
      return `<tr><td><code>${method.toUpperCase()} /api${escape(path)}</code></td><td>${escape(op.summary ?? '')}${
        params ? `<br><small>Query: ${params}</small>` : ''
      }${body ? `<br><small>Body: ${escape(body)}</small>` : ''}</td></tr>`;
    }),
  );
  const tools = MCP_TOOLS.map(
    (t) =>
      `<tr><td><code>${t.name}</code></td><td>${escape(t.description)}${
        Object.keys(t.inputSchema.properties).length
          ? `<br><small>Arguments: ${Object.keys(t.inputSchema.properties)
              .map((k) => `<code>${k}</code>${t.inputSchema.required?.includes(k) ? '' : '?'}`)
              .join(', ')}</small>`
          : ''
      }</td></tr>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloud network planner API</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.6rem; } h2 { margin-top: 2rem; border-bottom: 1px solid #d0d7de; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; } td { border-top: 1px solid #d0d7de; padding: .45rem .5rem; vertical-align: top; }
  td:first-child { white-space: nowrap; } code, pre { font: 13px ui-monospace, monospace; background: #f6f8fa; border-radius: 4px; }
  code { padding: .1rem .3rem; } pre { padding: .8rem; overflow-x: auto; white-space: pre-wrap; } small { color: #59636e; }
</style>
</head>
<body>
<h1>Cloud network planner API</h1>
<p>${escape(doc.info.description)}</p>
<ul>
  <li>Base URL: <code>${escape(base)}</code></li>
  <li>OpenAPI 3.1: <a href="${escape(base)}/openapi.json"><code>${escape(base)}/openapi.json</code></a></li>
  <li>MCP server (Streamable HTTP): <code>${escape(base)}/mcp</code></li>
  <li>Design format as Markdown: <a href="${escape(base)}/design-format"><code>${escape(base)}/design-format</code></a></li>
</ul>

<h2>Connect an agent</h2>
<pre>claude mcp add --transport http cloud-network-planner ${escape(base)}/mcp</pre>
<p>Any MCP client that supports Streamable HTTP can use the same URL. No sign-in or key is needed.</p>

<h2>Try it</h2>
<pre>curl -X POST ${escape(base)}/designs/new -H 'Content-Type: application/json' -d '{"cloud":"azure","name":"Example"}'</pre>
<p>The answer holds the design, its check summary and a <code>link</code> that opens it in the app. Send the design back to
<code>/designs/check</code>, <code>/designs/export?format=terraform</code> and the other routes below.</p>

<h2>HTTP routes</h2>
<table>${routes.join('')}</table>

<h2>MCP tools</h2>
<table>${tools}</table>

<h2>Design format</h2>
<pre>${escape(DESIGN_FORMAT)}</pre>
</body>
</html>
`;
}
