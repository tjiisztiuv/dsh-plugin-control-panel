import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { InboxStore, defaultInboxDir, isoLocal } from '../inbox-store.js'
import { createInboxStore } from '../index.js'

const MINUTE = 60 * 1000

/** A store on a fresh directory whose clock the test moves by hand. */
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshcp-inbox-'))
  const time = { now: new Date('2026-09-18T10:00:00.000+08:00').getTime() }
  const store = new InboxStore({ dir, clock: () => new Date(time.now), ...options })
  return { dir, time, store, advance: (minutes) => { time.now += minutes * MINUTE } }
}

test('appends one JSON line per message in SimpleAgent\'s field order', () => {
  const { dir, store } = fixture()
  const item = store.add({ source: 'schedule', title: '夜间测试', body: '3 failed', level: 'warn' })
  const lines = readFileSync(join(dir, 'inbox.jsonl'), 'utf8').split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[1], '')
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['id', 'source', 'title', 'body', 'ts', 'level', 'ref'])
  assert.match(item.id, /^ms_\d{13}_[0-9a-f]{6}$/)
  assert.match(item.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
  assert.equal(new Date(item.ts).getTime(), new Date('2026-09-18T10:00:00.000+08:00').getTime())
})

test('lists newest first with a preview and no body; get returns the body', () => {
  const { store } = fixture()
  const first = store.add({ source: 'cli', title: '第一条', body: 'line one\n\n  line two' })
  const second = store.add({ source: 'cli', title: '第二条' })
  const rows = store.list()
  assert.deepEqual(rows.map(row => row.id), [second.id, first.id])
  assert.equal(rows[1].preview, 'line one line two')
  assert.equal('body' in rows[1], false)
  assert.equal(store.get(first.id).body, 'line one\n\n  line two')
  assert.equal(store.get('ms_missing'), null)
})

test('an unknown level becomes info, and an overlong body is clipped with a note', () => {
  const { store } = fixture()
  const item = store.add({ source: 'cli', title: 't', body: '字'.repeat(64001), level: 'fatal' })
  assert.equal(item.level, 'info')
  assert.equal(Array.from(item.body).length > 64000, true)
  assert.match(item.body, /原文 64001 字）$/)
  assert.equal(Array.from(store.list()[0].preview).length, 201)
})

test('a message archives itself thirty minutes after it is first opened', () => {
  const { store, advance } = fixture()
  const item = store.add({ source: 'cli', title: 't' })
  advance(600)
  assert.equal(store.list().length, 1, 'never opened, never archived')
  assert.equal(store.markRead(item.id), true)
  assert.equal(store.markRead(item.id), false, 'a second open keeps the first time')
  advance(29)
  assert.equal(store.list()[0].read, true)
  assert.deepEqual(store.counts(), { unread: 0, active: 1, archived: 0 })
  advance(1)
  assert.equal(store.list().length, 0)
  assert.equal(store.list({ view: 'archived' })[0].id, item.id)
  assert.deepEqual(store.counts(), { unread: 0, active: 0, archived: 1 })
})

test('manual archive is immediate, marks the message read, and keeps its first archive time', () => {
  const { store, advance } = fixture()
  const item = store.add({ source: 'cli', title: 't' })
  const archived = store.archive(item.id)
  assert.equal(archived.archived, true)
  assert.equal(archived.read, true)
  advance(5)
  assert.equal(store.archive(item.id).archive_at, archived.archive_at)
  assert.equal(store.archive('ms_missing'), null)
})

test('"all" marks every unread message, and the archived view puts the latest archived first', () => {
  const { store, advance } = fixture()
  const older = store.add({ source: 'cli', title: 'older' })
  const newer = store.add({ source: 'cli', title: 'newer' })
  store.markRead(older.id)
  advance(10)
  assert.equal(store.markRead('all'), true)
  assert.deepEqual(store.counts(), { unread: 0, active: 2, archived: 0 })
  advance(60)
  assert.deepEqual(store.list({ view: 'archived' }).map(row => row.id), [newer.id, older.id])
  assert.equal(store.markRead('ms_missing'), false)
})

