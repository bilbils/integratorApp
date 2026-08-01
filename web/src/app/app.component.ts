import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './core/auth.service';
import { environment } from '../environments/environment';

interface Health {
  ok: boolean;
  version?: string;
  build?: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <span class="brand">
        <img src="brand/staffility-logo-reversed.svg" alt="Staffility" />
        <span class="app">Integrator Admin</span>
      </span>

      <span class="build" [class.build-warn]="mismatch()" [title]="buildTitle()">
        v{{ uiVersion }} · {{ uiBuild }}
        @if (mismatch()) { <span class="build-flag">API {{ apiLabel() }}</span> }
      </span>

      @if (auth.isLoggedIn()) {
        <nav class="nav">
          <a routerLink="/highlights" routerLinkActive="active">Highlights</a>
          <a routerLink="/agents" routerLinkActive="active">AI Agents</a>
          <a routerLink="/apps" routerLinkActive="active">Apps &amp; Access</a>
        </nav>
        <button class="linkbtn" (click)="logout()">Log out</button>
      }
    </header>
    <main class="container" [class.wide]="wide()"><router-outlet /></main>
  `,
})
export class AppComponent {
  auth = inject(AuthService);
  private router = inject(Router);
  private http = inject(HttpClient);

  readonly uiVersion = environment.version;
  readonly uiBuild = environment.buildStamp;

  /** What the running API reports. null until it answers, false if unreachable. */
  private readonly api = signal<Health | null | false>(null);

  /** The two-pane editor screens need more room than a plain list. */
  readonly wide = signal(false);

  constructor() {
    this.router.events.subscribe(() => this.wide.set(/^\/(agents|apps)/.test(this.router.url)));

    // /health is public, so this works on the login screen too - which is
    // exactly where you want to know the API is up before typing a password.
    const root = environment.apiBaseUrl.replace(/\/api\/v1\/?$/, '');
    this.http.get<Health>(`${root}/health`).subscribe({
      next: (h) => this.api.set(h),
      error: () => this.api.set(false),
    });
  }

  apiLabel(): string {
    const a = this.api();
    if (a === false) return 'unreachable';
    if (!a) return '…';
    return a.build ?? a.version ?? 'unknown';
  }

  /** Loud only when it matters: the API is down, or serving a different build. */
  mismatch(): boolean {
    const a = this.api();
    if (a === null) return false;
    if (a === false) return true;
    return a.build !== this.uiBuild;
  }

  buildTitle(): string {
    return `UI v${this.uiVersion} build ${this.uiBuild} · API ${this.apiLabel()}`;
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
