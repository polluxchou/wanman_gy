/** Frontend-facing view models for the Wanman Web Cockpit. */

export type AgentState = 'idle' | 'running' | 'paused' | 'stopped' | 'error';
export type AgentLifecycle = '24/7' | 'on-demand' | 'idle_cached';
export type AgentRuntime = 'claude' | 'codex';
export type ConnectionState = 'connected' | 'reconnecting' | 'down';
export type RuntimeSessionKind = 'run' | 'takeover';
export type RuntimeSessionStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error' | 'stale';
export type RuntimeLogLevel = 'info' | 'warn' | 'error';

/** Cockpit-only: adds derived 'blocked' status on top of runtime statuses. */
export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'failed'
  | 'blocked';

export type MessagePriority = 'steer' | 'normal';
export type TaskScopeType = 'code' | 'docs' | 'tests' | 'ops' | 'mixed';
export type ArtifactReviewStatus = 'accepted' | 'revision_needed';
export type HumanActionKind =
  | 'decision'
  | 'blocker'
  | 'access_request'
  | 'agent_error'
  | 'task_review';

export interface RuntimeStats {
  completedRuns: number;
  agents: number;
  activeInitiatives: number;
  activeCapsules: number;
}

export interface LoopInfo {
  runId: string;
  currentLoop: number;
}

export interface Story {
  id: string;
  title: string;
  goal: string | null;
  supervisorUrl: string;
  connection: ConnectionState;
  runtimeStats: RuntimeStats;
  loop: LoopInfo | null;
  lastUpdatedAt: number;
}

export interface Agent {
  name: string;
  state: AgentState;
  lifecycle: AgentLifecycle;
  runtime?: AgentRuntime;
  model: string;
  pendingMessages?: number;
  completedRuns: number;
  lastActivityAt?: number | null;
  isDynamic?: boolean;
  systemPrompt?: string;
  crons?: string[];
  events?: string[];
}

