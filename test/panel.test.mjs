import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, sampleState } from './fake-host.mjs'

test('registers two main panels, each with a sidebar entry under the same id, side by side', () => {
  const { definition, plugin, registered, renderIcon, renderTodayIcon } = mount(sampleState())
  assert.equal(definition.id, 'dsh-plugin-control-panel')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'layout'])
  assert.deepEqual(Object.keys(registered.main), ['control-panel', 'control-panel-today'])
  assert.deepEqual(Object.keys(registered['sidebar.panellist']), Object.keys(registered.main))
  const entries = Object.values(registered['sidebar.panellist']).map(({ options }) => [options.order, options.label()])
  assert.deepEqual(entries, [[20, '控制面板'], [21, '今日']])
  assert.match(renderIcon(18), /^<svg width="18" height="18"/)
  assert.doesNotMatch(renderIcon(18), /<circle/, 'no unread dot on an empty inbox')
  assert.match(renderTodayIcon(18), /^<svg width="18" height="18"/)
  assert.doesNotMatch(renderTodayIcon(18), /<circle/, 'no dot before any advice is written')
})

test('lists active and recent top-level sessions, attention first', () => {
  const html = mount(sampleState()).render()
  const position = title => html.indexOf(title)
  for (const title of ['清理下载目录', '修 pytest 临时目录', '写 changelog']) assert.ok(position(title) > 0, title)
  assert.ok(position('清理下载目录') < position('修 pytest 临时目录'), 'waiting sorts before running')
  assert.ok(position('修 pytest 临时目录') < position('写 changelog'), 'running sorts before idle')
  for (const hidden of ['三天前的任务', '空白会话', '子智能体会话', '已归档会话']) assert.equal(position(hidden), -1, hidden)
  assert.match(html, /等待审批/)
  assert.match(html, /SimpleAgent/)
  assert.match(html, /10 分钟前/)
})

test('status band counts running, waiting, unread messages, and recent tasks', () => {
  const html = mount(sampleState()).render()
  const stat = label => new RegExp(`dshcp-stat-value">(\\d+)</span><span class="dshcp-stat-label">${label}`).exec(html)?.[1]
  assert.equal(stat('运行中'), '1')
  assert.equal(stat('等待处理'), '1')
  assert.equal(stat('未读消息'), '0')
  assert.equal(stat('近 24 小时任务'), '3')
})

test('shows the empty states', () => {
  const state = sampleState()
  state.workspaces = { ...state.workspaces, items: [] }
  state.sessions = { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }
  state.statuses = new Map()
  const panel = mount(state)
  assert.match(panel.render(), /还没有工作区/)
  assert.match(panel.render(), /正在读取会话/)
  state.sessions = { ...state.sessions, phase: 'ready' }
  assert.match(panel.render(), /近 24 小时没有任务/)
})

test('renders an empty view when a host hook is missing', () => {
  const html = mount(sampleState()).render({ useSessions: undefined, useSessionStatus: undefined })
  assert.match(html, /控制面板/)
  assert.match(html, /正在读取会话/)
})

test('dispatches the draft to the most recently active workspace', async () => {
  const panel = mount(sampleState())
  panel.callbacks.onDraft('把 tests 下重复的 fixture 提出来')
  panel.callbacks.onDispatch()
  await panel.settle()
  assert.deepEqual(panel.calls, [
    ['connect', 'ws-a'],
    ['using', 'session-in-ws-a', 'controlPanel'],
    ['prompt', 'session-in-ws-a', [{ type: 'text', text: '把 tests 下重复的 fixture 提出来' }], 'queue'],
  ])
  const desk = panel.desk.getSnapshot()
  assert.equal(desk.draft, '')
  assert.equal(desk.sending, false)
  assert.deepEqual(desk.notice, { kind: 'sent', sessionId: 'session-in-ws-a', workspaceId: 'ws-a' })
  assert.match(panel.render(), /已下发到「SimpleAgent」/)
})

test('a leading @name routes the task; a bare @name only switches the workspace', async () => {
  const panel = mount(sampleState())
  panel.callbacks.onDraft('@scr 清一下临时文件')
  panel.callbacks.onDispatch()
  await panel.settle()
  assert.deepEqual(panel.calls[0], ['connect', 'ws-b'])
  assert.deepEqual(panel.calls[2][2], [{ type: 'text', text: '清一下临时文件' }])

  panel.calls.length = 0
  panel.callbacks.onDraft('@SimpleAgent')
  panel.callbacks.onDispatch()
  await panel.settle()
  assert.deepEqual(panel.calls, [])
  assert.equal(panel.desk.getSnapshot().workspaceId, 'ws-a')
  assert.equal(panel.desk.getSnapshot().draft, '')
})

test('an unknown @name reports the problem and sends nothing', async () => {
  const panel = mount(sampleState())
  panel.callbacks.onDraft('@nowhere 做点什么')
  panel.callbacks.onDispatch()
  await panel.settle()
  assert.deepEqual(panel.calls, [])
  assert.equal(panel.desk.getSnapshot().draft, '@nowhere 做点什么')
  assert.match(panel.render(), /找不到名为「nowhere」的工作区/)
})

test('a rejected prompt keeps the draft and shows the reason', async () => {
  const state = sampleState()
  state.promptResult = { ok: false, error: { code: 'session/model-unavailable', message: 'model is unavailable' } }
  const panel = mount(state)
  panel.callbacks.onDraft('跑一下测试')
  panel.callbacks.onDispatch()
  await panel.settle()
  const desk = panel.desk.getSnapshot()
  assert.equal(desk.draft, '跑一下测试')
  assert.equal(desk.sending, false)
  assert.match(panel.render(), /下发失败：model is unavailable/)
})

test('a failed session creation is reported the same way', async () => {
  const state = sampleState()
  state.connectError = 'session create failed: gateway/internal'
  const panel = mount(state)
  panel.callbacks.onDraft('跑一下测试')
  panel.callbacks.onDispatch()
  await panel.settle()
  assert.equal(panel.calls.length, 1)
  assert.match(panel.render(), /下发失败：session create failed/)
})

test('opening a row asks the host to show that session', () => {
  const panel = mount(sampleState())
  panel.callbacks.onOpenSession('s-run')
  assert.deepEqual(panel.calls, [['open', 's-run']])
})

test('both dictionaries define the same keys, and the panel renders in English', () => {
  const panel = mount(sampleState())
  const { zh, en } = panel.dictionaries.controlPanel
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  panel.host.locale = 'en'
  const html = panel.render()
  assert.match(html, /Command desk/)
  assert.match(html, /Awaiting approval/)
})
