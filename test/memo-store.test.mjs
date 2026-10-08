import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isoLocal } from '../inbox-store.js'
import { MemoFileError, MemoStore } from '../memo-store.js'
import { createInboxStore, createMemoStore } from '../index.js'

const MINUTE = 60 * 1000

/** A store on a fresh directory whose clock the test moves by hand. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dshcp-memo-'))
  const time = { now: new Date('2026-09-18T10:00:00.000+08:00').getTime() }
  const store = new MemoStore({ dir, clock: () => new Date(time.now) })
  return { dir, time, store, file: join(dir, 'todos.json'), advance: (minutes) => { time.now += minutes * MINUTE } }
}

test('adds a memo with SimpleAgent\'s fields and writes the file as a JSON array', () => {
  const { store, file } = fixture()
  const item = store.add({ text: '  周五前回邮件  ' })
  assert.match(item.id, /^td_\d{13}_[0-9a-f]{6}$/)
  assert.equal(item.text, '周五前回邮件')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(stored, [{
    id: item.id, text: '周五前回邮件', done: false, kind: 'text', ref: {},
    created_at: isoLocal(new Date('2026-09-18T10:00:00.000+08:00')), done_at: null,
  }])
})

test('refuses an empty memo and writes nothing', () => {
  const { store, dir } = fixture()
  assert.equal(store.add({ text: '   ' }), null)
  assert.equal(store.add({}), null)
  assert.deepEqual(readdirSync(dir), [])
})

test('lists unfinished memos first, each group oldest first', () => {
  const { store, advance } = fixture()
  const first = store.add({ text: 'first' })
  advance(1)
  const second = store.add({ text: 'second' })
  advance(1)
  const third = store.add({ text: 'third' })
  store.update(first.id, { done: true })
  assert.deepEqual(store.list().map(item => item.text), ['second', 'third', 'first'])
  store.update(first.id, { done: false })
  assert.deepEqual(store.list().map(item => item.id), [first.id, second.id, third.id])
})

test('marking done records the time, and unmarking clears it', () => {
  const { store, advance } = fixture()
  const item = store.add({ text: 't' })
  advance(5)
  const done = store.update(item.id, { done: true })
  assert.equal(done.done, true)
  assert.equal(done.done_at, isoLocal(new Date('2026-09-18T10:05:00.000+08:00')))
  assert.equal(store.update(item.id, { done: false }).done_at, null)
})

test('edits the text, and rejects an unknown id or an empty replacement', () => {
  const { store } = fixture()
  const item = store.add({ text: 'old' })
  assert.equal(store.update(item.id, { text: ' new ' }).text, 'new')
  assert.equal(store.update(item.id, { text: '  ' }), null)
  assert.equal(store.update('td_missing', { done: true }), null)
  assert.equal(store.list()[0].text, 'new')
})

test('removes a memo by id', () => {
  const { store } = fixture()
  const keep = store.add({ text: 'keep' })
  const drop = store.add({ text: 'drop' })
  assert.equal(store.remove(drop.id), true)
  assert.equal(store.remove(drop.id), false)
  assert.deepEqual(store.list().map(item => item.id), [keep.id])
})

test('a DSH session memo stays kind "text" so SimpleAgent shows it as a plain memo', () => {
  const { store } = fixture()
  const item = store.add({ text: '修 pytest', kind: 'session', ref: { dsh_session_id: 'abc', nested: { no: 1 }, empty: '' } })
  assert.equal(item.kind, 'text')
  assert.deepEqual(item.ref, { dsh_session_id: 'abc' })
  assert.equal(item.action, 'dsh-session')
})

test('a SimpleAgent session memo keeps kind "session" and its two ids', () => {
  const { store } = fixture()
  const item = store.add({ text: '会话失败', kind: 'session', ref: { space_id: 'sp_1', session_id: 'se_2' } })
  assert.equal(item.kind, 'session')
  assert.equal(item.action, 'simpleagent-session')
  assert.equal(store.add({ text: 'half a ref', kind: 'session', ref: { space_id: 'sp_1' } }).kind, 'text')
})

test('keeps fields it does not know when it rewrites the file', () => {
  const { store, file } = fixture()
  writeFileSync(file, JSON.stringify([
    { id: 'td_1', text: 'from a newer tool', done: false, kind: 'text', ref: {}, created_at: '2026-09-01T08:00:00.000+08:00', done_at: null, priority: 'high' },
  ]))
  store.update('td_1', { done: true })
  store.add({ text: 'another' })
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored[0].priority, 'high')
  assert.equal(stored[0].done, true)
  assert.equal(stored.length, 2)
})

test('never overwrites a file that is not a JSON array', () => {
  for (const content of ['{"td_1": ', '{"not": "an array"}']) {
    const { store, file } = fixture()
    writeFileSync(file, content)
    assert.throws(() => store.list(), MemoFileError)
    assert.throws(() => store.add({ text: 'would clobber' }), MemoFileError)
    assert.throws(() => store.remove('td_1'), MemoFileError)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('leaves no temporary file behind', () => {
  const { store, dir } = fixture()
  store.add({ text: 't' })
  assert.deepEqual(readdirSync(dir), ['todos.json'])
})

test('lives in the same directory as the inbox', () => {
  assert.equal(createMemoStore({ inboxDir: '/data/panel' }, {}).dir, createInboxStore({ inboxDir: '/data/panel' }, {}).dir)
  assert.equal(createMemoStore(undefined, { DSH_CONTROL_PANEL_DIR: '/srv/inbox' }).path, '/srv/inbox/todos.json')
})
