import { useState } from 'react';
import { useThreads, useThread } from '../hooks/useWanman.js';
import { PageHeader } from '../components/Layout.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { LoadingRows, Spinner } from '../components/Spinner.js';
import { SendMessageModal } from '../components/SendMessageModal.js';
import { formatTime, formatDateTime, copyToClipboard } from '../lib/utils.js';
import type { Thread, ThreadMessage } from '@wanman/cockpit-client';

// ── Helpers ──

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p['message'] === 'string') return p['message'];
    if (typeof p['text'] === 'string') return p['text'];
    if (typeof p['summary'] === 'string') return p['summary'];
    return JSON.stringify(payload, null, 2);
  }
  return String(payload ?? '');
}

/** Extract task-id mentions from a payload string (full UUID or short 8-char). */
function extractTaskIds(payload: unknown): string[] {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const shortRe = /\b([0-9a-f]{8})\b/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = uuidRe.exec(text)) !== null) found.add(m[0]!.toLowerCase());
  while ((m = shortRe.exec(text)) !== null) found.add(m[1]!.toLowerCase());
  return Array.from(found).slice(0, 5);
}

// ── Thread list item ──

interface ThreadItemProps {
  thread: Thread;
  isSelected: boolean;
  onClick: () => void;
}

function ThreadItem({ thread, isSelected, onClick }: ThreadItemProps) {
  const preview = thread.lastMessage ? payloadText(thread.lastMessage.payload).slice(0, 90) : null;
  const fromHuman = thread.participants.includes('human');

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-stone-100 last:border-0 transition-colors ${
        isSelected ? 'bg-orange-50' : 'hover:bg-stone-50'
      } ${thread.pendingForHuman ? 'border-l-2 border-l-amber-400' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            {thread.participants.map(p => (
              <span
                key={p}
                className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                  p === 'human' ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-700'
                }`}
              >
                {p}
              </span>
            ))}
            {thread.pendingForHuman && (
              <span className="text-xs font-semibold text-amber-700">⬡ pending</span>
            )}
            {fromHuman && !thread.pendingForHuman && (
              <span className="text-xs text-stone-400">Human thread</span>
            )}
          </div>
          {preview && (
            <p className="text-xs text-stone-600 truncate leading-snug">{preview}</p>
          )}
        </div>
        <div className="text-right flex-shrink-0 space-y-0.5">
          <p className="text-xs text-stone-400">{thread.messageCount} msg{thread.messageCount !== 1 ? 's' : ''}</p>
          {thread.lastMessage && (
            <p className="text-xs text-stone-400">{formatTime(thread.lastMessage.timestamp)}</p>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Message bubble ──

interface MessageBubbleProps {
  msg: ThreadMessage;
  onTaskClick?: (id: string) => void;
}

function MessageBubble({ msg, onTaskClick }: MessageBubbleProps) {
  const isHumanBound = msg.to === 'human';
  const isFromHuman = msg.from === 'human';
  const text = payloadText(msg.payload);
  const taskIds = extractTaskIds(msg.payload);

  const typeColor =
    msg.type === 'decision' ? 'text-amber-700 bg-amber-50 border-amber-200' :
    msg.type === 'blocker' ? 'text-red-700 bg-red-50 border-red-200' :
    msg.type === 'access_request' ? 'text-purple-700 bg-purple-50 border-purple-200' :
    msg.type === 'decision_response' || msg.type === 'blocker_response' ? 'text-green-700 bg-green-50 border-green-200' :
    'text-stone-500 bg-stone-50 border-stone-200';

  return (
    <div className={`px-4 py-3 border-b border-stone-50 last:border-0 ${isHumanBound ? 'bg-amber-50/40' : isFromHuman ? 'bg-orange-50/30' : ''}`}>
      <div className="flex items-start gap-2">
        {/* Avatar */}
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${
          isFromHuman ? 'bg-orange-600 text-white' : 'bg-stone-200 text-stone-600'
        }`}>
          {msg.from.slice(0, 1).toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header line */}
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <span className="text-xs font-semibold text-stone-800">{msg.from}</span>
            <span className="text-xs text-stone-400">→</span>
            <span className={`text-xs font-medium ${msg.to === 'human' ? 'text-amber-700' : 'text-stone-600'}`}>{msg.to}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${typeColor}`}>{msg.type}</span>
            {msg.priority === 'steer' && (
              <span className="text-xs font-semibold text-red-600 bg-red-50 px-1 rounded border border-red-200">STEER</span>
            )}
            {!msg.delivered && (
              <span className="text-xs text-stone-400 italic">undelivered</span>
            )}
          </div>

          {/* Body */}
          {typeof msg.payload === 'object' && msg.payload !== null && JSON.stringify(msg.payload).length > 60 ? (
            <pre className="text-xs font-mono text-stone-700 whitespace-pre-wrap bg-stone-50 border border-stone-200 rounded p-2 max-h-40 overflow-y-auto mt-1">
              {text}
            </pre>
          ) : (
            <p className="text-sm text-stone-800 leading-snug">{text}</p>
          )}

          {/* Task links */}
          {taskIds.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {taskIds.map(tid => (
                <button
                  key={tid}
                  onClick={() => onTaskClick?.(tid)}
                  className="text-xs font-mono text-orange-600 hover:text-orange-800 bg-orange-50 border border-orange-100 px-1.5 py-0.5 rounded"
                >
                  task:{tid.slice(0, 8)}
                </button>
              ))}
            </div>
          )}

          {/* Timestamp */}
          <p className="text-xs text-stone-400 mt-1">{formatDateTime(msg.timestamp)}</p>
        </div>

        {/* Copy */}
        <button
          title="Copy payload"
          className="text-xs text-stone-300 hover:text-stone-600 flex-shrink-0 mt-0.5"
          onClick={() => copyToClipboard(text)}
        >
          ⎘
        </button>
      </div>
    </div>
  );
}

// ── Thread detail panel ──

interface ThreadDetailProps {
  threadId: string;
  onTaskClick?: (id: string) => void;
  onReply?: (threadId: string, participants: string[]) => void;
}

function ThreadDetail({ threadId, onTaskClick, onReply }: ThreadDetailProps) {
  const { data, isLoading, isError, error } = useThread(threadId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (isError) return <div className="p-4"><ErrorBanner error={error} title="Could not load thread" /></div>;
  if (!data) return <EmptyState title="Thread not found" />;

  const { thread, messages } = data;
  const canReply = thread.participants.some(p => p !== 'human');

  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="px-4 py-3 border-b border-stone-200 bg-white flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {thread.participants.map(p => (
              <span
                key={p}
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  p === 'human' ? 'bg-amber-100 text-amber-800' : 'bg-orange-100 text-orange-800'
                }`}
              >
                {p}
              </span>
            ))}
            <span className="text-xs text-stone-400">{messages.length} messages</span>
          </div>
          {canReply && (
            <button
              onClick={() => onReply?.(threadId, thread.participants)}
              className="text-xs font-medium text-orange-600 hover:text-orange-800 bg-orange-50 hover:bg-orange-100 border border-orange-200 px-2.5 py-1 rounded"
            >
              Reply ↩
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState title="No messages in this thread" />
        ) : (
          messages.map(msg => (
            <MessageBubble key={msg.id} msg={msg} onTaskClick={onTaskClick} />
          ))
        )}
      </div>
    </div>
  );
}

