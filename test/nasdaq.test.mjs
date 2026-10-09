/**
 * The desk's Nasdaq line: settings, reading the tool's files, a run of a fake nasdaq_valuation tool as a real
 * child process, when a run is due, and the line on the Control Panel page end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdviceStore, localDate } from '../advice-store.js'
import { isoLocal } from '../inbox-store.js'
import { nasdaqRoutes } from '../index.js'
import {
  NasdaqService, changeOf, normalizeNasdaqSettings, quoteOf, readQuote, startNasdaq,
} from '../nasdaq-runner.js'
import { NASDAQ, fakeNasdaqTool } from './fake-agents.mjs'
import { mount, sampleState } from './fake-host.mjs'

const MINUTE = 60 * 1000

/** A data directory, a tool directory with the fake tool in it, and a clock the test moves by hand. */
function fixture(at = '2026-10-09T08:10:00.000+08:00') {
  const root = mkdtempSync(join(tmpdir(), 'dshcp-nasdaq-'))
  const dir = join(root, 'data')
  const cwd = join(root, 'nasdaq_valuation')
  for (const path of [dir, cwd]) mkdirSync(path)
  const time = { now: new Date(at).getTime() }
  const clock = () => new Date(time.now)
  const tool = fakeNasdaqTool(cwd)
  const settings = normalizeNasdaqSettings({ cwd, command: [tool.path, '--flag'] })
  return {
    root, dir, cwd, time, clock, tool, settings,
    store: new AdviceStore({ dir, clock, name: 'nasdaq' }),
    advance: (minutes) => { time.now += minutes * MINUTE },
  }
}

/** A day the tool's numbers came in, as the Host half saves it. */
const ready = (date, fields = {}) => ({
  date, status: 'ready', generated_at: isoLocal(new Date(`${date}T08:11:00`)), trigger: 'schedule', duration_ms: 21000,
  report_date: NASDAQ.report_date, close: NASDAQ.close, valuation_score: NASDAQ.valuation_score, sma_score: NASDAQ.sma_score,
  signals_at: `${date}T08:10:58+08:00`, prev_date: '2026-10-07', prev_close: NASDAQ.prev_close, change_pct: -1.39,
  error: null, failures: 0, last_failed_at: null, ...fields,
})

test('settings default to main.py under /usr/bin/python3 at 08:10, and bad values fall back', () => {
  assert.deepEqual(normalizeNasdaqSettings(undefined), {
    cwd: '', at: '08:10', command: ['/usr/bin/python3', 'main.py'], timeoutMinutes: 5,
  })
  const settings = normalizeNasdaqSettings({ cwd: ' ~/tools/nasdaq ', at: '7:5', command: ['~/venv/bin/python', 'main.py'], timeoutMinutes: 2 })
  assert.match(settings.cwd, /^\/.*\/tools\/nasdaq$/)
  assert.equal(settings.at, '08:10', '7:5 is not HH:MM')
  assert.match(settings.command[0], /^\/.*\/venv\/bin\/python$/)
  assert.equal(settings.timeoutMinutes, 2)
  assert.equal(normalizeNasdaqSettings({ at: '9:30' }).at, '09:30')
  assert.deepEqual(normalizeNasdaqSettings(settings), settings)
})

test('the change is the session\'s close against the bar before it in the cache', () => {
  const csv = 'Date,Open,High,Low,Close,Volume,source\n2026-10-06,1,1,1,100,0,yfinance\n2026-10-07,1,1,1,102.5,0,akshare\n2026-10-08,1,1,1,101.475,0,yfinance\n'
  assert.deepEqual(changeOf(csv, '2026-10-08'), { prev_date: '2026-10-07', prev_close: 102.5, change_pct: -1 })
  assert.deepEqual(changeOf(csv, '2026-10-07'), { prev_date: '2026-10-06', prev_close: 100, change_pct: 2.5 })
  assert.equal(changeOf(csv, '2026-10-06'), null, 'no bar before the first')
  assert.equal(changeOf(csv, '2026-10-09'), null, 'a session the cache does not have')
  assert.deepEqual(changeOf(csv.replace(/2026-10-0(\d)/g, '2026-10-0$1 00:00:00-04:00'), '2026-10-08').change_pct, -1, 'timestamps in the Date column')
  assert.equal(changeOf(csv.replace('102.5', ''), '2026-10-08'), null)
  assert.equal(changeOf('Day,Price\n2026-10-07,1\n2026-10-08,2', '2026-10-08'), null)
  assert.equal(changeOf('', '2026-10-08'), null)
})

