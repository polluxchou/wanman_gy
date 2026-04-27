import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useArtifact, useArtifacts, useReviewArtifact, useTasks } from '../hooks/useWanman.js';
import { PageHeader } from '../components/Layout.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { LoadingRows, Spinner } from '../components/Spinner.js';
import { artifactPreviewMode, isBrainAbsentError } from '@wanman/cockpit-client';
import type { Artifact, ArtifactReviewStatus, Task } from '@wanman/cockpit-client';

interface LocalReview {
  status: ArtifactReviewStatus;
  note?: string;
}

function ArtifactRow({
  artifact,
  isSelected,
  localReview,
  onClick,
}: {
  artifact: Artifact;
  isSelected: boolean;
  localReview?: LocalReview;
  onClick: () => void;
}) {
  const reviewStatus = localReview?.status ?? artifact.reviewStatus;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-stone-100 last:border-0 transition-colors ${
        isSelected ? 'bg-orange-50' : 'hover:bg-stone-50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-medium bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">
              {artifact.kind}
            </span>
            <span className="text-xs text-stone-400">{artifact.agent}</span>
            {artifact.verified && <StatusBadge status="ok" label="verified" />}
            {reviewStatus && (
              <StatusBadge
                status={reviewStatus === 'accepted' ? 'done' : 'review'}
                label={reviewStatus === 'accepted' ? 'accepted' : 'revision needed'}
              />
            )}
          </div>
          {artifact.path ? (
            <p className="text-sm font-mono text-stone-700 truncate">{artifact.path}</p>
          ) : (
            <p className="text-sm text-stone-500 italic">no path</p>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          {artifact.confidence > 0 && (
            <p className="text-xs text-stone-500">{Math.round(artifact.confidence * 100)}% confidence</p>
          )}
          {artifact.contentLength !== null && (
            <p className="text-xs text-stone-400">{artifact.contentLength} chars</p>
          )}
        </div>
      </div>
      {artifact.createdAt > 0 && (
        <p className="text-xs text-stone-400 mt-1">{new Date(artifact.createdAt).toLocaleString()}</p>
      )}
    </button>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  let code: string[] = [];
  let inCode = false;

  function flushCode(key: string) {
    if (code.length === 0) return;
    nodes.push(
      <pre key={key} className="text-xs font-mono bg-slate-950 text-stone-100 rounded p-3 overflow-x-auto">
        {code.join('\n')}
      </pre>,
    );
    code = [];
  }

  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (inCode) flushCode(`code-${index}`);
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const className =
        level === 1
          ? 'text-lg font-semibold text-stone-900 mt-3'
          : level === 2
            ? 'text-base font-semibold text-stone-900 mt-3'
            : 'text-sm font-semibold text-stone-800 mt-2';
      nodes.push(<p key={index} className={className}>{text}</p>);
      return;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      nodes.push(<p key={index} className="text-sm text-stone-700 pl-4">- {line.replace(/^\s*[-*]\s+/, '')}</p>);
      return;
    }
    if (line.trim() === '') {
      nodes.push(<div key={index} className="h-2" />);
      return;
    }
    nodes.push(<p key={index} className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{line}</p>);
  });
  flushCode('code-final');
  return <div className="space-y-1">{nodes}</div>;
}

