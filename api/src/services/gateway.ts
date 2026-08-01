import { config } from '../config.js';
import { recordRun, type Agent } from './agents.js';

/**
 * The AI gateway's invoke path.
 *
 * OpenRouter sits underneath (Bill's call, 2026-08-01): one key, one endpoint,
 * every provider behind it. This module is the ONLY place that knows that.
 * Everything above it - the registry, access grants, the cost log - is ours and
 * provider-agnostic, so swapping to a self-hosted LiteLLM later means rewriting
 * this file and nothing else.
 *
 * What happens on a call:
 *   1. run the agent's cheapest-capable model,
 *   2. if that fails in a way a better model would fix, run the fallback,
 *   3. log every attempt with its cost and outcome.
 *
 * Step 3 is the point. "Escalate on evidence" only means something if the
 * evidence gets written down, including - especially - the failures.
 */

export class GatewayNotConfigured extends Error {
  constructor() {
    super('AI gateway is not configured: set OPENROUTER_API_KEY');
  }
}

export class GatewayError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface InvokeResult {
  output: string;
  /** Parsed object when the agent is set to return JSON. */
  data?: unknown;
  model: string;
  used_fallback: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number;
  latency_ms: number;
}

interface Attempt {
  ok: boolean;
  content?: string;
  data?: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number;
  latencyMs: number;
  detail?: string;
  /**
   * True when the model itself was not good enough - it returned nothing
   * usable, or broke the requested JSON shape. False for transport problems
   * (timeout, 429, 5xx), which say nothing about the model's ability and must
   * never be counted as evidence to escalate.
   */
  hardFail: boolean;
}

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * OpenRouter reports this in ACCOUNT CREDITS, not dollars. We store it as
     * given; confirm the credit-to-USD rate before reading the spend report as
     * literal dollars.
     */
    cost?: number;
  };
  error?: { message?: string };
}

/** 429 and 5xx are the provider having a bad moment, not the model failing. */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function callModel(agent: Agent, model: string, input: string): Promise<Attempt> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gatewayTimeoutMs);

  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(agent.prompt ? [{ role: 'system', content: agent.prompt }] : []),
      { role: 'user', content: input },
    ],
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    // Ask OpenRouter to price the call for us instead of us maintaining a
    // per-model rate card that would drift the week after it's written.
    usage: { include: true },
  };
  if (agent.json_output) body['response_format'] = { type: 'json_object' };

  try {
    const res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.appUrl,
        'X-Title': config.appTitle,
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - started;
    const payload = (await res.json().catch(() => ({}))) as OpenRouterResponse;
    const cost = Number(payload.usage?.cost ?? 0);
    const promptTokens = payload.usage?.prompt_tokens ?? null;
    const completionTokens = payload.usage?.completion_tokens ?? null;

    if (!res.ok) {
      return {
        ok: false,
        promptTokens, completionTokens, cost, latencyMs,
        detail: `HTTP ${res.status}: ${payload.error?.message ?? 'request rejected'}`.slice(0, 2000),
        hardFail: !isTransient(res.status),
      };
    }

    const content = payload.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) {
      return {
        ok: false,
        promptTokens, completionTokens, cost, latencyMs,
        detail: 'model returned an empty response',
        hardFail: true,
      };
    }

    if (agent.json_output) {
      try {
        const data = JSON.parse(content);
        return { ok: true, content, data, promptTokens, completionTokens, cost, latencyMs, hardFail: false };
      } catch {
        // The agent is set to return JSON and this model couldn't. That is
        // exactly the "not good enough" signal the fallback exists for.
        return {
          ok: false,
          promptTokens, completionTokens, cost, latencyMs,
          detail: 'model did not return valid JSON',
          hardFail: true,
        };
      }
    }

    return { ok: true, content, promptTokens, completionTokens, cost, latencyMs, hardFail: false };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      promptTokens: null, completionTokens: null, cost: 0, latencyMs,
      detail: aborted
        ? `timed out after ${config.gatewayTimeoutMs}ms`
        : `could not reach the gateway: ${(err as Error).message}`.slice(0, 2000),
      hardFail: false,
    };
  }
}

