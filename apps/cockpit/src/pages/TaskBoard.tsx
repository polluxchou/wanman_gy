import { useEffect, useState } from 'react';
import type {
  FormEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import {
  useAgents,
  useArtifactsForTask,
  useAssignTask,
  useCreateTask,
  useMarkTaskComplete,
  useReturnTaskForRevision,
  useTask,
  useTasks,
  useThreads,
  useUpdateTask,
} from '../hooks/useWanman.js';
import { PageHeader } from '../components/Layout.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { LoadingRows } from '../components/Spinner.js';
import { extractFilePaths, copyToClipboard } from '../lib/utils.js';
import {
  agentAssignmentWarning,
  isBrainAbsentError,
  isTaskTransitionAllowed,
  nextTaskStatuses,
  validateMarkComplete,
  validateReturnForRevision,
  validateTaskCreate,
} from '@wanman/cockpit-client';
import type { Agent, Artifact, Task, TaskScopeType, TaskStatus } from '@wanman/cockpit-client';

const STATUS_ORDER: TaskStatus[] = [
  'in_progress',
  'assigned',
  'review',
  'blocked',
  'pending',
  'failed',
  'done',
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: 'In Progress',
  assigned: 'Assigned',
  review: 'Review',
  blocked: 'Blocked',
  pending: 'Pending',
  failed: 'Failed',
  done: 'Done',
};

const SCOPE_TYPES: TaskScopeType[] = ['code', 'docs', 'tests', 'ops', 'mixed'];

interface TaskCardProps {
  task: Task;
  isSelected: boolean;
  onClick: () => void;
}

const STATUS_DOT: Record<TaskStatus, string> = {
  in_progress: 'bg-amber-400',
  assigned:    'bg-orange-400',
  review:      'bg-yellow-500',
  done:        'bg-emerald-500',
  failed:      'bg-red-500',
  blocked:     'bg-red-400',
  pending:     'bg-stone-300',
};

function TaskCard({ task, isSelected, onClick }: TaskCardProps) {
  const preview = (task.description || task.result || '').slice(0, 90);
  const previewText = preview.length < (task.description || task.result || '').length
    ? preview + '…'
    : preview;
  const dateLabel = task.updatedAt > 0
    ? new Date(task.updatedAt).toLocaleDateString()
    : null;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3.5 rounded-lg border transition-all ${
        isSelected
          ? 'bg-amber-100 border-amber-400 shadow-md ring-1 ring-amber-300'
          : 'bg-amber-50 border-amber-200 hover:border-amber-300 hover:shadow-sm'
      }`}
    >
      {/* Top row: tags left, status right */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {task.scopeType && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/80 border border-amber-200 text-amber-800 leading-none">
              {task.scopeType}
            </span>
          )}
          {task.assignee && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/80 border border-stone-200 text-stone-600 leading-none max-w-[72px] truncate">
              {task.assignee}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[task.status] ?? 'bg-stone-300'}`} />
          <span className="text-[10px] text-stone-500 whitespace-nowrap">{task.status.replace('_', ' ')}</span>
        </div>
      </div>

      {/* Title */}
      <p className="text-sm font-semibold text-stone-900 leading-snug mb-2 line-clamp-2">
        {task.title}
      </p>

      {/* Preview */}
      {previewText && (
        <p className="text-xs text-stone-500 leading-relaxed mb-2.5 line-clamp-2">
          {previewText}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-stone-400">{task.shortId}</span>
        <div className="flex items-center gap-2">
          {task.priority >= 7 && (
            <span className="text-[10px] font-semibold text-red-500">P{task.priority}</span>
          )}
          {dateLabel && <span className="text-[10px] text-stone-400">{dateLabel}</span>}
        </div>
      </div>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-stone-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full text-sm px-3 py-2 border border-stone-300 rounded focus:outline-none focus:ring-2 focus:ring-orange-300 ${props.className ?? ''}`}
    />
  );
}

function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full text-sm px-3 py-2 border border-stone-300 rounded resize-none focus:outline-none focus:ring-2 focus:ring-orange-300 ${props.className ?? ''}`}
    />
  );
}