export interface RuntimeLogEntry {
  id: string;
  timestamp: number;
  level: RuntimeLogLevel;
  source: 'host' | 'supervisor' | 'agent' | 'cockpit' | 'runtime';
  agent?: string | null;
  eventType?: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunSession {
  id: string;
  kind: RuntimeSessionKind;
  status: RuntimeSessionStatus;
  goal: string;
  runtime: AgentRuntime;
  supervisorUrl?: string;
  port?: number;
  projectPath?: string;
  workspacePath?: string;
  configPath?: string;
  outputDir?: string;
  startedAt: number;
  endedAt?: number | null;
  error?: string | null;
  createdBy?: 'cockpit';
  metadata?: Record<string, unknown>;
  lastHeartbeatAt?: number;
  heartbeatStatus?: 'healthy' | 'missed' | 'stale';
  heartbeatMisses?: number;
}

export interface RuntimeCapabilitySet {
  startRun: boolean;
  startTakeover: boolean;
  stopSession: boolean;
  pause: boolean;
  resume: boolean;
  logs: boolean;
  events?: boolean;
  sessions?: boolean;
  takeoverPreview?: boolean;
}

export interface RuntimeAuthProvider {
  name: 'claude' | 'codex' | 'github';
  status: 'authenticated' | 'unauthenticated' | 'pending' | 'error';
  error?: string;
}

export interface RuntimeStatus {
  hostBridge: boolean;
  hostMode?: 'dev' | 'local';
  supervisor: {
    connection: 'connected' | 'not_running' | 'reconnecting' | 'error';
    url: string;
    status: 'running' | 'paused' | 'stopping' | 'stopped' | 'error' | 'stale';
    error?: string | null;
  };
  activeSession: RunSession | null;
  currentGoal: string | null;
  currentRuntime: AgentRuntime | null;
  agents: Agent[];
  loop: LoopInfo | null;
  lastEvent: RuntimeLogEntry | null;
  auth: RuntimeAuthProvider[];
  readiness?: RuntimeReadiness;
  capabilities: RuntimeCapabilitySet;
}

export interface AgentRosterDraftAgent {
  name: string;
  enabled: boolean;
  lifecycle: AgentLifecycle;
  runtime?: AgentRuntime;
  model: string;
  roleSummary: string;
  systemPrompt?: string;
  isCustom?: boolean;
}

export interface AgentRosterDraft {
  runtime: AgentRuntime;
  goal: string;
  source: 'default' | 'takeover-preview' | 'active';
  projectPath?: string;
  agents: AgentRosterDraftAgent[];
}

export interface AgentRosterValidationIssue {
  field: string;
  message: string;
}

export interface AgentRosterValidationResult {
  valid: boolean;
  errors: AgentRosterValidationIssue[];
  warnings: AgentRosterValidationIssue[];
}

export interface TakeoverPreview {
  projectPath: string;
  projectName: string;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  packageScripts: string[];
  ciProviders: string[];
  testFrameworks: string[];
  hasReadme: boolean;
  hasDocs: boolean;
  codeRoots: string[];
  issueTracker: 'github' | 'none';
  githubRemote?: string;
  inferredGoal: string;
  generatedAgentRoster: AgentRosterDraft;
  warnings: string[];
  overlayPath?: string;
}

export interface RuntimeProviderReadiness {
  name: 'claude' | 'codex' | 'github';
  available: boolean;
  authenticated: boolean;
  ready: boolean;
  message: string;
  executablePath?: string;
  suggestedFix?: string;
}

export interface RuntimeReadiness {
  providers: {
    claude: RuntimeProviderReadiness;
    codex: RuntimeProviderReadiness;
    github: RuntimeProviderReadiness;
  };
  selectedRuntimeReady: {
    claude: boolean;
    codex: boolean;
  };
}

export interface StartRunInput {
  goal: string;
  runtime: AgentRuntime;
  codexModel?: string;
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  loopMode: 'finite' | 'infinite';
  loops?: number;
  pollInterval: number;
  errorLimit: number;
  outputDir?: string;
  roster: AgentRosterDraft;
}

export interface StartTakeoverInput {
  projectPath: string;
  goalOverride?: string;
  runtime: AgentRuntime;
  dryRun: boolean;
  infinite: boolean;
  loops?: number;
  pollInterval: number;
  outputDir?: string;
  noBrain?: boolean;
  codexModel?: string;
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface Task {
  id: string;
  shortId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  priority: number;
  scope?: { paths: string[]; patterns?: string[] };
  dependsOn: string[];
  initiativeId?: string | null;
  capsuleId?: string | null;
  subsystem?: string | null;
  scopeType?: TaskScopeType | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  priority: MessagePriority;
  payload: unknown;
  timestamp: number;
  delivered: boolean;
}

export interface Thread {
  id: string;
  participants: string[];
  lastMessage: ThreadMessage | null;
  messageCount: number;
  pendingForHuman: boolean;
}

export interface Artifact {
  id: string;
  kind: string;
  agent: string;
  path: string | null;
  contentLength: number | null;
  content: string | null;
  metadata: Record<string, unknown>;
  confidence: number;
  verified: boolean;
  taskId?: string | null;
  reviewStatus?: ArtifactReviewStatus | null;
  reviewNote?: string | null;
  createdAt: number;
}

export interface AgentCurrentWork {
  agent: Agent;
  assignedTasks: Task[];
  inProgressTasks: Task[];
  reviewTasks: Task[];
  recentThreads: Thread[];
  recentArtifacts: Artifact[];
  errorState: string | null;
}

export interface HumanAction {
  id: string;
  kind: HumanActionKind;
  summary: string;
  originator: string;
  relatedTaskId?: string | null;
  relatedThreadId?: string | null;
  relatedAgent?: string | null;
  priority: MessagePriority;
  createdAt: number;
  payload?: unknown;
  /** Whether the human has acknowledged/handled this item. */
  handled: boolean;
  handledAt?: number | null;
}

export interface SendMessageInput {
  to: string;
  from?: 'human';
  type?: 'message' | 'decision_response' | 'blocker_response';
  payload: string | Record<string, unknown>;
  priority?: 'normal' | 'steer';
  relatedTaskId?: string;
  relatedThreadId?: string;
}

export interface ContextEntry {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
}

export interface HealthResult {
  status: 'ok' | 'degraded';
  agents: Agent[];
  loop: LoopInfo | null;
  runtime: RuntimeStats;
  timestamp: number;
}
