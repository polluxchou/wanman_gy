import {
  generateAgentConfig,
  scanProject,
} from '@wanman/cli/takeover-project'
import type { AgentRosterDraft, Runtime, TakeoverPreview } from './types.js'

export function buildTakeoverPreview(input: {
  projectPath: string
  goalOverride?: string
  runtime: Runtime
}): TakeoverPreview {
  const profile = scanProject(input.projectPath)
  const generated = generateAgentConfig(profile, input.goalOverride, input.runtime)
  const warnings: string[] = []

  if (!profile.hasReadme) warnings.push('README not detected.')
  if (!profile.hasDocs) warnings.push('docs directory not detected.')
  if ((profile.packageScripts?.length ?? 0) === 0) warnings.push('No package scripts detected.')
  if (profile.testFrameworks.length === 0) warnings.push('No test framework detected.')
  if (profile.ci.length === 0) warnings.push('No CI provider detected.')
  if ((profile.codeRoots?.length ?? 0) === 0) warnings.push('No conventional code roots detected; agents will inspect the repository root.')

  const roster: AgentRosterDraft = {
    runtime: generated.runtime,
    goal: generated.goal,
    source: 'takeover-preview',
    projectPath: profile.path,
    agents: generated.agents.map(agent => ({
      name: agent.name,
      enabled: agent.enabled,
      lifecycle: agent.lifecycle,
      runtime: agent.runtime,
      model: agent.model,
      roleSummary: agent.reason,
      systemPrompt: agent.systemPromptHint,
    })),
  }

  return {
    projectPath: profile.path,
    projectName: generated.intent.projectName,
    languages: profile.languages,
    frameworks: profile.frameworks,
    packageManagers: profile.packageManagers,
    packageScripts: profile.packageScripts ?? [],
    ciProviders: profile.ci,
    testFrameworks: profile.testFrameworks,
    hasReadme: profile.hasReadme,
    hasDocs: profile.hasDocs,
    codeRoots: profile.codeRoots ?? [],
    issueTracker: profile.issueTracker,
    githubRemote: profile.githubRemote,
    inferredGoal: generated.goal,
    generatedAgentRoster: roster,
    warnings,
  }
}
