/**
 * Cross-check against SimpleAgent's own `panel/store.py`: both implementations work on one directory
 * and must agree on every message's state and on every memo. Set SIMPLEAGENT_SRC to a SimpleAgent checkout and run
 * `npm run test:simpleagent`. Skipped when SIMPLEAGENT_SRC is unset or python3 is missing.
 *
 * store.py is loaded by path with a stub for `simpleagent.config`, so SimpleAgent's dependencies
 * need not be installed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { InboxStore } from '../inbox-store.js'
import { MemoStore } from '../memo-store.js'

const DRIVER = `
import sys, json, types, datetime, importlib.util
from pathlib import Path
if not hasattr(datetime, "UTC"):
    datetime.UTC = datetime.timezone.utc  # store.py imports datetime.UTC, added in Python 3.11
src, home = Path(sys.argv[1]), Path(sys.argv[2])
for name in ("simpleagent", "simpleagent.panel"):
    package = types.ModuleType(name)
    package.__path__ = []
    sys.modules[name] = package
config = types.ModuleType("simpleagent.config")
config.home_dir = lambda: home
sys.modules["simpleagent.config"] = config
spec = importlib.util.spec_from_file_location("simpleagent.panel.store", src / "src/simpleagent/panel/store.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
store = module.PanelStore(home=home)
out = None
for step in json.loads(sys.argv[3]):
    op = step["op"]
    if op == "add":
        out = store.add_message(source=step["source"], title=step["title"], body=step.get("body", ""),
                                level=step.get("level", "info"), ref=step.get("ref")).to_dict()
    elif op == "read":
        out = store.mark_read(step["id"])
    elif op == "archive":
        out = store.archive(step["id"])
    elif op == "dump":
        out = {"active": store.list_messages(view="active", limit=500),
               "archived": store.list_messages(view="archived", limit=500),
               "counts": store.counts()}
    elif op == "get":
        out = store.get_message(step["id"])
    elif op == "todo_add":
        out = store.add_todo(step["text"], kind=step.get("kind", "text"), ref=step.get("ref")).to_dict()
    elif op == "todo_update":
        item = store.update_todo(step["id"], **step["fields"])
        out = item.to_dict() if item else None
    elif op == "todo_delete":
        out = store.delete_todo(step["id"])
    elif op == "todo_list":
        out = store.list_todos()
print(json.dumps(out, ensure_ascii=False))
`

const source = process.env.SIMPLEAGENT_SRC ? resolve(process.env.SIMPLEAGENT_SRC) : undefined
const python = spawnSync('python3', ['--version']).status === 0
const skip = source === undefined ? 'SIMPLEAGENT_SRC is not set'
  : !existsSync(join(source, 'src/simpleagent/panel/store.py')) ? `${source} has no panel/store.py`
    : !python ? 'python3 is not available' : false

test('SimpleAgent\'s store.py and this plugin agree on one shared directory', { skip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'dshcp-sa-'))
  const node = new InboxStore({ dir: join(home, 'panel') })
  const py = (...steps) => {
    const run = spawnSync('python3', ['-c', DRIVER, source, home, JSON.stringify(steps)], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout)
  }
  /** The fields both sides must report identically; `action` differs by design and is checked apart. */
  const comparable = row => ({
    id: row.id, source: row.source, title: row.title, level: row.level, ref: row.ref, preview: row.preview,
    ts: Date.parse(row.ts), read: row.read, read_at: row.read_at, archived: row.archived,
    archive_at: row.archive_at === null ? null : Date.parse(row.archive_at),
  })
  const agree = (label) => {
    const theirs = py({ op: 'dump' })
    for (const view of ['active', 'archived']) {
      assert.deepEqual(node.list({ view, limit: 500 }).map(comparable), theirs[view].map(comparable), `${label}: ${view}`)
    }
    assert.deepEqual(node.counts(), theirs.counts, `${label}: counts`)
    return theirs
  }

  const report = py({ op: 'add', source: 'schedule', title: '夜间测试', body: 'FAILED tests/test_a.py\\n\\n  3 failed, 818 passed', level: 'warn' })
  const failure = py({ op: 'add', source: 'system', title: '会话失败', level: 'error', ref: { space_id: 'sp_1', session_id: 'se_2' } })
  const ours = node.add({ source: 'dsh', title: '任务失败：修 pytest', body: 'model is unavailable', level: 'error', ref: { dsh_session_id: 'abc-123' } })
  let theirs = agree('after three appends')
  const action = Object.fromEntries(theirs.active.map(row => [row.id, row.action]))
  assert.equal(action[failure.id], 'session')
  assert.equal(action[ours.id], 'text', 'SimpleAgent shows a DSH-session message as plain text')
  assert.equal(node.get(failure.id).action, 'simpleagent-session')
  assert.equal(node.get(report.id).body, py({ op: 'get', id: report.id }).body)
  assert.equal(py({ op: 'get', id: ours.id }).body, 'model is unavailable')

  assert.equal(node.markRead(report.id), true)
  agree('after this plugin marks one read')

  assert.equal(py({ op: 'archive', id: failure.id }).archived, true)
  theirs = agree('after SimpleAgent archives one')
  assert.deepEqual(theirs.archived.map(row => row.id), [failure.id])

  assert.equal(py({ op: 'read', id: 'all' }), true)
  assert.equal(agree('after SimpleAgent marks all read').counts.unread, 0)

  assert.equal(node.archive(ours.id).archived, true)
  assert.deepEqual(agree('after this plugin archives one').counts, { unread: 0, active: 1, archived: 2 })
})

