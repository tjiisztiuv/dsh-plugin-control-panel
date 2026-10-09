/**
 * The daily advice without the panel: settings, answer parsing, the agents as real child processes (fake
 * `claude` and `opencode` executables), the fallback between them, the run lock, and when a run is due.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdviceStore } from '../advice-store.js'
import {
  AdviceService, buildMail, buildPrompt, buildTodayFile, generateAdvice, normalizeAdviceSettings, parseAdvice, runAgentProcess, runMailProcess,
} from '../advice-runner.js'
import { isoLocal } from '../inbox-store.js'
import { adviceRoutes } from '../index.js'
import { ADVICE, fakeAgent, fakeMailer } from './fake-agents.mjs'

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
    claudeModel: 'sonnet', opencodeModel: '', claudeBin: '', opencodeBin: '', mailCommand: [], todayFile: '',
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

test('the mail command is a path or a list starting with one, and `~` expands only in the path', () => {
  const home = normalizeAdviceSettings({ mailCommand: ' ~/.local/bin/mail-me ' }).mailCommand
  assert.equal(home.length, 1)
  assert.match(home[0], /^\/.*\/\.local\/bin\/mail-me$/)
  const listed = normalizeAdviceSettings({ mailCommand: ['~/bin/send', '-t', '~me@example.com'] })
  assert.match(listed.mailCommand[0], /^\/.*\/bin\/send$/)
  assert.deepEqual(listed.mailCommand.slice(1), ['-t', '~me@example.com'])
  assert.deepEqual(normalizeAdviceSettings(listed), listed)
  for (const off of [undefined, '', '  ', [], [''], 42, { path: 'x' }]) assert.deepEqual(normalizeAdviceSettings({ mailCommand: off }).mailCommand, [])
})

test('the prompt names the day, forbids writes, and asks for the JSON shape', () => {
  const prompt = buildPrompt(new Date('2026-10-07T08:00:00.000+08:00'))
  assert.match(prompt, /2026-10-07，周三，现在 08:00/)
  assert.match(prompt, /只读不写/)
  assert.match(prompt, /先看当前目录的 AGENTS\.md[^\n]*子目录/, 'it finds the project from a workspace root')
  assert.match(prompt, /控制面板会按你下面的回答写那个文件/)
  assert.match(prompt, /memory\.md/)
  assert.match(prompt, /"day": "训练日 或 休息日[\s\S]*"sport"[\s\S]*"diet"[\s\S]*"note"/)
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
  assert.equal(advice.day, '', 'no day kind, and only the two kinds count')
  assert.equal(parseAdvice(JSON.stringify({ ...ADVICE, day: '恢复日' })).day, '')
  assert.equal(parseAdvice(JSON.stringify({ ...ADVICE, day: ' 休息日 ' })).day, '休息日')
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

/** A stand-in for runMailProcess that answers `result` and records what it was asked to send. */
function scriptedMail(result = { ok: true, error: null }, during = () => {}) {
  const calls = []
  const sendMail = async (command, mail) => {
    calls.push({ command, ...mail })
    during()
    return { log: 'log for mail', ...result }
  }
  return { calls, sendMail }
}

test('the mail has the day and the exercise headline in its subject, and both columns in full', () => {
  const record = {
    date: '2026-10-09', generated_at: '2026-10-09T08:03:27.623+08:00', agent: 'claude', model: 'sonnet', ...ADVICE,
  }
  const { subject, body } = buildMail(record)
  assert.equal(subject, '今日 10-09 周五：轻松跑 6 km · 心率 ≤145')
  assert.equal(body, [
    '运动：轻松跑 6 km · 心率 ≤145\n• 先热身 10 分钟\n• 跑后拉伸腘绳肌',
    '饮食：训练日 · 约 1900 kcal\n• 早餐：燕麦 50 g + 鸡蛋 2 个\n• 饮水 2500 ml，跑后补 600 ml',
    '提醒：最近没有训练记录，按常用周结构安排。',
    'claude · sonnet 生成于 08:03',
  ].join('\n\n') + '\n')
  const bare = buildMail({ ...record, agent: 'opencode', model: null, note: '', sport: { headline: '', items: ['散步'] } })
  assert.equal(bare.subject, '今日 10-09 周五：运动计划')
  assert.doesNotMatch(bare.body, /提醒/)
  assert.match(bare.body, /opencode 生成于 08:03\n$/)
})

