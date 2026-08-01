import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="card login">
      <h1>Sign in</h1>
      <p class="muted">Integrator admin</p>

      <form (ngSubmit)="submit()">
        <label>
          Email
          <input type="email" name="email" [(ngModel)]="email" autocomplete="username" required />
        </label>
        <label>
          Password
          <input type="password" name="password" [(ngModel)]="password" autocomplete="current-password" required />
        </label>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        <button type="submit" class="btn" [disabled]="loading()">
          {{ loading() ? 'Signing in...' : 'Sign in' }}
        </button>
      </form>
    </div>
  `,
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);

  email = '';
  password = '';
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);

  submit(): void {
    this.loading.set(true);
    this.error.set(null);
    this.auth.login(this.email, this.password).subscribe({
      next: () => this.router.navigate(['/highlights']),
      error: (err: { status?: number }) => {
        // A 401 really is a bad password. Anything else means we never got to
        // ask - saying "invalid password" then would send you hunting for the
        // wrong problem, which is exactly what the deployed UI does today while
        // its API is still local-only.
        this.error.set(
          err?.status === 401
            ? 'Invalid email or password.'
            : 'Can’t reach the API. It isn’t running, or isn’t reachable from here — ' +
              'check the build marker at the top of the page.',
        );
        this.loading.set(false);
      },
    });
  }
}
