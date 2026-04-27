import type { AgentMatrixConfig, AgentRuntime } from '@wanman/core'

export type Runtime = AgentRuntime
export type SessionKind = 'run' | 'takeover'
export type SessionStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error' | 'stale'
export type RuntimeEventLevel = 'info' | 'warn' | 'error'
export type RuntimeEventSource = 'host' | 'supervisor' | 'agent' | 'cockpit'

export interface RuntimeEvent {
  id: string
  sessionId?: string
  timestamp: number
  level: RuntimeEventLevel
  source: RuntimeEventSource
  eventType: string
  agent?: string
  message: string
  data?: Record<string, unknown>
}

export interface RuntimeEventFilter {
  sessionId?: string
  agent?: string
  level?: RuntimeEventLevel
  eventType?: string
  since?: number
  limit?: number
}

export interface RunSession {
  id: string
  kind: SessionKind
  status: SessionStatus
  goal: string
  runtime: Runtime
  supervisorUrl?: string
  port?: number
  projectPath?: string
  workspacePath?: string
  configPath?: string
  outputDir?: string
  startedAt: number
  endedAt?: number | null
  error?: string | null
  createdBy: 'cockpit'
  metadata: Record<string, unknown>
  lastHeartbeatAt?: number
  heartbeatStatus?: 'healthy' | 'missed' | 'stale'
  heartbeatMisses?: number
}

export interface RosterAgent {
  name: string
  enabled: boolean
  lifecycle: '24/7' | 'on-demand' | 'idle_cached'
  runtime?: Runtime
  model: string
  roleSummary: string
  systemPrompt?: string
  isCustom?: boolean
}

export interface AgentRosterDraft {
  runtime: Runtime
  goal: string
  source: 'default' | 'takeover-preview' | 'active'
  projectPath?: string
  agents: RosterAgent[]
}

export interface AgentRosterValidationIssue {
  field: string
  message: string
}

export interface AgentRosterValidationResult {
  valid: boolean
  errors: AgentRosterValidationIssue[]
  warnings: AgentRosterValidationIssue[]
}

export interface StartRunInput {
  goal: string
  runtime: Runtime
  codexModel?: string
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  loopMode: 'finite' | 'infinite'
  loops?: number
  pollInterval: number
  errorLimit: number
  outputDir?: string
  roster: AgentRosterDraft
}

export interface StartTakeoverInput {
  projectPath: string
  goalOverride?: string
  runtime: Runtime
  dryRun: boolean
  infinite: boolean
  loops?: number
  pollInterval: number
  outputDir?: string
  noBrain?: boolean
  codexModel?: string
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
}

export interface TakeoverPreview {
  projectPath: string
  projectName: string
  languages: string[]
  frameworks: string[]
  packageManagers: string[]
  packageScripts: string[]
  ciProviders: string[]
  testFrameworks: string[]
  hasReadme: boolean
  hasDocs: boolean
  codeRoots: string[]
  issueTracker: 'github' | 'none'
  githubRemote?: string
  inferredGoal: string
  generatedAgentRoster: AgentRosterDraft
  warnings: string[]
  overlayPath?: string
}

export interface RuntimeProviderReadiness {
  name: 'claude' | 'codex' | 'github'
  available: boolean
  authenticated: boolean
  ready: boolean
  message: string
  executablePath?: string
  suggestedFix?: string
}

export interface RuntimeReadiness {
  providers: {
    claude: RuntimeProviderReadiness
    codex: RuntimeProviderReadiness
    github: RuntimeProviderReadiness
  }
  selectedRuntimeReady: {
    claude: boolean
    codex: boolean
  }
}

export interface RuntimeStatus {
  hostBridge: boolean
  hostMode: 'dev' | 'local'
  supervisor: {
    connection: 'connected' | 'not_running' | 'reconnecting' | 'error'
    url: string
    status: 'running' | 'paused' | 'stopping' | 'stopped' | 'error' | 'stale'
    error?: string | null
  }
  activeSession: RunSession | null
  currentGoal: string | null
  currentRuntime: Runtime | null
  agents: Array<Record<string, unknown>>
  loop: Record<string, unknown> | null
  lastEvent: RuntimeEvent | null
  auth: RuntimeProviderReadiness[]
  readiness: RuntimeReadiness
  capabilities: {
    startRun: boolean
    startTakeover: boolean
    stopSession: boolean
    pause: boolean
    resume: boolean
    logs: boolean
    events: boolean
    sessions: boolean
    takeoverPreview: boolean
  }
}

export interface SupervisorHandle {
  endpoint: string
  port: number
  workspacePath?: string
  configPath?: string
  outputDir?: string
  stop(force?: boolean): Promise<void>
}

export interface ProcessLauncherCallbacks {
  onLogLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

export interface ProcessLauncher {
  start(session: RunSession, config: AgentMatrixConfig, input: StartRunInput | StartTakeoverInput, callbacks?: ProcessLauncherCallbacks): Promise<SupervisorHandle>
}

export interface CommandCheckResult {
  ok: boolean
  message: string
  executablePath?: string
}

export type ReadinessRunner = (command: 'claude' | 'codex' | 'github') => Promise<CommandCheckResult>

export interface ControlErrorBody {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export interface ForkSessionInput {
  /** ID of the stale/stopped session to fork from. */
  sessionId: string
  /** Override goal for the new session (defaults to original goal). */
  goalOverride?: string
}
