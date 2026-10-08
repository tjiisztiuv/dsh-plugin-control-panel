/**
 * Inbox storage: an append-only message file that any script can write, plus a state file this plugin
 * owns. The format is the one SimpleAgent's panel directory uses, so pointing `dir` at that directory
 * shares one inbox between the two tools.
 *
 *   <dir>/inbox.jsonl  append-only; one JSON object per line: { id, source, title, body, ts, level, ref }
 *   <dir>/state.json   { "<id>": { "read_at": iso | null, "archived_at": iso | null } }, rewritten atomically
 *   <dir>/read.json    SimpleAgent's older read list (ids only); migrated once when state.json is absent
 *
 * Archiving is computed, never moved:
 *   archive_at = archived_at ?? read_at + archiveAfter       (never opened => never archived)
 *   archived   = now >= archive_at
 *
 * `ref` decides what opening a message does. SimpleAgent writes { space_id, session_id } or { url };
 * this plugin writes { dsh_session_id } for a DSH session, which SimpleAgent shows as plain text.
 *
 * Both tools may run at once. Appends are one O_APPEND write of a whole line, so lines never interleave.
 * state.json is read-modify-rename by whichever tool handles the click; two clicks in the two UIs within
 * the same few milliseconds can lose one of them.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const INBOX_FILENAME = 'inbox.jsonl'
export const STATE_FILENAME = 'state.json'
export const LEGACY_READ_FILENAME = 'read.json'
export const DEFAULT_ARCHIVE_AFTER_MINUTES = 30
export const PREVIEW_CHARS = 200
export const MAX_BODY_CHARS = 64000
export const LEVELS = ['info', 'success', 'warn', 'error']

/** Expand a leading `~` the way a shell would. */
export function expandHome(path) {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export const DEFAULT_DIRNAME = '.dsh-control-panel'
export const DIR_ENV = 'DSH_CONTROL_PANEL_DIR'

/** The inbox directory when the row config names none: `$DSH_CONTROL_PANEL_DIR`, else `~/.dsh-control-panel`. */
export function defaultInboxDir(env = process.env) {
  const override = env[DIR_ENV]
  return typeof override === 'string' && override.trim() !== ''
    ? expandHome(override.trim())
    : join(homedir(), DEFAULT_DIRNAME)
}

/** Local time with offset and milliseconds, e.g. `2026-09-18T10:00:00.000+08:00`; Python's `isoformat` shape. */
export function isoLocal(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

/** Epoch milliseconds of a stored timestamp, or null. A timestamp without a zone reads as local time. */
function parseTime(value) {
  if (value === null || value === undefined || value === '') return null
  const at = Date.parse(String(value))
  return Number.isNaN(at) ? null : at
}

function clipBody(body) {
  const chars = Array.from(body)
  if (chars.length <= MAX_BODY_CHARS) return body
  return `${chars.slice(0, MAX_BODY_CHARS).join('')}\n\n…（正文过长已截断，原文 ${chars.length} 字）`
}

function previewOf(body) {
  const flat = Array.from(body.split(/\s+/).filter(part => part !== '').join(' '))
  return flat.length <= PREVIEW_CHARS ? flat.join('') : `${flat.slice(0, PREVIEW_CHARS).join('').trimEnd()}…`
}

/** What opening the message does: jump to a DSH session, note a SimpleAgent session, or show the text. */
function actionOf(ref) {
  if (typeof ref.dsh_session_id === 'string' && ref.dsh_session_id !== '') return 'dsh-session'
  if (ref.space_id && ref.session_id) return 'simpleagent-session'
  return 'text'
}

function itemOf(raw) {
  const text = (value, fallback) => (typeof value === 'string' ? value : fallback)
  const ref = raw.ref !== null && typeof raw.ref === 'object' && !Array.isArray(raw.ref) ? { ...raw.ref } : {}
  return {
    id: String(raw.id),
    source: text(raw.source, 'system'),
    title: text(raw.title, ''),
    body: text(raw.body, ''),
    ts: text(raw.ts, ''),
    level: text(raw.level, 'info'),
    ref,
  }
}

export class InboxStore {
  /**
   * @param options.dir - directory holding inbox.jsonl and state.json.
   * @param options.archiveAfterMinutes - minutes from first open to automatic archiving.
   * @param options.clock - returns the current Date; injectable so tests can move time.
   */
  constructor({ dir, archiveAfterMinutes = DEFAULT_ARCHIVE_AFTER_MINUTES, clock = () => new Date() }) {
    this.dir = dir
    this.archiveAfterMinutes = archiveAfterMinutes
    this.archiveAfterMs = archiveAfterMinutes * 60 * 1000
    this.clock = clock
  }

  /** Append one message as a single whole-line write. */
  add({ source, title, body = '', level = 'info', ref = {} }) {
    mkdirSync(this.dir, { recursive: true })
    const item = {
      id: `ms_${Date.now()}_${randomBytes(3).toString('hex')}`,
      source,
      title,
      body: clipBody(body),
      ts: isoLocal(this.clock()),
      level: LEVELS.includes(level) ? level : 'info',
      ref,
    }
    const descriptor = openSync(join(this.dir, INBOX_FILENAME), 'a', 0o644)
    try {
      writeSync(descriptor, Buffer.from(`${JSON.stringify(item)}\n`, 'utf8'))
    } finally {
      closeSync(descriptor)
    }
    return item
  }

  /** Record the first open; later opens keep the original time. `all` or `*` marks every unread message. */
  markRead(id) {
    const ids = new Set(this.items().map(item => item.id))
    const targets = id === 'all' || id === '*' ? [...ids] : ids.has(id) ? [id] : []
    const state = this.state()
    const now = isoLocal(this.clock())
    let changed = false
    for (const target of targets) {
      const entry = state[target] ?? (state[target] = { read_at: null, archived_at: null })
      if (!entry.read_at) {
        entry.read_at = now
        changed = true
      }
    }
    if (changed) this.writeState(state)
    return changed
  }

  /** Archive now. An unopened message also becomes read. Returns the list view of the item, or null. */
  archive(id) {
    const item = this.items().find(candidate => candidate.id === id)
    if (item === undefined) return null
    const state = this.state()
    const now = this.clock()
    const entry = state[id] ?? (state[id] = { read_at: null, archived_at: null })
    if (!this.status(entry, now.getTime()).archived) {
      entry.read_at = entry.read_at || isoLocal(now)
      entry.archived_at = isoLocal(now)
      this.writeState(state)
    }
    return this.view(item, entry, now.getTime(), false)
  }

  /** Messages of one view without bodies. Active: newest first. Archived: most recently archived first. */
  list({ view = 'active', limit = 50, unreadOnly = false } = {}) {
    const now = this.clock().getTime()
    const state = this.state()
    const rows = []
    for (const item of this.items().reverse()) {
      const entry = state[item.id] ?? {}
      const status = this.status(entry, now)
      if (status.archived !== (view === 'archived') || (unreadOnly && status.read)) continue
      rows.push({ archiveAt: status.archiveAt, value: this.view(item, entry, now, false) })
    }
    if (view === 'archived') rows.sort((left, right) => (right.archiveAt ?? now) - (left.archiveAt ?? now))
    return rows.slice(0, limit).map(row => row.value)
  }

  /** One message with its full body, or null. */
  get(id) {
    const item = this.items().find(candidate => candidate.id === id)
    if (item === undefined) return null
    return this.view(item, this.state()[id] ?? {}, this.clock().getTime(), true)
  }

  counts() {
    const now = this.clock().getTime()
    const state = this.state()
    const counts = { unread: 0, active: 0, archived: 0 }
    for (const item of this.items()) {
      const status = this.status(state[item.id] ?? {}, now)
      counts[status.archived ? 'archived' : 'active'] += 1
      if (!status.read) counts.unread += 1
    }
    return counts
  }

  /** Every well-formed line in file order. A half-written last line is skipped and read complete next time. */
  items() {
    const path = join(this.dir, INBOX_FILENAME)
    if (!existsSync(path)) return []
    const items = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let raw
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.id) items.push(itemOf(raw))
    }
    return items
  }

  status(entry, now) {
    const readAt = parseTime(entry.read_at)
    const archiveAt = parseTime(entry.archived_at) ?? (readAt === null ? null : readAt + this.archiveAfterMs)
    return { read: readAt !== null, archiveAt, archived: archiveAt !== null && now >= archiveAt }
  }

  view(item, entry, now, full) {
    const status = this.status(entry, now)
    const { body, ...rest } = item
    return {
      ...rest,
      ...(full ? { body } : {}),
      preview: previewOf(body),
      action: actionOf(item.ref),
      read: status.read,
      read_at: entry.read_at ?? null,
      archive_at: status.archiveAt === null ? null : isoLocal(new Date(status.archiveAt)),
      archived: status.archived,
    }
  }

  state() {
    const path = join(this.dir, STATE_FILENAME)
    if (!existsSync(path)) return this.migrateLegacyRead()
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  /** The older read.json has ids but no times; its mtime becomes every id's read_at. */
  migrateLegacyRead() {
    const legacy = join(this.dir, LEGACY_READ_FILENAME)
    if (!existsSync(legacy)) return {}
    let ids
    try {
      ids = JSON.parse(readFileSync(legacy, 'utf8'))
    } catch {
      return {}
    }
    if (!Array.isArray(ids)) return {}
    const readAt = isoLocal(statSync(legacy).mtime)
    const state = {}
    for (const id of ids) if (id) state[String(id)] = { read_at: readAt, archived_at: null }
    this.writeState(state)
    return state
  }

  /** Write a private temporary file, then rename over state.json; a crash never leaves half a file. */
  writeState(state) {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, STATE_FILENAME)
    const temporary = `${path}.dshcp-${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 1), 'utf8')
    renameSync(temporary, path)
  }
}