function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full text-sm px-3 py-2 border border-stone-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-orange-300 ${props.className ?? ''}`}
    />
  );
}

function parseLines(value: string): string[] {
  return value
    .split(/\n|,/)
    .map(part => part.trim())
    .filter(Boolean);
}

function OutputReferences({ text }: { text: string }) {
  const paths = extractFilePaths(text);
  if (paths.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Output References</p>
      <div className="space-y-0.5">
        {paths.map(p => (
          <div key={p} className="flex items-center gap-1">
            <span className="text-xs font-mono text-orange-700 bg-orange-50 border border-orange-100 px-2 py-0.5 rounded truncate flex-1">
              {p}
            </span>
            <button
              title="Copy path"
              className="text-xs text-stone-400 hover:text-stone-700 px-1 flex-shrink-0"
              onClick={() => copyToClipboard(p)}
            >
              Copy
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateTaskModal({
  agents,
  onClose,
  onCreated,
}: {
  agents: Agent[];
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const createTask = useCreateTask();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(5);
  const [paths, setPaths] = useState('');
  const [patterns, setPatterns] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  const [initiativeId, setInitiativeId] = useState('');
  const [capsuleId, setCapsuleId] = useState('');
  const [subsystem, setSubsystem] = useState('');
  const [scopeType, setScopeType] = useState<TaskScopeType>('mixed');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedAgent = agents.find(agent => agent.name === assignee);
  const assignmentWarning = agentAssignmentWarning(selectedAgent);
  const scope = { paths: parseLines(paths), patterns: parseLines(patterns) };
  const scopeWarning = validateTaskCreate({ title: title || 'draft', scopeType, scope });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitError(null);
    if (!title.trim()) {
      setSubmitError('Task title is required.');
      return;
    }
    createTask.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        assignee: assignee || undefined,
        priority,
        scope,
        dependsOn: parseLines(dependsOn),
        initiativeId: initiativeId.trim() || undefined,
        capsuleId: capsuleId.trim() || undefined,
        subsystem: subsystem.trim() || undefined,
        scopeType,
      },
      {
        onSuccess: task => {
          onCreated(task);
          onClose();
        },
        onError: err => setSubmitError(err instanceof Error ? err.message : 'Task creation failed'),
      },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200 sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-stone-900">Create task</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg leading-none">x</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <Field label="Title">
            <TextInput value={title} onChange={event => setTitle(event.target.value)} placeholder="Task title" autoFocus />
          </Field>
          <Field label="Description">
            <TextArea value={description} onChange={event => setDescription(event.target.value)} rows={4} placeholder="What should the assignee do?" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Assignee">
              <Select value={assignee} onChange={event => setAssignee(event.target.value)}>
                <option value="">Unassigned</option>
                {agents.map(agent => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name} ({agent.state})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <TextInput type="number" min={1} max={10} value={priority} onChange={event => setPriority(Number(event.target.value))} />
            </Field>
            <Field label="Scope type">
              <Select value={scopeType} onChange={event => setScopeType(event.target.value as TaskScopeType)}>
                {SCOPE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </Select>
            </Field>
          </div>
          {assignmentWarning && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {assignmentWarning}
            </p>
          )}
          {scopeWarning && !scopeWarning.includes('required') && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              {scopeWarning}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scope paths">
              <TextArea value={paths} onChange={event => setPaths(event.target.value)} rows={3} placeholder="One path per line or comma-separated" />
            </Field>
            <Field label="Scope patterns">
              <TextArea value={patterns} onChange={event => setPatterns(event.target.value)} rows={3} placeholder="apps/cockpit/src/**/*.tsx" />
            </Field>
          </div>
          <Field label="Depends on tasks">
            <TextInput value={dependsOn} onChange={event => setDependsOn(event.target.value)} placeholder="Task ids, comma-separated" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Initiative ID">
              <TextInput value={initiativeId} onChange={event => setInitiativeId(event.target.value)} />
            </Field>
            <Field label="Capsule ID">
              <TextInput value={capsuleId} onChange={event => setCapsuleId(event.target.value)} />
            </Field>
            <Field label="Subsystem">
              <TextInput value={subsystem} onChange={event => setSubsystem(event.target.value)} />
            </Field>
          </div>
          {(submitError || createTask.error) && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {submitError ?? (createTask.error instanceof Error ? createTask.error.message : 'Task creation failed')}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900 rounded">
              Cancel
            </button>
            <button type="submit" disabled={createTask.isPending || !title.trim()} className="px-4 py-2 text-sm font-medium bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">
              {createTask.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TaskActions({
  task,
  agents,
  artifacts,
}: {
  task: Task;
  agents: Agent[];
  artifacts: Artifact[];
}) {
  const updateTask = useUpdateTask();
  const assignTask = useAssignTask();
  const completeTask = useMarkTaskComplete();
  const returnTask = useReturnTaskForRevision();
  const [assignee, setAssignee] = useState(task.assignee ?? '');
  const [result, setResult] = useState(task.result ?? '');
  const [revisionReason, setRevisionReason] = useState('');
  const [notifyAssignee, setNotifyAssignee] = useState(true);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>(artifacts.map(a => a.id));
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setAssignee(task.assignee ?? '');
    setResult(task.result ?? '');
  }, [task.assignee, task.id, task.result]);

  useEffect(() => {
    setSelectedArtifactIds(artifacts.map(a => a.id));
  }, [artifacts]);

  const selectedAgent = agents.find(agent => agent.name === assignee);
  const assignmentWarning = agentAssignmentWarning(selectedAgent);
  const transitionTargets = nextTaskStatuses(task.status).filter(status => status !== 'failed');
  const canFail = ['pending', 'assigned', 'in_progress', 'review'].includes(task.status);

  function runMutation(mutate: () => void) {
    setActionError(null);
    mutate();
  }

  return (
    <div className="space-y-4 border-t border-stone-200 pt-4">
      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">Operations</p>
        <div className="flex flex-wrap gap-2">
          {transitionTargets.map(next => (
            <button
              key={next}
              onClick={() => runMutation(() => updateTask.mutate(
                { id: task.id, status: next },
                { onError: err => setActionError(err instanceof Error ? err.message : 'Task update failed') },
              ))}
              disabled={updateTask.isPending || !isTaskTransitionAllowed(task.status, next)}
              className="px-3 py-1.5 text-xs font-medium rounded bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-50"
            >
              Move to {STATUS_LABELS[next]}
            </button>
          ))}
          {canFail && (
            <button
              onClick={() => {
                if (!window.confirm('Mark this task failed?')) return;
                runMutation(() => updateTask.mutate(
                  { id: task.id, status: 'failed' },
                  { onError: err => setActionError(err instanceof Error ? err.message : 'Task update failed') },
                ));
              }}
              className="px-3 py-1.5 text-xs font-medium rounded border border-red-200 text-red-700 hover:bg-red-50"
            >
              Mark failed
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <Field label="Assign or reassign">
          <Select value={assignee} onChange={event => setAssignee(event.target.value)}>
            <option value="">Unassigned</option>
            {agents.map(agent => (
              <option key={agent.name} value={agent.name}>{agent.name} ({agent.state})</option>
            ))}
          </Select>
        </Field>
        <button
          onClick={() => runMutation(() => assignTask.mutate(
            { taskId: task.id, assignee },
            { onError: err => setActionError(err instanceof Error ? err.message : 'Assignment failed') },
          ))}
          disabled={!assignee || assignee === task.assignee || assignTask.isPending}
          className="px-3 py-2 text-xs font-medium rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
        >
          Assign
        </button>
      </div>
      {assignmentWarning && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          {assignmentWarning}
        </p>
      )}

      {task.status === 'review' && (
        <div className="space-y-3">
          <Field label="Result summary">
            <TextArea value={result} onChange={event => setResult(event.target.value)} rows={4} />
          </Field>
          {artifacts.length > 0 && (
            <div>
              <p className="text-xs font-medium text-stone-600 mb-1">Reference artifacts</p>
              <div className="space-y-1 max-h-28 overflow-y-auto border border-stone-200 rounded p-2">
                {artifacts.map(artifact => (
                  <label key={artifact.id} className="flex items-center gap-2 text-xs text-stone-700">
                    <input
                      type="checkbox"
                      checked={selectedArtifactIds.includes(artifact.id)}
                      onChange={event => {
                        setSelectedArtifactIds(current =>
                          event.target.checked
                            ? Array.from(new Set([...current, artifact.id]))
                            : current.filter(id => id !== artifact.id),
                        );
                      }}
                    />
                    <span className="font-mono">{artifact.id}</span>
                    <span className="truncate">{artifact.path ?? artifact.kind}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                const validation = validateMarkComplete(result);
                if (validation) {
                  setActionError(validation);
                  return;
                }
                runMutation(() => completeTask.mutate(
                  { taskId: task.id, result, artifactIds: selectedArtifactIds },
                  { onError: err => setActionError(err instanceof Error ? err.message : 'Mark complete failed') },
                ));
              }}
              className="px-3 py-1.5 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700"
            >
              Mark complete
            </button>
          </div>
          <Field label="Return for revision reason">
            <TextArea value={revisionReason} onChange={event => setRevisionReason(event.target.value)} rows={3} />
          </Field>
          <label className="flex items-center gap-2 text-xs text-stone-600">
            <input type="checkbox" checked={notifyAssignee} onChange={event => setNotifyAssignee(event.target.checked)} />
            Notify assignee when Stage 2 messaging is available
          </label>
          <button
            onClick={() => {
              const validation = validateReturnForRevision(revisionReason);
              if (validation) {
                setActionError(validation);
                return;
              }
              runMutation(() => returnTask.mutate(
                { taskId: task.id, assignee: task.assignee, reason: revisionReason, notifyAssignee },
                { onError: err => setActionError(err instanceof Error ? err.message : 'Return for revision failed') },
              ));
            }}
            className="px-3 py-1.5 text-xs font-medium rounded border border-amber-300 text-amber-800 hover:bg-amber-50"
          >
            Return for revision
          </button>
        </div>
      )}

      {(actionError || updateTask.error || assignTask.error || completeTask.error || returnTask.error) && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {actionError ??
            (updateTask.error instanceof Error ? updateTask.error.message : null) ??
            (assignTask.error instanceof Error ? assignTask.error.message : null) ??
            (completeTask.error instanceof Error ? completeTask.error.message : null) ??
            (returnTask.error instanceof Error ? returnTask.error.message : 'Task operation failed')}
        </p>
      )}
    </div>
  );
}

function TaskDetail({ taskId }: { taskId: string }) {
  const { data: task, isLoading, isError, error } = useTask(taskId);
  const { data: agents } = useAgents();
  const artifactsQuery = useArtifactsForTask(taskId);
  const { data: threads } = useThreads({ taskId });

  if (isLoading) return <LoadingRows count={3} />;
  if (isError) return <ErrorBanner error={error} />;
  if (!task) return <EmptyState title="Task not found" />;

  const artifacts = artifactsQuery.data ?? [];
  const brainAbsent = artifactsQuery.isError && isBrainAbsentError(artifactsQuery.error);

  return (
    <div className="p-5 space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="font-mono text-xs text-stone-400">{task.shortId}</span>
          <StatusBadge status={task.status} />
          <span className="text-xs font-mono text-stone-400 break-all">{task.id}</span>
        </div>
        <h2 className="text-base font-semibold text-stone-900">{task.title}</h2>
      </div>

      <TaskActions task={task} agents={agents ?? []} artifacts={artifacts} />

      {task.description && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Description</p>
          <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{task.description}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <Info label="Assignee" value={task.assignee ?? '-'} />
        <Info label="Priority" value={String(task.priority)} />
        <Info label="Scope type" value={task.scopeType ?? '-'} />
        <Info label="Subsystem" value={task.subsystem ?? '-'} />
        <Info label="Initiative" value={task.initiativeId ?? '-'} mono />
        <Info label="Capsule" value={task.capsuleId ?? '-'} mono />
      </div>

      {task.scope && ((task.scope.paths?.length ?? 0) > 0 || (task.scope.patterns?.length ?? 0) > 0) && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Scope</p>
          <div className="space-y-0.5">
            {(task.scope.paths ?? []).map(p => (
              <p key={p} className="text-xs font-mono text-stone-600 bg-stone-100 px-2 py-1 rounded">{p}</p>
            ))}
            {(task.scope.patterns ?? []).map(p => (
              <p key={p} className="text-xs font-mono text-orange-700 bg-orange-50 px-2 py-1 rounded">{p}</p>
            ))}
          </div>
        </div>
      )}

      {task.dependsOn.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Dependencies</p>
          <div className="space-y-0.5">
            {task.dependsOn.map(dep => (
              <p key={dep} className="text-xs font-mono text-stone-600 bg-stone-100 px-2 py-1 rounded">{dep}</p>
            ))}
          </div>
        </div>
      )}

      {task.result && (
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Result</p>
          <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap bg-stone-50 border border-stone-200 rounded p-3 max-h-48 overflow-y-auto">
            {task.result}
          </p>
        </div>
      )}

      {task.result && <OutputReferences text={task.result} />}

      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">Related artifacts</p>
        {brainAbsent ? (
          <p className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded px-3 py-2">
            Artifact brain is not configured, so artifact links cannot be loaded.
          </p>
        ) : artifactsQuery.isError ? (
          <ErrorBanner error={artifactsQuery.error} title="Could not load related artifacts" />
        ) : artifacts.length === 0 ? (
          <p className="text-xs text-stone-500">No direct artifact metadata link was found. The cockpit also checks artifact paths against task scope and result text.</p>
        ) : (
          <div className="space-y-1">
            {artifacts.map(artifact => (
              <div key={artifact.id} className="flex items-center gap-2 px-3 py-2 bg-stone-50 border border-stone-100 rounded">
                <span className="text-xs font-mono text-stone-500">{artifact.id}</span>
                <span className="text-xs text-stone-600">{artifact.kind}</span>
                <span className="text-xs font-mono text-stone-700 truncate flex-1">{artifact.path ?? 'no path'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">Related threads</p>
        {(threads ?? []).length === 0 ? (
          <p className="text-xs text-stone-500">No Stage 2 thread messages mention this task yet.</p>
        ) : (
          <div className="space-y-1">
            {(threads ?? []).map(thread => (
              <div key={thread.id} className="px-3 py-2 bg-stone-50 border border-stone-100 rounded">
                <p className="text-xs font-mono text-stone-700">{thread.id}</p>
                <p className="text-xs text-stone-500">{thread.messageCount} messages</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-stone-400 space-y-0.5">
        <p>Created: {task.createdAt > 0 ? new Date(task.createdAt).toLocaleString() : '-'}</p>
        <p>Updated: {task.updatedAt > 0 ? new Date(task.updatedAt).toLocaleString() : '-'}</p>
      </div>
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-stone-500 mb-0.5">{label}</p>
      <p className={`font-medium text-stone-800 break-all ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

