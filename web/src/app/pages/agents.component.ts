import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import {
  Agent,
  AgentWrite,
  ApiService,
  ConsumerApp,
  GatewayModel,
  InvokeResult,
} from '../core/api.service';

/**
 * The AI gateway's admin screen: an editable registry of agents.
 *
 * Every agent is a saved row - name, purpose, prompt, model, knobs, and which
 * apps may call it. Adding a capability is adding a row, not a deploy.
 *
 * The model picker is fed live from the gateway (GET /agents/models), sorted
 * cheapest first, so "cheapest capable" is something you read off the list
 * rather than guess at - and so it can never drift out of date the way a
 * hardcoded rate card would.
 */

/** More than this many hard failures in 30 days is evidence, not noise. */
const ESCALATE_AT = 3;

interface Draft {
  id: string | null;                 // null = not saved yet
  name: string;
  purpose: string;
  prompt: string;
  model: string;
  fallback_model: string;            // '' = none
  temperature: number;
  max_tokens: number;
  json_output: boolean;
  enabled: boolean;
  allowed_app_ids: string[];
}

function draftFrom(agent: Agent): Draft {
  return {
    id: agent.id,
    name: agent.name,
    purpose: agent.purpose ?? '',
    prompt: agent.prompt,
    model: agent.model,
    fallback_model: agent.fallback_model ?? '',
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    json_output: agent.json_output,
    enabled: agent.enabled,
    allowed_app_ids: agent.allowed_apps.map((a) => a.id),
  };
}

function blankDraft(): Draft {
  return {
    id: null,
    name: 'New agent',
    purpose: '',
    prompt: '',
    model: '',
    fallback_model: '',
    temperature: 0.3,
    max_tokens: 400,
    json_output: false,
    enabled: false,
    allowed_app_ids: [],
  };
}

