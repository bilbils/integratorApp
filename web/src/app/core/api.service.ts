import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export type Outcome = 'win' | 'loss' | 'lesson';

export interface Highlight {
  id: string;
  source: string;
  project: string | null;
  outcome: Outcome;
  significance: number;
  title: string;
  highlight: string;
  detail: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  captured_at: string;
  created_at: string;
}

export interface HighlightFilters {
  project?: string;
  outcome?: Outcome | '';
  since?: string;
  significance_min?: number | null;
  limit?: number;
}

// --- AI gateway: the agent registry ----------------------------------------

export interface AgentApp {
  id: string;
  name: string;
}

export interface AgentStats {
  calls: number;
  cost_usd: number;
  ok_rate: number;
  hard_fails: number;
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  prompt: string;
  model: string;
  fallback_model: string | null;
  temperature: number;
  max_tokens: number;
  json_output: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  allowed_apps: AgentApp[];
  stats: AgentStats;
}

/** Everything the edit form can change. Sent as a partial on save. */
export interface AgentWrite {
  slug?: string;
  name?: string;
  purpose?: string | null;
  prompt?: string;
  model?: string;
  fallback_model?: string | null;
  temperature?: number;
  max_tokens?: number;
  json_output?: boolean;
  enabled?: boolean;
  allowed_app_ids?: string[];
}

// --- Consumer apps & connector access ---------------------------------------

export type Permission = 'read' | 'sync';

export interface ConnectorGrant {
  connector_id: string;
  connector_key: string;
  kind: 'inbound' | 'outbound';
  permission: Permission;
}

export interface Connector {
  id: string;
  key: string;
  kind: 'inbound' | 'outbound';
  active: boolean;
}

export interface ConsumerApp {
  id: string;
  name: string;
  active: boolean;
  key_id: string | null;
  last_used_at: string | null;
  created_at: string;
  grants: ConnectorGrant[];
  agent_count: number;
}

export interface ConsumerAppWrite {
  name?: string;
  active?: boolean;
  grants?: { connector_id: string; permission: Permission }[];
}

/** The API key is present only in a create or rotate response. */
export interface MintedKey {
  app: ConsumerApp;
  api_key: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private headers(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.auth.token() ?? ''}` });
  }

  private get base(): string {
    return environment.apiBaseUrl;
  }

  getHighlights(filters: HighlightFilters = {}): Observable<Highlight[]> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    }
    return this.http.get<Highlight[]>(`${this.base}/highlights`, { headers: this.headers(), params });
  }

  getAgents(): Observable<Agent[]> {
    return this.http.get<Agent[]>(`${this.base}/agents`, { headers: this.headers() });
  }

  createAgent(body: AgentWrite): Observable<Agent> {
    return this.http.post<Agent>(`${this.base}/agents`, body, { headers: this.headers() });
  }

  updateAgent(id: string, body: AgentWrite): Observable<Agent> {
    return this.http.patch<Agent>(`${this.base}/agents/${id}`, body, { headers: this.headers() });
  }

  deleteAgent(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/agents/${id}`, { headers: this.headers() });
  }

  getConsumerApps(includeInactive = true): Observable<ConsumerApp[]> {
    const params = new HttpParams().set('include_inactive', String(includeInactive));
    return this.http.get<ConsumerApp[]>(`${this.base}/consumer-apps`, {
      headers: this.headers(),
      params,
    });
  }

  getConnectors(): Observable<Connector[]> {
    return this.http.get<Connector[]>(`${this.base}/consumer-apps/connectors`, {
      headers: this.headers(),
    });
  }

  createConsumerApp(body: ConsumerAppWrite): Observable<MintedKey> {
    return this.http.post<MintedKey>(`${this.base}/consumer-apps`, body, { headers: this.headers() });
  }

  updateConsumerApp(id: string, body: ConsumerAppWrite): Observable<ConsumerApp> {
    return this.http.patch<ConsumerApp>(`${this.base}/consumer-apps/${id}`, body, {
      headers: this.headers(),
    });
  }

  rotateConsumerAppKey(id: string): Observable<MintedKey> {
    return this.http.post<MintedKey>(`${this.base}/consumer-apps/${id}/rotate-key`, {}, {
      headers: this.headers(),
    });
  }

  deleteConsumerApp(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/consumer-apps/${id}?confirm=true`, {
      headers: this.headers(),
    });
  }
}
