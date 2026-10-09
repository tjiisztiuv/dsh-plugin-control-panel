/**
 * Daily advice: once a day, run a coding agent inside a project directory and keep what it says as today's
 * exercise plan and diet suggestion. advice-store.js owns the files; this module owns the agents.
 *
 * The project directory is expected to carry its own instructions (AGENTS.md, CLAUDE.md, a status file, a
 * memory file); the prompt here only says what to produce today and in which shape. The agent may read
 * but never write: claude gets only its Read, Glob and Grep tools, opencode gets every other permission
 * denied. Agents are tried in order and the first one whose answer parses wins, so a spent claude quota
 * falls through to opencode. Advice that was written can then go where a phone reads it: into a Markdown
 * file that the user syncs (`todayFile`), and through a mail command of the user's (`mailCommand`).
 *
 * Row config in a profile's cordis.patch.yml, under `advice`:
 *   cwd             project directory the agent runs in; `~` expands. Unset: the feature is off
 *   at              local time a day's run becomes due, "HH:MM". Default: 08:00
 *   agents          order to try, from "claude" and "opencode". Default: [claude, opencode]
 *   timeoutMinutes  per agent. Default: 10
 *   claudeModel     passed as --model; "" uses the CLI's own default. Default: sonnet
 *   opencodeModel   passed as -m, e.g. deepseek/deepseek-flash; "" uses opencode.json's. Default: ""
 *   claudeBin, opencodeBin   executable paths when they are not in the usual places
 *   mailCommand     a command that mails each day's advice once it is written: a path, or a path and its
 *                   first arguments as a list; `~` expands in the path. It gets the subject as its last
 *                   argument and the body on stdin, e.g. scripts/mail-me. Unset: no mail
 *   todayFile       a Markdown file rewritten with each day's advice, holding that day only; `~` expands.
 *                   Its directory must exist. Unset: no file
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { expandHome, isoLocal } from './inbox-store.js'
import { AdviceStore } from './advice-store.js'

export const AGENT_NAMES = ['claude', 'opencode']
export const DEFAULT_AT = '08:00'
const DEFAULT_TIMEOUT_MINUTES = 10
const DEFAULT_CLAUDE_MODEL = 'sonnet'
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_KINDS = ['训练日', '休息日']
const STDOUT_LIMIT = 4 * 1024 * 1024
const STDERR_LIMIT = 256 * 1024
const LOG_TAIL = 16 * 1024
/** Long enough for the mail command's own retries: mail-me tries three times, 30 s each, with 80 s between. */
const MAIL_TIMEOUT_MS = 4 * 60 * 1000

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
    mailCommand: commandOf(options.mailCommand),
    todayFile: stringOr(options.todayFile, '') === '' ? '' : expandHome(stringOr(options.todayFile, '')),
  }
}

