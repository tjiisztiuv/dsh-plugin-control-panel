/**
 * Memos end to end inside one process: the Client half's requests reach the real Host half's routes,
 * which read and write a real todos.json.
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, sampleState } from './fake-host.mjs'

const stat = (html, label) =>
  new RegExp(`dshcp-stat-value">(\\d+)</span><span class="dshcp-stat-label">${label}`).exec(html)?.[1]

/** A mounted, opened panel whose memo file already holds `texts`. */
async function opened(texts = [], state = sampleState()) {
  const panel = mount(state)
  const outside = panel.outsideMemos()
  const items = texts.map(text => outside.add({ text }))
  panel.callbacks.onPanelMount()
  await panel.settle()
  return { panel, items, outside, stored: () => JSON.parse(readFileSync(join(panel.inboxDir, 'todos.json'), 'utf8')) }
}

test('shows the empty state, then a typed memo after Enter', async () => {
  const { panel, stored } = await opened()
  assert.match(panel.render(), /还没有备忘。/)
  panel.callbacks.onMemoDraft('  周五前回邮件 ')
  panel.callbacks.onMemoSubmit()
  await panel.settle()
  const memos = panel.memos.getSnapshot()
  assert.deepEqual(memos.items.map(item => item.text), ['周五前回邮件'])
  assert.equal(memos.draft, '')
  assert.equal(memos.saving, false)
  assert.equal(stored()[0].text, '周五前回邮件')
  const html = panel.render()
  assert.match(html, /dshcp-memo-text">周五前回邮件</)
  assert.equal(stat(html, '待办'), '1')
})

test('an empty draft saves nothing', async () => {
  const { panel } = await opened()
  panel.callbacks.onMemoDraft('   ')
  panel.callbacks.onMemoSubmit()
  await panel.settle()
  assert.deepEqual(panel.memos.getSnapshot().items, [])
  assert.match(panel.render(), /<button type="button" class="dshcp-button" disabled="">添加<\/button>/)
})

test('ticking a memo moves it below the unfinished ones and out of the to-do count', async () => {
  const { panel, items, outside } = await opened(['第一条', '第二条'])
  panel.callbacks.onMemoToggle(panel.memos.getSnapshot().items[0])
  await panel.settle()
  assert.deepEqual(panel.memos.getSnapshot().items.map(item => [item.text, item.done]), [['第二条', false], ['第一条', true]])
  assert.equal(typeof outside.list()[1].done_at, 'string')
  const html = panel.render()
  assert.equal(stat(html, '待办'), '1')
  assert.match(html, /data-done="true"[^>]*><button[^>]*aria-checked="true"[^>]*aria-label="标记为未完成"/)
  panel.callbacks.onMemoToggle(panel.memos.getSnapshot().items[1])
  await panel.settle()
  assert.deepEqual(panel.memos.getSnapshot().items.map(item => item.id), items.map(item => item.id))
})

test('deleting a memo removes it from the file', async () => {
  const { panel, items, stored } = await opened(['留下', '删掉'])
  panel.callbacks.onMemoRemove(items[1].id)
  await panel.settle()
  assert.deepEqual(stored().map(item => item.text), ['留下'])
  assert.doesNotMatch(panel.render(), /删掉/)
})

test('"+备忘" on a task row saves a memo that jumps back to that session', async () => {
  const { panel } = await opened()
  assert.match(panel.render(), /aria-label="把「修 pytest 临时目录」记到备忘"/)
  panel.callbacks.onTaskMemo({ id: 's-run', title: '修 pytest 临时目录' })
  await panel.settle()
  const memo = panel.memos.getSnapshot().items[0]
  assert.equal(memo.text, '修 pytest 临时目录')
  assert.deepEqual(memo.ref, { dsh_session_id: 's-run' })
  assert.equal(memo.kind, 'text')
  assert.match(panel.render(), />跳到会话<\/button>/)
  panel.callbacks.onMemoGoto(memo)
  assert.deepEqual(panel.calls, [['open', 's-run']])
})

test('says so when a memo\'s session no longer exists, without asking the host to open it', async () => {
  const { panel, outside } = await opened()
  outside.add({ text: '旧会话', ref: { dsh_session_id: 's-deleted' } })
  panel.callbacks.onMemoRetry()
  await panel.settle()
  panel.callbacks.onMemoGoto(panel.memos.getSnapshot().items[0])
  assert.deepEqual(panel.calls, [])
  assert.match(panel.render(), /这个会话已经不在了。/)
})

test('"+备忘" in the message dialog turns the message title into a memo, once', async () => {
  const panel = mount(sampleState())
  const message = panel.outside().add({ source: 'schedule', title: '夜间测试失败', body: '3 failed' })
  panel.callbacks.onPanelMount()
  await panel.settle()
  panel.callbacks.onMessageOpen(panel.inbox.getSnapshot().items[0])
  await panel.settle()
  assert.match(panel.render(), />\+备忘<\/button>/)
  panel.callbacks.onDetailMemo()
  await panel.settle()
  assert.deepEqual(panel.memos.getSnapshot().items.map(item => [item.text, item.kind, item.ref]), [['夜间测试失败', 'text', {}]])
  assert.match(panel.render(), /disabled="">已加入备忘<\/button>/)
  panel.callbacks.onDetailMemo()
  await panel.settle()
  assert.equal(panel.memos.getSnapshot().items.length, 1)
  assert.equal(panel.inbox.getSnapshot().detail.id, message.id)
})

test('a memo made from a SimpleAgent-session message keeps the ids SimpleAgent jumps by', async () => {
  const panel = mount(sampleState())
  panel.outside().add({ source: 'system', title: '会话失败', ref: { space_id: 'sp_1', session_id: 'se_2' } })
  panel.callbacks.onPanelMount()
  await panel.settle()
  panel.callbacks.onMessageOpen(panel.inbox.getSnapshot().items[0])
  await panel.settle()
  panel.callbacks.onDetailMemo()
  await panel.settle()
  const memo = panel.memos.getSnapshot().items[0]
  assert.equal(memo.kind, 'session')
  assert.deepEqual(memo.ref, { space_id: 'sp_1', session_id: 'se_2' })
  assert.doesNotMatch(panel.render(), />跳到会话</, 'a SimpleAgent session cannot be opened here')
})

test('a message about a DSH session that is gone opens as text instead of jumping', async () => {
  const panel = mount(sampleState())
  panel.outside().add({ source: 'dsh', title: '任务失败', body: '原因', ref: { dsh_session_id: 's-deleted' } })
  panel.callbacks.onPanelMount()
  await panel.settle()
  panel.callbacks.onMessageOpen(panel.inbox.getSnapshot().items[0])
  await panel.settle()
  assert.deepEqual(panel.calls, [])
  assert.equal(panel.inbox.getSnapshot().detail.item.body, '原因')
})

test('reports an unusable memo file, leaves it untouched, and recovers once it is repaired', async () => {
  const panel = mount(sampleState())
  const file = join(panel.inboxDir, 'todos.json')
  writeFileSync(file, '{"broken": ')
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.equal(panel.memos.getSnapshot().phase, 'error')
  assert.match(panel.render(), /读不到备忘：.*is not valid JSON/)
  assert.doesNotMatch(panel.render(), /class="dshcp-memo-input"/, 'no input while the file cannot be written safely')
  assert.equal(readFileSync(file, 'utf8'), '{"broken": ')
  writeFileSync(file, '[]')
  panel.callbacks.onMemoRetry()
  await panel.settle()
  assert.equal(panel.memos.getSnapshot().phase, 'ready')
})

test('a failed save keeps the draft and shows the reason', async () => {
  const { panel } = await opened(['已有的'])
  writeFileSync(join(panel.inboxDir, 'todos.json'), 'not json')
  panel.callbacks.onMemoDraft('新的一条')
  panel.callbacks.onMemoSubmit()
  await panel.settle()
  const memos = panel.memos.getSnapshot()
  assert.equal(memos.draft, '新的一条')
  assert.equal(memos.saving, false)
  assert.match(panel.render(), /没保存成功：.*is not valid JSON/)
})

test('picks up memos another tool added on the next poll while the panel is open', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const { panel, outside } = await opened(['原来的'])
    outside.add({ text: '别处加的' })
    mock.timers.tick(30000)
    await panel.settle()
    assert.deepEqual(panel.memos.getSnapshot().items.map(item => item.text), ['原来的', '别处加的'])
    panel.dispose()
  } finally {
    mock.timers.reset()
  }
})
