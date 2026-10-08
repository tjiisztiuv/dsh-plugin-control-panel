/**
 * Memo storage: one JSON file holding every memo, rewritten atomically on each change.
 *
 *   <dir>/todos.json   [ { id, text, done, kind, ref, created_at, done_at }, ... ]
 *
 * The file name and the fields are the ones SimpleAgent's panel directory uses, so pointing `dir` at that
 * directory shares one memo list between the two tools.
 *
 * `ref` decides whether a memo can jump somewhere. This plugin writes { dsh_session_id } for a DSH session
 * and keeps `kind` as "text", which SimpleAgent shows as a plain memo. SimpleAgent writes
 * kind "session" with { space_id, session_id }, which this plugin shows as a plain memo.
 *
 * Entries are kept as the objects read from disk, so a field this version does not know survives a rewrite.
 * A file that exists but does not hold a JSON array is never overwritten: every operation fails with a
 * {@link MemoFileError} until someone repairs or removes it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isoLocal } from './inbox-store.js'

export const TODOS_FILENAME = 'todos.json'

/** The memo file exists but cannot be used; its content is left untouched. */
export class MemoFileError extends Error {
  constructor(path, reason) {
    super(`${path} ${reason}; repair or remove the file`)
    this.name = 'MemoFileError'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Keep only string-valued entries: a reference is a small set of ids, never nested data. */
function cleanRef(ref) {
  const clean = {}
  if (isRecord(ref)) {
    for (const [key, value] of Object.entries(ref)) if (typeof value === 'string' && value !== '') clean[key] = value
  }
  return clean
}

/** Where a memo can jump: a DSH session, a SimpleAgent session, or nowhere. */
function actionOf(kind, ref) {
  if (typeof ref.dsh_session_id === 'string' && ref.dsh_session_id !== '') return 'dsh-session'
  if (kind === 'session' && ref.space_id && ref.session_id) return 'simpleagent-session'
  return 'text'
}

function viewOf(raw) {
  const ref = cleanRef(raw.ref)
  const kind = raw.kind === 'session' ? 'session' : 'text'
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    done: raw.done === true,
    kind,
    ref,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    done_at: typeof raw.done_at === 'string' ? raw.done_at : null,
    action: actionOf(kind, ref),
  }
}

export class MemoStore {
  /**
   * @param options.dir - directory holding todos.json.
   * @param options.clock - returns the current Date; injectable so tests can move time.
   */
  constructor({ dir, clock = () => new Date() }) {
    this.dir = dir
    this.path = join(dir, TODOS_FILENAME)
    this.clock = clock
  }

  /** Every memo: unfinished first, then by creation time, oldest first. */
  list() {
    const time = view => {
      const at = Date.parse(view.created_at)
      return Number.isNaN(at) ? 0 : at
    }
    return this.read().map(viewOf)
      .map((view, index) => ({ view, index }))
      .sort((left, right) => (Number(left.view.done) - Number(right.view.done))
        || (time(left.view) - time(right.view)) || (left.index - right.index))
      .map(entry => entry.view)
  }

  /**
   * Append a memo.
   * @param input.text - the note; surrounding whitespace is dropped.
   * @param input.kind - "session" is kept only together with SimpleAgent's { space_id, session_id }.
   * @param input.ref - optional jump target; non-string values are dropped.
   * @returns the new memo, or null when the text is empty.
   */
  add({ text, kind, ref }) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') return null
    const items = this.read()
    const cleaned = cleanRef(ref)
    const raw = {
      id: `td_${Date.now()}_${randomBytes(3).toString('hex')}`,
      text: trimmed,
      done: false,
      kind: kind === 'session' && cleaned.space_id && cleaned.session_id ? 'session' : 'text',
      ref: cleaned,
      created_at: isoLocal(this.clock()),
      done_at: null,
    }
    items.push(raw)
    this.write(items)
    return viewOf(raw)
  }

  /**
   * Change a memo's text, its done state, or both.
   * @returns the updated memo, or null when the id is unknown or the new text is empty.
   */
  update(id, { text, done }) {
    const items = this.read()
    const raw = items.find(item => item.id === id)
    if (raw === undefined) return null
    if (text !== undefined) {
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (trimmed === '') return null
      raw.text = trimmed
    }
    if (done !== undefined) {
      raw.done = done === true
      raw.done_at = raw.done ? isoLocal(this.clock()) : null
    }
    this.write(items)
    return viewOf(raw)
  }

  /** @returns whether a memo with this id existed and was removed. */
  remove(id) {
    const items = this.read()
    const kept = items.filter(item => item.id !== id)
    if (kept.length === items.length) return false
    this.write(kept)
    return true
  }

  /** The file's entries as stored. A missing file is an empty list; an unusable one throws. */
  read() {
    if (!existsSync(this.path)) return []
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      throw new MemoFileError(this.path, 'is not valid JSON')
    }
    if (!Array.isArray(parsed)) throw new MemoFileError(this.path, 'does not hold a JSON array')
    return parsed.filter(isRecord)
  }

  /** Write a private temporary file, then rename over todos.json; a crash never leaves half a file. */
  write(items) {
    mkdirSync(this.dir, { recursive: true })
    const temporary = `${this.path}.dshcp-${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(items, null, 2), 'utf8')
    renameSync(temporary, this.path)
  }
}