/** A command as an argument list, from a path or a list starting with one; [] when there is none. */
function commandOf(value) {
  const listed = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const parts = listed.filter(part => typeof part === 'string' || typeof part === 'number').map(part => String(part).trim())
  if (parts.length === 0 || parts[0] === '') return []
  return [expandHome(parts[0]), ...parts.slice(1)]
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
1. 先看当前目录的 AGENTS.md。它是工作区规则时，会说明运动健康项目在哪个子目录（例如 sport_health_cc/）：下面提到的「项目 AGENTS.md」、文件和目录都在那个子目录里。当前目录本身就是项目时，就在当前目录。
2. 按项目 AGENTS.md 第 2 节了解现状：当前状态文件（STATUS.md）和 memory.md 必须读，已经在上下文里的不用重复读。
3. 再只读和今天直接相关的：weekly_plans/ 里日期覆盖今天的周计划（没有就参考最近一份和当前状态里的常用周结构）、运动日志.md 最近的记录、饮食日志.md 开头的营养目标。不要读 健康管理/ 目录。
4. 只读不写：不要新建、修改、移动或删除任何文件，不要运行同步，也不要做项目 AGENTS.md 4.8 的对话收尾。工作区规则里写「今日建议.md」的步骤这次不用你做：控制面板会按你下面的回答写那个文件，你只管回答。那里对内容的要求（每条给具体数字、休息日怎么写、有预警信号就降级）照样适用。
5. 建议必须符合 memory.md 的全部约束（动作选择、先力量后跑步、补水、结石和尿酸、晚餐和油脂、血脂、心脏相关的强度限制等）。
6. 有预警信号而降级、改成休息，或者数据有缺口（例如最近没有训练记录）时，给保守、可执行的安排，并在 note 里用一句话说明原因。

输出：只输出一个 JSON 对象，前后不要有任何其他文字，格式如下：
{
  "day": "训练日 或 休息日，二选一",
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
    const day = stringOr(value.day, '')
    if (sport !== null && diet !== null) {
      return { day: DAY_KINDS.includes(day) ? day : '', sport, diet, note: clip(stringOr(value.note, ''), 200) }
    }
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
 * Run a command to its end, keeping the head of its output. `input`, when given, is written to its stdin.
 * @returns { code, killedBy, error, timedOut, aborted, stdout, stderr, seconds }; `error` is set when it never ran.
 */
function runToEnd(bin, args, { cwd, env, input, timeoutMs, signal }) {
  const started = Date.now()
  return new Promise((resolve) => {
    const stdout = collector(STDOUT_LIMIT)
    const stderr = collector(STDERR_LIMIT)
    let settled = false
    let timedOut = false
    let timer = null
    let onAbort = null
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
      resolve({
        code: null, killedBy: null, error: null, ...outcome, timedOut, aborted: signal?.aborted === true,
        stdout: stdout.text, stderr: stderr.text, seconds: Math.round((Date.now() - started) / 100) / 10,
      })
    }
    let child
    try {
      child = spawn(bin, args, { cwd, env, stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ error })
      return
    }
    const kill = () => {
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000).unref()
    }
    timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    timer.unref?.()
    onAbort = () => { kill() }
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', (error) => { finish({ error }) })
    child.on('close', (code, killedBy) => { finish({ code, killedBy }) })
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/** Why a finished {@link runToEnd} failed, or null when it exited 0. `missing` is the message for ENOENT. */
function failureOf(run, { bin, missing, minutes }) {
  if (run.error !== null) return run.error.code === 'ENOENT' ? missing : `启动不了 ${bin}：${run.error.message}`
  if (run.timedOut) return `超过 ${minutes} 分钟没跑完`
  if (run.aborted) return '被中止'
  if (run.code !== 0) {
    const reason = reasonFrom(run.stderr, run.stdout)
    return `退出码 ${run.code ?? run.killedBy}${reason !== '' ? `：${reason}` : ''}`
  }
  return null
}

/** What one process run adds to the day's log file. */
function logOf(header, error, run) {
  return `${header}\n# ${error === null ? 'ok' : `failed: ${error}`} · ${run.seconds}s\n`
    + `## stdout\n${tail(run.stdout)}\n## stderr\n${tail(run.stderr)}\n`
}

/**
 * Run one agent once in the project directory.
 * @returns { ok, text, error, log } where `log` is what goes into the day's log file.
 */
export async function runAgentProcess(agent, { settings, prompt, signal, env = process.env }) {
  const spec = AGENTS[agent]
  const bin = resolveBin(agent, agent === 'claude' ? settings.claudeBin : settings.opencodeBin, env)
  const model = agent === 'claude' ? settings.claudeModel : settings.opencodeModel
  const command = spec.command({ model, cwd: settings.cwd, prompt })
  const run = await runToEnd(bin, command.args, {
    cwd: settings.cwd,
    env: { ...env, ...command.env, PATH: pathFor(bin, env) },
    input: command.viaStdin ? prompt : undefined,
    timeoutMs: settings.timeoutMinutes * 60 * 1000,
    signal,
  })
  let result
  const failure = failureOf(run, { bin, missing: `找不到 ${agent}（${bin}），可以在配置里写 ${agent}Bin`, minutes: settings.timeoutMinutes })
  if (failure !== null) {
    result = { ok: false, text: '', error: failure }
  } else {
    try {
      result = { ok: true, text: spec.answer(run.stdout), error: null }
    } catch (error) {
      result = { ok: false, text: '', error: clip(String(error.message || error), 160) }
    }
  }
  const header = `$ ${bin} ${command.args.map(arg => (arg === prompt ? '<prompt>' : arg)).join(' ')}`
  return { ...result, log: logOf(header, result.error, run) }
}

/** `周X` of a `YYYY-MM-DD` date. */
function weekdayOf(date) {
  const [year, month, day] = date.split('-').map(Number)
  return WEEKDAYS[new Date(year, month - 1, day).getDay()]
}

/** `claude · opus 生成于 08:03` without the verb: who wrote a record, and when. */
function writerOf(record) {
  return { who: record.model ? `${record.agent} · ${record.model}` : record.agent, time: String(record.generated_at).slice(11, 16) }
}

/**
 * A day's advice as a plain-text mail. The subject carries the exercise headline, since that is what a
 * phone's mail list shows; the body has both columns in full, the note, and who wrote it.
 */
export function buildMail(record) {
  const section = (title, value) => [`${title}：${value.headline}`, ...value.items.map(item => `• ${item}`)].join('\n')
  const parts = [section('运动', record.sport), section('饮食', record.diet)]
  if (record.note) parts.push(`提醒：${record.note}`)
  const { who, time } = writerOf(record)
  parts.push(`${who} 生成于 ${time}`)
  return {
    subject: `今日 ${record.date.slice(5)} ${weekdayOf(record.date)}：${record.sport.headline || '运动计划'}`,
    body: `${parts.join('\n\n')}\n`,
  }
}

/**
 * A day's advice as the Markdown of the today file, in the shape the SportHealth workspace's AGENTS.md
 * gives `inbox/今日建议.md`: a title with the date and the kind of day, the note quoted under it, then the
 * exercise and diet sections, each a headline line and a list. The last line says it was written here.
 */
export function buildTodayFile(record) {
  const title = `今日建议 · ${record.date}（${weekdayOf(record.date)}）${record.day ? `· ${record.day}` : ''}`
  const section = (name, value) => [
    `## ${name}`,
    ...(value.headline ? ['', value.headline] : []),
    ...(value.items.length > 0 ? ['', ...value.items.map(item => `- ${item}`)] : []),
  ].join('\n')
  const { who, time } = writerOf(record)
  const parts = [`# ${title}`]
  if (record.note) parts.push(`> ${record.note}`)
  parts.push(section('运动', record.sport), section('饮食', record.diet), `*${who} 自动生成于 ${time}*`)
  return `${parts.join('\n\n')}\n`
}

/** Why a file could not be written, in the words the Today page shows. */
function writeProblem(path, error) {
  if (error.code === 'ENOENT') return `找不到目录 ${dirname(path)}`
  if (error.code === 'EISDIR') return `${path} 是目录`
  if (error.code === 'EPERM' || error.code === 'EACCES') return `没有权限写 ${path}（文件只读，或 macOS 隐私保护拦下了这个进程）`
  return `写不了 ${path}：${error.message}`
}

/**
 * Overwrite the today file with a day's advice. When the file held something else, that is kept in the
 * store first: the user may have noted on the phone what they actually did.
 * @returns { ok, error, replaced } where `replaced` is where the old content was kept, or null.
 */
export function writeTodayFile(path, record, store) {
  const content = buildTodayFile(record)
  try {
    let previous = null
    try {
      previous = readFileSync(path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const replaced = previous !== null && previous !== content ? store.keepReplaced(previous) : null
    // In place, not through a temporary file: a sync job watching the directory would carry that file too.
    writeFileSync(path, content, 'utf8')
    return { ok: true, error: null, replaced }
  } catch (error) {
    return { ok: false, error: writeProblem(path, error), replaced: null }
  }
}

/**
 * Hand one mail to the configured command: the subject as its last argument, the body on its stdin.
 * The command does the sending and its own retries; this only waits for it, up to `MAIL_TIMEOUT_MS`.
 * @returns { ok, error, log }.
 */
export async function runMailProcess(command, { subject, body, signal, env = process.env }) {
  const [bin, ...args] = command
  const run = await runToEnd(bin, [...args, subject], {
    env: { ...env, PATH: pathFor(bin, env) }, input: body, timeoutMs: MAIL_TIMEOUT_MS, signal,
  })
  const error = failureOf(run, { bin, missing: `找不到发信命令 ${bin}`, minutes: MAIL_TIMEOUT_MS / 60000 })
  return { ok: error === null, error, log: logOf(`$ ${[bin, ...args].join(' ')} <subject>`, error, run) }
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
 * shape, and save the result; then write the today file and send the mail, for those that are configured.
 * @returns null when another run holds the lock, else the run's promise of { ok, record }.
 */
export function startAdvice({ store, settings, trigger, signal, runAgent = runAgentProcess, sendMail = runMailProcess }) {
  const lock = store.acquire({ trigger, agent: settings.agents[0] })
  return lock === null ? null : runAndDeliver({ store, settings, trigger, signal, runAgent, sendMail, lock })
}

/** {@link startAdvice}, awaited. @returns { started: false } when another run holds the lock. */
export async function generateAdvice(options) {
  const pending = startAdvice(options)
  return pending === null ? { started: false } : { started: true, ...(await pending) }
}

/**
 * The run under the lock, then the today file and the mail once the lock is free: a slow mail server keeps
 * neither the Today page on "writing" nor a manual run waiting.
 */
async function runAndDeliver(options) {
  const outcome = await runLocked(options)
  if (!outcome.ok) return outcome
  let record = outcome.record
  if (options.settings.todayFile !== '') record = saveTodayFile(options, record)
  if (options.settings.mailCommand.length > 0) record = await mailAdvice(options, record)
  return { ...outcome, record }
}

/**
 * Add fields to the day's record, unless a newer run replaced it meanwhile; that run notes its own.
 * @returns the record as it stands for this run.
 */
function annotate(store, record, fields) {
  const current = store.read(record.date)
  if (current === null || current.generated_at !== record.generated_at) return record
  const next = { ...current, ...fields }
  store.write(record.date, next)
  return next
}

/** Write the today file, log where it went and what it replaced, and note the outcome on the record. */
function saveTodayFile({ store, settings, trigger }, record) {
  const result = writeTodayFile(settings.todayFile, record, store)
  const kept = result.replaced !== null ? `；原来的内容存到 ${result.replaced}` : ''
  store.log(record.date, `\n===== ${isoLocal(store.clock())} · ${trigger} · 今日文件\n${result.ok ? `写入 ${settings.todayFile}${kept}` : result.error}`)
  return annotate(store, record, {
    today_file: result.ok ? { written_at: isoLocal(store.clock()), error: null } : { written_at: null, error: result.error },
  })
}

/**
 * Mail advice that was just written, then note on the day's record whether it went out. A record that a
 * newer run replaced meanwhile is left alone; that run mails its own. A failed mail is not retried here.
 */
async function mailAdvice({ store, settings, trigger, signal, sendMail }, record) {
  const { subject, body } = buildMail(record)
  const result = await sendMail(settings.mailCommand, { subject, body, signal })
  store.log(record.date, `\n===== ${isoLocal(store.clock())} · ${trigger} · 邮件\n${result.log ?? ''}`)
  return annotate(store, record, {
    mail: result.ok ? { sent_at: isoLocal(store.clock()), error: null } : { sent_at: null, error: result.error || '发信失败' },
  })
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
  constructor({ dir, settings, clock = () => new Date(), runAgent = runAgentProcess, sendMail = runMailProcess,
    checkEveryMs = 5 * 60 * 1000, firstCheckAfterMs = 20 * 1000, retryAfterMs = 30 * 60 * 1000, maxFailures = 3 }) {
    this.settings = normalizeAdviceSettings(settings)
    this.store = new AdviceStore({ dir, clock, staleAfterMs: (this.settings.timeoutMinutes * this.settings.agents.length + 10) * 60 * 1000 })
    this.clock = clock
    this.runAgent = runAgent
    this.sendMail = sendMail
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
      mail: this.settings.mailCommand.length > 0,
      todayFile: this.settings.todayFile,
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
    const pending = startAdvice({
      store: this.store, settings: this.settings, trigger, signal: this.abort.signal, runAgent: this.runAgent, sendMail: this.sendMail,
    })
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
