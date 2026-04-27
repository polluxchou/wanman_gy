import { useState } from 'react';
import { useAgents, useArtifacts, useTasks, useThreads } from '../hooks/useWanman.js';
import { PageHeader } from '../components/Layout.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { LoadingRows } from '../components/Spinner.js';
import { activeTaskCount, deriveAgentCurrentWork, isBrainAbsentError } from '@wanman/cockpit-client';
import type { Agent, AgentCurrentWork } from '@wanman/cockpit-client';

interface AgentCardProps {
  agent: Agent;
  isSelected: boolean;
  onClick: () => void;
  activeTaskCount: number;
}

function AgentCard({ agent, isSelected, onClick, activeTaskCount }: AgentCardProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-stone-100 transition-colors last:border-0 ${
        isSelected ? 'bg-orange-50' : 'hover:bg-stone-50'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={agent.state} dot />
          <span className="font-medium text-stone-900 truncate">{agent.name}</span>
        </div>
        <span className="text-xs text-stone-400 ml-2 flex-shrink-0">{agent.completedRuns} runs</span>
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <span className="text-xs text-stone-500 font-mono">{agent.lifecycle}</span>
        {agent.model && (
          <span className="text-xs text-stone-400">{agent.model}</span>
        )}
        {activeTaskCount > 0 && (
          <span className="text-xs text-orange-600">
            {activeTaskCount} task{activeTaskCount !== 1 ? 's' : ''} active
          </span>
        )}
      </div>
    </button>
  );
}

interface AgentDetailProps {
  work: AgentCurrentWork;
  artifactsUnavailable: boolean;
}