/**
 * Run one agent. Caller must already have checked that the agent is enabled and
 * that this consumer is allowed to call it - enforcement lives at the route.
 */
export async function invokeAgent(
  agent: Agent,
  input: string,
  consumerAppId: string | null,
): Promise<InvokeResult> {
  if (!config.openrouterApiKey) throw new GatewayNotConfigured();

  const log = (model: string, attempt: Attempt, usedFallback: boolean) =>
    recordRun({
      agent_id: agent.id,
      consumer_app_id: consumerAppId,
      model,
      used_fallback: usedFallback,
      status: attempt.ok ? 'ok' : 'error',
      hard_fail: attempt.hardFail,
      prompt_tokens: attempt.promptTokens,
      completion_tokens: attempt.completionTokens,
      cost_usd: attempt.cost,
      latency_ms: attempt.latencyMs,
      detail: attempt.detail ?? null,
    }).catch((err) => console.error('run log failed:', err));

  const primary = await callModel(agent, agent.model, input);
  await log(agent.model, primary, false);

  if (primary.ok) {
    return {
      output: primary.content ?? '',
      data: primary.data,
      model: agent.model,
      used_fallback: false,
      prompt_tokens: primary.promptTokens,
      completion_tokens: primary.completionTokens,
      cost: primary.cost,
      latency_ms: primary.latencyMs,
    };
  }

  // Only escalate when a stronger model would plausibly help. A timeout or a
  // 503 means try again later, not pay more.
  if (!agent.fallback_model || !primary.hardFail) {
    throw new GatewayError(primary.detail ?? 'model call failed', primary.hardFail ? 502 : 503);
  }

  const second = await callModel(agent, agent.fallback_model, input);
  await log(agent.fallback_model, second, true);

  if (!second.ok) {
    throw new GatewayError(
      `both models failed - ${agent.model}: ${primary.detail}; ${agent.fallback_model}: ${second.detail}`,
      502,
    );
  }

  return {
    output: second.content ?? '',
    data: second.data,
    model: agent.fallback_model,
    used_fallback: true,
    prompt_tokens: second.promptTokens,
    completion_tokens: second.completionTokens,
    cost: second.cost,
    // Total wall clock the caller actually waited, both attempts included.
    latency_ms: primary.latencyMs + second.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

export interface GatewayModel {
  id: string;
  name: string;
  /** USD per million tokens, as advertised by the gateway. */
  prompt_per_m: number | null;
  completion_per_m: number | null;
  context_length: number | null;
}

let cache: { at: number; models: GatewayModel[] } | null = null;
const CACHE_MS = 60 * 60 * 1000;

/**
 * The live catalogue, straight from the gateway. Deliberately not a hardcoded
 * list: model names and prices change constantly, and a stale rate card baked
 * into the picker would quietly stop meaning "cheapest capable".
 *
 * Returns [] rather than throwing when the gateway isn't configured or is
 * unreachable - the admin screen falls back to a plain text field so an agent
 * can still be edited.
 */
export async function listModels(now = Date.now()): Promise<GatewayModel[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.models;
  if (!config.openrouterApiKey) return [];

  try {
    const res = await fetch(`${config.openrouterBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
    });
    if (!res.ok) return cache?.models ?? [];

    const payload = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };

    const perMillion = (v: string | undefined): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n * 1_000_000 : null;
    };

    const models: GatewayModel[] = (payload.data ?? [])
      .filter((m): m is { id: string } & typeof m => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        prompt_per_m: perMillion(m.pricing?.prompt),
        completion_per_m: perMillion(m.pricing?.completion),
        context_length: m.context_length ?? null,
      }))
      .sort((a, b) => (a.prompt_per_m ?? Infinity) - (b.prompt_per_m ?? Infinity));

    cache = { at: now, models };
    return models;
  } catch (err) {
    console.error('model catalogue fetch failed:', err);
    return cache?.models ?? [];
  }
}
