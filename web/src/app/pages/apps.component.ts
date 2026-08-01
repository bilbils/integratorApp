import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import {
  ApiService,
  Connector,
  ConsumerApp,
  ConsumerAppWrite,
  Permission,
} from '../core/api.service';

/**
 * Consumer apps and what they're allowed to reach.
 *
 * Registering an app here is the prerequisite for granting it an agent — the
 * agents screen only lists apps that exist and are active. Keys are shown once,
 * at mint or rotation, and never again.
 */

interface Draft {
  id: string | null;
  name: string;
  active: boolean;
  grants: Map<string, Permission>;   // connector_id -> permission
}

function draftFrom(app: ConsumerApp): Draft {
  return {
    id: app.id,
    name: app.name,
    active: app.active,
    grants: new Map(app.grants.map((g) => [g.connector_id, g.permission])),
  };
}

function blankDraft(): Draft {
  return { id: null, name: '', active: true, grants: new Map() };
}

@Component({
  selector: 'app-apps',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <div class="toolbar agents-toolbar">
      <div>
        <h2 class="screen-title">Apps &amp; Access</h2>
        <p class="muted note">
          Every app that reads from the Integrator is registered here with its own key,
          and sees only what you grant it. Register an app before granting it an agent.
        </p>
      </div>
      <button class="btn" (click)="newApp()">+ Register app</button>
    </div>

    @if (error()) {
      <p class="error">{{ error() }}</p>
    }

    <!-- Shown exactly once, right after mint or rotation. -->
    @if (minted(); as m) {
      <div class="card keycard">
        <div class="keycard-head">
          <b>New key for {{ m.name }}</b>
          <button class="linkbtn" (click)="minted.set(null)">Dismiss</button>
        </div>
        <p class="muted small">
          Copy it now — only its hash is stored, so this is the one and only time it can be shown.
          If it's lost, rotate for a new one.
        </p>
        <code class="keyvalue">{{ m.key }}</code>
        <button class="btn ghost" (click)="copy(m.key)">{{ copied() ? 'Copied' : 'Copy key' }}</button>
      </div>
    }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else {
      <div class="split">
        <div class="list">
          @if (apps().length === 0) {
            <p class="muted">No apps registered yet.</p>
          }
          @for (a of apps(); track a.id) {
            <div class="card agent-card" [class.active]="draft()?.id === a.id" (click)="select(a)">
              <span class="pill" [class.pill-on]="a.active">{{ a.active ? 'Active' : 'Off' }}</span>
              <div class="agent-name">{{ a.name }}</div>
              <div class="agent-badges">
                @for (g of a.grants; track g.connector_id) {
                  <span class="chip chip-model">{{ g.connector_key }} · {{ g.permission }}</span>
                }
                @if (a.agent_count > 0) {
                  <span class="chip">{{ a.agent_count }} agent{{ a.agent_count === 1 ? '' : 's' }}</span>
                }
                @if (a.grants.length === 0 && a.agent_count === 0) {
                  <span class="chip">no access granted</span>
                }
              </div>
              <div class="agent-stat muted">
                @if (a.last_used_at) {
                  last used {{ a.last_used_at | date: 'MMM d, h:mm a' }}
                } @else {
                  never used
                }
                @if (!a.key_id) { · <span class="warn">legacy key — rotate</span> }
              </div>
            </div>
          }
        </div>

        @if (draft(); as d) {
          <div class="card editor">
            <div class="editor-head">
              <div>
                <div class="editor-title">{{ d.name || 'New app' }}</div>
                <div class="muted small">{{ d.id ? 'Registered app' : 'Not registered yet' }}</div>
              </div>
              <label class="switch-row">
                <input type="checkbox" name="active" [(ngModel)]="d.active" />
                <span class="switch"></span>
                <span>{{ d.active ? 'Active' : 'Disabled' }}</span>
              </label>
            </div>

            <label class="stack">
              App name
              <input type="text" name="name" [(ngModel)]="d.name" placeholder="Staffility" />
              <span class="hint muted">How this app shows up in access lists across the admin.</span>
            </label>

            <div class="stack">
              <span class="field-label">Connector access</span>
              @if (connectors().length === 0) {
                <span class="muted small">No connectors registered yet.</span>
              }
              @for (c of connectors(); track c.id) {
                <div class="grantrow">
                  <label class="switch-row">
                    <input
                      type="checkbox"
                      [checked]="d.grants.has(c.id)"
                      (change)="toggleGrant(c.id)"
                    />
                    <span class="switch"></span>
                    <span>{{ c.key }}</span>
                  </label>
                  <span class="chip">{{ c.kind }}</span>
                  @if (d.grants.has(c.id)) {
                    <select
                      class="permsel"
                      [ngModel]="d.grants.get(c.id)"
                      (ngModelChange)="setPermission(c.id, $event)"
                      [ngModelOptions]="{ standalone: true }"
                    >
                      <option value="read">read</option>
                      <option value="sync">sync</option>
                    </select>
                  }
                </div>
              }
              <span class="hint muted">
                Agent-level access is separate — grant individual agents on the AI Agents screen.
              </span>
            </div>

            @if (d.id) {
              <div class="costpanel">
                <div class="costpanel-title muted">Key</div>
                <div class="keyfacts">
                  <div>
                    <b>{{ selected()?.key_id ?? '—' }}</b>
                    <span class="muted small">key id (public half)</span>
                  </div>
                  <div>
                    <b>{{ selected()?.last_used_at ? (selected()!.last_used_at | date: 'MMM d, h:mm a') : 'Never' }}</b>
                    <span class="muted small">last used</span>
                  </div>
                  <div>
                    <button class="btn ghost" (click)="rotate()" [disabled]="busy()">
                      {{ confirmingRotate() ? 'Click again to rotate' : 'Rotate key' }}
                    </button>
                  </div>
                </div>
                @if (!selected()?.key_id) {
                  <p class="escalate">
                    This app still uses a pre-migration key. It works, but every request falls back to
                    the slow check. Rotating moves it onto the fast path.
                  </p>
                } @else {
                  <p class="escalate clear">Rotating issues a new key and stops the old one immediately.</p>
                }
              </div>
            }

            <div class="editor-foot">
              @if (d.id) {
                <button class="btn danger" (click)="remove()" [disabled]="busy()">
                  {{ confirmingDelete() ? 'Click again — this drops all its grants' : 'Delete app' }}
                </button>
              } @else {
                <button class="linkbtn" (click)="draft.set(null)">Cancel</button>
              }
              <span class="foot-right">
                @if (saved()) { <span class="ok small">Saved</span> }
                <button class="btn" (click)="save()" [disabled]="busy() || !d.name.trim()">
                  {{ busy() ? 'Saving…' : d.id ? 'Save changes' : 'Register + mint key' }}
                </button>
              </span>
            </div>
          </div>
        } @else {
          <div class="card muted empty">Select an app, or register a new one.</div>
        }
      </div>
    }
  `,
})
export class AppsComponent implements OnInit {
  private api = inject(ApiService);

  readonly apps = signal<ConsumerApp[]>([]);
  readonly connectors = signal<Connector[]>([]);
  readonly draft = signal<Draft | null>(null);
  readonly minted = signal<{ name: string; key: string } | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly saved = signal(false);
  readonly copied = signal(false);
  readonly error = signal<string | null>(null);
  readonly confirmingDelete = signal(false);
  readonly confirmingRotate = signal(false);

  /** The saved row behind the draft — key id and last-used come from there. */
  selected(): ConsumerApp | null {
    const id = this.draft()?.id;
    return id ? this.apps().find((a) => a.id === id) ?? null : null;
  }

  ngOnInit(): void {
    this.load();
    this.api.getConnectors().subscribe({
      next: (rows) => this.connectors.set(rows),
      error: () => this.connectors.set([]),
    });
  }

  load(selectId?: string): void {
    this.loading.set(this.apps().length === 0);
    this.api.getConsumerApps(true).subscribe({
      next: (rows) => {
        this.apps.set(rows);
        this.loading.set(false);
        const keep = selectId ?? this.draft()?.id ?? undefined;
        const found = keep ? rows.find((a) => a.id === keep) : undefined;
        if (found) this.draft.set(draftFrom(found));
      },
      error: () => {
        this.error.set('Could not load apps. Is the API running and are you signed in?');
        this.loading.set(false);
      },
    });
  }

  select(app: ConsumerApp): void {
    this.resetConfirmations();
    this.draft.set(draftFrom(app));
  }

  newApp(): void {
    this.resetConfirmations();
    this.draft.set(blankDraft());
  }

  private resetConfirmations(): void {
    this.confirmingDelete.set(false);
    this.confirmingRotate.set(false);
    this.saved.set(false);
  }

  toggleGrant(connectorId: string): void {
    const d = this.draft();
    if (!d) return;
    if (d.grants.has(connectorId)) d.grants.delete(connectorId);
    else d.grants.set(connectorId, 'read');
    this.draft.set({ ...d });
  }

  setPermission(connectorId: string, permission: Permission): void {
    const d = this.draft();
    if (!d) return;
    d.grants.set(connectorId, permission);
    this.draft.set({ ...d });
  }

  copy(key: string): void {
    navigator.clipboard?.writeText(key).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 1500);
      },
      () => this.error.set('Could not copy — select the key and copy it manually.'),
    );
  }

  save(): void {
    const d = this.draft();
    if (!d) return;

    const body: ConsumerAppWrite = {
      name: d.name.trim(),
      active: d.active,
      grants: [...d.grants].map(([connector_id, permission]) => ({ connector_id, permission })),
    };

    this.busy.set(true);
    this.error.set(null);

    if (d.id) {
      this.api.updateConsumerApp(d.id, body).subscribe({
        next: (app) => {
          this.busy.set(false);
          this.saved.set(true);
          setTimeout(() => this.saved.set(false), 1500);
          this.load(app.id);
        },
        error: (err: { status?: number }) => this.fail(err),
      });
    } else {
      this.api.createConsumerApp(body).subscribe({
        next: (m) => {
          this.busy.set(false);
          this.minted.set({ name: m.app.name, key: m.api_key });
          this.load(m.app.id);
        },
        error: (err: { status?: number }) => this.fail(err),
      });
    }
  }

  rotate(): void {
    const d = this.draft();
    if (!d?.id) return;

    if (!this.confirmingRotate()) {
      this.confirmingRotate.set(true);
      setTimeout(() => this.confirmingRotate.set(false), 4000);
      return;
    }

    this.busy.set(true);
    this.confirmingRotate.set(false);
    this.api.rotateConsumerAppKey(d.id).subscribe({
      next: (m) => {
        this.busy.set(false);
        this.minted.set({ name: m.app.name, key: m.api_key });
        this.load(m.app.id);
      },
      error: (err: { status?: number }) => this.fail(err),
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
    this.api.deleteConsumerApp(d.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmingDelete.set(false);
        this.draft.set(null);
        this.load();
      },
      error: (err: { status?: number }) => this.fail(err),
    });
  }

  private fail(err: { status?: number }): void {
    this.busy.set(false);
    this.error.set(
      err?.status === 409
        ? 'An app with that name already exists — pick a different name.'
        : 'That did not go through. Check the API is running and try again.',
    );
  }
}
