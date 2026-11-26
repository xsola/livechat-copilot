import { z } from 'zod';

export const pageCounter = z.enum([
  'sessions', 'rendered', 'expired', 'cached', 'local', 'community', 'builtin', 'automatic', 'manualPicker',
]);
export const modelTask = z.enum(['translation', 'vision', 'connection', 'roomProfile', 'agent']);
export type ModelTask = z.infer<typeof modelTask>;
export type PageCounter = z.infer<typeof pageCounter>;

export interface TaskUsage {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalMs: number;
}

export interface DailyUsage {
  date: string;
  page: Partial<Record<PageCounter, number>>;
  models: Partial<Record<ModelTask, TaskUsage>>;
}

export function updateUsage(days: DailyUsage[], update: (day: DailyUsage) => void, now = new Date()) {
  const localDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 29);
  const first = [cutoff.getFullYear(), String(cutoff.getMonth() + 1).padStart(2, '0'),
    String(cutoff.getDate()).padStart(2, '0')].join('-');
  const recent = days.filter(day => day.date >= first && day.date <= localDate);
  let today = recent.find(day => day.date === localDate);
  if (!today) {
    today = { date: localDate, page: {}, models: {} };
    recent.push(today);
  }
  update(today);
  return recent.sort((a, b) => a.date.localeCompare(b.date));
}
