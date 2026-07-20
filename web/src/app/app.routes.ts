import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'highlights' },
  {
    path: 'login',
    loadComponent: () => import('./pages/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'highlights',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/highlights.component').then((m) => m.HighlightsComponent),
  },
  { path: '**', redirectTo: 'highlights' },
];
