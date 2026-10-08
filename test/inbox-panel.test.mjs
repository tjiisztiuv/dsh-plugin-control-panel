/**
 * The inbox end to end inside one process: the Client half's requests reach the real Host half's routes,
 * which read and write a real directory. Messages arrive the way they do in use, through a second store
 * handle on that directory standing in for `sa inbox push`.
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mount, sampleState } from './fake-host.mjs'

const MINUTE = 60 * 1000
const stat = (html, label) =>
  new RegExp(`dshcp-stat-value">(\\d+)</span><span class="dshcp-stat-label">${label}`).exec(html)?.[1]

/** A mounted panel whose inbox already holds `messages`, opened so the list is loaded. */
async function opened(messages, state = sampleState()) {
  const panel = mount(state)
  const outside = panel.outside()
  const items = messages.map(message => outside.add({ source: 'cli', title: 't', ...message }))
  panel.callbacks.onPanelMount()
  await panel.settle()
  return { panel, items, outside, listed: id => panel.inbox.getSnapshot().items.find(item => item.id === id) }
}

test('lists pushed messages newest first with the unread count in three places', async () => {
  const { panel, items } = await opened([
    { source: 'schedule', title: '夜间测试', body: 'FAILED tests/test_a.py\n3 failed, 818 passed', level: 'warn' },
    { title: '备份完成', body: 'NAS 增量备份 12.3 GB', level: 'success' },
  ])
  const inbox = panel.inbox.getSnapshot()
  assert.equal(inbox.phase, 'ready')
  assert.deepEqual(inbox.items.map(item => item.id), [items[1].id, items[0].id])
  assert.deepEqual(inbox.counts, { unread: 2, active: 2, archived: 0 })
  const html = panel.render()
  assert.ok(html.indexOf('备份完成') < html.indexOf('夜间测试'))
  assert.match(html, /FAILED tests\/test_a\.py 3 failed, 818 passed/)
  assert.match(html, /<span>schedule<\/span>/)
  assert.match(html, /dshcp-badge">2</)
  assert.equal(stat(html, '未读消息'), '2')
  assert.match(panel.renderIcon(16), /<circle/)
  assert.match(html, /点开过的消息 30 分钟后自动归档/)
})

test('opening a message records the read on disk and shows the full text', async () => {
  const body = `第一行\n\n${'很长的报告 '.repeat(60)}`
  const { panel, items, outside, listed } = await opened([{ title: '周报', body }])
  assert.equal(listed(items[0].id).preview.endsWith('…'), true, 'the list carries only a clipped preview')
  panel.callbacks.onMessageOpen(listed(items[0].id))
  await panel.settle()
  const detail = panel.inbox.getSnapshot().detail
  assert.equal(detail.loading, false)
  assert.equal(detail.item.body, body)
  assert.equal(outside.get(items[0].id).read, true)
  assert.equal(existsSync(join(panel.inboxDir, 'state.json')), true)
  assert.equal(panel.inbox.getSnapshot().counts.unread, 0)
  const html = panel.render()
  assert.match(html, /role="dialog"/)
  assert.match(html, /很长的报告 很长的报告/)
  for (const label of ['复制', '归档', '关闭']) assert.match(html, new RegExp(`>${label}</button>`))
  assert.doesNotMatch(html, /打开链接/)
  panel.callbacks.onDetailClose()
  assert.doesNotMatch(panel.render(), /role="dialog"/)
})

test('offers a link only for an http(s) url', async () => {
  const { panel, items, listed } = await opened([
    { title: 'safe', ref: { url: 'https://example.com/report' } },
    { title: 'unsafe', ref: { url: 'javascript:alert(1)' } },
  ])
  panel.callbacks.onMessageOpen(listed(items[0].id))
  await panel.settle()
  assert.match(panel.render(), /href="https:\/\/example\.com\/report"[^>]*>打开链接/)
  panel.callbacks.onMessageOpen(listed(items[1].id))
  await panel.settle()
  assert.doesNotMatch(panel.render(), /打开链接|javascript:/)
})

test('archiving from the dialog moves the message to the archived view', async () => {
  const { panel, items, listed } = await opened([{ title: '要归档的' }, { title: '留下的' }])
  panel.callbacks.onMessageOpen(listed(items[0].id))
  await panel.settle()
  panel.callbacks.onDetailArchive(items[0].id)
  await panel.settle()
  assert.equal(panel.inbox.getSnapshot().detail, null)
  assert.deepEqual(panel.inbox.getSnapshot().items.map(item => item.id), [items[1].id])
  panel.callbacks.onInboxView('archived')
  await panel.settle()
  assert.deepEqual(panel.inbox.getSnapshot().items.map(item => item.id), [items[0].id])
  assert.doesNotMatch(panel.render(), /自动归档/, 'the countdown hint belongs to the current view')
})

test('"mark all read" clears the unread count and keeps the messages current', async () => {
  const { panel } = await opened([{ title: 'a' }, { title: 'b' }, { title: 'c' }])
  assert.match(panel.render(), />全部已读</)
  panel.callbacks.onMarkAllRead()
  await panel.settle()
  assert.deepEqual(panel.inbox.getSnapshot().counts, { unread: 0, active: 3, archived: 0 })
  assert.doesNotMatch(panel.render(), />全部已读</)
  assert.doesNotMatch(panel.renderIcon(16), /<circle/)
})

test('a message read more than thirty minutes ago is already in the archive', async () => {
  const panel = mount(sampleState())
  const item = panel.outside().add({ source: 'cli', title: '看过的' })
  panel.outside({ clock: () => new Date(Date.now() - 31 * MINUTE) }).markRead(item.id)
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.deepEqual(panel.inbox.getSnapshot().items, [])
  assert.ok(panel.render().includes(`没有消息。往 ${panel.inboxDir}/inbox.jsonl 追加一行 JSON 就能投递`))
  panel.callbacks.onInboxView('archived')
  await panel.settle()
  assert.deepEqual(panel.inbox.getSnapshot().items.map(row => row.id), [item.id])
})

test('a message about a DSH session opens that session instead of the dialog', async () => {
  const { panel, items, outside, listed } = await opened([{ title: '任务失败', level: 'error', ref: { dsh_session_id: 's-run' } }])
  panel.callbacks.onMessageOpen(listed(items[0].id))
  await panel.settle()
  assert.deepEqual(panel.calls, [['open', 's-run']])
  assert.equal(panel.inbox.getSnapshot().detail, null)
  assert.equal(outside.get(items[0].id).read, true)
})

test('a message about a SimpleAgent session opens as text with a note', async () => {
  const { panel, items, listed } = await opened([{ title: '会话失败', body: '原因在这里', ref: { space_id: 'sp_1', session_id: 'se_2' } }])
  panel.callbacks.onMessageOpen(listed(items[0].id))
  await panel.settle()
  const html = panel.render()
  assert.match(html, /这条消息指向 SimpleAgent 里的一个会话/)
  assert.match(html, /原因在这里/)
})

test('says so when the Host half is not serving the routes', async () => {
  const state = sampleState()
  state.hostMissing = true
  const panel = mount(state)
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.equal(panel.inbox.getSnapshot().phase, 'error')
  assert.match(panel.render(), /读不到消息：插件的 Host 半没有响应/)
  assert.match(panel.render(), />重试</)
  assert.match(panel.render(), /清理下载目录/, 'the rest of the panel still renders')
})

test('polls every thirty seconds: counts only while the panel is closed, the list once it is open', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const panel = mount(sampleState())
    await panel.settle()
    panel.outside().add({ source: 'cli', title: '面板关着时来的' })
    mock.timers.tick(30000)
    await panel.settle()
    assert.equal(panel.inbox.getSnapshot().counts.unread, 1)
    assert.deepEqual(panel.inbox.getSnapshot().items, [], 'closed panel does not read the list')
    assert.match(panel.renderIcon(16), /<circle/)

    const unmount = panel.callbacks.onPanelMount()
    await panel.settle()
    panel.outside().add({ source: 'cli', title: '面板开着时来的' })
    mock.timers.tick(30000)
    await panel.settle()
    assert.deepEqual(panel.inbox.getSnapshot().items.map(item => item.title), ['面板开着时来的', '面板关着时来的'])
    unmount()
    panel.dispose()
  } finally {
    mock.timers.reset()
  }
})