function AgentDetail({ work, artifactsUnavailable }: AgentDetailProps) {
  const { agent } = work;
  const activeTasks = [...work.inProgressTasks, ...work.assignedTasks, ...work.reviewTasks];
  return (
    <div className="p-5 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <StatusBadge status={agent.state} dot />
          {agent.runtime && (
            <span className="text-xs text-stone-400 font-mono">{agent.runtime}</span>
          )}
        </div>
        <h2 className="text-lg font-semibold text-stone-900">{agent.name}</h2>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-stone-500 mb-0.5">Lifecycle</p>
          <p className="font-mono font-medium text-stone-800">{agent.lifecycle}</p>
        </div>
        <div>
          <p className="text-stone-500 mb-0.5">Model</p>
          <p className="font-medium text-stone-800">{agent.model || '—'}</p>
        </div>
        <div>
          <p className="text-stone-500 mb-0.5">Completed Runs</p>
          <p className="font-semibold text-stone-900 text-base">{agent.completedRuns}</p>
        </div>
        {agent.pendingMessages !== undefined && (
          <div>
            <p className="text-stone-500 mb-0.5">Pending Messages</p>
            <p className="font-medium text-stone-800">{agent.pendingMessages}</p>
          </div>
        )}
      </div>

      {work.errorState && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {work.errorState}
        </p>
      )}

      {activeTasks.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">
            Current Work
          </p>
          <div className="space-y-1">
            {activeTasks.map(t => (
              <div
                key={t.id}
                className="flex items-center gap-2 px-3 py-2 bg-stone-50 rounded-md border border-stone-100"
              >
                <span className="font-mono text-xs text-stone-400">{t.shortId}</span>
                <span className="text-sm text-stone-700 truncate flex-1">{t.title}</span>
                <StatusBadge status={t.status} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded px-3 py-2">
          No assigned, in-progress, or review tasks are currently linked to this agent.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-stone-50 border border-stone-100 rounded px-3 py-2">
          <p className="text-stone-500">Assigned</p>
          <p className="text-base font-semibold text-stone-900">{work.assignedTasks.length}</p>
        </div>
        <div className="bg-stone-50 border border-stone-100 rounded px-3 py-2">
          <p className="text-stone-500">In progress</p>
          <p className="text-base font-semibold text-stone-900">{work.inProgressTasks.length}</p>
        </div>
        <div className="bg-stone-50 border border-stone-100 rounded px-3 py-2">
          <p className="text-stone-500">Review</p>
          <p className="text-base font-semibold text-stone-900">{work.reviewTasks.length}</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">
          Recent Threads
        </p>
        {work.recentThreads.length === 0 ? (
          <p className="text-xs text-stone-500">No Stage 2 threads mention this agent yet.</p>
        ) : (
          <div className="space-y-1">
            {work.recentThreads.slice(0, 5).map(thread => (
              <div key={thread.id} className="px-3 py-2 bg-stone-50 rounded border border-stone-100">
                <p className="text-xs font-mono text-stone-700">{thread.id}</p>
                <p className="text-xs text-stone-500">{thread.messageCount} messages</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">
          Recent Artifacts
        </p>
        {artifactsUnavailable ? (
          <p className="text-xs text-stone-500">Artifact brain is not configured, so recent artifacts cannot be shown.</p>
        ) : work.recentArtifacts.length === 0 ? (
          <p className="text-xs text-stone-500">No artifacts from this agent are available.</p>
        ) : (
          <div className="space-y-1">
            {work.recentArtifacts.map(artifact => (
              <div key={artifact.id} className="px-3 py-2 bg-stone-50 rounded border border-stone-100">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-stone-500">{artifact.id}</span>
                  <span className="text-xs text-stone-600">{artifact.kind}</span>
                </div>
                <p className="text-xs font-mono text-stone-700 truncate">{artifact.path ?? 'no path'}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {agent.crons && agent.crons.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
            Cron Schedules
          </p>
          <div className="space-y-0.5">
            {agent.crons.map(c => (
              <p key={c} className="text-xs font-mono text-stone-600 bg-stone-100 px-2 py-1 rounded">
                {c}
              </p>
            ))}
          </div>
        </div>
      )}

      {agent.events && agent.events.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
            Event Subscriptions
          </p>
          <div className="flex flex-wrap gap-1">
            {agent.events.map(e => (
              <span key={e} className="text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded">
                {e}
              </span>
            ))}
          </div>
        </div>
      )}

      {agent.systemPrompt && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
            System Prompt
          </p>
          <p className="text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded p-3 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono leading-relaxed">
            {agent.systemPrompt}
          </p>
        </div>
      )}

      <p className="text-xs text-stone-400 italic">
        Stage 3 only allows task assignment and existing message links. Agent config and lifecycle controls are intentionally unavailable.
      </p>
    </div>
  );
}

export function AgentList() {
  const { data: agents, isLoading, isError, error } = useAgents();
  const { data: tasks } = useTasks();
  const artifactsQuery = useArtifacts();
  const { data: threads } = useThreads();
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const selectedAgent = agents?.find(a => a.name === selectedName) ?? null;
  const artifactsUnavailable = artifactsQuery.isError && isBrainAbsentError(artifactsQuery.error);
  const artifacts = artifactsUnavailable || artifactsQuery.isError ? [] : (artifactsQuery.data ?? []);

  const selectedWork = selectedAgent
    ? deriveAgentCurrentWork(selectedAgent, tasks ?? [], artifacts, threads ?? [])
    : null;

  const total = agents?.length ?? 0;

  return (
    <div className="flex h-full">
      <div className={`flex flex-col ${selectedName ? 'w-1/2' : 'w-full'} border-r border-stone-200`}>
        <PageHeader
          title="Agents"
          subtitle={`${total} agent${total !== 1 ? 's' : ''}`}
        />

        <div className="flex-1 overflow-y-auto bg-white">
          {isLoading && !agents && <LoadingRows />}
          {isError && (
            <div className="p-4">
              <ErrorBanner error={error} title="Could not load agents" />
            </div>
          )}
          {!isLoading && total === 0 && (
            <EmptyState
              title="No agents found"
              description="Start a Wanman supervisor with agents.json configured."
            />
          )}
          {(agents ?? []).map(agent => (
            <AgentCard
              key={agent.name}
              agent={agent}
              isSelected={agent.name === selectedName}
              onClick={() => setSelectedName(agent.name === selectedName ? null : agent.name)}
              activeTaskCount={activeTaskCount(tasks ?? [], agent.name)}
            />
          ))}
        </div>
      </div>

      {selectedWork && (
        <div className="w-1/2 overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-white sticky top-0 z-10">
            <span className="text-sm font-medium text-stone-700">Agent detail</span>
            <button
              onClick={() => setSelectedName(null)}
              className="text-stone-400 hover:text-stone-600 text-lg leading-none"
            >
              ×
            </button>
          </div>
          <AgentDetail work={selectedWork} artifactsUnavailable={artifactsUnavailable} />
        </div>
      )}
    </div>
  );
}
