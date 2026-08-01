import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHighlight, listHighlights } from '../services/highlights.js';
import { listAgents, getAgent, recordRun } from '../services/agents.js';
import { invokeAgent } from '../services/gateway.js';
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

// --- AI gateway: the agent registry ----------------------------------------

// Read: an AI-driven consumer (Bills-Master-Plan, Staffility) discovers what
// jobs the gateway can do. Each agent is a row, so this list is always current.
server.registerTool(
  'list_ai_agents',
  {
    title: 'List AI agents',
    description:
      'Return the AI gateway\'s registered agents - the saved jobs it can run. ' +
      'Each agent has a purpose, a default (cheapest capable) model, an optional ' +
      'stronger fallback, and the consumer apps allowed to call it.',
    inputSchema: {
      enabled_only: z.boolean().default(true).describe('Only agents that are switched on.'),
      q: z.string().optional().describe('Match against agent name or purpose.'),
      limit: z.number().int().min(1).max(200).default(100),
    },
  },
  async ({ enabled_only, q, limit }) => {
    const rows = await listAgents(
      { enabled: enabled_only ? true : undefined, q, limit },
      { kind: 'admin' },
    );
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

// Read: full config for one agent, including its prompt.
server.registerTool(
  'get_ai_agent',
  {
    title: 'Get AI agent',
    description: 'Return one agent\'s full saved config, including its prompt, by slug or id.',
    inputSchema: {
      id_or_slug: z.string().describe("The agent's slug (e.g. 'summarizer') or its uuid."),
    },
  },
  async ({ id_or_slug }) => {
    const agent = await getAgent(id_or_slug, { kind: 'admin' });
    if (!agent) {
      return { content: [{ type: 'text', text: `No agent found for "${id_or_slug}".` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
  },
);

// Run: the gateway does the work. The caller names a job, not a model - the
// registry decides which model runs it, escalates if the cheap one can't cope,
// and logs what it cost.
server.registerTool(
  'run_ai_agent',
  {
    title: 'Run AI agent',
    description:
      'Run one of the gateway\'s registered agents on some input. You do not pick ' +
      'a model - the agent\'s saved config does, starting with the cheapest capable ' +
      'one and escalating to its fallback only if that is not good enough.',
    inputSchema: {
      id_or_slug: z.string().describe("The agent's slug (e.g. 'summarizer') or its uuid."),
      input: z.string().describe('The text for the agent to work on.'),
    },
  },
  async ({ id_or_slug, input }) => {
    const agent = await getAgent(id_or_slug, { kind: 'admin' });
    if (!agent) {
      return { content: [{ type: 'text', text: `No agent found for "${id_or_slug}".` }], isError: true };
    }
    if (!agent.enabled) {
      return { content: [{ type: 'text', text: `Agent "${agent.name}" is switched off.` }], isError: true };
    }
    try {
      const result = await invokeAgent(agent, input, null);
      return { content: [{ type: 'text', text: result.output }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Agent run failed: ${(err as Error).message}` }], isError: true };
    }
  },
);

// Push: whatever actually ran the model reports cost and outcome back, so the
// "escalate on evidence" decision rests on a log instead of a hunch.
server.registerTool(
  'log_agent_run',
  {
    title: 'Log AI agent run',
    description:
      'Record one call made through an agent: which model ran, whether it succeeded, ' +
      'what it cost, and whether the cheapest model was genuinely not good enough ' +
      '(hard_fail). This log is the evidence behind promoting an agent\'s fallback.',
    inputSchema: {
      ingest_token: z.string().describe('Shared ingest token (INGEST_TOKEN).'),
      agent_id: z.string().describe('The agent uuid.'),
      consumer_app_id: z.string().optional().describe('Which registered app made the call.'),
      model: z.string().describe('The model actually used.'),
      used_fallback: z.boolean().default(false),
      status: z.enum(['ok', 'error']),
      hard_fail: z.boolean().default(false).describe('Cheapest model could not do the job.'),
      prompt_tokens: z.number().int().min(0).optional(),
      completion_tokens: z.number().int().min(0).optional(),
      cost_usd: z.number().min(0).default(0),
      latency_ms: z.number().int().min(0).optional(),
      detail: z.string().optional(),
    },
  },
  async ({ ingest_token, ...input }) => {
    if (!checkIngestToken(ingest_token)) {
      return { content: [{ type: 'text', text: 'Error: invalid ingest token.' }], isError: true };
    }
    const row = await recordRun(input);
    return { content: [{ type: 'text', text: `Logged agent run ${row.id}.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Integrator MCP server running on stdio.');