// ── Main Messages page ──

interface MessagesProps {
  onNavigateToTask?: (taskId: string) => void;
}

export function Messages({ onNavigateToTask }: MessagesProps) {
  const [filterHuman, setFilterHuman] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyModal, setReplyModal] = useState<{ to: string; threadId: string } | null>(null);

  const { data: threads, isLoading, isError, error } = useThreads({ humanOnly: filterHuman || undefined });

  const total = threads?.length ?? 0;
  const humanPending = threads?.filter(t => t.pendingForHuman).length ?? 0;

  function handleReply(threadId: string, participants: string[]) {
    const target = participants.find(p => p !== 'human') ?? participants[0] ?? '';
    setReplyModal({ to: target, threadId });
  }

  return (
    <div className="flex h-full">
      {/* Thread list */}
      <div className={`flex flex-col ${selectedId ? 'w-2/5' : 'w-full'} border-r border-stone-200`}>
        <PageHeader
          title="Conversations"
          subtitle={
            total === 0
              ? 'No threads'
              : `${total} thread${total !== 1 ? 's' : ''}${humanPending > 0 ? ` · ${humanPending} pending human` : ''}`
          }
        />

        {/* Filter bar */}
        <div className="flex items-center gap-1 px-4 py-2 bg-white border-b border-stone-200 flex-shrink-0">
          <button
            onClick={() => setFilterHuman(false)}
            className={`px-2.5 py-1 text-xs rounded-md font-medium ${
              !filterHuman ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFilterHuman(true)}
            className={`px-2.5 py-1 text-xs rounded-md font-medium flex items-center gap-1 ${
              filterHuman ? 'bg-amber-600 text-white' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            <span>⬡</span> Human
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-white">
          {isLoading && !threads && <LoadingRows count={4} />}

          {isError && (
            <div className="p-4">
              <ErrorBanner error={error} title="Could not load threads" />
            </div>
          )}

          {!isLoading && !isError && total === 0 && (
            <div className="p-6">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 mb-6">
                <p className="font-semibold text-amber-800">Read-only endpoint enabled</p>
                <p className="mt-1.5 text-sm text-amber-700 leading-relaxed">
                  Threads are populated via the{' '}
                  <code className="font-mono bg-amber-100 px-1 rounded text-xs">thread.list</code> /{' '}
                  <code className="font-mono bg-amber-100 px-1 rounded text-xs">thread.get</code>{' '}
                  RPCs. These read the{' '}
                  <code className="font-mono bg-amber-100 px-1 rounded text-xs">messages</code> table
                  non-destructively — <code className="font-mono bg-amber-100 px-1 rounded text-xs">agent.recv</code> is never called.
                </p>
              </div>
              <EmptyState
                title="No message threads yet"
                description="Threads appear as agents exchange messages. Human-bound messages also appear here."
                icon="◇"
              />
            </div>
          )}

          {(threads ?? []).map(thread => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              isSelected={thread.id === selectedId}
              onClick={() => setSelectedId(thread.id === selectedId ? null : thread.id)}
            />
          ))}
        </div>
      </div>

      {/* Thread detail */}
      {selectedId && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-white sticky top-0 z-10 flex-shrink-0">
            <span className="text-sm font-medium text-stone-700">Thread</span>
            <button
              onClick={() => setSelectedId(null)}
              className="text-stone-400 hover:text-stone-600 text-lg leading-none"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <ThreadDetail
              threadId={selectedId}
              onTaskClick={onNavigateToTask}
              onReply={handleReply}
            />
          </div>
        </div>
      )}

      {/* Reply modal */}
      {replyModal && (
        <SendMessageModal
          to={replyModal.to}
          relatedThreadId={replyModal.threadId}
          title={`Reply to ${replyModal.to}`}
          onClose={() => setReplyModal(null)}
        />
      )}
    </div>
  );
}
