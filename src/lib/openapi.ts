// OpenAPI description of the HTTP API (GET /api/openapi.json).

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: unknown, description?: string) => ({
  required: true,
  ...(description ? { description } : {}),
  content: { 'application/json': { schema } },
});
const ok = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const cloudParam = {
  name: 'cloud',
  in: 'query',
  schema: { type: 'string', enum: ['azure', 'aws'], default: 'azure' },
};
const errors = {
  '400': { description: 'The request is not valid; `error` says what to fix.', content: { 'application/json': { schema: ref('Error') } } },
};
const designOrWrapped = {
  oneOf: [ref('Design'), ref('Plan'), { type: 'object', properties: { design: ref('DesignInput') }, required: ['design'] }],
};

export function openApiDocument(appUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cloud network planner API',
      version: '1.0.0',
      description:
        'Create, check, import, export and share network designs for Azure and AWS. Nothing is stored: every call carries the design it works on, and calls that return a design also return a link that opens it in the app. The same operations are available as an MCP server at /api/mcp. GET /api/design-format explains the design format.',
    },
    servers: [{ url: `${appUrl}api` }],
    paths: {
      '/design-format': {
        get: { summary: 'The design format, explained', responses: { '200': { description: 'Markdown', content: { 'text/markdown': {} } } } },
      },
      '/regions': { get: { summary: 'Regions a design can use', parameters: [cloudParam], responses: { '200': ok({ type: 'array' }) } } },
      '/spoke-templates': {
        get: { summary: 'Spoke templates for add-spoke', parameters: [cloudParam], responses: { '200': ok({ type: 'array' }) } },
      },
      '/import-commands': {
        get: { summary: 'CLI commands whose output /import and /designs/compare read', parameters: [cloudParam], responses: { '200': ok({ type: 'array' }) } },
      },
      '/designs/new': {
        post: {
          summary: "The app's starting design for a cloud",
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object', properties: { cloud: { type: 'string', enum: ['azure', 'aws'] }, name: { type: 'string' } } } } },
          },
          responses: { '200': ok(ref('DesignWithLink')), ...errors },
        },
      },
      '/designs/check': {
        post: {
          summary: 'Allocate and validate a design',
          requestBody: jsonBody(designOrWrapped),
          responses: { '200': ok(ref('CheckResult')), ...errors },
        },
      },
      '/designs/read': {
        post: {
          summary: 'Read a design from a share link, an exported design file or a plan',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: designOrWrapped }, 'text/plain': { schema: { type: 'string', description: 'A share link.' } } },
          },
          responses: { '200': ok(ref('Design')), ...errors },
        },
      },
      '/designs/link': {
        post: {
          summary: 'A link that opens the design in the app',
          requestBody: jsonBody(designOrWrapped),
          responses: { '200': ok({ type: 'object', properties: { link: { type: 'string', format: 'uri' } } }), ...errors },
        },
      },
      '/designs/export': {
        post: {
          summary: 'Infrastructure as code for the design',
          parameters: [
            { name: 'format', in: 'query', required: true, schema: { type: 'string', enum: ['bicep', 'terraform', 'terragrunt'] } },
            { name: 'zip', in: 'query', schema: { type: 'boolean' }, description: 'Return a zip, as the app downloads it. Or send Accept: application/zip.' },
          ],
          requestBody: jsonBody(designOrWrapped),
          responses: {
            '200': {
              description: 'The files, or a zip of them',
              content: { 'application/json': { schema: ref('ExportResult') }, 'application/zip': {} },
            },
            ...errors,
          },
        },
      },
      '/designs/add-region': {
        post: {
          summary: 'Add a region with the default hub and platform spokes',
          requestBody: jsonBody({ type: 'object', properties: { design: ref('DesignInput'), location: { type: 'string' } }, required: ['design'] }),
          responses: { '200': ok(ref('DesignWithLink')), ...errors },
        },
      },
      '/designs/add-spoke': {
        post: {
          summary: 'Add a spoke from a template to a region',
          requestBody: jsonBody({
            type: 'object',
            properties: { design: ref('DesignInput'), region: { type: 'string' }, template: { type: 'string' }, name: { type: 'string' } },
            required: ['design', 'region', 'template'],
          }),
          responses: { '200': ok(ref('DesignWithLink')), ...errors },
        },
      },
      '/designs/compare': {
        post: {
          summary: 'Compare a design with deployed networks',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              design: ref('DesignInput'),
              deployed: { description: 'Output of the import commands, as text or JSON.' },
            },
            required: ['design', 'deployed'],
          }),
          responses: { '200': ok({ type: 'object', properties: { networks: { type: 'array' }, counts: { type: 'object' }, notes: { type: 'array' } } }), ...errors },
        },
      },
      '/import': {
        post: {
          summary: 'Build a design from deployed networks',
          parameters: [cloudParam, { name: 'name', in: 'query', schema: { type: 'string' } }],
          requestBody: {
            required: true,
            description: 'Output of the import commands, as sent by the CLI (several outputs may be pasted together).',
            content: { 'text/plain': { schema: { type: 'string' } }, 'application/json': {} },
          },
          responses: { '200': ok(ref('DesignWithLink')), ...errors, '422': { description: 'No networks found', content: { 'application/json': { schema: ref('Error') } } } },
        },
      },
      '/mcp': {
        post: {
          summary: 'MCP server (Streamable HTTP, stateless, JSON responses)',
          requestBody: jsonBody({ type: 'object', description: 'A JSON-RPC message.' }),
          responses: { '200': ok({ type: 'object' }), '202': { description: 'Notification accepted' } },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } }, required: ['error'] },
        DesignInput: {
          description: 'A design, a bare plan, an exported design file, or a share link to the app.',
          oneOf: [ref('Design'), ref('Plan'), { type: 'string' }],
        },
        Design: {
          type: 'object',
          properties: { plan: ref('Plan'), naming: ref('Naming') },
          required: ['plan'],
        },
        Naming: {
          type: 'object',
          properties: { app: { type: 'string' }, environment: { type: 'string' }, instance: { type: 'string' } },
        },
        Plan: {
          type: 'object',
          properties: {
            version: { const: 1 },
            cloud: { type: 'string', enum: ['azure', 'aws'] },
            name: { type: 'string' },
            root: { type: 'string', examples: ['10.0.0.0/8'] },
            placement: { type: 'string', enum: ['single', 'alz', 'alz-platform'] },
            excluded: { type: 'array', items: { type: 'object', properties: { cidr: { type: 'string' }, label: { type: 'string' } }, required: ['cidr'] } },
            regions: { type: 'array', items: ref('Region') },
          },
          required: ['root', 'regions'],
        },
        Region: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            location: { type: 'string' },
            prefix: { type: 'integer', minimum: 0, maximum: 32 },
            fixed: { type: 'string' },
            topology: { type: 'string', enum: ['hub-spoke', 'vwan'] },
            hub: ref('Network'),
            spokes: { type: 'array', items: ref('Network') },
          },
          required: ['location', 'prefix', 'hub'],
        },
        Network: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string', enum: ['landing-zone', 'platform', 'identity', 'management', 'security', 'egress', 'endpoints'] },
            prefix: { type: 'integer', minimum: 0, maximum: 32 },
            fixed: { type: 'string' },
            ranges: { type: 'array', items: { type: 'object', properties: { prefix: { type: 'integer' }, fixed: { type: 'string' } }, required: ['prefix'] } },
            subscription: { type: 'string' },
            resourceGroup: { type: 'string' },
            subnets: { type: 'array', items: ref('Subnet') },
          },
          required: ['name', 'prefix'],
        },
        Subnet: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prefix: { type: 'integer', minimum: 0, maximum: 32 },
            fixed: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            range: { type: 'integer', minimum: 0 },
            hosts: { type: 'integer', minimum: 0 },
          },
          required: ['name', 'prefix'],
        },
        Problem: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['error', 'warning'] }, where: { type: 'string' }, message: { type: 'string' } },
        },
        DesignWithLink: {
          type: 'object',
          properties: {
            design: ref('Design'),
            link: { type: 'string', format: 'uri', description: 'Opens the design in the app.' },
            check: {
              type: 'object',
              properties: { valid: { type: 'boolean' }, errors: { type: 'integer' }, warnings: { type: 'integer' }, problems: { type: 'array', items: ref('Problem') } },
            },
            notes: { type: 'array', description: 'Import only: what the importer assumed or skipped.' },
          },
        },
        CheckResult: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            cloud: { type: 'string' },
            valid: { type: 'boolean' },
            errors: { type: 'integer' },
            warnings: { type: 'integer' },
            problems: { type: 'array', items: ref('Problem') },
            root: { type: ['string', 'null'] },
            free: { type: 'array', items: { type: 'string' } },
            regions: { type: 'array', items: { type: 'object' } },
          },
        },
        ExportResult: {
          type: 'object',
          properties: {
            cloud: { type: 'string' },
            format: { type: 'string' },
            root: { type: 'string' },
            errors: { type: 'integer' },
            files: {
              type: 'array',
              items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, description: { type: 'string' } } },
            },
          },
        },
      },
    },
  };
}