@Component({
  selector: 'app-agents',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
  template: `
    <div class="toolbar agents-toolbar">
      <div>
        <h2 class="screen-title">AI Agents</h2>
        <p class="muted note">
          Each agent is a saved job: a name, a prompt, a model, and who can call it.
          Add a capability by adding a row — no deploy.
        </p>
      </div>
      <button class="btn" (click)="newAgent()">+ New agent</button>
    </div>

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <div class="split">
        <!-- Left: the registry -->
        <div class="list">
          @if (agents().length === 0 && !draft()) {
            <p class="muted">No agents yet. Add the first one.</p>
          }
          @for (a of agents(); track a.id) {
            <div class="card agent-card" [class.active]="draft()?.id === a.id" (click)="select(a)">
              <button
                class="pill"
                [class.pill-on]="a.enabled"
                (click)="toggleEnabled(a, $event)"
                [disabled]="busy()"
              >{{ a.enabled ? 'On' : 'Off' }}</button>

              <div class="agent-name">{{ a.name }}</div>
              <div class="agent-purpose muted">{{ a.purpose || 'No purpose yet' }}</div>

              <div class="agent-badges">
                <span class="chip chip-model">{{ a.model }} · cheapest</span>
                @if (a.fallback_model) {
                  <span class="chip">↑ {{ a.fallback_model }}</span>
                }
              </div>

              <div class="agent-stat muted">
                {{ a.stats.calls | number }} calls · \${{ a.stats.cost_usd | number: '1.2-2' }} ·
                {{ a.stats.ok_rate | number: '1.0-1' }}% ok
                @if (a.stats.hard_fails > ESCALATE_AT) {
                  · <span class="warn">{{ a.stats.hard_fails }} hard calls failed on cheapest</span>
                }
              </div>
            </div>
          }
        </div>

        <!-- Right: the editor -->
        @if (draft(); as d) {
          <div class="card editor">
            <div class="editor-head">
              <div>
                <div class="editor-title">{{ d.name || 'Untitled agent' }}</div>
                <div class="muted small">{{ d.id ? 'Editing saved agent' : 'New — not saved yet' }}</div>
              </div>
              <label class="switch-row">
                <input type="checkbox" name="enabled" [(ngModel)]="d.enabled" />
                <span class="switch"></span>
                <span>{{ d.enabled ? 'Enabled' : 'Disabled' }}</span>
              </label>
            </div>

            <div class="two">
              <label>
                Agent name
                <input type="text" name="name" [(ngModel)]="d.name" />
              </label>
              <label>
                Purpose (short)
                <input type="text" name="purpose" [(ngModel)]="d.purpose" />
              </label>
            </div>

            <label class="stack">
              Instructions — the agent's prompt
              <textarea name="prompt" rows="6" [(ngModel)]="d.prompt"></textarea>
              <span class="hint muted">Tune it here. No code, no deploy.</span>
            </label>

            <div class="two">
              <label>
                Default model — cheapest that can do the job
                @if (models().length) {
                  <select name="model" [(ngModel)]="d.model">
                    @for (m of modelOptions(d.model); track m.id) {
                      <option [value]="m.id">{{ label(m) }}</option>
                    }
                  </select>
                } @else {
                  <input type="text" name="model" [(ngModel)]="d.model" placeholder="provider/model" />
                }
              </label>
              <label>
                Fallback model — escalate on evidence
                @if (models().length) {
                  <select name="fallback" [(ngModel)]="d.fallback_model">
                    <option value="">None</option>
                    @for (m of modelOptions(d.fallback_model); track m.id) {
                      <option [value]="m.id">{{ label(m) }}</option>
                    }
                  </select>
                } @else {
                  <input type="text" name="fallback" [(ngModel)]="d.fallback_model" placeholder="none" />
                }
              </label>
            </div>
            @if (!models().length) {
              <span class="hint muted">
                Model list is unavailable — the gateway needs OPENROUTER_API_KEY set.
                Type a model id by hand for now.
              </span>
            }

            <div class="two">
              <label>
                Creativity (temperature) — {{ d.temperature }}
                <input type="range" name="temp" min="0" max="1" step="0.1" [(ngModel)]="d.temperature" />
              </label>
              <label>
                Max length (tokens)
                <input type="number" name="maxlen" min="1" [(ngModel)]="d.max_tokens" />
              </label>
            </div>

            <label class="switch-row">
              <input type="checkbox" name="json" [(ngModel)]="d.json_output" />
              <span class="switch"></span>
              <span>Return clean JSON — for agents whose result is read by code</span>
            </label>

            <div class="stack">
              <span class="field-label">Which apps can call this agent</span>
              @if (apps().length === 0) {
                <span class="muted small">No consumer apps registered yet.</span>
              }
              <div class="chips">
                @for (app of apps(); track app.id) {
                  <button
                    type="button"
                    class="chip chip-select"
                    [class.chip-sel]="d.allowed_app_ids.includes(app.id)"
                    (click)="toggleApp(app.id)"
                  >{{ d.allowed_app_ids.includes(app.id) ? '✓ ' : '' }}{{ app.name }}</button>
                }
              </div>
            </div>

            @if (selectedStats(); as s) {
              <div class="costpanel">
                <div class="costpanel-title muted">Cost &amp; outcome (last 30 days)</div>
                <div class="costgrid">
                  <div><b>{{ s.calls | number }}</b><span class="muted small">calls</span></div>
                  <div><b>\${{ s.cost_usd | number: '1.2-2' }}</b><span class="muted small">model spend</span></div>
                  <div><b>{{ s.ok_rate | number: '1.0-1' }}%</b><span class="muted small">success rate</span></div>
                  <div><b>{{ s.hard_fails }}</b><span class="muted small">hard calls failed on cheapest</span></div>
                </div>
                @if (s.calls === 0) {
                  <p class="escalate neutral">No calls logged yet — this fills in once the gateway starts routing work.</p>
                } @else if (s.hard_fails > ESCALATE_AT) {
                  <p class="escalate">
                    {{ s.hard_fails }} hard calls failed on <b>{{ d.model }}</b> recently.
                    The evidence says: consider making <b>{{ d.fallback_model || 'a stronger model' }}</b> the default here.
                  </p>
                } @else {
                  <p class="escalate clear">Cheapest model is holding up — no reason to pay for a stronger one yet.</p>
                }
              </div>
            }

            @if (d.id && d.enabled) {
              <div class="costpanel">
                <div class="costpanel-title muted">Try it</div>
                <textarea
                  rows="3"
                  name="tryinput"
                  placeholder="Paste something for this agent to work on…"
                  [(ngModel)]="tryInput"
                ></textarea>
                <div class="tryrow">
                  <button class="btn ghost" (click)="run(d)" [disabled]="running() || !tryInput.trim()">
                    {{ running() ? 'Running…' : 'Run agent' }}
                  </button>
                  <span class="muted small">Saved config runs — save your edits first.</span>
                </div>
                @if (runError()) { <p class="error small">{{ runError() }}</p> }
                @if (runResult(); as r) {
                  <pre class="tryout">{{ r.output }}</pre>
                  <div class="agent-stat muted">
                    {{ r.model }}
                    @if (r.used_fallback) { · <span class="warn">escalated to fallback</span> }
                    · {{ r.prompt_tokens }}+{{ r.completion_tokens }} tokens
                    · {{ r.cost | number: '1.6-6' }} credits
                    · {{ r.latency_ms }}ms
                  </div>
                }
              </div>
            }

            <div class="editor-foot">
              @if (d.id) {
                <button class="btn danger" (click)="remove()" [disabled]="busy()">
                  {{ confirmingDelete() ? 'Click again to confirm' : 'Delete agent' }}
                </button>
              } @else {
                <button class="linkbtn" (click)="cancel()">Cancel</button>
              }
              <span class="foot-right">
                @if (saved()) { <span class="ok small">Saved</span> }
                <button class="btn" (click)="save()" [disabled]="busy() || !d.name.trim() || !d.model">
                  {{ busy() ? 'Saving…' : 'Save changes' }}
                </button>
              </span>
            </div>
          </div>
        } @else {
          <div class="card muted empty">Select an agent, or add a new one.</div>
        }
      </div>
    }
  `,
})
export class AgentsComponent implements OnInit {
  private api = inject(ApiService);

