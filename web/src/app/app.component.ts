import { Component, inject } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <header class="topbar">
      <span class="brand">Integrator <span class="dim">/ Highlights</span></span>
      @if (auth.isLoggedIn()) {
        <button class="linkbtn" (click)="logout()">Log out</button>
      }
    </header>
    <main class="container"><router-outlet /></main>
  `,
})
export class AppComponent {
  auth = inject(AuthService);
  private router = inject(Router);

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
