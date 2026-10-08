/**
 * Daily advice storage: one file per day holding what the agent suggested, plus a lock held while a run is
 * going. The lock is a file, not an in-memory flag, so a second dsh process, or one restarted while its
 * agent is still running, does not start another run.
 *
 *   <dir>/advice/<YYYY-MM-DD>.json  { date, status, generated_at, agent, model, trigger, duration_ms,
 *                                     sport: { headline, items }, diet: { headline, items }, note,
 *                                     error, failures, last_failed_at }, rewritten atomically
 *   <dir>/advice/<YYYY-MM-DD>.log   every attempt's command, exit, and output tail; for when a run fails
 *   <dir>/advice/run.lock           { pid, started_at, trigger, agent } while a run is going
 *   <dir>/advice/seen.json          { generated_at, seen_at }: the newest advice the Today page was opened on.
 *                                   A file of its own, so marking it never races a run rewriting the day
 *
 * `status` is "ready" once any run of the day succeeded; a later failed run keeps that content and only sets
 * `error`. It is "failed" when no run of the day has succeeded yet.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isoLocal } from './inbox-store.js'

export const ADVICE_DIRNAME = 'advice'
export const LOCK_FILENAME = 'run.lock'
export const SEEN_FILENAME = 'seen.json'

/** `YYYY-MM-DD` of a date in local time. */
export function localDate(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomically(path, value) {
  const temporary = `${path}.dshcp-${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Whether a process with this id still exists. EPERM means it does, under another user. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export class AdviceStore {
  /**
   * @param options.dir - the plugin's data directory; advice lives in its `advice/` subdirectory.
   * @param options.clock - returns the current Date; injectable so tests can move time.
   * @param options.staleAfterMs - a lock older than this is abandoned even if its process still exists.
   */
  constructor({ dir, clock = () => new Date(), staleAfterMs = 60 * 60 * 1000 }) {
    this.dir = join(dir, ADVICE_DIRNAME)
    this.clock = clock
    this.staleAfterMs = staleAfterMs
  }

  today() {
    return localDate(this.clock())
  }

  pathOf(date) {
    return join(this.dir, `${date}.json`)
  }

  logPathOf(date) {
    return join(this.dir, `${date}.log`)
  }

  /** The day's record, or null when there is none or it cannot be read. */
  read(date) {
    const record = readJson(this.pathOf(date))
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : null
  }

  write(date, record) {
    mkdirSync(this.dir, { recursive: true })
    writeJsonAtomically(this.pathOf(date), record)
  }

  /** Append one block to the day's log. Logging must never fail a run. */
  log(date, text) {
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.logPathOf(date), text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    } catch {
      // ignored on purpose
    }
  }

  /** `generated_at` of the newest advice the Today page was opened on, or null. */
  readSeen() {
    const seen = readJson(join(this.dir, SEEN_FILENAME))
    return seen !== null && typeof seen === 'object' && typeof seen.generated_at === 'string' ? seen.generated_at : null
  }

  writeSeen(generatedAt) {
    mkdirSync(this.dir, { recursive: true })
    writeJsonAtomically(join(this.dir, SEEN_FILENAME), { generated_at: generatedAt, seen_at: isoLocal(this.clock()) })
  }

  /** The lock's content while a live run holds it, else null. */
  running() {
    const lock = readJson(join(this.dir, LOCK_FILENAME))
    if (lock === null || typeof lock !== 'object') return null
    const started = Date.parse(lock.started_at)
    const fresh = !Number.isNaN(started) && this.clock().getTime() - started < this.staleAfterMs
    return alive(lock.pid) && fresh ? lock : null
  }

  /**
   * Take the run lock. A lock left by a dead process, or one older than `staleAfterMs`, is taken over.
   * @returns a handle with `update(fields)` and `release()`, or null when a live run holds the lock.
   */
  acquire(fields) {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, LOCK_FILENAME)
    const content = { pid: process.pid, started_at: isoLocal(this.clock()), ...fields }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd
      try {
        fd = openSync(path, 'wx', 0o644)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (this.running() !== null) return null
        try { unlinkSync(path) } catch { /* another process took it over first */ }
        continue
      }
      writeSync(fd, JSON.stringify(content))
      closeSync(fd)
      let current = content
      return {
        update: (change) => {
          current = { ...current, ...change }
          try { writeJsonAtomically(path, current) } catch { /* the lock still holds */ }
        },
        release: () => {
          const held = readJson(path)
          if (held !== null && held.pid === process.pid && held.started_at === content.started_at) {
            try { unlinkSync(path) } catch { /* already gone */ }
          }
        },
      }
    }
    return null
  }
}