test('the scores come from latest_signals.json, and anything missing is refused', () => {
  const good = { generated_at: '2026-10-09T08:10:58+08:00', report_date: '2026-10-08', signals: { valuation_score: 6.3, sma_score: 5, ndx_close: 30725.81 } }
  assert.deepEqual(quoteOf(JSON.stringify(good)), {
    ok: true,
    quote: { report_date: '2026-10-08', close: 30725.81, valuation_score: 6.3, sma_score: 5, signals_at: '2026-10-09T08:10:58+08:00' },
  })
  assert.equal(quoteOf(JSON.stringify({ ...good, signals: { ...good.signals, ndx_close: null } })).quote.close, null)
  for (const broken of [
    'not json', '[]', JSON.stringify({ ...good, report_date: 'yesterday' }),
    JSON.stringify({ ...good, signals: { sma_score: 5 } }), JSON.stringify({ ...good, signals: { valuation_score: 6.3, sma_score: 4.5 } }),
    JSON.stringify({ ...good, signals: { valuation_score: null, sma_score: 5 } }),
  ]) assert.equal(quoteOf(broken).ok, false, broken)
})

test('a run executes the command in the tool directory and saves the session\'s numbers', async () => {
  const { cwd, store, settings, tool, clock } = fixture()
  const outcome = await startNasdaq({ store, settings, trigger: 'schedule' })
  assert.equal(outcome.ok, true, outcome.record.error)
  const seen = tool.capture()
  assert.deepEqual(seen.args, ['--flag'])
  assert.equal(realpathSync(seen.cwd), realpathSync(cwd))
  assert.equal(seen.encoding, 'utf-8')
  const record = store.read(localDate(clock()))
  assert.deepEqual(
    { ...record, signals_at: undefined },
    { ...ready('2026-10-09'), generated_at: isoLocal(clock()), duration_ms: 0, signals_at: undefined },
  )
  assert.equal(store.running(), null, 'the lock is released')
  assert.match(readFileSync(store.logPathOf('2026-10-09'), 'utf8'), /fake-main --flag\n# ok/)
})

test('a run whose command does not rewrite latest_signals.json fails instead of showing old numbers', async () => {
  const { store, settings, tool, cwd } = fixture()
  writeFileSync(join(cwd, 'latest_signals.json'), JSON.stringify({ generated_at: '2026-10-08T13:46:03+08:00', report_date: '2026-10-07', signals: { valuation_score: 6.1, sma_score: 4 } }))
  tool.mode('silent')
  const outcome = await startNasdaq({ store, settings, trigger: 'schedule' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.record.status, 'failed')
  assert.match(outcome.record.error, /latest_signals\.json 不是这次运行写的（生成于 2026-10-08T13:46:03\+08:00）/)
  assert.ok(readQuote(cwd, new Date('2026-10-08T00:00:00+08:00')).ok, 'the same file is fine for a run that started before it')
})

test('without the bar cache the scores still come in, with no change', async () => {
  const { store, settings, tool } = fixture()
  tool.mode('nocache')
  const outcome = await startNasdaq({ store, settings, trigger: 'manual' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.record.change_pct, null)
  assert.equal(outcome.record.valuation_score, 6.3)
})

test('a failing command records why; a failed refresh keeps the day\'s numbers', async () => {
  const { store, settings, tool } = fixture()
  tool.mode('fail')
  const failed = await startNasdaq({ store, settings, trigger: 'schedule' })
  assert.equal(failed.record.status, 'failed')
  assert.match(failed.record.error, /^退出码 1：ConnectionError: yfinance unreachable$/)
  assert.equal(failed.record.failures, 1)
  assert.match(readFileSync(store.logPathOf('2026-10-09'), 'utf8'), /Traceback/)
  tool.mode('ok')
  await startNasdaq({ store, settings, trigger: 'manual' })
  tool.mode('fail')
  const refresh = await startNasdaq({ store, settings, trigger: 'manual' })
  assert.equal(refresh.record.status, 'ready')
  assert.equal(refresh.record.change_pct, -1.39)
  assert.match(refresh.record.error, /yfinance unreachable/)
})

test('a missing tool directory or command says so', async () => {
  const { store, settings, root } = fixture()
  const gone = await startNasdaq({ store, settings: { ...settings, cwd: join(root, 'nope') }, trigger: 'schedule' })
  assert.match(gone.record.error, /^找不到目录 .*nope$/)
  const missing = await startNasdaq({ store, settings: { ...settings, command: [join(root, 'no-python')] }, trigger: 'schedule' })
  assert.match(missing.record.error, /^找不到 .*no-python，可以在配置里写 nasdaq\.command$/)
})

test('a day is due from 08:10 until a run succeeds, failed runs are retried, and a run in progress blocks another', async () => {
  const { dir, settings, clock, advance, time } = fixture('2026-10-09T08:00:00.000+08:00')
  const results = []
  const runCommand = async () => results.shift() ?? { ok: false, error: '没有更多脚本', log: '' }
  const service = new NasdaqService({ dir, settings, clock, runCommand, retryAfterMs: 30 * MINUTE, maxFailures: 2 })
  assert.equal(service.due(), false, 'before 08:10')
  advance(10)
  assert.equal(service.due(), true)
  results.push({ ok: false, error: '退出码 1：ConnectionError', log: '' })
  service.tick()
  assert.equal(service.run('manual'), false, 'the lock holds while the first run goes')
  await service.current
  assert.equal(service.status().record.status, 'failed')
  assert.equal(service.due(), false, 'not again right away')
  advance(30)
  assert.equal(service.due(), true, 'retried after 30 minutes')
  results.push({ ok: false, error: '退出码 1：ConnectionError', log: '' })
  service.tick()
  await service.current
  advance(60)
  assert.equal(service.due(), false, 'two failures stop the schedule for the day')
  time.now = new Date('2026-10-10T08:10:00.000+08:00').getTime()
  assert.equal(service.due(), true, 'the next day starts over')
})

test('status shows the newest numbers while today\'s are not in, and an unconfigured service is off', () => {
  const { dir, settings, clock, store } = fixture('2026-10-10T07:00:00.000+08:00')
  store.write('2026-10-08', ready('2026-10-08', { report_date: '2026-10-07', change_pct: 0.5 }))
  store.write('2026-10-09', ready('2026-10-09'))
  store.write('2026-10-10', { date: '2026-10-10', status: 'failed', trigger: 'schedule', error: '超时', failures: 1, last_failed_at: isoLocal(clock()) })
  const status = new NasdaqService({ dir, settings, clock }).status()
  assert.equal(status.enabled, true)
  assert.equal(status.at, '08:10')
  assert.equal(status.record.status, 'failed')
  assert.equal(status.latest.date, '2026-10-09')
  assert.equal(status.latest.change_pct, -1.39)
  const off = new NasdaqService({ dir: mkdtempSync(join(tmpdir(), 'dshcp-nasdaq-off-')), settings: undefined, clock })
  assert.deepEqual({ enabled: off.enabled, record: off.status().record, latest: off.status().latest }, { enabled: false, record: null, latest: null })
  assert.equal(off.due(), false)
  assert.equal(off.run('manual'), false)
})

test('the routes answer the status and refuse to run when unconfigured', async () => {
  const { dir, settings, clock } = fixture()
  const route = (routes, suffix) => routes.find(item => item.suffix === suffix)
  const on = nasdaqRoutes(new NasdaqService({ dir, settings, clock }))
  assert.equal((await route(on, 'nasdaq.today').handle().json()).enabled, true)
  assert.deepEqual(route(on, 'nasdaq.run').methods, ['POST'])
  const off = nasdaqRoutes(new NasdaqService({ dir: mkdtempSync(join(tmpdir(), 'dshcp-nasdaq-off-')), settings: undefined, clock }))
  const refused = await route(off, 'nasdaq.run').handle()
  assert.equal(refused.status, 400)
  assert.deepEqual(await refused.json(), { error: 'nasdaq.cwd is not configured' })
})

// ---- the line on the desk ----------------------------------------------------------------------------------

/** A plugin whose Host half has the Nasdaq line on, with the desk on screen. */
async function desk(nasdaq = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dshcp-nasdaq-panel-'))
  const cwd = join(root, 'nasdaq_valuation')
  mkdirSync(cwd)
  const tool = fakeNasdaqTool(cwd)
  const inboxDir = join(root, 'data')
  const panel = mount({ ...sampleState(), inboxDir, hostConfig: { nasdaq: { cwd, command: [tool.path], ...nasdaq } } })
  const store = new AdviceStore({ dir: inboxDir, name: 'nasdaq' })
  const today = localDate(new Date())
  const show = async () => {
    panel.callbacks.onPanelMount()
    await panel.settle()
    return panel.render()
  }
  return { panel, store, tool, today, show }
}

/** The rendered Nasdaq line; it holds no nested div. */
const lineOf = html => /<div class="dshcp-nasdaq-line"[\s\S]*?<\/div>/.exec(html)?.[0] ?? ''

test('an unconfigured plugin has no Nasdaq line', async () => {
  const panel = mount(sampleState())
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.doesNotMatch(panel.render(), /control-panel-nasdaq-line/)
  assert.match(panel.render(), /<div class="dshcp-glance"><\/div>/, 'the empty box hides itself in CSS')
  panel.dispose()
})

test('the line shows the session, its change, and both scores in one row, under the today line', async () => {
  const { panel, store, today, show } = await desk()
  store.write(today, ready(today))
  const html = await show()
  const line = lineOf(html)
  assert.match(line, /^<div class="dshcp-nasdaq-line" data-testid="control-panel-nasdaq-line" title="2026-10-08 收盘 30,725.81，前一交易日 2026-10-07 收盘 31,160.08">/)
  assert.match(line, /<span class="dshcp-nasdaq-label">纳指<\/span><span class="dshcp-nasdaq-text"><span class="dshcp-nasdaq-part"><span class="dshcp-nasdaq-kind">10-08 周四<\/span><span class="dshcp-nasdaq-change" data-dir="down">-1.39%<\/span><\/span><span class="dshcp-nasdaq-part"><span class="dshcp-nasdaq-kind">乖离分<\/span>6.3<\/span><span class="dshcp-nasdaq-part"><span class="dshcp-nasdaq-kind">SMA<\/span>5\/5<\/span><\/span>/)
  assert.match(line, /<span class="dshcp-nasdaq-side"><span class="dshcp-nasdaq-status">08:11 更新<\/span><button type="button" class="dshcp-link">刷新<\/button><\/span><\/div>$/)
  assert.ok(html.indexOf('control-panel-nasdaq-line') < html.indexOf('指挥台'), 'it sits above the command desk')
  panel.dispose()
})

test('a rise is marked up and keeps its sign; a missing change shows a dash', async () => {
  const { panel, store, today, show } = await desk()
  store.write(today, ready(today, { change_pct: 0.5 }))
  assert.match(lineOf(await show()), /<span class="dshcp-nasdaq-change" data-dir="up">\+0.50%<\/span>/)
  store.write(today, ready(today, { change_pct: null, prev_date: null, prev_close: null }))
  const line = lineOf(await show())
  assert.match(line, /<span class="dshcp-nasdaq-change">—<\/span>/)
  assert.match(line, /title="2026-10-08 收盘 30,725.81">/)
  panel.dispose()
})

test('before today\'s run the line keeps the last numbers and says when it updates', async () => {
  const { panel, store, today, show } = await desk({ at: '23:59' })
  store.write('2026-10-01', ready('2026-10-01', { report_date: '2026-09-30', change_pct: 1.2 }))
  const line = lineOf(await show())
  assert.match(line, /<span class="dshcp-nasdaq-kind">09-30 周三<\/span><span class="dshcp-nasdaq-change" data-dir="up">\+1.20%<\/span>/)
  assert.match(line, /<span class="dshcp-nasdaq-status">23:59 自动更新<\/span><button type="button" class="dshcp-link">现在更新<\/button>/)
  assert.equal(store.read(today), null)
  panel.dispose()
})

test('a failed update is red, says why on hover, and offers a retry; with no numbers it says why in the line', async () => {
  const { panel, store, today, show } = await desk()
  const failed = { date: today, status: 'failed', trigger: 'schedule', error: '退出码 1：ConnectionError', failures: 1, last_failed_at: isoLocal(new Date()) }
  store.write(today, failed)
  let line = lineOf(await show())
  assert.match(line, /^<div class="dshcp-nasdaq-line" data-kind="error"/)
  assert.match(line, /<span class="dshcp-nasdaq-text">更新失败：退出码 1：ConnectionError<\/span>/)
  assert.match(line, /<span class="dshcp-nasdaq-status">更新失败<\/span><button type="button" class="dshcp-link">重试<\/button>/)
  assert.match(line, /title="更新失败：退出码 1：ConnectionError\n日志在 .*\.log"/)
  store.write('2026-10-01', ready('2026-10-01'))
  line = lineOf(await show())
  assert.match(line, /data-dir="down">-1.39%/, 'older numbers stay up')
  assert.match(line, /<span class="dshcp-nasdaq-status">更新失败<\/span>/)
  panel.dispose()
})

test('updating now shows the run, then the numbers once the tool has written them', async () => {
  const { panel, store, tool, today, show } = await desk()
  await show()
  panel.callbacks.onNasdaqRun()
  await panel.settle()
  assert.equal(panel.nasdaq.getSnapshot().data.running.trigger, 'manual')
  assert.match(lineOf(panel.render()), /<span class="dshcp-nasdaq-text">还没有数据<\/span><span class="dshcp-nasdaq-side"><span class="dshcp-nasdaq-status">正在更新…<\/span><\/span>/)
  for (let waited = 0; store.read(today) === null && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
  for (let waited = 0; store.running() !== null && waited < 2000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(store.read(today).status, 'ready')
  assert.deepEqual(tool.capture().args, [])
  assert.match(lineOf(await show()), /data-dir="down">-1.39%<\/span><\/span><span class="dshcp-nasdaq-part"><span class="dshcp-nasdaq-kind">乖离分<\/span>6.3/)
  panel.dispose()
})

test('a Host half without the Nasdaq routes leaves the desk without the line', async () => {
  const panel = mount({ ...sampleState(), hostMissing: true })
  panel.callbacks.onPanelMount()
  await panel.settle()
  assert.equal(panel.nasdaq.getSnapshot().phase, 'error')
  assert.doesNotMatch(panel.render(), /control-panel-nasdaq-line/)
  panel.dispose()
})

test('the line reads in English too', async () => {
  const { panel, store, today, show } = await desk()
  store.write(today, ready(today))
  panel.host.locale = 'en'
  const line = lineOf(await show())
  assert.match(line, /<span class="dshcp-nasdaq-label">Nasdaq<\/span>/)
  assert.match(line, /<span class="dshcp-nasdaq-kind">10-08 Thu<\/span>/)
  assert.match(line, /<span class="dshcp-nasdaq-kind">Deviation<\/span>6.3/)
  assert.match(line, /<span class="dshcp-nasdaq-status">Updated 08:11<\/span><button type="button" class="dshcp-link">Refresh<\/button>/)
  panel.dispose()
})
