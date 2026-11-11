import type { IncomingMessage } from 'node:http';
import { type Plugin, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Serves the API under /api in `npm run dev`, as the Static Web App's functions do when deployed. */
function devApi(): Plugin {
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        const { handleApiRequest, appUrlOf } = await server.ssrLoadModule('/src/lib/apiHttp.ts');
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const header = (name: string) => {
          const value = req.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : (value ?? null);
        };
        const response = await handleApiRequest({
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          header,
          body: await readBody(req),
          appUrl: appUrlOf(url.href, header),
        });
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
});
