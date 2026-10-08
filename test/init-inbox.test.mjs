import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DIRNAME, InboxStore, defaultInboxDir } from '../inbox-store.js'

const SCRIPT = fileURLToPath(new URL('../scripts/init-inbox.sh', import.meta.url))
const skip = spawnSync('bash', ['--version']).status === 0 ? false : 'bash is not available'

/** Run the script with HOME moved to a fresh directory, so the default location is a sandbox. */
function run(args = [], env = {}) {
  const home = env.HOME ?? mkdtempSync(join(tmpdir(), 'dshcp-home-'))
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env } })
  return { home, ...result }
}

test('creates the directory the plugin reads by default, private to the user', { skip }, () => {
  const { home, status, stdout } = run()
  assert.equal(status, 0)
  // The script and the plugin must agree on the default name.
  const dir = join(home, DEFAULT_DIRNAME)
  assert.equal(DEFAULT_DIRNAME, '.dsh-control-panel')
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(readFileSync(join(dir, 'inbox.jsonl'), 'utf8'), '')
  assert.match(stdout, new RegExp(`消息文件：${dir}/inbox.jsonl`))
  assert.doesNotMatch(stdout, /不是默认目录/)
})

test('running it again keeps the messages already there', { skip }, () => {
  const first = run()
  const inbox = join(first.home, '.dsh-control-panel', 'inbox.jsonl')
  appendFileSync(inbox, '{"id":"ms_keep","title":"留着"}\n')
  assert.equal(run([], { HOME: first.home }).status, 0)
  assert.equal(readFileSync(inbox, 'utf8'), '{"id":"ms_keep","title":"留着"}\n')
})

test('--test appends a message the plugin can read', { skip }, () => {
  const { home, status } = run(['--test'])
  assert.equal(status, 0)
  const rows = new InboxStore({ dir: join(home, '.dsh-control-panel') }).list()
  assert.equal(rows.length, 1)
  assert.match(rows[0].id, /^ms_\d{13}_[0-9a-f]{6}$/)
  assert.equal(rows[0].title, '测试消息')
  assert.equal(rows[0].level, 'success')
  assert.equal(Number.isNaN(Date.parse(rows[0].ts)), false)
})

test('a directory argument or DSH_CONTROL_PANEL_DIR picks another place and says how to point the plugin at it', { skip }, () => {
  const custom = join(mkdtempSync(join(tmpdir(), 'dshcp-custom-')), 'nested', 'inbox')
  const byArgument = run([custom])
  assert.equal(byArgument.status, 0)
  assert.equal(statSync(join(custom, 'inbox.jsonl')).isFile(), true)
  assert.match(byArgument.stdout, new RegExp(`inboxDir: ${custom}`))
  assert.match(byArgument.stdout, new RegExp(`export DSH_CONTROL_PANEL_DIR="${custom}"`))

  const other = join(mkdtempSync(join(tmpdir(), 'dshcp-env-')), 'inbox')
  const byEnvironment = run([], { DSH_CONTROL_PANEL_DIR: other })
  assert.equal(byEnvironment.status, 0)
  assert.equal(statSync(join(other, 'inbox.jsonl')).isFile(), true)
  assert.equal(defaultInboxDir({ DSH_CONTROL_PANEL_DIR: other }), other, 'the plugin resolves the same variable')
})

test('rejects an unknown option and prints usage for --help', { skip }, () => {
  assert.equal(run(['--wipe']).status, 2)
  const help = run(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /scripts\/init-inbox\.sh --test/)
})
