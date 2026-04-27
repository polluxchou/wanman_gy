import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from '../lib/client.js';
import type {
  CreateTaskInput,
  HumanActionKind,
  ReviewArtifactInput,
  SendMessageInput,
  StartRunInput,
  StartTakeoverInput,
  TaskStatus,
  AgentRuntime,
  UpdateTaskInput,
} from '@wanman/cockpit-client';

// Polling intervals (ms)
const HEALTH_INTERVAL = 2_000;
const TASKS_INTERVAL = 5_000;
const SLOW_INTERVAL = 30_000;
const HUMAN_INTERVAL = 5_000;

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => client.getHealth(),
    refetchInterval: HEALTH_INTERVAL,
    retry: 3,
  });
}

export function useStory() {
  return useQuery({
    queryKey: ['story'],
    queryFn: () => client.getStory(),
    refetchInterval: HEALTH_INTERVAL,
  });
}

export function useRuntimeStatus() {
  return useQuery({
    queryKey: ['runtimeStatus'],
    queryFn: () => client.getRuntimeStatus(),
    refetchInterval: HEALTH_INTERVAL,
  });
}

export function useRuntimeLogs(filter?: { level?: 'info' | 'warn' | 'error'; limit?: number }) {
  return useQuery({
    queryKey: ['runtimeLogs', filter],
    queryFn: () => client.getRuntimeLogs(filter),
    refetchInterval: HEALTH_INTERVAL,
  });
}

export function useRuntimeEvents(filter?: { sessionId?: string; level?: 'info' | 'warn' | 'error'; eventType?: string; limit?: number }) {
  return useQuery({
    queryKey: ['runtimeEvents', filter],
    queryFn: () => client.getRuntimeEvents(filter),
    refetchInterval: HEALTH_INTERVAL,
  });
}

export function useRuntimeSessions(filter?: { status?: string; kind?: 'run' | 'takeover' }) {
  return useQuery({
    queryKey: ['runtimeSessions', filter],
    queryFn: () => client.listSessions(filter),
    refetchInterval: HEALTH_INTERVAL,
  });
}

export function useRuntimeReadiness() {
  return useQuery({
    queryKey: ['runtimeReadiness'],
    queryFn: () => client.getRuntimeReadiness(),
    refetchInterval: SLOW_INTERVAL,
  });
}

export function useTakeoverPreview() {
  return useMutation({
    mutationFn: (input: { projectPath: string; goalOverride?: string; runtime: AgentRuntime }) => client.previewTakeover(input),
  });
}

export function useAgentRosterDraft(input?: { projectPath?: string; runtime?: 'claude' | 'codex'; goal?: string }) {
  return useQuery({
    queryKey: ['agentRosterDraft', input],
    queryFn: () => client.getAgentRosterDraft(input),
    enabled: true,
    staleTime: 5_000,
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartRunInput) => client.startRun(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['runtimeLogs'] });
    },
  });
}

export function useStartTakeover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartTakeoverInput) => client.startTakeover(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['runtimeLogs'] });
    },
  });
}

export function useStopSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId?: string; reason?: string }) => client.stopSession(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['runtimeLogs'] });
    },
  });
}

export function usePauseSupervisor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { sessionId?: string }) => client.pauseSupervisor(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['runtimeLogs'] });
    },
  });
}

export function useResumeSupervisor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: { sessionId?: string }) => client.resumeSupervisor(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['runtimeLogs'] });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => client.listAgents(),
    refetchInterval: HEALTH_INTERVAL,
  });
}

export function useTasks(filter?: {
  status?: TaskStatus;
  assignee?: string;
  initiativeId?: string;
  capsuleId?: string;
}) {
  return useQuery({
    queryKey: ['tasks', filter],
    queryFn: () => client.listTasks(filter),
    refetchInterval: TASKS_INTERVAL,
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => (id ? client.getTask(id) : Promise.resolve(null)),
    enabled: id !== null,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => client.createTask(input),
    onSuccess: task => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.setQueryData(['task', task.id], task);
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => client.updateTask(input),
    onSuccess: task => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['humanActions'] });
      void qc.setQueryData(['task', task.id], task);
    },
  });
}

