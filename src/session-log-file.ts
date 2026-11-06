/**
 * Persisted session-log lookup for sessions that are not live in this process.
 *
 * The web client can open a historical session straight from the sidebar: the
 * Host never creates a live `Session` for it, so `ctx.sessions.get(id)` returns
 * `undefined` while the log is already durable on disk. Read-only consumers
 * (trajectory wall) fall back to this module instead of failing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { readSessionLogEvents } from './forge/sessionlog.ts'

const LOG_FILE = /^session\.v\d+\.jsonl(\.zstd|\.zst)?$/

interface CachedLog {
  mtimeMs: number
  size: number
  events: SessionEvent[]
}

/** Decoded logs keyed by absolute path; invalidated by mtime or size drift. */
const cache = new Map<string, CachedLog>()

function sessionsRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

function idVariants(sessionId: string): string[] {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return sessionId === bare ? [sessionId] : [sessionId, bare, `session-${sessionId}`]
}

/**
 * Locate the newest session log file for `sessionId`: every cwd bucket under
 * `<DSH_HOME>/sessions` may hold a `<sessionId>/session.v<N>.jsonl[.zstd]`.
 */
export function findSessionLogFile(sessionId: string): string | undefined {
  const root = sessionsRoot()
  if (!existsSync(root)) return undefined
  let best: { file: string; mtimeMs: number } | undefined
  for (const variant of idVariants(sessionId)) {
    for (const bucket of readdirSync(root, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      const dir = join(root, bucket.name, variant)
      if (!existsSync(dir)) continue
      let files: string[]
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of files) {
        if (!LOG_FILE.test(name)) continue
        const file = join(dir, name)
        let stat
        try {
          stat = statSync(file)
        } catch {
          continue
        }
        if (best === undefined || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs }
      }
    }
    if (best !== undefined) break
  }
  return best?.file
}

/** Restore the logical events of one persisted session log, memoized by file state. */
export function readPersistedSessionEvents(sessionId: string): { file: string; events: SessionEvent[] } | undefined {
  const file = findSessionLogFile(sessionId)
  if (file === undefined) return undefined
  const stat = statSync(file)
  const hit = cache.get(file)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return { file, events: hit.events }
  }
  const events = readSessionLogEvents(readFileSync(file))
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events })
  return { file, events }
}
