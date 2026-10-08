/**
 * Daily advice: once a day, run a coding agent inside a project directory and keep what it says as today's
 * exercise plan and diet suggestion. advice-store.js owns the files; this module owns the agents.
 *
 * The project directory is expected to carry its own instructions (AGENTS.md, CLAUDE.md, a status file, a
 * memory file); the prompt here only says what to produce today and in which shape. The agent may read
 * but never write: claude gets only its Read, Glob and Grep tools, opencode gets every other permission
 * denied. Agents are tried in order and the first one whose answer parses wins, so a spent claude quota
 * falls through to opencode.
 *
 * Row config in a profile's cordis.patch.yml, under `advice`:
 *   cwd             project directory the agent runs in; `~` expands. Unset: the feature is off
 *   at              local time a day's run becomes due, "HH:MM". Default: 08:00
 *   agents          order to try, from "claude" and "opencode". Default: [claude, opencode]
 *   timeoutMinutes  per agent. Default: 10
 *   claudeModel     passed as --model; "" uses the CLI's own default. Default: sonnet
 *   opencodeModel   passed as -m, e.g. deepseek/deepseek-flash; "" uses opencode.json's. Default: ""
 *   claudeBin, opencodeBin   executable paths when they are not in the usual places
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { expandHome, isoLocal } from './inbox-store.js'
import { AdviceStore } from './advice-store.js'

export const AGENT_NAMES = ['claude', 'opencode']
export const DEFAULT_AT = '08:00'
const DEFAULT_TIMEOUT_MINUTES = 10
const DEFAULT_CLAUDE_MODEL = 'sonnet'
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const STDOUT_LIMIT = 4 * 1024 * 1024
const STDERR_LIMIT = 256 * 1024
const LOG_TAIL = 16 * 1024

/** Last match wins in opencode's permission rules, so the allows after "*" are what stays possible. */
const OPENCODE_READ_ONLY = JSON.stringify({ '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' })

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * The row config's `advice` object, or settings saved from it, with every value checked and defaulted.
 * The result has the same keys, so normalizing twice changes nothing.
 */
export function normalizeAdviceSettings(raw) {
  const options = isRecord(raw) ? raw : {}
  const cwd = stringOr(options.cwd, '')
  const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(stringOr(options.at, ''))
  const listed = Array.isArray(options.agents) ? options.agents
    : typeof options.agents === 'string' ? options.agents.split(',') : AGENT_NAMES
  const agents = [...new Set(listed.map(name => String(name).trim().toLowerCase()).filter(name => AGENT_NAMES.includes(name)))]
  const minutes = Number(options.timeoutMinutes)
  return {
    cwd: cwd === '' ? '' : expandHome(cwd),
    at: at === null ? DEFAULT_AT : `${at[1].padStart(2, '0')}:${at[2]}`,
    agents: agents.length > 0 ? agents : AGENT_NAMES,
    timeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES,
    claudeModel: stringOr(options.claudeModel, DEFAULT_CLAUDE_MODEL),
    opencodeModel: stringOr(options.opencodeModel, ''),
    claudeBin: stringOr(options.claudeBin, ''),
    opencodeBin: stringOr(options.opencodeBin, ''),
  }
}

/** Today's moment at which `at` falls, in local time. */
export function dueTimeOf(now, at) {
  const [hours, minutes] = at.split(':').map(Number)
  const due = new Date(now.getTime())
  due.setHours(hours, minutes, 0, 0)
  return due
}

