/**
 * The Today page, the desk's line about it, and the sidebar dot, end to end inside one process: the Client
 * half's requests reach the real Host half's routes, which read the advice files and start runs with a fake
 * `claude` executable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdviceStore, localDate } from '../advice-store.js'
import { isoLocal } from '../inbox-store.js'
import { ADVICE, fakeAgent } from './fake-agents.mjs'
import { mount, sampleState } from './fake-host.mjs'

/**
 * A plugin whose Host half has the advice turned on, pointed at a project directory and fake agents.
 * `open` puts the Today page on screen.
 */
async function opened(advice = {}, { open = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dshcp-advice-panel-'))
  const cwd = join(root, 'sport_health_cc')
  const bin = join(root, 'bin')
  mkdirSync(cwd)
  mkdirSync(bin)
  const claude = fakeAgent(bin, 'claude')
  const inboxDir = join(root, 'data')
  const panel = mount({ ...sampleState(), inboxDir, hostConfig: { advice: { cwd, claudeBin: claude.path, agents: ['claude'], ...advice } } })
  const store = new AdviceStore({ dir: inboxDir })
  if (open) {
    panel.callbacks.onTodayMount()
    await panel.settle()
  }
  return { panel, store, claude, today: localDate(new Date()) }
}

const ready = today => ({
  date: today, status: 'ready', generated_at: isoLocal(new Date(`${today}T08:01:00`)), agent: 'claude', model: 'sonnet',
  trigger: 'schedule', duration_ms: 61000, ...ADVICE, skipped: [], error: null, failures: 0, last_failed_at: null,
})

test('an unconfigured plugin shows the two titled columns on the Today page and how to turn it on', async () => {
  const panel = mount(sampleState())
  panel.callbacks.onTodayMount()
  await panel.settle()
  const html = panel.renderToday()
  assert.match(html, /<h1>今日<\/h1><span class="dshcp-today-date">\d+月\d+日星期.<\/span>/)
  assert.match(html, /<h2>运动计划<\/h2><p class="dshcp-advice-placeholder">未配置<\/p>/)
  assert.match(html, /<h2>饮食建议<\/h2>/)
  assert.equal((html.match(/class="dshcp-advice-card"/g) ?? []).length, 2)
  assert.match(html, /advice\.cwd/)
  panel.callbacks.onPanelMount()
  await panel.settle()
  const desk = panel.render()
  assert.doesNotMatch(desk, /class="dshcp-advice/, 'the desk holds no advice')
  assert.doesNotMatch(desk, /control-panel-today-line/, 'nor a line about it while it is off')
  panel.dispose()
})

test('today\'s advice shows its headline, items, note, and who wrote it', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  store.write(today, ready(today))
  panel.callbacks.onTodayMount()
  await panel.settle()
  const html = panel.renderToday()
  assert.match(html, /<h2>运动计划<\/h2><p class="dshcp-advice-headline">轻松跑 6 km · 心率 ≤145<\/p><ul class="dshcp-advice-items"><li>先热身 10 分钟<\/li><li>跑后拉伸腘绳肌<\/li><\/ul>/)
  assert.match(html, /<h2>饮食建议<\/h2><p class="dshcp-advice-headline">训练日 · 约 1900 kcal<\/p>/)
  assert.match(html, /dshcp-advice-note">最近没有训练记录，按常用周结构安排。</)
  assert.match(html, /<span>sport_health_cc<\/span><span>claude · sonnet 生成于 08:01<\/span><span>每天 08:00 自动生成（claude）<\/span><span><button type="button" class="dshcp-link">重新生成<\/button>/)
  panel.dispose()
})

test('long advice shows every item on the Today page, with nothing to expand', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  const items = n => Array.from({ length: n }, (_, index) => `第 ${index + 1} 条`)
  store.write(today, { ...ready(today), sport: { headline: '休息日', items: items(6) }, diet: { headline: '约 1700 kcal', items: items(4) } })
  panel.callbacks.onTodayMount()
  await panel.settle()
  const html = panel.renderToday()
  assert.equal((html.match(/<li>第 \d+ 条<\/li>/g) ?? []).length, 10)
  assert.doesNotMatch(html, /aria-expanded/)
  panel.dispose()
})

test('the desk keeps one line with today\'s two headlines, and it opens the Today page', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  store.write(today, ready(today))
  panel.callbacks.onPanelMount()
  await panel.settle()
  const html = panel.render()
  assert.match(html, /<button type="button" class="dshcp-today-line" data-testid="control-panel-today-line"><span class="dshcp-today-label">今日<\/span><span class="dshcp-today-text"><span class="dshcp-today-part"><span class="dshcp-today-kind">运动<\/span>轻松跑 6 km · 心率 ≤145<\/span><span class="dshcp-today-part"><span class="dshcp-today-kind">饮食<\/span>训练日 · 约 1900 kcal<\/span><\/span><span class="dshcp-today-go">查看 →<\/span><\/button>/)
  assert.ok(html.indexOf('control-panel-today-line') < html.indexOf('指挥台'), 'the line sits above the command desk')
  assert.doesNotMatch(html, /先热身 10 分钟/, 'the items stay on the Today page')
  panel.callbacks.onOpenToday()
  assert.deepEqual(panel.calls, [['select', 'control-panel-today']])
  panel.dispose()
})

