import type { Page } from '../App.js';
import { useHealth, useAgents, useTasks, useHumanActions } from '../hooks/useWanman.js';
import { PageHeader } from '../components/Layout.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { LoadingRows } from '../components/Spinner.js';
import type { AgentState } from '@wanman/cockpit-client';

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  sub?: string;
  onClick?: () => void;
  highlight?: 'warn' | 'error' | 'ok' | null;
}

function StatCard({ label, value, sub, onClick, highlight }: StatCardProps) {
  const borderColor =
    highlight === 'error'
      ? 'border-red-200'
      : highlight === 'warn'
        ? 'border-amber-200'
        : highlight === 'ok'
          ? 'border-emerald-200'
          : 'border-stone-200';

  const bgColor =
    highlight === 'error'
      ? 'bg-red-50'
      : highlight === 'warn'
        ? 'bg-amber-50'
        : 'bg-white';

  return (
    <button
      className={`w-full text-left rounded-lg border ${borderColor} ${bgColor} px-5 py-4 transition-colors ${onClick ? 'hover:bg-stone-50 cursor-pointer' : 'cursor-default'}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold text-stone-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-stone-400">{sub}</p>}
    </button>
  );
}

interface OverviewProps {
  onNavigate: (page: Page) => void;
}

const AGENT_STATE_ORDER: AgentState[] = ['running', 'idle', 'paused', 'stopped', 'error'];

export function Overview({ onNavigate }: OverviewProps) {
  const health = useHealth();
  const agents = useAgents();
  const tasks = useTasks();
  const humanActions = useHumanActions();

  const agentsByState: Partial<Record<AgentState, number>> = {};
  for (const agent of agents.data ?? []) {
    agentsByState[agent.state] = (agentsByState[agent.state] ?? 0) + 1;
  }
  const errorAgents = agentsByState.error ?? 0;

  const taskCounts: Record<string, number> = {};
  for (const task of tasks.data ?? []) {
    taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
  }
  const failedTasks = (taskCounts['failed'] ?? 0) + (taskCounts['blocked'] ?? 0);
  const activeTasks = (taskCounts['in_progress'] ?? 0) + (taskCounts['assigned'] ?? 0);

  const runtime = health.data?.runtime;
  const inboxCount = humanActions.data?.length ?? 0;
  const topActions = humanActions.data?.slice(0, 3) ?? [];

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={
          health.data
            ? `Last updated ${new Date(health.data.timestamp).toLocaleTimeString()}`
            : undefined
        }
      />

      {health.isError && (
        <div className="p-6">
          <div className="rounded-lg border border-red-200 bg-red-50 px-5 py-4">
            <p className="font-semibold text-red-700">Supervisor unreachable</p>
            <p className="mt-1 text-sm text-red-600">
              Make sure{' '}
              <code className="font-mono bg-red-100 px-1 rounded">wanman start</code> is running
              and reachable at{' '}
              <code className="font-mono bg-red-100 px-1 rounded">localhost:3120</code>.
            </p>
            <p className="mt-1 text-xs text-red-500">
              Error: {health.error instanceof Error ? health.error.message : 'Connection failed'}
            </p>
          </div>
        </div>
      )}

      {health.isLoading && !health.data && <LoadingRows count={2} />}

      {/* Stat cards */}
      <div className="p-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Agents"
          value={agents.data?.length ?? '—'}
          sub={
            Object.entries(agentsByState)
              .filter(([, v]) => v && v > 0)
              .map(([k, v]) => `${v} ${k}`)
              .join(' · ') || undefined
          }
          onClick={() => onNavigate('agents')}
          highlight={errorAgents > 0 ? 'error' : null}
        />
        <StatCard
          label="Tasks"
          value={tasks.data?.length ?? '—'}
          sub={activeTasks > 0 ? `${activeTasks} active` : 'none active'}
          onClick={() => onNavigate('tasks')}
          highlight={failedTasks > 0 ? 'error' : activeTasks > 0 ? 'ok' : null}
        />
        <StatCard
          label="Completed Runs"
          value={runtime?.completedRuns ?? '—'}
          sub={
            health.data?.loop
              ? `loop ${health.data.loop.currentLoop} · run ${health.data.loop.runId}`
              : undefined
          }
        />
        <StatCard
          label="Needs Attention"
          value={inboxCount}
          sub={inboxCount === 0 ? 'all clear' : `${inboxCount} item${inboxCount !== 1 ? 's' : ''}`}
          onClick={() => onNavigate('inbox')}
          highlight={inboxCount > 0 ? 'warn' : 'ok'}
        />
      </div>

      {/* Secondary stats row */}
      <div className="px-6 pb-6 grid grid-cols-2 gap-4">
        <StatCard
          label="Active Initiatives"
          value={runtime?.activeInitiatives ?? '—'}
        />
        <StatCard
          label="Active Capsules"
          value={runtime?.activeCapsules ?? '—'}
        />
      </div>

      {/* Agent state breakdown */}
      {agents.data && agents.data.length > 0 && (
        <section className="px-6 pb-6">
          <h2 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-3">
            Agent States
          </h2>
          <div className="bg-white rounded-lg border border-stone-200 divide-y divide-stone-100">
            {AGENT_STATE_ORDER.filter(s => (agentsByState[s] ?? 0) > 0).map(state => (
              <div key={state} className="flex items-center justify-between px-4 py-2.5">
                <StatusBadge status={state} dot />
                <span className="text-sm font-semibold text-stone-700">
                  {agentsByState[state]}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Task status breakdown */}
      {tasks.data && tasks.data.length > 0 && (
        <section className="px-6 pb-6">
          <h2 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-3">
            Task Status
          </h2>
          <div className="bg-white rounded-lg border border-stone-200 divide-y divide-stone-100">
            {Object.entries(taskCounts)
              .sort(([, a], [, b]) => b - a)
              .map(([status, count]) => (
                <div key={status} className="flex items-center justify-between px-4 py-2.5">
                  <StatusBadge status={status as Parameters<typeof StatusBadge>[0]['status']} />
                  <span className="text-sm font-semibold text-stone-700">{count}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Human inbox preview */}
      {topActions.length > 0 && (
        <section className="px-6 pb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
              Needs Your Attention
            </h2>
            <button
              className="text-xs text-orange-600 hover:text-orange-800 font-medium"
              onClick={() => onNavigate('inbox')}
            >
              View all ({inboxCount}) →
            </button>
          </div>
          <div className="bg-white rounded-lg border border-stone-200 divide-y divide-stone-100">
            {topActions.map(action => (
              <div key={action.id} className="px-4 py-3 flex items-start gap-3">
                <StatusBadge
                  status={action.priority === 'steer' ? 'error' : 'review'}
                  label={action.kind.replace(/_/g, ' ')}
                  className="mt-0.5 flex-shrink-0"
                />
                <p className="text-sm text-stone-700 leading-snug">{action.summary}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Error states */}
      {agents.isError && (
        <div className="px-6 pb-4">
          <ErrorBanner error={agents.error} title="Could not load agents" />
        </div>
      )}
      {tasks.isError && (
        <div className="px-6 pb-4">
          <ErrorBanner error={tasks.error} title="Could not load tasks" />
        </div>
      )}
    </div>
  );
}