/** What the agent is asked. The project's own files say how to coach; this only says what to hand back. */
export function buildPrompt(now) {
  const pad = value => String(value).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `这是控制面板的无人值守定时任务，不是对话：没有人看得到你的过程，也没有人能回答你的问题。
任务：为用户写今天（${day}，${WEEKDAYS[now.getDay()]}，现在 ${time}）的「今日运动计划」和「今日饮食建议」，显示在控制面板顶部。

做法：
1. 按 AGENTS.md 第 2 节了解现状：当前状态文件（STATUS.md）和 memory.md 必须读，已经在上下文里的不用重复读。
2. 再只读和今天直接相关的：weekly_plans/ 里日期覆盖今天的周计划（没有就参考最近一份和当前状态里的常用周结构）、运动日志.md 最近的记录、饮食日志.md 开头的营养目标。不要读 健康管理/ 目录。
3. 只读不写：不要新建、修改、移动或删除任何文件，也不要做 AGENTS.md 4.8 的对话收尾。
4. 建议必须符合 memory.md 的全部约束（动作选择、先力量后跑步、补水、结石和尿酸、晚餐和油脂、血脂、心脏相关的强度限制等）。
5. 数据有缺口时（例如最近没有训练记录），给保守、可执行的安排，并在 note 里用一句话说明依据。

输出：只输出一个 JSON 对象，前后不要有任何其他文字，格式如下：
{
  "sport": {
    "headline": "今天练什么，20 字以内，例如：轻松跑 6 km · 心率 ≤145；休息日也要写，例如：休息日 · 拉伸 15 分钟",
    "items": ["3 到 6 条，每条 40 字以内：具体到动作、距离或时长、组数次数、心率区间、时间段和注意事项"]
  },
  "diet": {
    "headline": "20 字以内，例如：训练日 · 约 1900 kcal · 蛋白 100 g",
    "items": ["4 到 6 条，每条 40 字以内：早餐、午餐、晚餐、加餐分别给具体食物和份量，最后一条写全天饮水量和怎么分配"]
  },
  "note": "40 字以内的一句提醒或数据缺口说明；没有就写空字符串"
}`
}