test('the desk line says when the day\'s run is going or failed, and is absent before any run', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.doesNotMatch(panel.render(), /control-panel-today-line/)
  mkdirSync(store.dir, { recursive: true })
  writeFileSync(join(store.dir, 'run.lock'), JSON.stringify({ pid: process.ppid, started_at: isoLocal(new Date()), trigger: 'schedule', agent: 'claude' }))
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.match(panel.render(), /<span class="dshcp-today-text">正在生成今天的建议…<\/span>/)
  rmSync(join(store.dir, 'run.lock'))
  store.write(today, { date: today, status: 'failed', trigger: 'schedule', error: 'claude：超时', failures: 1, last_failed_at: isoLocal(new Date()) })
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.match(panel.render(), /class="dshcp-today-line" data-kind="error"[^>]*><span class="dshcp-today-label">今日<\/span><span class="dshcp-today-text">今天的建议还没生成出来<\/span>/)
  panel.dispose()
})

test('the Today entry shows a dot for new advice until the Today page is opened on it', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  const first = ready(today)
  store.write(today, first)
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.match(panel.renderTodayIcon(16), /<circle/, 'written, not looked at')
  assert.match(panel.render(), /control-panel-today-line/, 'the desk line alone does not count as seen')
  assert.match(panel.renderTodayIcon(16), /<circle/)

  const close = panel.callbacks.onTodayMount()
  await panel.settle()
  assert.doesNotMatch(panel.renderTodayIcon(16), /<circle/)
  assert.equal(store.readSeen(), first.generated_at, 'the Host keeps it, so the dot stays out after a restart')
  close()

  // Written again while the Today page is closed: new advice, so the dot comes back.
  store.write(today, { ...first, generated_at: isoLocal(new Date(`${today}T09:30:00`)) })
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.match(panel.renderTodayIcon(16), /<circle/)
  assert.equal(store.readSeen(), first.generated_at)
  panel.dispose()
})

test('advice that arrives while the Today page is open counts as seen at once', async () => {
  const { panel, store, today } = await opened()
  assert.doesNotMatch(panel.renderTodayIcon(16), /<circle/)
  store.write(today, ready(today))
  panel.callbacks.onAdviceRetry()
  await panel.settle()
  assert.match(panel.renderToday(), /dshcp-advice-headline">轻松跑 6 km/)
  assert.doesNotMatch(panel.renderTodayIcon(16), /<circle/)
  assert.equal(store.readSeen(), ready(today).generated_at)
  panel.dispose()
})

test('the desk\'s counts sit on the title line', async () => {
  const panel = mount(sampleState())
  const html = panel.render()
  assert.match(html, /<div class="dshcp-heading"><h1>控制面板<\/h1><div class="dshcp-band">/)
  panel.dispose()
})

test('a fallback and a failed regeneration are both visible under the advice', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  store.write(today, { ...ready(today), agent: 'opencode', model: null, skipped: [{ agent: 'claude', error: 'rate limit' }], error: 'claude：超时' })
  panel.callbacks.onTodayMount()
  await panel.settle()
  const html = panel.renderToday()
  assert.match(html, /opencode 生成于 08:01/)
  assert.match(html, /claude 没跑成，改用了 opencode/)
  assert.match(html, /role="alert"><span>刚才重新生成没成功：claude：超时<\/span>/)
  panel.dispose()
})