test('the mail command gets the subject as its last argument and the body on stdin', async () => {
  const { root } = fixture()
  const mailer = fakeMailer(join(root, 'bin'))
  const sent = await runMailProcess([mailer.path, '-t', 'me@example.com'], { subject: '今日 主题', body: '正文\n第二行\n' })
  assert.equal(sent.ok, true, sent.error)
  assert.equal(sent.error, null)
  assert.deepEqual(mailer.capture(), { args: ['-t', 'me@example.com', '今日 主题'], input: '正文\n第二行\n' })
  assert.match(sent.log, /mail-me -t me@example\.com <subject>\n# ok/)
  assert.doesNotMatch(sent.log, /正文/)

  mailer.mode('fail')
  const failed = await runMailProcess([mailer.path], { subject: 's', body: 'b' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, '退出码 1：mail-me: 发送失败（试了 3 次）：TimeoutError: timed out')
  const missing = await runMailProcess(['/nonexistent/mail-me'], { subject: 's', body: 'b' })
  assert.equal(missing.error, '找不到发信命令 /nonexistent/mail-me')
})

test('written advice is mailed after the lock is released, and the record notes it', async () => {
  const { store, settings } = fixture()
  const locks = []
  const { calls, sendMail } = scriptedMail(undefined, () => { locks.push(store.running()) })
  const result = await generateAdvice({
    store, settings: { ...settings, mailCommand: ['/bin/mail-me'] }, trigger: 'schedule',
    runAgent: scripted([{ ok: true, text: okText }]).runAgent, sendMail,
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].command, ['/bin/mail-me'])
  assert.deepEqual([calls[0].subject, calls[0].body], [buildMail(store.read('2026-10-07')).subject, buildMail(store.read('2026-10-07')).body])
  assert.deepEqual(locks, [null], 'no run lock while mailing')
  const record = store.read('2026-10-07')
  assert.equal(record.status, 'ready')
  assert.deepEqual(record.mail, { sent_at: isoLocal(new Date('2026-10-07T08:00:00.000+08:00')), error: null })
  assert.deepEqual(result.record, record)
  assert.match(readFileSync(store.logPathOf('2026-10-07'), 'utf8'), /schedule · 邮件\nlog for mail/)
})

test('a mail that does not go out leaves the advice as it is and says why', async () => {
  const { store, settings } = fixture()
  const { sendMail } = scriptedMail({ ok: false, error: '退出码 1：mail-me: QQ 邮箱登录失败' })
  await generateAdvice({
    store, settings: { ...settings, mailCommand: ['/bin/mail-me'] }, trigger: 'manual',
    runAgent: scripted([{ ok: true, text: okText }]).runAgent, sendMail,
  })
  const record = store.read('2026-10-07')
  assert.equal(record.status, 'ready')
  assert.equal(record.error, null)
  assert.deepEqual(record.sport, ADVICE.sport)
  assert.deepEqual(record.mail, { sent_at: null, error: '退出码 1：mail-me: QQ 邮箱登录失败' })
})

test('nothing is mailed without a mail command, or when no agent wrote anything', async () => {
  const { store, settings } = fixture()
  const quiet = scriptedMail()
  await generateAdvice({ store, settings, trigger: 'schedule', runAgent: scripted([{ ok: true, text: okText }]).runAgent, sendMail: quiet.sendMail })
  assert.deepEqual(quiet.calls, [])
  assert.equal('mail' in store.read('2026-10-07'), false)

  const other = fixture()
  const failing = scriptedMail()
  await generateAdvice({
    store: other.store, settings: { ...other.settings, mailCommand: ['/bin/mail-me'] }, trigger: 'schedule',
    runAgent: scripted([{ ok: false, error: 'a' }, { ok: false, error: 'b' }]).runAgent, sendMail: failing.sendMail,
  })
  assert.deepEqual(failing.calls, [])
  assert.equal(other.store.read('2026-10-07').status, 'failed')
})

test('advice replaced while its mail was going out keeps the newer record untouched', async () => {
  const { store, settings } = fixture()
  const newer = { date: '2026-10-07', status: 'ready', generated_at: '2026-10-07T08:05:00.000+08:00', agent: 'opencode', ...ADVICE }
  const { sendMail } = scriptedMail(undefined, () => { store.write('2026-10-07', newer) })
  await generateAdvice({
    store, settings: { ...settings, mailCommand: ['/bin/mail-me'] }, trigger: 'schedule',
    runAgent: scripted([{ ok: true, text: okText }]).runAgent, sendMail,
  })
  assert.deepEqual(store.read('2026-10-07'), newer)
})

test('the service mails through its own sender and says whether mail is on', async () => {
  const { dir, settings, clock, store } = fixture()
  const { calls, sendMail } = scriptedMail()
  const service = new AdviceService({
    dir, settings: { ...settings, mailCommand: '/bin/mail-me' }, clock, runAgent: scripted([{ ok: true, text: okText }]).runAgent, sendMail,
  })
  assert.equal(service.status().mail, true)
  assert.equal(new AdviceService({ dir, settings, clock }).status().mail, false)
  assert.equal(service.run('manual'), true)
  await service.current
  assert.equal(calls.length, 1)
  assert.equal(store.read('2026-10-07').mail.error, null)
})

test('the today file follows the workspace\'s 今日建议.md shape: title with the day, the note, two sections', () => {
  const record = {
    date: '2026-10-09', generated_at: '2026-10-09T08:03:27.623+08:00', agent: 'claude', model: 'opus', ...ADVICE,
  }
  assert.equal(buildTodayFile(record), [
    '# 今日建议 · 2026-10-09（周五）· 训练日',
    '> 最近没有训练记录，按常用周结构安排。',
    '## 运动\n\n轻松跑 6 km · 心率 ≤145\n\n- 先热身 10 分钟\n- 跑后拉伸腘绳肌',
    '## 饮食\n\n训练日 · 约 1900 kcal\n\n- 早餐：燕麦 50 g + 鸡蛋 2 个\n- 饮水 2500 ml，跑后补 600 ml',
    '*claude · opus 自动生成于 08:03*',
  ].join('\n\n') + '\n')
  const bare = buildTodayFile({ ...record, day: '', note: '', model: null, sport: { headline: '休息', items: [] } })
  assert.match(bare, /^# 今日建议 · 2026-10-09（周五）\n\n## 运动\n\n休息\n\n## 饮食/)
  assert.match(bare, /\*claude 自动生成于 08:03\*\n$/)
})

test('written advice overwrites the today file, and keeps what the file held before when it differs', async () => {
  const { root, store, settings, dir, advance } = fixture()
  const inbox = join(root, 'inbox')
  mkdirSync(inbox)
  const todayFile = join(inbox, '今日建议.md')
  writeFileSync(todayFile, '# 昨天的\n\n实际：跑了 5 km\n')
  const options = { store, settings: { ...settings, todayFile }, trigger: 'schedule' }
  await generateAdvice({ ...options, runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  const record = store.read('2026-10-07')
  assert.equal(readFileSync(todayFile, 'utf8'), buildTodayFile(record))
  assert.deepEqual(record.today_file, { written_at: isoLocal(new Date('2026-10-07T08:00:00.000+08:00')), error: null })
  const replaced = join(dir, 'advice', 'replaced')
  assert.deepEqual(readdirSync(replaced), ['2026-10-07T080000.md'])
  assert.equal(readFileSync(join(replaced, '2026-10-07T080000.md'), 'utf8'), '# 昨天的\n\n实际：跑了 5 km\n')
  assert.match(readFileSync(store.logPathOf('2026-10-07'), 'utf8'), /schedule · 今日文件\n写入 .*今日建议\.md；原来的内容存到 .*replaced\/2026-10-07T080000\.md/)

  advance(1)
  await generateAdvice({ ...options, trigger: 'manual', runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  assert.equal(readFileSync(todayFile, 'utf8'), buildTodayFile(store.read('2026-10-07')))
  assert.equal(readdirSync(replaced).length, 2, 'the first run\'s file differs in its time line, so it is kept too')
  advance(1)
  writeFileSync(todayFile, buildTodayFile(store.read('2026-10-07')).replace('08:01', '08:02'))
  await generateAdvice({ ...options, trigger: 'manual', runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  assert.equal(readdirSync(replaced).length, 2, 'nothing is kept when the file already holds exactly what is written')
})

test('a today file that cannot be written leaves the advice as it is and says why; the mail still goes', async () => {
  const { store, settings } = fixture()
  const mail = scriptedMail()
  await generateAdvice({
    store, settings: { ...settings, todayFile: '/nonexistent/inbox/今日建议.md', mailCommand: ['/bin/mail-me'] }, trigger: 'schedule',
    runAgent: scripted([{ ok: true, text: okText }]).runAgent, sendMail: mail.sendMail,
  })
  const record = store.read('2026-10-07')
  assert.equal(record.status, 'ready')
  assert.deepEqual(record.today_file, { written_at: null, error: '找不到目录 /nonexistent/inbox' })
  assert.equal(mail.calls.length, 1)
  assert.equal(record.mail.error, null, 'both notes stay on the record')

  const { root, store: other, settings: otherSettings } = fixture()
  const locked = join(root, 'locked.md')
  writeFileSync(locked, 'x')
  chmodSync(locked, 0o444)
  await generateAdvice({ store: other, settings: { ...otherSettings, todayFile: locked }, trigger: 'schedule', runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  assert.match(other.read('2026-10-07').today_file.error, /^没有权限写 .*locked\.md/)
})

test('no today file is written without the setting, or when no agent wrote anything', async () => {
  const { root, store, settings } = fixture()
  await generateAdvice({ store, settings, trigger: 'schedule', runAgent: scripted([{ ok: true, text: okText }]).runAgent })
  assert.equal('today_file' in store.read('2026-10-07'), false)
  const other = fixture()
  const todayFile = join(root, '今日建议.md')
  await generateAdvice({
    store: other.store, settings: { ...other.settings, todayFile }, trigger: 'schedule',
    runAgent: scripted([{ ok: false, error: 'a' }, { ok: false, error: 'b' }]).runAgent,
  })
  assert.equal(existsSync(todayFile), false)
  assert.equal(normalizeAdviceSettings({ todayFile: ' ~/inbox/今日建议.md ' }).todayFile.endsWith('/inbox/今日建议.md'), true)
  assert.doesNotMatch(normalizeAdviceSettings({ todayFile: '~/x.md' }).todayFile, /~/)
})
