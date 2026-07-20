import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHighlight, listHighlights } from '../services/highlights.js';
import { checkIngestToken } from '../services/auth.js';

const server = new McpServer({ name: 'integrator-app', version: '0.1.0' });

// Push: an AI tool logs a curated session highlight. Wins AND failures both matter.
server.registerTool(
  'log_session_highlight',
  {
    title: 'Log session highlight',
    description:
      'Save a curated highlight of an AI work session to the Integrator. ' +
      'Store the gist, not a transcript. outcome must be win, loss, or lesson; ' +
      'significance 1-5 (use 4-5 only for a genuinely big win or failure).',
    inputSchema: {
      ingest_token: z.string().describe('Shared ingest token (INGEST_TOKEN).'),
      source: z.string().describe("Tool the session came from, e.g. 'claude', 'cursor'."),
      project: z.string().optional(),
      outcome: z.enum(['win', 'loss', 'lesson']),
      significance: z.number().int().min(1).max(5).default(3),
      title: z.string(),
      highlight: z.string().describe('The curated summary, in Bill Speak.'),
      detail: z.string().optional().describe('Optional richer detail when significance is high.'),
      tags: z.array(z.string()).default([]),
    },
  },
  async ({ ingest_token, ...input }) => {
    if (!checkIngestToken(ingest_token)) {
      return { content: [{ type: 'text', text: 'Error: invalid ingest token.' }], isError: true };
    }
    const row = await createHighlight(input);
    return { content: [{ type: 'text', text: `Saved highlight ${row.id} (${row.outcome}, sig ${row.significance}).` }] };
  },
);

// Read: a consumer (e.g. Bills-Master-Plan) searches highlights for reviews / content.
server.registerTool(
  'search_highlights',
  {
    title: 'Search session highlights',
    description: 'Return recent session highlights, newest first, with optional filters.',
    inputSchema: {
      project: z.string().optional(),
      outcome: z.enum(['win', 'loss', 'lesson']).optional(),
      since: z.string().optional().describe('ISO timestamp lower bound on captured_at.'),
      significance_min: z.number().int().min(1).max(5).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
  },
  async (args) => {
    const rows = await listHighlights(args);
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Integrator MCP server running on stdio.');