test('SimpleAgent\'s store.py and this plugin agree on one shared todos.json', { skip }, () => {
  const home = mkdtempSync(join(tmpdir(), 'dshcp-sa-memo-'))
  const node = new MemoStore({ dir: join(home, 'panel') })
  const py = (...steps) => {
    const run = spawnSync('python3', ['-c', DRIVER, source, home, JSON.stringify(steps)], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return JSON.parse(run.stdout)
  }
  const comparable = ({ id, text, done, kind, ref, created_at, done_at }) => ({ id, text, done, kind, ref, created_at, done_at })
  const agree = (label) => {
    const theirs = py({ op: 'todo_list' })
    assert.deepEqual(node.list().map(comparable), theirs.map(comparable), label)
    return theirs
  }

  const fromThem = py({ op: 'todo_add', text: 'SimpleAgent 加的' })
  const fromUs = node.add({ text: '插件加的', ref: { dsh_session_id: 'abc-123' } })
  const session = py({ op: 'todo_add', text: '会话备忘', kind: 'session', ref: { space_id: 'sp_1', session_id: 'se_2' } })
  let theirs = agree('after three adds')
  assert.equal(theirs.find(item => item.id === fromUs.id).kind, 'text', 'SimpleAgent shows a DSH-session memo as a plain memo')
  assert.equal(node.list().find(item => item.id === session.id).action, 'simpleagent-session')

  assert.equal(node.update(fromThem.id, { done: true }).done, true)
  theirs = agree('after this plugin ticks one')
  assert.deepEqual(theirs.map(item => item.id), [fromUs.id, session.id, fromThem.id], 'finished memos sink on both sides')

  assert.equal(py({ op: 'todo_update', id: fromUs.id, fields: { text: 'SimpleAgent 改过的' } }).text, 'SimpleAgent 改过的')
  agree('after SimpleAgent edits one')

  assert.equal(py({ op: 'todo_delete', id: session.id }), true)
  agree('after SimpleAgent deletes one')

  assert.equal(node.remove(fromThem.id), true)
  theirs = agree('after this plugin deletes one')
  assert.deepEqual(theirs.map(item => [item.text, item.ref]), [['SimpleAgent 改过的', { dsh_session_id: 'abc-123' }]])
})
