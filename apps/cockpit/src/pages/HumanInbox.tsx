import { useState } from 'react';
import type { Page } from '../App.js';
import { useHumanActions, useMarkHumanActionHandled } from '../hooks/useWanman.js';
import { PageHeader } from '../components/Layout.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { LoadingRows } from '../components/Spinner.js';
import { SendMessageModal } from '../components/SendMessageModal.js';
import { formatTime } from '../lib/utils.js';
import type { HumanAction, HumanActionKind } from '@wanman/cockpit-client';

const KIND_LABELS: Record<HumanActionKind, string> = {
  agent_error: 'Agent Error',
  task_review: 'Review',
  blocker: 'Blocked',
  decision: 'Decision',
  access_request: 'Access Request',
};

const KIND_ICONS: Record<HumanActionKind, string> = {
  agent_error: '⚠',
  task_review: '◎',
  blocker: '⬡',
  decision: '◇',
  access_request: '△',
};

const KIND_COLORS: Record<HumanActionKind, string> = {
  agent_error: 'border-l-red-500 bg-red-50',
  task_review: 'border-l-amber-400 bg-amber-50',
  blocker: 'border-l-orange-400 bg-orange-50',
  decision: 'border-l-blue-400 bg-blue-50',
  access_request: 'border-l-purple-400 bg-purple-50',
};

// ── Can this item be replied to via agent.send? ──
function canReply(action: HumanAction): boolean {
  return (
    (action.kind === 'decision' || action.kind === 'blocker' || action.kind === 'access_request') &&
    !!action.relatedAgent
  );
}

// ── Can this item be acknowledged via human.ack? ──
function canAck(action: HumanAction): boolean {
  return action.id.startsWith('human_inbox:');
}

// ── Action card ──

interface ActionCardProps {
  action: HumanAction;
  onNavigateToTask?: () => void;
  onNavigateToAgent?: () => void;
  onNavigateToMessages?: () => void;
  onReply?: () => void;
  onAck?: () => void;
  isAcking?: boolean;
}

