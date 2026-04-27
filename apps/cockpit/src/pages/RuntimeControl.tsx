import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentLifecycle, AgentRosterDraft, AgentRuntime, TakeoverPreview } from '@wanman/cockpit-client';
import {
  validateAgentRosterDraft,
  validateGoal,
  validateProjectPath,
} from '@wanman/cockpit-client';
import {
  useAgentRosterDraft,
  useForkSession,
  useLogStatus,
  usePauseSupervisor,
  useResumeSupervisor,
  useRuntimeEventStream,
  useRuntimeEvents,
  useRuntimeReadiness,
  useRuntimeSessions,
  useRuntimeLogs,
  useRuntimeStatus,
  useStartRun,
  useStartTakeover,
  useStopSession,
  useTakeoverPreview,
} from '../hooks/useWanman.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { Spinner } from '../components/Spinner.js';

type Tab = 'run' | 'takeover' | 'roster' | 'sessions' | 'events' | 'logs';

const lifecycleOptions: AgentLifecycle[] = ['24/7', 'on-demand', 'idle_cached'];
const runtimeOptions: AgentRuntime[] = ['claude', 'codex'];

function PageHeader() {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold text-stone-900">Runtime Control</h1>
        <p className="text-sm text-stone-500">Local supervisor, run, takeover, roster, and logs.</p>
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }) {
  const classes = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    slate: 'bg-stone-50 text-stone-700 border-stone-200',
  };
  return <span className={`px-2 py-0.5 rounded border text-xs font-medium ${classes[tone]}`}>{label}</span>;
}

function FieldLabel({ children }: { children: string }) {
  return <label className="block text-xs font-medium text-stone-600 mb-1">{children}</label>;
}

function asError(error: unknown): string | null {
  return error instanceof Error ? error.message : error ? String(error) : null;
}

function safeNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function RuntimeControl() {
  const [tab, setTab] = useState<Tab>('run');
  const [runtime, setRuntime] = useState<AgentRuntime>('claude');
  const [goal, setGoal] = useState('');
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState<'low' | 'medium' | 'high' | 'xhigh'>('medium');
  const [loopMode, setLoopMode] = useState<'finite' | 'infinite'>('finite');
  const [loops, setLoops] = useState('100');
  const [pollInterval, setPollInterval] = useState('15');
  const [errorLimit, setErrorLimit] = useState('20');
  const [outputDir, setOutputDir] = useState('.wanman/cockpit-runs');
  const [projectPath, setProjectPath] = useState('');
  const [takeoverDryRun, setTakeoverDryRun] = useState(true);
  const [takeoverNoBrain, setTakeoverNoBrain] = useState(false);
  const [takeoverPreview, setTakeoverPreview] = useState<TakeoverPreview | null>(null);
  const [roster, setRoster] = useState<AgentRosterDraft | null>(null);
  const [logLevel, setLogLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [eventType, setEventType] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const status = useRuntimeStatus();
  const { streamStatus } = useRuntimeEventStream();
  const logStatusQuery = useLogStatus();
  const forkSession = useForkSession();
  const draftQuery = useAgentRosterDraft({ runtime, goal });
  const logsQuery = useRuntimeLogs({ limit: 160, ...(logLevel !== 'all' ? { level: logLevel } : {}) });
  const eventsQuery = useRuntimeEvents({
    limit: 160,
    ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
    ...(eventType.trim() ? { eventType: eventType.trim() } : {}),
    ...(agentFilter.trim() ? { agent: agentFilter.trim() } : {}),
    ...(logLevel !== 'all' ? { level: logLevel } : {}),
  });
  const sessionsQuery = useRuntimeSessions();
  const readinessQuery = useRuntimeReadiness();
  const takeoverPreviewMutation = useTakeoverPreview();
  const startRun = useStartRun();
  const startTakeover = useStartTakeover();
  const stopSession = useStopSession();
  const pauseSupervisor = usePauseSupervisor();
  const resumeSupervisor = useResumeSupervisor();
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!roster && draftQuery.data) setRoster(draftQuery.data);
  }, [draftQuery.data, roster]);

  useEffect(() => {
    if (roster) setRoster({ ...roster, runtime, goal });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, goal]);

  useEffect(() => {
    if (autoScroll) logsEndRef.current?.scrollIntoView({ block: 'end' });
  }, [autoScroll, logsQuery.data]);

  const runtimeStatus = status.data;
  const activeSession = runtimeStatus?.activeSession;
  const isBusy =
    startRun.isPending ||
    startTakeover.isPending ||
    takeoverPreviewMutation.isPending ||
    stopSession.isPending ||
    pauseSupervisor.isPending ||
    resumeSupervisor.isPending ||
    forkSession.isPending;
  const rosterValidation = useMemo(
    () => roster ? validateAgentRosterDraft(roster) : { valid: false, errors: [], warnings: [] },
    [roster],
  );
  const operationError =
    asError(startRun.error) ||
    asError(startTakeover.error) ||
    asError(takeoverPreviewMutation.error) ||
    asError(stopSession.error) ||
    asError(pauseSupervisor.error) ||
    asError(resumeSupervisor.error) ||
    asError(forkSession.error) ||
    asError(status.error);

  function confirmAction(message: string): boolean {
    return window.confirm(message);
  }

  function updateRosterAgent(index: number, patch: Partial<AgentRosterDraft['agents'][number]>) {
    if (!roster) return;
    setRoster({
      ...roster,
      agents: roster.agents.map((agent, i) => i === index ? { ...agent, ...patch } : agent),
    });
  }

  function addAgent() {
    const next = roster ?? draftQuery.data;
    if (!next) return;
    const count = next.agents.filter(agent => agent.name.startsWith('custom')).length + 1;
    setRoster({
      ...next,
      agents: [
        ...next.agents,
        {
          name: `custom-${count}`,
          enabled: true,
          lifecycle: 'on-demand',
          runtime,
          model: 'standard',
          roleSummary: 'Handle focused operator-assigned work.',
          isCustom: true,
        },
      ],
    });
  }

  function removeAgent(index: number) {
    if (!roster) return;
    setRoster({ ...roster, agents: roster.agents.filter((_, i) => i !== index) });
  }

  async function handleStartRun() {
    const goalError = validateGoal(goal);
    if (goalError || !roster || !rosterValidation.valid) return;
    await startRun.mutateAsync({
      goal,
      runtime,
      codexModel: codexModel.trim() || undefined,
      codexReasoningEffort: runtime === 'codex' ? codexEffort : undefined,
      loopMode,
      loops: loopMode === 'finite' ? safeNumber(loops, 100) : undefined,
      pollInterval: safeNumber(pollInterval, 15),
      errorLimit: safeNumber(errorLimit, 20),
      outputDir: outputDir.trim() || undefined,
      roster,
    });
  }

  async function handleTakeoverPreview() {
    const pathError = validateProjectPath(projectPath);
    if (pathError) return;
    const preview = await takeoverPreviewMutation.mutateAsync({
      projectPath,
      goalOverride: goal.trim() || undefined,
      runtime,
    });
    setTakeoverPreview(preview);
    setGoal(preview.inferredGoal);
    setRoster(preview.generatedAgentRoster);
  }

  async function handleStartTakeover() {
    const pathError = validateProjectPath(projectPath);
    if (pathError) return;
    if (!takeoverPreview) {
      await handleTakeoverPreview();
      return;
    }
    if (!confirmAction('Start takeover against this local repo? This can create a local .wanman overlay and run agents.')) return;
    await startTakeover.mutateAsync({
      projectPath,
      goalOverride: goal.trim() || undefined,
      runtime,
      dryRun: false,
      infinite: loopMode === 'infinite',
      loops: loopMode === 'finite' ? safeNumber(loops, 100) : undefined,
      pollInterval: safeNumber(pollInterval, 15),
      outputDir: outputDir.trim() || undefined,
      noBrain: takeoverNoBrain,
      codexModel: codexModel.trim() || undefined,
      codexReasoningEffort: runtime === 'codex' ? codexEffort : undefined,
    });
  }

  const goalError = validateGoal(goal);
  const projectPathError = validateProjectPath(projectPath);
  const logs = logsQuery.data ?? [];
  const events = eventsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const readiness = runtimeStatus?.readiness ?? readinessQuery.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-6 py-5 space-y-5">
        <PageHeader />

        {operationError && <ErrorBanner title="Runtime operation failed" error={operationError} />}

        <section className="grid grid-cols-1 xl:grid-cols-4 gap-3">
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <p className="text-xs text-stone-500 mb-1">Supervisor</p>
            <div className="flex items-center gap-2">
              <StatusPill
                label={runtimeStatus?.supervisor.connection === 'connected' ? 'connected' : 'not running'}
                tone={runtimeStatus?.supervisor.connection === 'connected' ? 'green' : 'red'}
              />
              <StatusPill
                label={runtimeStatus?.supervisor.status ?? 'unknown'}
                tone={runtimeStatus?.supervisor.status === 'paused' ? 'amber' : 'slate'}
              />
            </div>
            <p className="text-xs text-stone-500 font-mono truncate mt-2">{runtimeStatus?.supervisor.url ?? 'http://localhost:3120'}</p>
          </div>
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <p className="text-xs text-stone-500 mb-1">Session</p>
            <div className="flex items-center gap-2">
              <StatusPill label={activeSession?.kind ?? 'none'} tone={activeSession ? 'green' : 'slate'} />
              <StatusPill label={activeSession?.status ?? 'idle'} tone={activeSession?.status === 'error' || activeSession?.status === 'stale' ? 'red' : 'slate'} />
            </div>
            <p className="text-xs text-stone-500 truncate mt-2">{activeSession?.goal || 'No active goal'}</p>
          </div>
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <p className="text-xs text-stone-500 mb-1">Runtime</p>
            <p className="text-base font-semibold text-stone-900">{runtimeStatus?.currentRuntime ?? runtime}</p>
            <p className="text-xs text-stone-500">{runtimeStatus?.agents.length ?? 0} agents · loop {runtimeStatus?.loop?.currentLoop ?? 0}</p>
          </div>
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <p className="text-xs text-stone-500 mb-1">Host / Stream</p>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusPill
                label={runtimeStatus?.hostBridge ? (runtimeStatus.hostMode ?? 'local') : 'supervisor only'}
                tone={runtimeStatus?.hostBridge ? 'green' : 'slate'}
              />
              <StatusPill
                label={streamStatus === 'streaming' ? 'SSE live' : streamStatus === 'fallback' ? 'polling' : 'connecting…'}
                tone={streamStatus === 'streaming' ? 'green' : streamStatus === 'fallback' ? 'amber' : 'slate'}
              />
            </div>
            <p className="text-xs text-stone-500 font-mono truncate mt-2">
              {runtimeStatus?.lastEvent?.message ?? 'No events yet'}
            </p>
            {logStatusQuery.data && (
              <p className="text-xs text-stone-400 mt-1">
                log {(logStatusQuery.data.currentSizeBytes / 1024).toFixed(0)} KB
                {logStatusQuery.data.archiveCount > 0 ? ` · ${logStatusQuery.data.archiveCount} archive${logStatusQuery.data.archiveCount > 1 ? 's' : ''}` : ''}
                {' '}/ {(logStatusQuery.data.maxSizeBytes / 1024 / 1024).toFixed(0)} MB limit
              </p>
            )}
          </div>
        </section>

        <section className="bg-white border border-stone-200 rounded-lg p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(['claude', 'codex', 'github'] as const).map(name => {
              const provider = readiness?.providers[name];
              return (
                <div key={name} className="border border-stone-200 rounded-md p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-stone-800">{name}</p>
                    <StatusPill label={provider?.ready ? 'ready' : provider?.available ? 'needs auth' : 'missing'} tone={provider?.ready ? 'green' : provider?.available ? 'amber' : 'red'} />
                  </div>
                  <p className="text-xs text-stone-500 mt-2">{provider?.message ?? 'Readiness check pending'}</p>
                  {!provider?.ready && provider?.suggestedFix && <p className="text-xs text-stone-500 mt-1">{provider.suggestedFix}</p>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="bg-white border border-stone-200 rounded-lg">
          <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3">
            <div className="flex gap-1">
              {(['run', 'takeover', 'roster', 'sessions', 'events', 'logs'] as Tab[]).map(item => (
                <button
                  key={item}
                  onClick={() => setTab(item)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === item ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
                >
                  {item[0]!.toUpperCase() + item.slice(1)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => confirmAction('Pause all agents? Running work may be interrupted.') && pauseSupervisor.mutate({ sessionId: activeSession?.id })}
                disabled={isBusy || !runtimeStatus?.capabilities.pause}
                className="px-3 py-1.5 text-sm rounded-md border border-amber-200 text-amber-700 disabled:opacity-50"
              >
                Pause
              </button>
              <button
                onClick={() => resumeSupervisor.mutate({ sessionId: activeSession?.id })}
                disabled={isBusy || !runtimeStatus?.capabilities.resume}
                className="px-3 py-1.5 text-sm rounded-md border border-emerald-200 text-emerald-700 disabled:opacity-50"
              >
                Resume
              </button>
              <button
                onClick={() => confirmAction('Stop the active Wanman session?') && stopSession.mutate({ sessionId: activeSession?.id, reason: 'operator request' })}
                disabled={isBusy || !runtimeStatus?.capabilities.stopSession}
                className="px-3 py-1.5 text-sm rounded-md border border-red-200 text-red-700 disabled:opacity-50"
              >
                Stop
              </button>
            </div>
          </div>

          {tab === 'run' && (
            <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                <div>
                  <FieldLabel>Goal</FieldLabel>
                  <textarea
                    value={goal}
                    onChange={event => setGoal(event.target.value)}
                    disabled={!!activeSession && activeSession.status === 'running'}
                    rows={5}
                    className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm resize-y"
                  />
                  {goalError && <p className="text-xs text-red-600 mt-1">{goalError}</p>}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <FieldLabel>Runtime</FieldLabel>
                    <select value={runtime} onChange={event => setRuntime(event.target.value as AgentRuntime)} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm">
                      {runtimeOptions.map(option => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </div>
                  <div>
                    <FieldLabel>Loop Mode</FieldLabel>
                    <select value={loopMode} onChange={event => setLoopMode(event.target.value as 'finite' | 'infinite')} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm">
                      <option value="finite">finite</option>
                      <option value="infinite">infinite</option>
                    </select>
                  </div>
                  <div>
                    <FieldLabel>Loops</FieldLabel>
                    <input value={loops} onChange={event => setLoops(event.target.value)} disabled={loopMode === 'infinite'} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm" />
                  </div>
                  <div>
                    <FieldLabel>Poll Seconds</FieldLabel>
                    <input value={pollInterval} onChange={event => setPollInterval(event.target.value)} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm" />
                  </div>
                </div>
                {runtime === 'codex' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>Codex Model</FieldLabel>
                      <input value={codexModel} onChange={event => setCodexModel(event.target.value)} placeholder="default" className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm" />
                    </div>
                    <div>
                      <FieldLabel>Codex Effort</FieldLabel>
                      <select value={codexEffort} onChange={event => setCodexEffort(event.target.value as typeof codexEffort)} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm">
                        {['low', 'medium', 'high', 'xhigh'].map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <FieldLabel>Error Limit</FieldLabel>
                  <input value={errorLimit} onChange={event => setErrorLimit(event.target.value)} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm" />
                </div>
                <div>
                  <FieldLabel>Output Directory</FieldLabel>
                  <input value={outputDir} onChange={event => setOutputDir(event.target.value)} className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm font-mono" />
                </div>
                <button
                  onClick={handleStartRun}
                  disabled={isBusy || !!goalError || !rosterValidation.valid || runtimeStatus?.capabilities.startRun === false}
                  className="w-full px-4 py-2 rounded-md bg-stone-900 text-white text-sm font-medium disabled:opacity-50"
                >
                  {startRun.isPending ? 'Starting…' : 'Start Run'}
                </button>
                <p className="text-xs text-stone-500">China-region providers are reserved for future adapters. Stage 4 execution remains Claude/Codex CLI only.</p>
              </div>
            </div>
          )}

          {tab === 'takeover' && (
            <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                <div>
                  <FieldLabel>Project Path</FieldLabel>
                  <input value={projectPath} onChange={event => setProjectPath(event.target.value)} className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-mono" />
                  {projectPath && projectPathError && <p className="text-xs text-red-600 mt-1">{projectPathError}</p>}
                </div>
                <div>
                  <FieldLabel>Goal Override</FieldLabel>
                  <textarea value={goal} onChange={event => setGoal(event.target.value)} rows={4} className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm resize-y" />
                </div>
              </div>
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="checkbox" checked={takeoverDryRun} onChange={event => setTakeoverDryRun(event.target.checked)} />
                  Dry-run preview first
                </label>
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="checkbox" checked={takeoverNoBrain} onChange={event => setTakeoverNoBrain(event.target.checked)} />
                  Disable db9 brain
                </label>
                <button
                  onClick={handleTakeoverPreview}
                  disabled={isBusy || !!projectPathError}
                  className="w-full px-4 py-2 rounded-md border border-stone-300 text-stone-800 text-sm font-medium disabled:opacity-50"
                >
                  {takeoverPreviewMutation.isPending ? 'Previewing…' : 'Preview'}
                </button>
                <button
                  onClick={handleStartTakeover}
                  disabled={isBusy || !!projectPathError || runtimeStatus?.capabilities.startTakeover === false}
                  className="w-full px-4 py-2 rounded-md bg-stone-900 text-white text-sm font-medium disabled:opacity-50"
                >
                  {startTakeover.isPending && !takeoverDryRun ? 'Starting…' : takeoverPreview ? 'Confirm & Start Takeover' : 'Preview Before Start'}
                </button>
              </div>
              {takeoverPreview && (
                <div className="lg:col-span-3 border-t border-stone-200 pt-4 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <p className="text-xs text-stone-500">Project</p>
                      <p className="text-sm font-medium text-stone-900">{takeoverPreview.projectName}</p>
                      <p className="text-xs font-mono text-stone-500 truncate">{takeoverPreview.projectPath}</p>
                    </div>
                    <div>
                      <p className="text-xs text-stone-500">Stack</p>
                      <p className="text-sm text-stone-800">{[...takeoverPreview.languages, ...takeoverPreview.frameworks].join(', ') || 'No stack signals'}</p>
                      <p className="text-xs text-stone-500">{takeoverPreview.packageManagers.join(', ') || 'No package manager'} · tests {takeoverPreview.testFrameworks.join(', ') || 'none'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-stone-500">Signals</p>
                      <p className="text-sm text-stone-800">CI {takeoverPreview.ciProviders.join(', ') || 'none'} · README {takeoverPreview.hasReadme ? 'yes' : 'no'} · docs {takeoverPreview.hasDocs ? 'yes' : 'no'}</p>
                      <p className="text-xs text-stone-500">roots {takeoverPreview.codeRoots.join(', ') || 'repo root'} · issues {takeoverPreview.issueTracker}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs font-medium text-stone-600 mb-1">Inferred Goal</p>
                      <p className="text-sm text-stone-700">{takeoverPreview.inferredGoal}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-stone-600 mb-1">Generated Agents</p>
                      <div className="flex flex-wrap gap-1">
                        {takeoverPreview.generatedAgentRoster.agents.map(agent => (
                          <StatusPill key={agent.name} label={`${agent.enabled ? '' : 'off '}${agent.name}`} tone={agent.enabled ? 'green' : 'slate'} />
                        ))}
                      </div>
                      {takeoverPreview.warnings.length > 0 && <p className="text-xs text-amber-700 mt-2">{takeoverPreview.warnings.join(' ')}</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'roster' && (
            <div className="p-4 space-y-3">
              {draftQuery.isLoading && !roster ? <Spinner /> : null}
              {rosterValidation.errors.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3">
                  {rosterValidation.errors.map(error => <p key={`${error.field}-${error.message}`} className="text-xs text-red-700">{error.field}: {error.message}</p>)}
                </div>
              )}
              <div className="grid grid-cols-12 gap-2 text-xs font-medium text-stone-500 px-2">
                <span className="col-span-1">On</span>
                <span className="col-span-2">Name</span>
                <span className="col-span-2">Lifecycle</span>
                <span className="col-span-2">Runtime</span>
                <span className="col-span-2">Model</span>
                <span className="col-span-3">Role</span>
              </div>
              {(roster?.agents ?? []).map((agent, index) => (
                <div key={`${agent.name}-${index}`} className="grid grid-cols-12 gap-2 items-center">
                  <input className="col-span-1" type="checkbox" checked={agent.enabled} onChange={event => updateRosterAgent(index, { enabled: event.target.checked })} />
                  <input className="col-span-2 rounded-md border border-stone-300 px-2 py-1.5 text-sm" value={agent.name} onChange={event => updateRosterAgent(index, { name: event.target.value })} />
                  <select className="col-span-2 rounded-md border border-stone-300 px-2 py-1.5 text-sm" value={agent.lifecycle} onChange={event => updateRosterAgent(index, { lifecycle: event.target.value as AgentLifecycle })}>
                    {lifecycleOptions.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                  <select className="col-span-2 rounded-md border border-stone-300 px-2 py-1.5 text-sm" value={agent.runtime ?? runtime} onChange={event => updateRosterAgent(index, { runtime: event.target.value as AgentRuntime })}>
                    {runtimeOptions.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                  <input className="col-span-2 rounded-md border border-stone-300 px-2 py-1.5 text-sm" value={agent.model} onChange={event => updateRosterAgent(index, { model: event.target.value })} />
                  <div className="col-span-3 flex gap-2">
                    <input className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1.5 text-sm" value={agent.roleSummary} onChange={event => updateRosterAgent(index, { roleSummary: event.target.value })} />
                    {agent.isCustom && <button onClick={() => removeAgent(index)} className="px-2 rounded-md border border-red-200 text-red-700 text-xs">Remove</button>}
                  </div>
                </div>
              ))}
              <button onClick={addAgent} className="px-3 py-1.5 rounded-md border border-stone-300 text-sm text-stone-700">Add Agent</button>
            </div>
          )}

          {tab === 'sessions' && (
            <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-1 space-y-2">
                {sessions.length === 0 && <p className="text-sm text-stone-500">No persisted sessions yet.</p>}
                {sessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 ${selectedSessionId === session.id ? 'border-stone-900 bg-stone-50' : 'border-stone-200'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-stone-800 truncate">{session.goal || session.id}</span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <StatusPill label={session.status} tone={session.status === 'error' || session.status === 'stale' ? 'red' : session.status === 'running' ? 'green' : session.status === 'paused' ? 'amber' : 'slate'} />
                        {session.heartbeatStatus === 'missed' && <StatusPill label="hb miss" tone="amber" />}
                      </div>
                    </div>
                    <p className="text-xs text-stone-500">{session.kind} · {session.runtime} · {new Date(session.startedAt).toLocaleString()}</p>
                    {session.lastHeartbeatAt && (
                      <p className="text-xs text-stone-400">heartbeat {new Date(session.lastHeartbeatAt).toLocaleTimeString()}</p>
                    )}
                  </button>
                ))}
              </div>
              <div className="lg:col-span-2 rounded-md border border-stone-200 p-4">
                {(() => {
                  const session = sessions.find(item => item.id === selectedSessionId) ?? activeSession ?? sessions[0];
                  if (!session) return <p className="text-sm text-stone-500">Select a session to inspect details.</p>;
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <StatusPill label={session.kind} tone="slate" />
                        <StatusPill label={session.status} tone={session.status === 'stale' || session.status === 'error' ? 'red' : session.status === 'running' ? 'green' : 'slate'} />
                      </div>
                      <p className="text-sm text-stone-800">{session.goal || 'No goal recorded'}</p>
                      <dl className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                        {[
                          ['id', session.id],
                          ['supervisor', session.supervisorUrl ?? 'none'],
                          ['project', session.projectPath ?? 'none'],
                          ['workspace', session.workspacePath ?? 'none'],
                          ['config', session.configPath ?? 'none'],
                          ['output', session.outputDir ?? 'none'],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-stone-500">{label}</dt>
                            <dd className="font-mono text-stone-700 break-all">{value}</dd>
                          </div>
                        ))}
                        {session.lastHeartbeatAt && (
                          <div>
                            <dt className="text-stone-500">last heartbeat</dt>
                            <dd className="font-mono text-stone-700">{new Date(session.lastHeartbeatAt).toLocaleTimeString()}</dd>
                          </div>
                        )}
                        {session.heartbeatStatus && session.heartbeatStatus !== 'healthy' && (
                          <div>
                            <dt className="text-stone-500">heartbeat</dt>
                            <dd className={`font-mono ${session.heartbeatStatus === 'stale' ? 'text-red-600' : 'text-amber-600'}`}>
                              {session.heartbeatStatus} ({session.heartbeatMisses ?? 0}/3 misses)
                            </dd>
                          </div>
                        )}
                      </dl>
                      {session.status === 'stale' && (
                        <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2">
                          <p className="text-sm font-medium text-red-700">Session is stale — supervisor process is not responding.</p>
                          <p className="text-xs text-red-600">
                            {session.error ?? 'The supervisor process could not be verified after repeated health checks.'}
                          </p>
                          <p className="text-xs text-stone-500">Session metadata preserved at: <span className="font-mono break-all">{session.outputDir ?? 'unknown'}</span></p>
                          <button
                            onClick={() => {
                              if (confirmAction('Start a new session using this session\'s goal, runtime, and project path? The stale session record will be preserved.')) {
                                forkSession.mutate({ sessionId: session.id })
                              }
                            }}
                            disabled={isBusy || runtimeStatus?.capabilities.startRun === false}
                            className="px-3 py-1.5 rounded-md bg-stone-900 text-white text-xs font-medium disabled:opacity-50"
                          >
                            {forkSession.isPending ? 'Creating…' : 'Start New From This Session'}
                          </button>
                        </div>
                      )}
                      {Boolean(session.metadata?.['recoveredFrom']) && (
                        <p className="text-xs text-stone-400">
                          Forked from session <span className="font-mono">{String(session.metadata?.['recoveredFrom'])}</span>
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {tab === 'events' && (
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <FieldLabel>Session</FieldLabel>
                  <select value={selectedSessionId ?? ''} onChange={event => setSelectedSessionId(event.target.value || null)} className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm">
                    <option value="">all</option>
                    {sessions.map(session => <option key={session.id} value={session.id}>{session.id}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel>Level</FieldLabel>
                  <select value={logLevel} onChange={event => setLogLevel(event.target.value as typeof logLevel)} className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm">
                    {['all', 'info', 'warn', 'error'].map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                </div>
                <div>
                  <FieldLabel>Event Type</FieldLabel>
                  <input value={eventType} onChange={event => setEventType(event.target.value)} placeholder="runtime.started" className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <FieldLabel>Agent</FieldLabel>
                  <input value={agentFilter} onChange={event => setAgentFilter(event.target.value)} placeholder="db9, coder…" className="w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div className="h-[420px] overflow-y-auto rounded-md bg-slate-950 p-3 font-mono text-xs">
                {events.length === 0 && <p className="text-stone-500">No events match this filter.</p>}
                {events.map(event => (
                  <div key={event.id} className="py-1 border-b border-stone-900 last:border-0">
                    <span className={event.level === 'error' ? 'text-red-300' : event.level === 'warn' ? 'text-amber-300' : 'text-stone-300'}>
                      {new Date(event.timestamp).toLocaleTimeString()} [{event.level}] {event.agent ? `${event.agent}/` : `${event.source}/`}{event.eventType}: {event.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'logs' && (
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FieldLabel>Level</FieldLabel>
                  <select value={logLevel} onChange={event => setLogLevel(event.target.value as typeof logLevel)} className="rounded-md border border-stone-300 px-2 py-1.5 text-sm">
                    {['all', 'info', 'warn', 'error'].map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />
                  Auto-scroll
                </label>
              </div>
              <div className="h-[420px] overflow-y-auto rounded-md bg-slate-950 p-3 font-mono text-xs">
                {logs.length === 0 && <p className="text-stone-500">Logs unavailable or empty.</p>}
                {logs.map(log => (
                  <button
                    key={log.id}
                    onClick={() => navigator.clipboard?.writeText(log.message)}
                    className="block w-full text-left py-1 border-b border-stone-900 last:border-0"
                    title="Click to copy log line"
                  >
                    <span className={log.level === 'error' ? 'text-red-300' : log.level === 'warn' ? 'text-amber-300' : 'text-stone-300'}>
                      {new Date(log.timestamp).toLocaleTimeString()} [{log.level}] {log.source}: {log.message}
                    </span>
                  </button>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