  readonly ESCALATE_AT = ESCALATE_AT;

  readonly agents = signal<Agent[]>([]);
  readonly apps = signal<ConsumerApp[]>([]);
  readonly draft = signal<Draft | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);
  readonly confirmingDelete = signal(false);

  // "Try it" panel state.
  tryInput = '';
  readonly running = signal(false);
  readonly runResult = signal<InvokeResult | null>(null);
  readonly runError = signal<string | null>(null);

  /** Runs the SAVED agent, not the draft — the point is to test what's live. */
  run(d: Draft): void {
    if (!d.id) return;
    this.running.set(true);
    this.runError.set(null);
    this.runResult.set(null);
    this.api.invokeAgent(d.id, this.tryInput).subscribe({
      next: (r) => {
        this.runResult.set(r);
        this.running.set(false);
        this.load(d.id ?? undefined);   // refresh the cost panel with this run
      },
      error: (err: { status?: number; error?: { error?: string } }) => {
        this.running.set(false);
        this.runError.set(
          err?.error?.error ??
            (err?.status === 503
              ? 'The gateway is not configured or is unreachable.'
              : 'That run failed.'),
        );
      },
    });
  }

  /** Stats belong to the saved agent, not the draft - a new agent has none. */
  readonly selectedStats = computed(() => {
    const id = this.draft()?.id;
    if (!id) return null;
    return this.agents().find((a) => a.id === id)?.stats ?? null;
  });

  /**
   * The catalogue comes from the gateway, cheapest first, so "cheapest capable"
   * is something you can read off the list instead of guess at.
   */
  readonly models = signal<GatewayModel[]>([]);

  /** Never drop the model an agent is already on, even if it left the catalogue. */
  modelOptions(current: string): GatewayModel[] {
    const list = this.models();
    if (!current || list.some((m) => m.id === current)) return list;
    return [
      { id: current, name: `${current} (not in catalogue)`, prompt_per_m: null, completion_per_m: null, context_length: null },
      ...list,
    ];
  }

  label(m: GatewayModel): string {
    if (m.prompt_per_m === null) return m.name;
    return `${m.name} — $${m.prompt_per_m.toFixed(2)}/M in, $${(m.completion_per_m ?? 0).toFixed(2)}/M out`;
  }

  ngOnInit(): void {
    this.load();
    this.api.getModels().subscribe({
      next: (rows) => this.models.set(rows),
      error: () => this.models.set([]),
    });
    // Only live apps belong in an access picker.
    this.api.getConsumerApps(false).subscribe({
      next: (rows) => this.apps.set(rows),
      error: () => this.apps.set([]),
    });
  }

  load(selectId?: string): void {
    this.loading.set(this.agents().length === 0);
    this.api.getAgents().subscribe({
      next: (rows) => {
        this.agents.set(rows);
        this.loading.set(false);
        const keep = selectId ?? this.draft()?.id ?? undefined;
        const found = keep ? rows.find((a) => a.id === keep) : undefined;
        if (found) this.draft.set(draftFrom(found));
      },
      error: () => {
        this.error.set('Could not load agents. Is the API running and are you signed in?');
        this.loading.set(false);
      },
    });
  }

  select(agent: Agent): void {
    this.confirmingDelete.set(false);
    this.saved.set(false);
    this.draft.set(draftFrom(agent));
  }

  newAgent(): void {
    this.confirmingDelete.set(false);
    this.saved.set(false);
    this.draft.set(blankDraft());
  }

  cancel(): void {
    this.draft.set(null);
  }

  toggleApp(appId: string): void {
    const d = this.draft();
    if (!d) return;
    d.allowed_app_ids = d.allowed_app_ids.includes(appId)
      ? d.allowed_app_ids.filter((id) => id !== appId)
      : [...d.allowed_app_ids, appId];
    this.draft.set({ ...d });
  }

  /** The list pill flips one agent on or off without opening the editor. */
  toggleEnabled(agent: Agent, event: Event): void {
    event.stopPropagation();
    this.busy.set(true);
    this.api.updateAgent(agent.id, { enabled: !agent.enabled }).subscribe({
      next: (updated) => {
        this.agents.set(this.agents().map((a) => (a.id === updated.id ? updated : a)));
        if (this.draft()?.id === updated.id) this.draft.set(draftFrom(updated));
        this.busy.set(false);
      },
      error: () => {
        this.error.set('Could not change that agent.');
        this.busy.set(false);
      },
    });
  }

  save(): void {
    const d = this.draft();
    if (!d) return;

    const body: AgentWrite = {
      name: d.name.trim(),
      purpose: d.purpose.trim() || null,
      prompt: d.prompt,
      model: d.model,
      fallback_model: d.fallback_model || null,
      temperature: Number(d.temperature),
      max_tokens: Number(d.max_tokens),
      json_output: d.json_output,
      enabled: d.enabled,
      allowed_app_ids: d.allowed_app_ids,
    };

    this.busy.set(true);
    this.error.set(null);
    const request = d.id ? this.api.updateAgent(d.id, body) : this.api.createAgent(body);

    request.subscribe({
      next: (agent) => {
        this.busy.set(false);
        this.saved.set(true);
        setTimeout(() => this.saved.set(false), 1500);
        this.load(agent.id);
      },
      error: (err: { status?: number }) => {
        this.busy.set(false);
        this.error.set(
          err?.status === 409
            ? 'An agent with that name already exists — give this one a different name.'
            : 'Could not save that agent.',
        );
      },
    });
  }

  remove(): void {
    const d = this.draft();
    if (!d?.id) return;

    if (!this.confirmingDelete()) {
      this.confirmingDelete.set(true);
      setTimeout(() => this.confirmingDelete.set(false), 4000);
      return;
    }

    this.busy.set(true);
    this.api.deleteAgent(d.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmingDelete.set(false);
        this.draft.set(null);
        this.load();
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Could not delete that agent.');
      },
    });
  }
}
