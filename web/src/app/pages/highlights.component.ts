import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService, Highlight, HighlightFilters } from '../core/api.service';

@Component({
  selector: 'app-highlights',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <div class="toolbar">
      <div class="filters">
        <input placeholder="Project" name="project" [(ngModel)]="filters.project" (keyup.enter)="load()" />
        <select name="outcome" [(ngModel)]="filters.outcome">
          <option value="">Any outcome</option>
          <option value="win">Win</option>
          <option value="loss">Loss</option>
          <option value="lesson">Lesson</option>
        </select>
        <select name="sig" [(ngModel)]="filters.significance_min">
          <option [ngValue]="null">Any significance</option>
          <option [ngValue]="3">3+</option>
          <option [ngValue]="4">4+</option>
          <option [ngValue]="5">5 only</option>
        </select>
        <button class="btn" (click)="load()">Filter</button>
      </div>
    </div>

    @if (loading()) {
      <p class="muted">Loading...</p>
    } @else if (error()) {
      <p class="error">{{ error() }}</p>
    } @else if (highlights().length === 0) {
      <p class="muted">No highlights yet.</p>
    } @else {
      <ul class="list">
        @for (h of highlights(); track h.id) {
          <li class="card row">
            <span class="badge" [class]="'badge-' + h.outcome">{{ h.outcome }}</span>
            <div class="row-main">
              <div class="row-title">{{ h.title }}</div>
              <div class="row-body">{{ h.highlight }}</div>
              <div class="row-meta">
                <span>sig {{ h.significance }}</span>
                <span>{{ h.source }}</span>
                @if (h.project) { <span>{{ h.project }}</span> }
                <span>{{ h.captured_at | date: 'MMM d, y, h:mm a' }}</span>
                @for (t of h.tags; track t) { <span class="tag">{{ t }}</span> }
              </div>
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class HighlightsComponent implements OnInit {
  private api = inject(ApiService);

  readonly highlights = signal<Highlight[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  filters: HighlightFilters = { project: '', outcome: '', significance_min: null, limit: 50 };

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.getHighlights(this.filters).subscribe({
      next: (rows) => {
        this.highlights.set(rows);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load highlights. Is the API running and are you signed in?');
        this.loading.set(false);
      },
    });
  }
}