function clip(text, limit) {
  const chars = Array.from(text)
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…`
}

function sectionOf(value) {
  if (!isRecord(value)) return null
  const headline = clip(stringOr(value.headline, ''), 60)
  const items = (Array.isArray(value.items) ? value.items : [])
    .filter(item => typeof item === 'string' && item.trim() !== '')
    .map(item => clip(item.trim(), 200))
    .slice(0, 8)
  return headline === '' && items.length === 0 ? null : { headline, items }
}

/**
 * The advice in an agent's answer: the JSON object itself, the one inside a code fence, or the outermost
 * braces of a reply that wrapped it in prose.
 * @returns { sport, diet, note }, or null when no candidate has both sections.
 */
export function parseAdvice(text) {
  const source = String(text ?? '')
  const candidates = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  if (fence !== null) candidates.push(fence[1])
  candidates.push(source)
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1))
  for (const candidate of candidates) {
    let value
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    const sport = sectionOf(value.sport)
    const diet = sectionOf(value.diet)
    if (sport !== null && diet !== null) return { sport, diet, note: clip(stringOr(value.note, ''), 200) }
  }
  return null
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A Dock-launched app finds nothing on its minimal PATH, so look where installers put them. */
const USUAL_PLACES = {
  claude: ['~/.local/bin/claude', '~/.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  opencode: ['~/.opencode/bin/opencode', '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'],
}

/** The agent's executable: the configured path, a usual install location, or the first one on PATH. */
export function resolveBin(agent, configured, env = process.env) {
  if (configured !== '') return expandHome(configured)
  for (const place of USUAL_PLACES[agent]) {
    const path = expandHome(place)
    if (executable(path)) return path
  }
  for (const directory of String(env.PATH ?? '').split(delimiter)) {
    if (directory !== '' && executable(join(directory, agent))) return join(directory, agent)
  }
  return agent
}

/** PATH for the agent: its own directory and the usual tool directories first, then what we were given. */
function pathFor(bin, env) {
  const extra = [dirname(bin), join(homedir(), '.local/bin'), join(homedir(), '.opencode/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  return [...new Set([...extra, ...String(env.PATH ?? '').split(delimiter)].filter(part => part !== '' && part !== '.'))].join(delimiter)
}

/** Each agent's command line and how its stdout becomes the final answer text. */
const AGENTS = {
  claude: {
    command: ({ model }) => ({
      args: ['-p', '--output-format', 'json', '--tools', 'Read,Glob,Grep', '--no-session-persistence',
        ...(model !== '' ? ['--model', model] : [])],
      viaStdin: true,
      env: {},
    }),
    answer(stdout) {
      const data = JSON.parse(stdout)
      if (data.is_error) throw new Error(String(data.result || data.subtype || 'claude reported an error'))
      return String(data.result ?? '')
    },
  },
  opencode: {
    command: ({ model, cwd, prompt }) => ({
      args: ['run', '--dir', cwd, '--format', 'json', ...(model !== '' ? ['-m', model] : []), prompt],
      viaStdin: false,
      env: { OPENCODE_PERMISSION: OPENCODE_READ_ONLY },
    }),
    answer(stdout) {
      const events = []
      for (const line of stdout.split('\n')) {
        try { events.push(JSON.parse(line)) } catch { /* progress lines can mix into stdout */ }
      }
      const failure = events.find(event => isRecord(event) && event.type === 'error')
      if (failure !== undefined) {
        const error = failure.error
        throw new Error(String((isRecord(error) && (error.data?.message || error.message || error.name)) || JSON.stringify(error)))
      }
      return events.filter(event => isRecord(event) && event.type === 'text').map(event => event.part?.text ?? '').join('')
    },
  },
}

/** Keep the first `limit` characters of a stream, and count what was dropped. */
function collector(limit) {
  let text = ''
  let dropped = 0
  return {
    push(chunk) {
      const piece = chunk.toString('utf8')
      const room = limit - text.length
      if (room > 0) text += piece.slice(0, room)
      dropped += Math.max(0, piece.length - Math.max(room, 0))
    },
    get text() { return dropped > 0 ? `${text}\n…（又截掉 ${dropped} 字）` : text },
  }
}

function tail(text) {
  return text.length <= LOG_TAIL ? text : `…${text.slice(-LOG_TAIL)}`
}

/** The last non-empty line of an error stream, which is usually the reason. */
function reasonFrom(stderr, stdout) {
  for (const stream of [stderr, stdout]) {
    const lines = stream.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (lines.length > 0) return clip(lines[lines.length - 1], 160)
  }
  return ''
}

/**
 * Run one agent once in the project directory.
 * @returns { ok, text, error, log } where `log` is what goes into the day's log file.
 */
export function runAgentProcess(agent, { settings, prompt, signal, env = process.env }) {
  const spec = AGENTS[agent]
  const bin = resolveBin(agent, agent === 'claude' ? settings.claudeBin : settings.opencodeBin, env)
  const model = agent === 'claude' ? settings.claudeModel : settings.opencodeModel
  const command = spec.command({ model, cwd: settings.cwd, prompt })
  const started = Date.now()
  return new Promise((resolve) => {
    const stdout = collector(STDOUT_LIMIT)
    const stderr = collector(STDERR_LIMIT)
    let settled = false
    let timedOut = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const seconds = Math.round((Date.now() - started) / 100) / 10
      const header = `$ ${bin} ${command.args.map(arg => (arg === prompt ? '<prompt>' : arg)).join(' ')}`
      resolve({
        ...result,
        log: `${header}\n# ${result.ok ? 'ok' : `failed: ${result.error}`} · ${seconds}s\n`
          + `## stdout\n${tail(stdout.text)}\n## stderr\n${tail(stderr.text)}\n`,
      })
    }
    let child
    try {
      child = spawn(bin, command.args, {
        cwd: settings.cwd,
        env: { ...env, ...command.env, PATH: pathFor(bin, env) },
        stdio: [command.viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ ok: false, text: '', error: `启动不了 ${bin}：${error.message}` })
      return
    }
    const kill = () => {
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000).unref()
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, settings.timeoutMinutes * 60 * 1000)
    timer.unref?.()
    const onAbort = () => { kill() }
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', (error) => {
      const reason = error.code === 'ENOENT' ? `找不到 ${agent}（${bin}），可以在配置里写 ${agent}Bin` : error.message
      finish({ ok: false, text: '', error: reason })
    })
    child.on('close', (code, killedBy) => {
      if (timedOut) return finish({ ok: false, text: '', error: `超过 ${settings.timeoutMinutes} 分钟没跑完` })
      if (signal?.aborted) return finish({ ok: false, text: '', error: '被中止' })
      if (code !== 0) {
        const reason = reasonFrom(stderr.text, stdout.text)
        return finish({ ok: false, text: '', error: `退出码 ${code ?? killedBy}${reason !== '' ? `：${reason}` : ''}` })
      }
      try {
        finish({ ok: true, text: spec.answer(stdout.text), error: null })
      } catch (error) {
        finish({ ok: false, text: '', error: clip(String(error.message || error), 160) })
      }
    })
    if (command.viaStdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(prompt)
    }
  })
}

