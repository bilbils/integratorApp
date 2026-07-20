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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  getHighlights(filters: HighlightFilters = {}): Observable<Highlight[]> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    }
    const headers = new HttpHeaders({ Authorization: `Bearer ${this.auth.token() ?? ''}` });
    return this.http.get<Highlight[]>(`${environment.apiBaseUrl}/highlights`, { headers, params });
  }
}
