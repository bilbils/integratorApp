import { z } from 'zod';
import { pool } from '../db/pool.js';

export const HighlightInput = z.object({
  source: z.string().min(1),
  project: z.string().optional(),
  outcome: z.enum(['win', 'loss', 'lesson']),
  significance: z.number().int().min(1).max(5).default(3),
  title: z.string().min(1),
  highlight: z.string().min(1),
  detail: z.string().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type HighlightInput = z.infer<typeof HighlightInput>;

export interface Highlight {
  id: string;
  source: string;
  project: string | null;
  outcome: 'win' | 'loss' | 'lesson';
  significance: number;
  title: string;
  highlight: string;
  detail: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  captured_at: string;
  created_at: string;
}

export async function createHighlight(input: z.input<typeof HighlightInput>): Promise<Highlight> {
  const h = HighlightInput.parse(input);
  const { rows } = await pool.query<Highlight>(
    `insert into session_highlights
       (source, project, outcome, significance, title, highlight, detail, tags, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [h.source, h.project ?? null, h.outcome, h.significance, h.title, h.highlight,
      h.detail ?? null, h.tags, h.metadata],
  );
  return rows[0];
}

export const HighlightQuery = z.object({
  project: z.string().optional(),
  outcome: z.enum(['win', 'loss', 'lesson']).optional(),
  since: z.string().optional(),                          // ISO timestamp
  significance_min: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HighlightQuery = z.infer<typeof HighlightQuery>;

export async function listHighlights(query: z.input<typeof HighlightQuery>): Promise<Highlight[]> {
  const q = HighlightQuery.parse(query);
  const filters: string[] = [];
  const params: unknown[] = [];

  if (q.project) { params.push(q.project); filters.push(`project = $${params.length}`); }
  if (q.outcome) { params.push(q.outcome); filters.push(`outcome = $${params.length}`); }
  if (q.since) { params.push(q.since); filters.push(`captured_at >= $${params.length}`); }
  if (q.significance_min) { params.push(q.significance_min); filters.push(`significance >= $${params.length}`); }

  const where = filters.length ? `where ${filters.join(' and ')}` : '';
  params.push(q.limit);

  const { rows } = await pool.query<Highlight>(
    `select * from session_highlights ${where} order by captured_at desc limit $${params.length}`,
    params,
  );
  return rows;
}

export async function getHighlight(id: string): Promise<Highlight | null> {
  const { rows } = await pool.query<Highlight>(
    `select * from session_highlights where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
