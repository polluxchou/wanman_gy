import * as fs from 'node:fs'
import type { StartRunInput, StartTakeoverInput } from './types.js'
import { validateLocalPath } from './safety.js'
import { validateAgentRosterDraft } from './roster.js'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRuntime(value: unknown): value is 'claude' | 'codex' {
  return value === 'claude' || value === 'codex'
}

export function validateStartRunInput(input: unknown): ValidationResult<StartRunInput> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Request body is required.' }
  const body = input as StartRunInput
  if (typeof body.goal !== 'string' || !body.goal.trim()) return { ok: false, error: 'Goal is required.' }
  if (!isRuntime(body.runtime)) return { ok: false, error: 'Runtime must be claude or codex.' }
  if (body.outputDir && validateLocalPath(body.outputDir, 'outputDir')) return { ok: false, error: validateLocalPath(body.outputDir, 'outputDir')! }
  if (!body.roster) return { ok: false, error: 'Roster is required.' }
  const rosterValidation = validateAgentRosterDraft(body.roster)
  if (!rosterValidation.valid) return { ok: false, error: rosterValidation.errors[0]?.message ?? 'Roster is invalid.' }
  return { ok: true, value: { ...body, goal: body.goal.trim() } }
}

export function validateStartTakeoverInput(input: unknown): ValidationResult<StartTakeoverInput> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Request body is required.' }
  const body = input as StartTakeoverInput
  if (!isRuntime(body.runtime)) return { ok: false, error: 'Runtime must be claude or codex.' }
  const pathError = typeof body.projectPath === 'string' ? validateLocalPath(body.projectPath, 'projectPath') : 'projectPath is required.'
  if (pathError) return { ok: false, error: pathError }
  if (!fs.existsSync(body.projectPath)) return { ok: false, error: 'Project path does not exist.' }
  if (body.outputDir && validateLocalPath(body.outputDir, 'outputDir')) return { ok: false, error: validateLocalPath(body.outputDir, 'outputDir')! }
  return { ok: true, value: { ...body, projectPath: body.projectPath.trim() } }
}