function ActionCard({
  action,
  onNavigateToTask,
  onNavigateToAgent,
  onNavigateToMessages,
  onReply,
  onAck,
  isAcking,
}: ActionCardProps) {
  const isPriority = action.priority === 'steer';
  const colorClass = KIND_COLORS[action.kind];

  return (
    <div
      className={`px-4 py-4 border-b border-stone-100 last:border-0 border-l-2 ${colorClass} ${
        action.handled ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`text-base flex-shrink-0 mt-0.5 ${
            isPriority ? 'text-red-500' : 'text-stone-500'
          }`}
        >
          {KIND_ICONS[action.kind]}
        </span>
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <StatusBadge
              status={action.priority === 'steer' ? 'error' : action.kind === 'blocker' ? 'blocked' : 'review'}
              label={KIND_LABELS[action.kind]}
            />
            {isPriority && (
              <span className="text-xs font-semibold text-red-600 bg-red-50 px-1 rounded border border-red-200">STEER</span>
            )}
            {action.handled && (
              <span className="text-xs text-stone-400 italic">handled</span>
            )}
          </div>

          {/* Summary */}
          <p className="text-sm text-stone-800 leading-snug">{action.summary}</p>

          {/* Context links */}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {action.relatedAgent && (
              <button
                className="text-xs text-orange-600 hover:text-orange-800 font-medium"
                onClick={onNavigateToAgent}
              >
                Agent: {action.relatedAgent} →
              </button>
            )}
            {action.relatedTaskId && (
              <button
                className="text-xs text-orange-600 hover:text-orange-800 font-medium"
                onClick={onNavigateToTask}
              >
                Task: {action.relatedTaskId.slice(0, 8)} →
              </button>
            )}
            {action.relatedThreadId && (
              <button
                className="text-xs text-orange-600 hover:text-orange-800 font-medium"
                onClick={onNavigateToMessages}
              >
                Thread →
              </button>
            )}
            {action.createdAt > 0 && (
              <span className="text-xs text-stone-400">{formatTime(action.createdAt)}</span>
            )}
          </div>

          {/* Actions */}
          {!action.handled && (
            <div className="flex items-center gap-2 mt-2">
              {canReply(action) && (
                <button
                  onClick={onReply}
                  className="text-xs font-medium text-orange-700 hover:text-indigo-900 bg-orange-50 hover:bg-orange-100 border border-orange-200 px-2.5 py-1 rounded"
                >
                  Reply ↩
                </button>
              )}
              {canAck(action) && (
                <button
                  onClick={onAck}
                  disabled={isAcking}
                  className="text-xs font-medium text-stone-600 hover:text-stone-900 bg-white hover:bg-stone-100 border border-stone-200 px-2.5 py-1 rounded disabled:opacity-50"
                >
                  {isAcking ? 'Marking…' : '✓ Mark handled'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main HumanInbox ──

interface HumanInboxProps {
  onNavigate: (page: Page) => void;
}

export function HumanInbox({ onNavigate }: HumanInboxProps) {
  const [showHandled, setShowHandled] = useState(false);
  const [replyModal, setReplyModal] = useState<{ to: string; relatedTaskId?: string; relatedThreadId?: string } | null>(null);

  const { data: actions, isLoading, isError, error } = useHumanActions(
    showHandled ? { status: 'handled' } : { status: 'open' },
  );
  const { mutate: ack, variables: ackingId } = useMarkHumanActionHandled();

  const openActions = (actions ?? []).filter(a => !a.handled);
  const handledActions = (actions ?? []).filter(a => a.handled);
  const display = showHandled ? handledActions : openActions;

  const steerCount = openActions.filter(a => a.priority === 'steer').length;

  return (
    <div>
      <PageHeader
        title="Inbox"
        subtitle={
          openActions.length === 0
            ? 'All clear'
            : `${openActions.length} open · ${steerCount} high-priority`
        }
      />

      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-stone-200">
        <button
          onClick={() => setShowHandled(false)}
          className={`px-2.5 py-1 text-xs rounded-md font-medium ${
            !showHandled ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
          }`}
        >
          Open {openActions.length > 0 ? `(${openActions.length})` : ''}
        </button>
        <button
          onClick={() => setShowHandled(true)}
          className={`px-2.5 py-1 text-xs rounded-md font-medium ${
            showHandled ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
          }`}
        >
          Handled
        </button>
        <span className="text-xs text-stone-400 ml-auto italic">
          Derived items auto-resolve when state changes. Inbox messages are acknowledged manually.
        </span>
      </div>

      {openActions.length === 0 && !showHandled && !isLoading && !isError && (
        <div className="p-6">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4 mb-4">
            <p className="font-semibold text-emerald-700">All clear</p>
            <p className="mt-1 text-sm text-emerald-600">
              No agents in error state, no tasks awaiting review, and no blocked work detected.
            </p>
          </div>
          <EmptyState
            title="Nothing needs your attention"
            description="Items appear here when agents error, tasks need review, or agents send you decisions."
            icon="△"
          />
        </div>
      )}

      {showHandled && handledActions.length === 0 && !isLoading && (
        <div className="p-6">
          <EmptyState
            title="No handled items"
            description="Acknowledged inbox items will appear here."
            icon="✓"
          />
        </div>
      )}

      {isLoading && !actions && <LoadingRows count={3} />}

      {isError && (
        <div className="p-4">
          <ErrorBanner error={error} title="Could not load inbox" />
        </div>
      )}

      <div className="bg-white">
        {display.map(action => (
          <ActionCard
            key={action.id}
            action={action}
            isAcking={ackingId === action.id}
            onNavigateToTask={() => onNavigate('tasks')}
            onNavigateToAgent={() => onNavigate('agents')}
            onNavigateToMessages={() => onNavigate('messages')}
            onReply={() =>
              setReplyModal({
                to: action.relatedAgent ?? '',
                relatedTaskId: action.relatedTaskId ?? undefined,
                relatedThreadId: action.relatedThreadId ?? undefined,
              })
            }
            onAck={() => ack(action.id)}
          />
        ))}
      </div>

      {/* Reply modal */}
      {replyModal && (
        <SendMessageModal
          to={replyModal.to}
          type="decision_response"
          relatedTaskId={replyModal.relatedTaskId}
          relatedThreadId={replyModal.relatedThreadId}
          title={`Reply to ${replyModal.to}`}
          onClose={() => setReplyModal(null)}
        />
      )}
    </div>
  );
}
