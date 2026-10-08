/**
 * The daily advice without the panel: settings, answer parsing, the agents as real child processes (fake
 * `claude` and `opencode` executables), the fallback between them, the run lock, and when a run is due.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdviceStore } from '../advice-store.js'
import { AdviceService, buildPrompt, generateAdvice, normalizeAdviceSettings, parseAdvice, runAgentProcess } from '../advice-runner.js'
import { isoLocal } from '../inbox-store.js'
import { adviceRoutes } from '../index.js'
import { ADVICE, fakeAgent } from './fake-agents.mjs'

const MINUTE = 60 * 1000

/** A data directory, a project directory, both fake agents, and a clock the test moves by hand. */
function fixture(at = '2026-10-07T08:00:00.000+08:00') {
  const root = mkdtempSync(join(tmpdir(), 'dshcp-advice-'))
  const dir = join(root, 'data')
  const cwd = join(root, 'sport_health_cc')
  const bin = join(root, 'bin')
  for (const path of [dir, cwd, bin]) mkdirSync(path)
  const time = { now: new Date(at).getTime() }
  const clock = () => new Date(time.now)
  const claude = fakeAgent(bin, 'claude')
  const opencode = fakeAgent(bin, 'opencode')
  const settings = normalizeAdviceSettings({ cwd, claudeBin: claude.path, opencodeBin: opencode.path })
  return {
    root, dir, cwd, time, clock, claude, opencode, settings,
    store: new AdviceStore({ dir, clock }),
    advance: (minutes) => { time.now += minutes * MINUTE },
  }
}

/** A stand-in for runAgentProcess that answers from a script of results and records the calls. */
function scripted(results) {
  const calls = []
  const runAgent = async (agent, options) => {
    calls.push({ agent, prompt: options.prompt })
    const next = results.shift() ?? { ok: false, error: 'no more scripted results' }
    return { text: '', error: null, log: `log for ${agent}`, ...next }
  }
  return { calls, runAgent }
}

const okText = JSON.stringify(ADVICE)

test('settings default to claude then opencode at 08:00, and bad values fall back', () => {
  assert.deepEqual(normalizeAdviceSettings(undefined), {
    cwd: '', at: '08:00', agents: ['claude', 'opencode'], timeoutMinutes: 10,
    claudeModel: 'sonnet', opencodeModel: '', claudeBin: '', opencodeBin: '',
  })
  const settings = normalizeAdviceSettings({
    cwd: ' ~/sport ', at: '7:05', agents: 'OpenCode, nope', timeoutMinutes: -1, claudeModel: '', opencodeModel: 'deepseek/deepseek-flash',
  })
  assert.match(settings.cwd, /\/sport$/)
  assert.doesNotMatch(settings.cwd, /~/)
  assert.equal(settings.at, '07:05')
  assert.deepEqual(settings.agents, ['opencode'])
  assert.equal(settings.timeoutMinutes, 10)
  assert.equal(settings.claudeModel, '')
  assert.equal(normalizeAdviceSettings({ at: '25:00', agents: [] }).at, '08:00')
  assert.deepEqual(normalizeAdviceSettings({ agents: [] }).agents, ['claude', 'opencode'])
  assert.deepEqual(normalizeAdviceSettings(settings), settings)
})

test('the prompt names the day, forbids writes, and asks for the JSON shape', () => {
  const prompt = buildPrompt(new Date('2026-10-07T08:00:00.000+08:00'))
  assert.match(prompt, /2026-10-07，周三，现在 08:00/)
  assert.match(prompt, /只读不写/)
  assert.match(prompt, /memory\.md/)
  assert.match(prompt, /"sport"[\s\S]*"diet"[\s\S]*"note"/)
})

test('parses the answer bare, in a code fence, or wrapped in prose', () => {
  assert.deepEqual(parseAdvice(okText), ADVICE)
  assert.deepEqual(parseAdvice(`好的：\n\`\`\`json\n${okText}\n\`\`\`\n祝训练顺利`), ADVICE)
  assert.deepEqual(parseAdvice(`这是今天的：${okText} 完毕`), ADVICE)
  assert.equal(parseAdvice('我没法按格式回答'), null)
  assert.equal(parseAdvice(JSON.stringify({ sport: ADVICE.sport })), null)
  assert.equal(parseAdvice(JSON.stringify({ sport: ADVICE.sport, diet: { headline: '', items: [] } })), null)
})