export function useAssignTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; assignee: string }) => client.assignTask(input),
    onSuccess: task => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['humanActions'] });
      void qc.setQueryData(['task', task.id], task);
    },
  });
}

export function useMarkTaskComplete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; result: string; artifactIds?: string[] }) => client.markTaskComplete(input),
    onSuccess: task => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['humanActions'] });
      void qc.setQueryData(['task', task.id], task);
    },
  });
}

export function useReturnTaskForRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; reason: string; assignee?: string | null; notifyAssignee?: boolean }) =>
      client.returnTaskForRevision(input),
    onSuccess: task => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['humanActions'] });
      void qc.setQueryData(['task', task.id], task);
    },
  });
}

export function useArtifacts(filter?: { agent?: string; kind?: string; verified?: boolean }) {
  return useQuery({
    queryKey: ['artifacts', filter],
    queryFn: () => client.listArtifacts(filter),
    refetchInterval: SLOW_INTERVAL,
  });
}

export function useArtifact(id: string | null) {
  return useQuery({
    queryKey: ['artifact', id],
    queryFn: () => (id ? client.getArtifact(id) : Promise.resolve(null)),
    enabled: id !== null,
  });
}

export function useArtifactsForTask(taskId: string | null) {
  return useQuery({
    queryKey: ['artifactsForTask', taskId],
    queryFn: () => (taskId ? client.listArtifactsForTask(taskId) : Promise.resolve([])),
    enabled: taskId !== null,
    refetchInterval: SLOW_INTERVAL,
  });
}

export function useReviewArtifact() {
  return useMutation({
    mutationFn: (input: ReviewArtifactInput) => client.reviewArtifact(input),
  });
}

export function useContext() {
  return useQuery({
    queryKey: ['context'],
    queryFn: () => client.listContext(),
    refetchInterval: SLOW_INTERVAL,
  });
}

export function useHumanActions(filter?: { status?: 'open' | 'handled'; kind?: HumanActionKind }) {
  return useQuery({
    queryKey: ['humanActions', filter],
    queryFn: () => client.listHumanActions(filter),
    refetchInterval: HUMAN_INTERVAL,
  });
}

export function useThreads(filter?: { agent?: string; taskId?: string; humanOnly?: boolean }) {
  return useQuery({
    queryKey: ['threads', filter],
    queryFn: () => client.listThreads(filter),
    refetchInterval: HUMAN_INTERVAL,
  });
}

export function useThread(id: string | null) {
  return useQuery({
    queryKey: ['thread', id],
    queryFn: () => (id ? client.getThread(id) : Promise.resolve(null)),
    enabled: id !== null,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendMessageInput) => client.sendMessage(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['humanActions'] });
    },
  });
}

export function useMarkHumanActionHandled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.markHumanActionHandled(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['humanActions'] });
    },
  });
}

/**
 * Connects to the host SSE event stream and invalidates relevant queries on each
 * incoming event so the UI refreshes without waiting for the next polling tick.
 * Falls back to polling-only mode if SSE is unavailable.
 * Cursor is persisted in sessionStorage to avoid duplicate replay on page refresh.
 */
export function useRuntimeEventStream(): { streamStatus: 'connecting' | 'streaming' | 'fallback' } {
  const qc = useQueryClient();
  const [streamStatus, setStreamStatus] = useState<'connecting' | 'streaming' | 'fallback'>('connecting');

  useEffect(() => {
    const unsub = client.subscribeToEvents(
      () => {
        void qc.invalidateQueries({ queryKey: ['runtimeEvents'] });
        void qc.invalidateQueries({ queryKey: ['runtimeLogs'] });
        void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      },
      {
        onStreamStatus: (s) => setStreamStatus(s),
      },
    );
    return unsub;
  }, [qc]);

  return { streamStatus };
}

export function useLogStatus() {
  return useQuery({
    queryKey: ['logStatus'],
    queryFn: () => client.getLogStatus(),
    refetchInterval: SLOW_INTERVAL,
  });
}

export function useForkSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; goalOverride?: string }) => client.forkSession(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtimeStatus'] });
      void qc.invalidateQueries({ queryKey: ['runtimeSessions'] });
    },
  });
}
