/** Extract probable file paths from freeform text (task results, artifact metadata). */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  // Match absolute paths (/foo/bar.ts), home paths (~/foo), relative (./foo, ../foo)
  const pathRe = /(?:^|\s|["'`(])((?:\/|~\/|\.\.?\/)[^\s"'`),;>]+)/gm;
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(text)) !== null) {
    const p = match[1]!.replace(/[.,;)>]+$/, '');
    if (p.length > 2 && !seen.has(p)) {
      seen.add(p);
      results.push(p);
    }
  }
  return results;
}

/** Copy text to clipboard; returns true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Format a timestamp (ms) for display. */
export function formatTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

/** Format a timestamp (ms) as full localeString. */
export function formatDateTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}