test('cleans what it parses: no note is an empty string, items are strings, long text is clipped', () => {
  const advice = parseAdvice(JSON.stringify({
    sport: { headline: '休息日', items: ['拉伸 15 分钟', 3, '  ', '散步'.repeat(200)] },
    diet: { items: ['早餐：燕麦'] },
  }))
  assert.equal(advice.note, '')
  assert.equal(advice.diet.headline, '')
  assert.equal(advice.sport.items.length, 2)
  assert.equal(Array.from(advice.sport.items[1]).length, 201)
  assert.ok(advice.sport.items[1].endsWith('…'))
})

test('claude runs read-only in the project with the prompt on stdin', async () => {
  const { cwd, claude, settings } = fixture()
  const result = await runAgentProcess('claude', { settings, prompt: '今天练什么' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(parseAdvice(result.text), ADVICE)
  const seen = claude.capture()
  assert.deepEqual(seen.args, ['-p', '--output-format', 'json', '--tools', 'Read,Glob,Grep', '--no-session-persistence', '--model', 'sonnet'])
  assert.equal(seen.input, '今天练什么')
  assert.equal(realpathSync(seen.cwd), realpathSync(cwd))
  assert.match(result.log, /--tools Read,Glob,Grep/)
  assert.match(result.log, /# ok/)
})

test('opencode gets the prompt as its last argument and every write permission denied', async () => {
  const { cwd, opencode, settings } = fixture()
  const result = await runAgentProcess('opencode', { settings: { ...settings, opencodeModel: 'deepseek/deepseek-flash' }, prompt: '今天吃什么' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(parseAdvice(result.text), ADVICE)
  const seen = opencode.capture()
  assert.deepEqual(seen.args, ['run', '--dir', cwd, '--format', 'json', '-m', 'deepseek/deepseek-flash', '今天吃什么'])
  assert.deepEqual(JSON.parse(seen.permission), { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' })
  assert.doesNotMatch(result.log, /今天吃什么/)
})

test('a failing agent reports its exit code and last error line; a missing one says so', async () => {
  const { claude, settings } = fixture()
  claude.mode('fail')
  const failed = await runAgentProcess('claude', { settings, prompt: 'x' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, '退出码 1：Error: rate limit reached')
  const missing = await runAgentProcess('claude', { settings: { ...settings, claudeBin: '/nonexistent/claude' }, prompt: 'x' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /找不到 claude/)
})

test('an agent that runs past the timeout is stopped', async () => {
  const { opencode, settings } = fixture()
  opencode.mode('sleep')
  const started = Date.now()
  const result = await runAgentProcess('opencode', { settings: { ...settings, timeoutMinutes: 0.003 }, prompt: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没跑完/)
  assert.ok(Date.now() - started < 5000)
})

test('the first agent that answers in shape writes today\'s record and the lock is released', async () => {
  const { store, settings, dir } = fixture()
  const { calls, runAgent } = scripted([{ ok: true, text: okText }])
  const result = await generateAdvice({ store, settings, trigger: 'schedule', runAgent })
  assert.equal(result.started, true)
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.agent), ['claude'])
  assert.match(calls[0].prompt, /2026-10-07/)
  const record = store.read('2026-10-07')
  assert.equal(record.status, 'ready')
  assert.equal(record.agent, 'claude')
  assert.equal(record.model, 'sonnet')
  assert.equal(record.trigger, 'schedule')
  assert.deepEqual([record.sport, record.diet, record.note], [ADVICE.sport, ADVICE.diet, ADVICE.note])
  assert.deepEqual(record.skipped, [])
  assert.equal(store.running(), null)
  assert.equal(existsSync(join(dir, 'advice', 'run.lock')), false)
  assert.match(readFileSync(join(dir, 'advice', '2026-10-07.log'), 'utf8'), /schedule · claude\nlog for claude/)
})

test('falls through to opencode when claude fails or answers out of shape', async () => {
  for (const first of [{ ok: false, error: '退出码 1：rate limit' }, { ok: true, text: '我没法按格式回答' }]) {
    const { store, settings } = fixture()
    const { calls, runAgent } = scripted([first, { ok: true, text: okText }])
    await generateAdvice({ store, settings, trigger: 'manual', runAgent })
    assert.deepEqual(calls.map(call => call.agent), ['claude', 'opencode'])
    const record = store.read('2026-10-07')
    assert.equal(record.agent, 'opencode')
    assert.equal(record.model, null)
    assert.deepEqual(record.skipped, [{ agent: 'claude', error: first.ok ? '回答不是约定的 JSON 格式' : first.error }])
  }
})

test('when every agent fails the day is marked failed, and failures count up', async () => {
  const { store, settings, advance } = fixture()
  const { runAgent } = scripted([{ ok: false, error: 'a' }, { ok: false, error: 'b' }, { ok: false, error: 'c' }, { ok: false, error: 'd' }])
  await generateAdvice({ store, settings, trigger: 'schedule', runAgent })
  assert.deepEqual(store.read('2026-10-07'), {
    date: '2026-10-07', status: 'failed', trigger: 'schedule', error: 'claude：a；opencode：b', failures: 1,
    last_failed_at: isoLocal(new Date('2026-10-07T08:00:00.000+08:00')),
  })
  advance(30)
  await generateAdvice({ store, settings, trigger: 'schedule', runAgent })
  assert.equal(store.read('2026-10-07').failures, 2)
  assert.equal(store.read('2026-10-07').error, 'claude：c；opencode：d')
})

test('a failed regeneration keeps the day\'s advice and only notes the error', async () => {
  const { store, settings } = fixture()
  await generateAdvice({ store, settings, trigger: 'schedule', runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  await generateAdvice({ store, settings, trigger: 'manual', runAgent: scripted([{ ok: false, error: 'x' }, { ok: false, error: 'y' }]).runAgent })
  const record = store.read('2026-10-07')
  assert.equal(record.status, 'ready')
  assert.deepEqual(record.sport, ADVICE.sport)
  assert.equal(record.error, 'claude：x；opencode：y')
  assert.equal(record.failures, 1)
})

test('a missing project directory fails without starting any agent', async () => {
  const { store, settings } = fixture()
  const { calls, runAgent } = scripted([])
  await generateAdvice({ store, settings: { ...settings, cwd: '/nonexistent/sport_health_cc' }, trigger: 'schedule', runAgent })
  assert.deepEqual(calls, [])
  assert.equal(store.read('2026-10-07').error, '目录：找不到目录 /nonexistent/sport_health_cc')
  assert.match(readFileSync(store.logPathOf('2026-10-07'), 'utf8'), /schedule\n找不到目录/)
})

test('a live lock blocks a second run; a lock left by a dead process is taken over', async () => {
  const { store, settings, dir } = fixture()
  mkdirSync(join(dir, 'advice'), { recursive: true })
  const lock = join(dir, 'advice', 'run.lock')
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, started_at: isoLocal(store.clock()), trigger: 'schedule', agent: 'claude' }))
  const blocked = scripted([{ ok: true, text: okText }])
  assert.deepEqual(await generateAdvice({ store, settings, trigger: 'manual', runAgent: blocked.runAgent }), { started: false })
  assert.deepEqual(blocked.calls, [])
  assert.equal(store.running().trigger, 'schedule')

  const { pid } = spawnSync(process.execPath, ['-e', ''])
  writeFileSync(lock, JSON.stringify({ pid, started_at: isoLocal(store.clock()), trigger: 'schedule' }))
  assert.equal(store.running(), null)
  const taken = await generateAdvice({ store, settings, trigger: 'manual', runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  assert.equal(taken.ok, true)
})

test('the lock names the agent being tried while the run is going', async () => {
  const { store, settings } = fixture()
  const seen = []
  const runAgent = async (agent) => {
    seen.push(store.running().agent)
    return agent === 'claude' ? { ok: false, error: 'x', log: '' } : { ok: true, text: okText, log: '' }
  }
  await generateAdvice({ store, settings, trigger: 'manual', runAgent })
  assert.deepEqual(seen, ['claude', 'opencode'])
})

test('a run is due from the configured time until one succeeds, with spaced and limited retries', async () => {
  const { dir, settings, clock, advance, store } = fixture('2026-10-07T07:59:00.000+08:00')
  const fail = { ok: false, error: 'x' }
  const script = scripted([fail, fail, fail, fail, fail, fail, { ok: true, text: okText }])
  const service = new AdviceService({ dir, settings, clock, runAgent: script.runAgent, retryAfterMs: 30 * MINUTE, maxFailures: 3 })
  assert.equal(service.due(), false)
  advance(1)
  assert.equal(service.due(), true)
  for (let failure = 1; failure <= 3; failure += 1) {
    assert.equal(service.run('schedule'), true)
    await service.current
    assert.equal(store.read('2026-10-07').failures, failure)
    assert.equal(service.due(), false)
    advance(29)
    assert.equal(service.due(), false)
    advance(1)
  }
  assert.equal(service.due(), false, 'three failures stop the schedule for the day')
  assert.equal(service.run('manual'), true, 'a manual run is still allowed')
  await service.current
  assert.equal(store.read('2026-10-07').status, 'ready')
  assert.equal(service.due(), false)
  advance(24 * 60)
  assert.equal(service.due(), true, 'the next day starts over')
})

test('a second run request while one is going does not start another', async () => {
  const { dir, settings, clock } = fixture()
  let finish
  const runAgent = () => new Promise((resolve) => { finish = resolve })
  const service = new AdviceService({ dir, settings, clock, runAgent })
  assert.equal(service.run('manual'), true)
  assert.equal(service.status().running.trigger, 'manual')
  assert.equal(service.run('manual'), false)
  await new Promise(resolve => setImmediate(resolve))
  finish({ ok: true, text: okText, log: '' })
  await service.current
  assert.equal(service.status().running, null)
  assert.equal(service.status().record.status, 'ready')
})

test('an unconfigured plugin never runs and writes nothing', () => {
  const { clock } = fixture()
  const empty = mkdtempSync(join(tmpdir(), 'dshcp-advice-off-'))
  const off = new AdviceService({ dir: empty, settings: undefined, clock })
  off.start()()
  assert.equal(off.status().enabled, false)
  assert.equal(off.due(), false)
  assert.equal(off.run('manual'), false)
  assert.equal(existsSync(join(empty, 'advice')), false)
})

test('the schedule\'s first check comes shortly after start and runs a due day', async () => {
  const { dir, settings, clock, store } = fixture()
  const { calls, runAgent } = scripted([{ ok: true, text: okText }])
  const service = new AdviceService({ dir, settings, clock, runAgent, firstCheckAfterMs: 10 })
  const dispose = service.start()
  for (let waited = 0; store.read('2026-10-07') === null && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  dispose()
  assert.deepEqual(calls.map(call => call.agent), ['claude'])
  assert.equal(store.read('2026-10-07').trigger, 'schedule')
})

test('advice.seen records the generated_at it is given, and refuses a missing one or an unconfigured plugin', async () => {
  const { dir, settings, clock, store } = fixture()
  const post = (routes, body) => routes.find(route => route.suffix === 'advice.seen')
    .handle(new Request('http://127.0.0.1/api/control-panel.advice.seen', { method: 'POST', body: JSON.stringify(body) }))
  const routes = adviceRoutes(new AdviceService({ dir, settings, clock }))
  assert.equal((await post(routes, {})).status, 400)
  assert.equal(store.readSeen(), null)
  const answer = await post(routes, { generated_at: '2026-10-07T08:03:00.000+08:00' })
  assert.equal(answer.status, 200)
  assert.equal((await answer.json()).seen, '2026-10-07T08:03:00.000+08:00')
  assert.equal(store.readSeen(), '2026-10-07T08:03:00.000+08:00')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'advice', 'seen.json'), 'utf8'))), ['generated_at', 'seen_at'])

  const empty = mkdtempSync(join(tmpdir(), 'dshcp-advice-off-'))
  const off = adviceRoutes(new AdviceService({ dir: empty, settings: undefined, clock }))
  assert.equal((await post(off, { generated_at: 'x' })).status, 400)
  assert.equal(existsSync(join(empty, 'advice')), false)
})