/** Why the project directory cannot be used, or null. macOS privacy protection shows up here as EPERM. */
function directoryProblem(cwd) {
  try {
    // Listing, not stat: macOS lets a blocked process stat the folder but not read it.
    readdirSync(cwd)
    return null
  } catch (error) {
    if (error.code === 'ENOENT') return `找不到目录 ${cwd}`
    if (error.code === 'ENOTDIR') return `${cwd} 不是目录`
    if (error.code === 'EPERM' || error.code === 'EACCES') return `没有权限访问 ${cwd}（macOS 隐私保护拦下了这个进程）`
    return `访问不了 ${cwd}：${error.message}`
  }
}

/**
 * Start one run for today: take the run lock, then try each agent in order until one answers in the agreed
 * shape, and save the result.
 * @returns null when another run holds the lock, else the run's promise of { ok, record }.
 */
export function startAdvice({ store, settings, trigger, signal, runAgent = runAgentProcess }) {
  const lock = store.acquire({ trigger, agent: settings.agents[0] })
  return lock === null ? null : runLocked({ store, settings, trigger, signal, runAgent, lock })
}

/** {@link startAdvice}, awaited. @returns { started: false } when another run holds the lock. */
export async function generateAdvice(options) {
  const pending = startAdvice(options)
  return pending === null ? { started: false } : { started: true, ...(await pending) }
}

async function runLocked({ store, settings, trigger, signal, runAgent, lock }) {
  const date = store.today()
  const started = store.clock().getTime()
  const failed = []
  try {
    const problem = directoryProblem(settings.cwd)
    if (problem !== null) {
      failed.push({ agent: '目录', error: problem })
      store.log(date, `\n===== ${isoLocal(store.clock())} · ${trigger}\n${problem}`)
    }
    for (const agent of problem === null ? settings.agents : []) {
      lock.update({ agent })
      const result = await runAgent(agent, { settings, prompt: buildPrompt(store.clock()), signal })
      store.log(date, `\n===== ${isoLocal(store.clock())} · ${trigger} · ${agent}\n${result.log ?? ''}`)
      const advice = result.ok ? parseAdvice(result.text) : null
      if (advice !== null) {
        const record = {
          date,
          status: 'ready',
          generated_at: isoLocal(store.clock()),
          agent,
          model: (agent === 'claude' ? settings.claudeModel : settings.opencodeModel) || null,
          trigger,
          duration_ms: store.clock().getTime() - started,
          ...advice,
          skipped: failed,
          error: null,
          failures: 0,
          last_failed_at: null,
        }
        store.write(date, record)
        return { ok: true, record }
      }
      failed.push({ agent, error: result.ok ? '回答不是约定的 JSON 格式' : result.error })
      if (signal?.aborted) break
    }
    const error = failed.map(item => `${item.agent}：${item.error}`).join('；')
    const previous = store.read(date)
    const now = isoLocal(store.clock())
    const failures = (Number(previous?.failures) || 0) + 1
    const record = previous !== null && previous.status === 'ready'
      ? { ...previous, error, failures, last_failed_at: now }
      : { date, status: 'failed', trigger, error, failures, last_failed_at: now }
    store.write(date, record)
    return { ok: false, record }
  } finally {
    lock.release()
  }
}

