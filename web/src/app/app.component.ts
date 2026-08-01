import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from './core/auth.service';

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

  /** The two-pane editor screens need more room than a plain list. */
  readonly wide = signal(false);

  constructor() {
    this.router.events.subscribe(() =>
      this.wide.set(/^\/(agents|apps)/.test(this.router.url)),
    );
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
