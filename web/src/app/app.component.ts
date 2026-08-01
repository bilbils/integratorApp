import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <span class="brand">Integrator</span>
      @if (auth.isLoggedIn()) {
        <nav class="nav">
          <a routerLink="/highlights" routerLinkActive="active">Highlights</a>
          <a routerLink="/agents" routerLinkActive="active">AI Agents</a>
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

  /** The agents screen is a two-pane editor and needs more room than a list. */
  readonly wide = signal(false);

  constructor() {
    this.router.events.subscribe(() => this.wide.set(this.router.url.startsWith('/agents')));
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
