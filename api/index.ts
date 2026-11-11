// Azure Functions entry for the API, deployed as the Static Web App's managed
// functions under /api. All the logic is in src/lib/apiHttp.ts; this only
// translates requests and responses.

import { app } from '@azure/functions';
import { MAX_BODY_BYTES, appUrlOf, handleApiRequest } from '../src/lib/apiHttp';

app.http('api', {
  // Every path under /api (the host's route prefix).
  route: '{*path}',
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  handler: async (request) => {
    const header = (name: string) => request.headers.get(name);
    const length = Number(header('content-length') ?? 0);
    const body = length > MAX_BODY_BYTES ? 'x'.repeat(MAX_BODY_BYTES + 1) : await request.text();
    const url = new URL(request.url);
    const response = await handleApiRequest({
      method: request.method.toUpperCase(),
      path: url.pathname.replace(/^\/api(?=\/|$)/, ''),
      query: url.searchParams,
      header,
      body,
      appUrl: appUrlOf(request.url, header, process.env.APP_URL),
    });
    return { status: response.status, headers: response.headers, body: response.body };
  },
});
