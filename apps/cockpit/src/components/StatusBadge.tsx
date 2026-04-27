import type { AgentState, TaskStatus } from '@wanman/cockpit-client';

type BadgeVariant = AgentState | TaskStatus | 'ok' | 'degraded' | 'down' | 'connected' | 'reconnecting';

const VARIANT_STYLES: Record<string, string> = {
  // Agent states
  running: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  idle: 'bg-stone-100 text-stone-600 ring-stone-200',
  paused: 'bg-amber-50 text-amber-700 ring-amber-200',
  stopped: 'bg-stone-100 text-stone-500 ring-stone-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
  // Task statuses
  pending: 'bg-stone-100 text-stone-600 ring-stone-200',
  assigned: 'bg-orange-50 text-orange-700 ring-orange-200',
  in_progress: 'bg-orange-100 text-orange-800 ring-orange-200',
  review: 'bg-amber-50 text-amber-700 ring-amber-200',
  done: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  blocked: 'bg-orange-50 text-orange-600 ring-orange-200',
  // Connection / health
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  connected: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  degraded: 'bg-amber-50 text-amber-700 ring-amber-200',
  reconnecting: 'bg-amber-50 text-amber-700 ring-amber-200',
  down: 'bg-red-50 text-red-700 ring-red-200',
};

const DOT_STYLES: Record<string, string> = {
  running: 'bg-emerald-500 animate-pulse',
  error: 'bg-red-500',
  ok: 'bg-emerald-500 animate-pulse',
  connected: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-red-500',
};

interface StatusBadgeProps {
  status: BadgeVariant;
  label?: string;
  dot?: boolean;
  className?: string;
}

export function StatusBadge({ status, label, dot = false, className = '' }: StatusBadgeProps) {
  const styles = VARIANT_STYLES[status] ?? 'bg-stone-100 text-stone-600 ring-stone-200';
  const dotStyle = DOT_STYLES[status] ?? 'bg-stone-400';
  const text = label ?? status.replace(/_/g, ' ');

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${styles} ${className}`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotStyle}`} />}
      {text}
    </span>
  );
}