test('writes state.json in SimpleAgent\'s shape and leaves no temporary file', () => {
  const { dir, store } = fixture()
  const item = store.add({ source: 'cli', title: 't' })
  store.markRead(item.id)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), {
    [item.id]: { read_at: isoLocal(new Date('2026-09-18T10:00:00.000+08:00')), archived_at: null },
  })
  assert.deepEqual(readdirSync(dir).sort(), ['inbox.jsonl', 'state.json'])
})

test('skips blank, half-written, and non-object lines', () => {
  const { dir, store } = fixture()
  const item = store.add({ source: 'cli', title: 'good' })
  appendFileSync(join(dir, 'inbox.jsonl'), '\n[1,2]\n{"title":"no id"}\n{"id":"ms_half","title":"cut of')
  assert.deepEqual(store.list().map(row => row.id), [item.id])
})

test('reads lines written by SimpleAgent and derives the action from ref', () => {
  const { dir, store } = fixture()
  const line = fields => `${JSON.stringify({ source: 'system', title: 't', body: '', ts: '2026-09-18T09:00:00.000+08:00', level: 'error', ...fields })}\n`
  writeFileSync(join(dir, 'inbox.jsonl'),
    line({ id: 'ms_1', ref: { space_id: 'sp_a', session_id: 'se_b' } })
    + line({ id: 'ms_2', ref: { url: 'https://example.com/report' } })
    + line({ id: 'ms_3', ref: { dsh_session_id: 'abc' } })
    + line({ id: 'ms_4' }))
  const actions = Object.fromEntries(store.list().map(row => [row.id, row.action]))
  assert.deepEqual(actions, { ms_1: 'simpleagent-session', ms_2: 'text', ms_3: 'dsh-session', ms_4: 'text' })
  assert.deepEqual(store.get('ms_4').ref, {})
})

test('migrates the older read.json once, using its modification time', () => {
  const { dir, store, time } = fixture()
  const item = store.add({ source: 'cli', title: 'old' })
  writeFileSync(join(dir, 'read.json'), JSON.stringify([item.id]))
  const yesterday = new Date(time.now - 24 * 60 * MINUTE)
  utimesSync(join(dir, 'read.json'), yesterday, yesterday)
  assert.equal(store.list().length, 0, 'read a day ago, so already archived')
  assert.equal(existsSync(join(dir, 'state.json')), true)
  assert.equal(store.list({ view: 'archived' })[0].read_at, isoLocal(yesterday))
})

test('a corrupt state.json reads as empty instead of failing', () => {
  const { dir, store } = fixture()
  store.add({ source: 'cli', title: 't' })
  writeFileSync(join(dir, 'state.json'), '{"ms_')
  assert.equal(store.list()[0].read, false)
})

test('resolves the directory from row config, then DSH_CONTROL_PANEL_DIR, then ~/.dsh-control-panel', () => {
  const env = { DSH_CONTROL_PANEL_DIR: '/srv/inbox' }
  assert.equal(createInboxStore({ inboxDir: '/data/panel' }, env).dir, '/data/panel')
  assert.equal(createInboxStore({ inboxDir: '~/shared/panel' }, {}).dir, join(homedir(), 'shared/panel'))
  assert.equal(createInboxStore({}, env).dir, '/srv/inbox')
  assert.equal(createInboxStore(undefined, {}).dir, join(homedir(), '.dsh-control-panel'))
  assert.equal(defaultInboxDir({ DSH_CONTROL_PANEL_DIR: '~/elsewhere' }), join(homedir(), 'elsewhere'))
  assert.equal(createInboxStore({}, { SIMPLEAGENT_HOME: '/srv/sa' }).dir, join(homedir(), '.dsh-control-panel'),
    'SimpleAgent\'s directory is used only when configured')
  assert.equal(createInboxStore({ archiveAfterMinutes: 5 }, {}).archiveAfterMinutes, 5)
  assert.equal(createInboxStore({ archiveAfterMinutes: 'soon' }, {}).archiveAfterMinutes, 30)
})
