import type { AgentDefinition, AgentMatrixConfig } from '@wanman/core'
import type { AgentRosterDraft, AgentRosterValidationResult, Runtime } from './types.js'

export function createDefaultRoster(runtime: Runtime, goal = ''): AgentRosterDraft {
  return {
    runtime,
    goal,
    source: 'default',
    agents: [
      {
        name: 'ceo',
        enabled: true,
        lifecycle: '24/7',
        runtime,
        model: 'high',
        roleSummary: 'Decompose the goal, assign tasks, review progress, and keep the run moving.',
      },
      {
        name: 'dev',
        enabled: true,
        lifecycle: 'on-demand',
        runtime,
        model: 'standard',
        roleSummary: 'Implement assigned code, docs, or analysis work end-to-end.',
      },
      {
        name: 'feedback',
        enabled: true,
        lifecycle: 'on-demand',
        runtime,
        model: 'standard',
        roleSummary: 'Review outputs, find gaps, and create follow-up work.',
      },
    ],
  }
}

export function validateAgentRosterDraft(draft: AgentRosterDraft): AgentRosterValidationResult {
  const errors: AgentRosterValidationResult['errors'] = []
  const warnings: AgentRosterValidationResult['warnings'] = []
  const seen = new Map<string, number>()

  draft.agents.forEach((agent, index) => {
    if (!agent.enabled) return
    const field = `agents[${index}]`
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(agent.name)) {
      errors.push({ field: `${field}.name`, message: 'Agent name must be a safe identifier.' })
    }
    const prior = seen.get(agent.name)
    if (prior !== undefined) errors.push({ field: `${field}.name`, message: `Agent name duplicates agents[${prior}].name.` })
    else seen.set(agent.name, index)
    if ((agent.runtime ?? draft.runtime) === 'codex' && agent.lifecycle === 'idle_cached') {
      errors.push({ field: `${field}.lifecycle`, message: 'idle_cached is Claude-only.' })
    }
    if (!agent.roleSummary.trim()) {
      warnings.push({ field: `${field}.roleSummary`, message: 'A short role summary helps assignment.' })
    }
  })

  if (draft.agents.filter(agent => agent.enabled).length === 0) {
    errors.push({ field: 'agents', message: 'At least one enabled agent is required.' })
  }
  return { valid: errors.length === 0, errors, warnings }
}

export function rosterToConfig(draft: AgentRosterDraft, port = 3120): AgentMatrixConfig {
  const agents: AgentDefinition[] = draft.agents
    .filter(agent => agent.enabled)
    .map(agent => ({
      name: agent.name,
      lifecycle: agent.lifecycle,
      runtime: agent.runtime ?? draft.runtime,
      model: agent.model,
      systemPrompt: agent.systemPrompt || `You are ${agent.name}. ${agent.roleSummary}`,
    }))
  return { agents, goal: draft.goal, port }
}