test('a failed day says why, where the log is, and offers a retry', async () => {
  const { panel, store, today } = await opened({}, { open: false })
  store.write(today, { date: today, status: 'failed', trigger: 'schedule', error: 'claude：退出码 1：rate limit', failures: 1, last_failed_at: isoLocal(new Date()) })
  panel.callbacks.onTodayMount()
  await panel.settle()
  const html = panel.renderToday()
  assert.match(html, /dshcp-advice-placeholder">今天的还没生成出来</)
  assert.match(html, /生成失败：claude：退出码 1：rate limit/)
  assert.match(html, />重试<\/button>/)
  assert.ok(html.includes(`日志在 ${store.logPathOf(today)}`))
  panel.dispose()
})

test('before any run the strip offers to write it now', async () => {
  const { panel } = await opened({ at: '00:00' })
  const html = panel.renderToday()
  assert.match(html, /dshcp-advice-placeholder">几分钟内自动生成</)
  assert.match(html, /<span>每天 00:00 自动生成（claude）<\/span><span><button type="button" class="dshcp-link">现在生成<\/button>/)
  panel.dispose()
})

test('writing it now shows the run, then today\'s advice once the agent answers', async () => {
  const { panel, store, claude, today } = await opened()
  panel.callbacks.onAdviceRun()
  await panel.settle()
  const during = panel.advice.getSnapshot().data
  assert.equal(during.running.trigger, 'manual')
  assert.equal(during.running.agent, 'claude')
  assert.match(panel.renderToday(), /dshcp-advice-placeholder">正在生成…</)
  assert.match(panel.renderToday(), /claude 正在读项目资料/)
  for (let waited = 0; store.read(today) === null && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
  for (let waited = 0; store.running() !== null && waited < 2000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(store.read(today).status, 'ready')
  assert.equal(claude.capture().args.includes('Read,Glob,Grep'), true)
  panel.callbacks.onAdviceRetry()
  await panel.settle()
  assert.match(panel.renderToday(), /dshcp-advice-headline">轻松跑 6 km · 心率 ≤145</)
  panel.dispose()
})

test('a run started elsewhere shows as running and blocks another one', async () => {
  const { panel, store } = await opened({}, { open: false })
  mkdirSync(store.dir, { recursive: true })
  writeFileSync(join(store.dir, 'run.lock'), JSON.stringify({ pid: process.ppid, started_at: isoLocal(new Date()), trigger: 'schedule', agent: 'opencode' }))
  panel.callbacks.onTodayMount()
  await panel.settle()
  assert.match(panel.renderToday(), /opencode 正在读项目资料/)
  assert.doesNotMatch(panel.renderToday(), /现在生成/)
  panel.callbacks.onAdviceRun()
  await panel.settle()
  assert.equal(panel.advice.getSnapshot().data.running.trigger, 'schedule')
  panel.dispose()
})

test('a Host half without the advice routes says to restart dsh', async () => {
  const panel = mount({ ...sampleState(), hostMissing: true })
  panel.callbacks.onTodayMount()
  await panel.settle()
  const html = panel.renderToday()
  assert.match(html, /读不到今日建议：插件的 Host 半没有响应/)
  assert.match(html, /dshcp-advice-placeholder">—</)
  panel.dispose()
})

test('asking an unconfigured Host half to run says why it cannot', async () => {
  const panel = mount(sampleState())
  panel.callbacks.onTodayMount()
  await panel.settle()
  panel.callbacks.onAdviceRun()
  await panel.settle()
  assert.equal(panel.advice.getSnapshot().notice, 'advice.cwd is not configured')
  assert.equal(existsSync(join(panel.inboxDir, 'advice')), false)
  panel.dispose()
})