/**
 * The Host half's side: answers the panel and starts a day's run once it is due. A run is due from `at`
 * onward until one succeeds; failed runs are retried after `retryAfterMs`, at most `maxFailures` times a
 * day, and a manual run is always allowed. It only runs while dsh does: opened after `at`, dsh starts the
 * day's run about `firstCheckAfterMs` later.
 */
export class AdviceService {
  constructor({ dir, settings, clock = () => new Date(), runAgent = runAgentProcess,
    checkEveryMs = 5 * 60 * 1000, firstCheckAfterMs = 20 * 1000, retryAfterMs = 30 * 60 * 1000, maxFailures = 3 }) {
    this.settings = normalizeAdviceSettings(settings)
    this.store = new AdviceStore({ dir, clock, staleAfterMs: (this.settings.timeoutMinutes * this.settings.agents.length + 10) * 60 * 1000 })
    this.clock = clock
    this.runAgent = runAgent
    this.checkEveryMs = checkEveryMs
    this.firstCheckAfterMs = firstCheckAfterMs
    this.retryAfterMs = retryAfterMs
    this.maxFailures = maxFailures
    this.abort = new AbortController()
    /** The run this process started, if one is going; tests await it. */
    this.current = null
  }

  get enabled() {
    return this.settings.cwd !== ''
  }

  status() {
    const date = this.store.today()
    const running = this.enabled ? this.store.running() : null
    return {
      enabled: this.enabled,
      date,
      at: this.settings.at,
      agents: this.settings.agents,
      project: this.enabled ? basename(this.settings.cwd) : '',
      running: running === null ? null : { started_at: running.started_at, trigger: running.trigger, agent: running.agent },
      record: this.enabled ? this.store.read(date) : null,
      /** `generated_at` of the newest advice the Today page was opened on; the sidebar dot compares it. */
      seen: this.enabled ? this.store.readSeen() : null,
      logPath: this.store.logPathOf(date),
    }
  }

  markSeen(generatedAt) {
    this.store.writeSeen(generatedAt)
  }

  due() {
    if (!this.enabled || this.store.running() !== null) return false
    const now = this.clock()
    if (now < dueTimeOf(now, this.settings.at)) return false
    const record = this.store.read(this.store.today())
    if (record === null) return true
    if (record.status === 'ready') return false
    const lastFailed = Date.parse(record.last_failed_at)
    return (Number(record.failures) || 0) < this.maxFailures
      && (Number.isNaN(lastFailed) || now.getTime() - lastFailed >= this.retryAfterMs)
  }

  /** Start a run in the background. @returns whether it started (false: off, or another run is going). */
  run(trigger) {
    if (!this.enabled) return false
    const pending = startAdvice({ store: this.store, settings: this.settings, trigger, signal: this.abort.signal, runAgent: this.runAgent })
    if (pending === null) return false
    this.current = pending.catch((error) => { console.error('dsh-plugin-control-panel: advice run failed', error) })
      .finally(() => { this.current = null })
    return true
  }

  tick() {
    if (this.due()) this.run('schedule')
  }

  /** Begin the schedule. @returns the disposer, which also stops a run this process started. */
  start() {
    if (!this.enabled) return () => {}
    const first = setTimeout(() => { this.tick() }, this.firstCheckAfterMs)
    const timer = setInterval(() => { this.tick() }, this.checkEveryMs)
    first.unref?.()
    timer.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      this.abort.abort()
    }
  }
}
