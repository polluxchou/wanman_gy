import * as path from 'node:path'

const SHELL_CONTROL_PATTERN = /[;&|`$<>]/
const SECRET_KEYS = /(token|secret|password|api[_-]?key|authorization)/i

export function validateLocalPath(value: string, field: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return `${field} is required.`
  if (SHELL_CONTROL_PATTERN.test(trimmed)) return `${field} cannot contain shell control characters.`
  if (trimmed.includes('\0')) return `${field} cannot contain null bytes.`
  return null
}

export function resolveSafePath(base: string, input: string): string {
  const trimmed = input.trim()
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed)
  return path.resolve(base, trimmed)
}

export function sanitizeMessage(message: string): string {
  return message
    .replace(/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+/gi, '$1[redacted]')
    .replace(/([A-Za-z0-9_]*PASSWORD[A-Za-z0-9_]*=)[^\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
}

export function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEYS.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (typeof value === 'string') out[key] = sanitizeMessage(value)
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeData(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}