export function TaskBoard() {
  const { data: tasks, isLoading, isError, error } = useTasks();
  const { data: agents } = useAgents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<TaskStatus | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const filtered =
    filterStatus === 'all'
      ? (tasks ?? [])
      : (tasks ?? []).filter(t => t.status === filterStatus);

  const total = tasks?.length ?? 0;

  return (
    <div className="flex h-full">
      <div className={`flex flex-col ${selectedId ? 'w-1/2' : 'w-full'} border-r border-stone-200`}>
        <PageHeader
          title="Tasks"
          subtitle={`${total} task${total !== 1 ? 's' : ''}`}
          actions={
            <button
              onClick={() => setShowCreate(true)}
              className="px-3 py-1.5 text-xs font-medium rounded bg-orange-600 text-white hover:bg-orange-700"
            >
              New task
            </button>
          }
        />

        <div className="flex items-center gap-1 px-4 py-2.5 bg-white border-b border-stone-200 overflow-x-auto flex-shrink-0">
          <div className="flex items-center bg-stone-100 rounded-full p-0.5 gap-0.5">
            <button
              onClick={() => setFilterStatus('all')}
              className={`px-3 py-1 text-xs rounded-full font-medium whitespace-nowrap transition-all ${
                filterStatus === 'all'
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              All {total > 0 && <span className="text-stone-400 ml-0.5">{total}</span>}
            </button>
            {STATUS_ORDER.map(status => {
              const count = (tasks ?? []).filter(t => t.status === status).length;
              if (count === 0) return null;
              return (
                <button
                  key={status}
                  onClick={() => setFilterStatus(status)}
                  className={`px-3 py-1 text-xs rounded-full font-medium whitespace-nowrap transition-all ${
                    filterStatus === status
                      ? 'bg-white text-stone-900 shadow-sm'
                      : 'text-stone-500 hover:text-stone-700'
                  }`}
                >
                  {STATUS_LABELS[status]} <span className="text-stone-400 ml-0.5">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && !tasks && <LoadingRows />}
          {isError && (
            <div className="mb-4">
              <ErrorBanner error={error} title="Could not load tasks" />
            </div>
          )}
          {!isLoading && filtered.length === 0 && (
            <EmptyState title="No tasks" description="Create a task from the workbench or wait for agents to add work." />
          )}
          <div className={`grid gap-3 ${selectedId ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'}`}>
            {filtered.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                isSelected={task.id === selectedId}
                onClick={() => setSelectedId(task.id === selectedId ? null : task.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {selectedId && (
        <div className="w-1/2 overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-white sticky top-0 z-10">
            <span className="text-sm font-medium text-stone-700">Task workbench</span>
            <button onClick={() => setSelectedId(null)} className="text-stone-400 hover:text-stone-600 text-lg leading-none">
              x
            </button>
          </div>
          <TaskDetail taskId={selectedId} />
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          agents={agents ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={task => setSelectedId(task.id)}
        />
      )}
    </div>
  );
}