function TextDiff({ current, previous }: { current: string; previous: string }) {
  const currentLines = current.split('\n');
  const previousLines = previous.split('\n');
  const max = Math.max(currentLines.length, previousLines.length);
  const rows = Array.from({ length: max }, (_, index) => ({
    before: previousLines[index] ?? '',
    after: currentLines[index] ?? '',
    changed: (previousLines[index] ?? '') !== (currentLines[index] ?? ''),
  }));

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Previous</p>
        <pre className="text-xs font-mono bg-stone-50 border border-stone-200 rounded p-3 max-h-96 overflow-auto">
          {rows.map((row, index) => (
            <span key={index} className={row.changed ? 'block bg-red-50 text-red-800' : 'block text-stone-600'}>
              {row.before || ' '}
            </span>
          ))}
        </pre>
      </div>
      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Selected</p>
        <pre className="text-xs font-mono bg-stone-50 border border-stone-200 rounded p-3 max-h-96 overflow-auto">
          {rows.map((row, index) => (
            <span key={index} className={row.changed ? 'block bg-emerald-50 text-emerald-800' : 'block text-stone-600'}>
              {row.after || ' '}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

function ArtifactPreview({
  artifactId,
  artifacts,
  tasks,
  localReview,
  onReview,
}: {
  artifactId: string;
  artifacts: Artifact[];
  tasks: Task[];
  localReview?: LocalReview;
  onReview: (status: ArtifactReviewStatus, note: string) => void;
}) {
  const { data: artifact, isLoading, isError, error } = useArtifact(artifactId);
  const [compareId, setCompareId] = useState('');
  const [reviewNote, setReviewNote] = useState(localReview?.note ?? '');
  const reviewMutation = useReviewArtifact();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (isError) return <div className="p-4"><ErrorBanner error={error} /></div>;
  if (!artifact) return <EmptyState title="Artifact not found" />;

  const mode = artifactPreviewMode(artifact);
  const relatedTask = tasks.find(task =>
    artifact.taskId === task.id ||
    (artifact.taskId ? task.id.startsWith(artifact.taskId) : false) ||
    (artifact.path ? task.result?.includes(artifact.path) || task.scope?.paths?.includes(artifact.path) : false),
  );
  const comparable = artifacts
    .filter(item => item.id !== artifact.id && item.path && item.path === artifact.path)
    .sort((a, b) => b.createdAt - a.createdAt);
  const compareArtifact = artifacts.find(item => item.id === compareId);
  const reviewStatus = localReview?.status ?? artifact.reviewStatus ?? null;
  const currentArtifactId = artifact.id;

  function markReview(status: ArtifactReviewStatus) {
    onReview(status, reviewNote.trim());
    reviewMutation.mutate({ artifactId: currentArtifactId, status, note: reviewNote.trim(), relatedTaskId: relatedTask?.id });
  }

  return (
    <div className="p-5 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-xs font-medium bg-stone-100 text-stone-600 px-1.5 py-0.5 rounded">{artifact.kind}</span>
          <span className="text-xs text-stone-500">{artifact.agent}</span>
          {artifact.verified && <StatusBadge status="ok" label="verified" />}
          {reviewStatus && (
            <StatusBadge
              status={reviewStatus === 'accepted' ? 'done' : 'review'}
              label={reviewStatus === 'accepted' ? 'accepted' : 'revision needed'}
            />
          )}
        </div>
        {artifact.path && <p className="text-sm font-mono text-stone-700 break-all">{artifact.path}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Info label="Producing agent" value={artifact.agent} />
        <Info label="Kind" value={artifact.kind} />
        <Info label="Related task" value={relatedTask ? `${relatedTask.shortId} ${relatedTask.title}` : artifact.taskId ?? 'best-effort only'} />
        <Info label="Output reference" value={artifact.path ?? '-'} mono />
        {artifact.confidence > 0 && <Info label="Confidence" value={`${Math.round(artifact.confidence * 100)}%`} />}
        {artifact.createdAt > 0 && <Info label="Created" value={new Date(artifact.createdAt).toLocaleString()} />}
      </div>

      {Object.keys(artifact.metadata).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Metadata</p>
          <pre className="text-xs font-mono bg-stone-50 border border-stone-200 rounded p-3 overflow-x-auto max-h-32">
            {JSON.stringify(artifact.metadata, null, 2)}
          </pre>
        </div>
      )}

      <div className="border-t border-stone-200 pt-4 space-y-3">
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Review</p>
        <textarea
          value={reviewNote}
          onChange={event => setReviewNote(event.target.value)}
          rows={3}
          placeholder="Review note"
          className="w-full text-sm px-3 py-2 border border-stone-300 rounded resize-none focus:outline-none focus:ring-2 focus:ring-orange-300"
        />
        <div className="flex flex-wrap gap-2">
          <button onClick={() => markReview('accepted')} className="px-3 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700">
            Accept artifact
          </button>
          <button onClick={() => markReview('revision_needed')} className="px-3 py-1.5 text-xs font-medium rounded border border-amber-300 text-amber-800 hover:bg-amber-50">
            Needs revision
          </button>
        </div>
        <p className="text-xs text-stone-500">
          Review status is stored in this browser session only. Runtime artifact metadata updates need a future artifact.updateMetadata RPC.
        </p>
      </div>

      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
          Content {mode === 'markdown' && <span className="text-stone-400">(Markdown)</span>}
        </p>
        {mode === 'missing' ? (
          <EmptyState title="Content unavailable" description="The artifact row exists, but the brain did not return content for this artifact." />
        ) : mode === 'markdown' ? (
          <div className="bg-white border border-stone-200 rounded p-4 max-h-[34rem] overflow-y-auto">
            <MarkdownPreview content={artifact.content ?? ''} />
          </div>
        ) : (
          <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono bg-stone-50 border border-stone-200 rounded p-3 max-h-[34rem] overflow-y-auto">
            {artifact.content}
          </pre>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Compare</p>
        {comparable.length === 0 ? (
          <p className="text-xs text-stone-500">No prior artifact with the same path is available for comparison.</p>
        ) : (
          <div className="space-y-3">
            <select
              value={compareId}
              onChange={event => setCompareId(event.target.value)}
              className="w-full text-sm px-3 py-2 border border-stone-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-orange-300"
            >
              <option value="">Select prior artifact</option>
              {comparable.map(item => (
                <option key={item.id} value={item.id}>
                  #{item.id} {item.createdAt > 0 ? new Date(item.createdAt).toLocaleString() : item.kind}
                </option>
              ))}
            </select>
            {compareArtifact?.content && artifact.content && (
              <TextDiff previous={compareArtifact.content} current={artifact.content} />
            )}
            {compareArtifact && !compareArtifact.content && (
              <p className="text-xs text-stone-500">The comparison artifact has no loaded content.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-stone-500">{label}</p>
      <p className={`font-medium text-stone-800 break-all ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

export function Artifacts() {
  const { data: artifacts, isLoading, isError, error } = useArtifacts();
  const { data: tasks } = useTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [reviews, setReviews] = useState<Record<string, LocalReview>>({});

  const brainAbsent = isError && isBrainAbsentError(error);
  const artifactList = artifacts ?? [];
  const kinds = Array.from(new Set(artifactList.map(a => a.kind))).sort();
  const filtered = useMemo(
    () => kindFilter === 'all' ? artifactList : artifactList.filter(a => a.kind === kindFilter),
    [artifactList, kindFilter],
  );
  const hasArtifacts = !isLoading && !isError && filtered.length > 0;
  const noArtifactsYet = !isLoading && !isError && !brainAbsent && artifactList.length === 0;

  return (
    <div className="flex h-full">
      <div className={`flex flex-col ${selectedId ? 'w-1/2' : 'w-full'} border-r border-stone-200`}>
        <PageHeader title="Artifacts" subtitle={`${filtered.length} artifact${filtered.length !== 1 ? 's' : ''}`} />

        {kinds.length > 0 && (
          <div className="flex items-center gap-1 px-4 py-2 bg-white border-b border-stone-200 overflow-x-auto flex-shrink-0">
            <button
              onClick={() => setKindFilter('all')}
              className={`px-2.5 py-1 text-xs rounded-md font-medium ${kindFilter === 'all' ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
            >
              All
            </button>
            {kinds.map(k => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={`px-2.5 py-1 text-xs rounded-md font-medium ${kindFilter === k ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
              >
                {k}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto bg-white">
          {isLoading && !artifacts && <LoadingRows />}

          {isError && !brainAbsent && (
            <div className="p-4">
              <ErrorBanner error={error} title="Could not load artifacts" />
            </div>
          )}

          {brainAbsent && (
            <div className="p-6">
              <div className="rounded border border-stone-200 bg-stone-50 px-5 py-4 mb-4">
                <p className="font-semibold text-stone-700">Artifact storage not configured</p>
                <p className="mt-1 text-sm text-stone-600 leading-relaxed">
                  Artifacts live in the optional db9 brain adapter. The supervisor was started without a brain config block, so review data is unavailable.
                </p>
              </div>
              <EmptyState title="Brain adapter not configured" description="Add a brain config block to agents.json to enable artifact storage." icon="◈" />
            </div>
          )}

          {noArtifactsYet && (
            <EmptyState title="No artifacts yet" description="Artifacts produced by agents will appear here once the brain adapter stores them." icon="◈" />
          )}

          {hasArtifacts && filtered.map((artifact: Artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              localReview={reviews[artifact.id]}
              isSelected={artifact.id === selectedId}
              onClick={() => setSelectedId(artifact.id === selectedId ? null : artifact.id)}
            />
          ))}
        </div>
      </div>

      {selectedId && (
        <div className="w-1/2 overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-white sticky top-0 z-10">
            <span className="text-sm font-medium text-stone-700">Artifact review</span>
            <button onClick={() => setSelectedId(null)} className="text-stone-400 hover:text-stone-600 text-lg leading-none">
              x
            </button>
          </div>
          <ArtifactPreview
            artifactId={selectedId}
            artifacts={artifactList}
            tasks={tasks ?? []}
            localReview={reviews[selectedId]}
            onReview={(status, note) => setReviews(current => ({ ...current, [selectedId]: { status, note } }))}
          />
        </div>
      )}
    </div>
  );
}
