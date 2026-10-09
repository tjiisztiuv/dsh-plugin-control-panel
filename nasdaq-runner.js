/**
 * The desk's Nasdaq line: once a day, run the nasdaq_valuation tool in its own directory and keep three of its
 * numbers: how far the Nasdaq-100 moved in its last session, the deviation-percentile score (乖离分位评分), and
 * the SMA three-line score. The tool computes them; this module runs it and reads what it left behind:
 * `latest_signals.json` for the session date, the close, and the two scores as the report prints them, and the
 * tool's cache of daily bars, `cache/ndx_daily.csv`, for the close before, which the change needs.
 * advice-store.js keeps the days, under `<dir>/nasdaq/`.
 *
 * Row config in a profile's cordis.patch.yml, under `nasdaq`:
 *   cwd             the nasdaq_valuation directory; `~` expands. Unset: the feature is off
 *   at              local time a day's run becomes due, "HH:MM". Default: 08:10
 *   command         what runs there: a path, or a path and its arguments as a list; `~` expands in the path.
 *                   It must rewrite latest_signals.json. Default: [/usr/bin/python3, main.py]
 *   timeoutMinutes  Default: 5
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { AdviceStore } from './advice-store.js'
import {
  clip, commandOf, dayIsDue, directoryProblem, failureOf, isRecord, logOf, pathFor, runToEnd, stringOr,
} from './advice-runner.js'
import { expandHome, isoLocal } from './inbox-store.js'

export const NASDAQ_DIRNAME = 'nasdaq'
export const DEFAULT_NASDAQ_AT = '08:10'
const DEFAULT_COMMAND = ['/usr/bin/python3', 'main.py']
const DEFAULT_TIMEOUT_MINUTES = 5
const SIGNALS_FILE = 'latest_signals.json'
const BARS_FILE = join('cache', 'ndx_daily.csv')
/** How many of the newest day files the line looks through for numbers while today's are not in yet. */
const LOOKBACK_FILES = 7

/** The row config's `nasdaq` object, checked and defaulted; normalizing twice changes nothing. */
export function normalizeNasdaqSettings(raw) {
  const options = isRecord(raw) ? raw : {}
  const cwd = stringOr(options.cwd, '')
  const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(stringOr(options.at, ''))
  const command = commandOf(options.command)
  const minutes = Number(options.timeoutMinutes)
  return {
    cwd: cwd === '' ? '' : expandHome(cwd),
    at: at === null ? DEFAULT_NASDAQ_AT : `${at[1].padStart(2, '0')}:${at[2]}`,
    command: command.length > 0 ? command : [...DEFAULT_COMMAND],
    timeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES,
  }
}

const round = (value, digits) => Number(value.toFixed(digits))

/**
 * The session date, the close, and the two scores in latest_signals.json. They come from its `signals` block,
 * which the tool rounds the way its report prints them.
 * @returns { ok: true, quote: { report_date, close, valuation_score, sma_score, signals_at } }, or { ok: false, error }.
 */
export function quoteOf(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: `${SIGNALS_FILE} 不是合法的 JSON` }
  }
  const signals = isRecord(data) && isRecord(data.signals) ? data.signals : {}
  const date = isRecord(data) && typeof data.report_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.report_date) ? data.report_date : null
  const valuation = signals.valuation_score
  const sma = signals.sma_score
  if (date === null || typeof valuation !== 'number' || !Number.isFinite(valuation) || !Number.isInteger(sma)) {
    return { ok: false, error: `${SIGNALS_FILE} 里缺 report_date、signals.valuation_score 或 signals.sma_score` }
  }
  return {
    ok: true,
    quote: {
      report_date: date,
      close: typeof signals.ndx_close === 'number' && Number.isFinite(signals.ndx_close) ? signals.ndx_close : null,
      valuation_score: valuation,
      sma_score: sma,
      signals_at: typeof data.generated_at === 'string' ? data.generated_at : null,
    },
  }
}

/**
 * The session on `date` against the bar before it, from the daily-bar cache: a CSV with `Date` and `Close`
 * columns, oldest first. @returns { prev_date, prev_close, change_pct }, or null when either bar is missing.
 */
export function changeOf(csv, date) {
  const lines = String(csv).split('\n').map(line => line.trim()).filter(line => line !== '')
  const header = (lines[0] ?? '').split(',')
  const dateAt = header.indexOf('Date')
  const closeAt = header.indexOf('Close')
  if (dateAt < 0 || closeAt < 0) return null
  for (let index = lines.length - 1; index >= 2; index -= 1) {
    const cells = lines[index].split(',')
    if (String(cells[dateAt]).slice(0, 10) !== date) continue
    const before = lines[index - 1].split(',')
    const close = Number(cells[closeAt])
    const previous = Number(before[closeAt])
    if (!(close > 0) || !(previous > 0)) return null
    return { prev_date: String(before[dateAt]).slice(0, 10), prev_close: round(previous, 2), change_pct: round((close / previous - 1) * 100, 2) }
  }
  return null
}

/**
 * What a run that started at `started` left in the tool's directory. latest_signals.json written before that
 * is refused: it would be an older day's numbers, from a command that does not rewrite the file.
 * @returns { ok: true, quote } or { ok: false, error }.
 */
export function readQuote(cwd, started) {
  let text
  try {
    text = readFileSync(join(cwd, SIGNALS_FILE), 'utf8')
  } catch (error) {
    return { ok: false, error: error.code === 'ENOENT' ? `没有生成 ${SIGNALS_FILE}` : `读不了 ${SIGNALS_FILE}：${error.message}` }
  }
  const parsed = quoteOf(text)
  if (!parsed.ok) return parsed
  const written = Date.parse(parsed.quote.signals_at)
  // The tool's timestamp has whole seconds, so the start is rounded down to compare.
  if (Number.isNaN(written) || written < Math.floor(started.getTime() / 1000) * 1000) {
    return { ok: false, error: `${SIGNALS_FILE} 不是这次运行写的（生成于 ${parsed.quote.signals_at ?? '未知时间'}）` }
  }
  let change = null
  try {
    change = changeOf(readFileSync(join(cwd, BARS_FILE), 'utf8'), parsed.quote.report_date)
  } catch {
    // Without the cache only the change is missing; the scores still show.
  }
  return { ok: true, quote: { ...parsed.quote, ...(change ?? { prev_date: null, prev_close: null, change_pct: null }) } }
}

/** Run the configured command once in the tool's directory. @returns { ok, error, log }. */
export async function runNasdaqProcess(settings, { signal, env = process.env } = {}) {
  const [bin, ...args] = settings.command
  const run = await runToEnd(bin, args, {
    cwd: settings.cwd,
    // A Dock-launched dsh has no LANG, and the tool prints Chinese.
    env: { ...env, PATH: pathFor(bin, env), PYTHONIOENCODING: 'utf-8' },
    timeoutMs: settings.timeoutMinutes * 60 * 1000,
    signal,
  })
  const error = failureOf(run, { bin, missing: `找不到 ${bin}，可以在配置里写 nasdaq.command`, minutes: settings.timeoutMinutes })
  return { ok: error === null, error, log: logOf(`$ ${settings.command.join(' ')}`, error, run) }
}

/**
 * Start one run for today: take the lock, run the tool, read its numbers, and save the day.
 * @returns null when another run holds the lock, else the run's promise of { ok, record }.
 */
export function startNasdaq({ store, settings, trigger, signal, runCommand = runNasdaqProcess }) {
  const lock = store.acquire({ trigger })
  return lock === null ? null : runLocked({ store, settings, trigger, signal, runCommand, lock })
}

async function runLocked({ store, settings, trigger, signal, runCommand, lock }) {
  const date = store.today()
  const started = store.clock()
  try {
    let error = directoryProblem(settings.cwd)
    let quote = null
    if (error !== null) {
      store.log(date, `\n===== ${isoLocal(store.clock())} · ${trigger}\n${error}`)
    } else {
      const result = await runCommand(settings, { signal })
      store.log(date, `\n===== ${isoLocal(store.clock())} · ${trigger}\n${result.log ?? ''}`)
      error = result.ok ? null : clip(result.error || '运行失败', 200)
      if (error === null) {
        const read = readQuote(settings.cwd, started)
        if (read.ok) {
          quote = read.quote
        } else {
          error = read.error
          store.log(date, `# ${error}`)
        }
      }
    }
    if (quote !== null) {
      const record = {
        date,
        status: 'ready',
        generated_at: isoLocal(store.clock()),
        trigger,
        duration_ms: store.clock().getTime() - started.getTime(),
        ...quote,
        error: null,
        failures: 0,
        last_failed_at: null,
      }
      store.write(date, record)
      return { ok: true, record }
    }
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

/** The newest day whose run succeeded, today's or an earlier one, or null. */
function latestReady(store) {
  let names
  try {
    names = readdirSync(store.dir)
  } catch {
    return null
  }
  const days = names.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse().slice(0, LOOKBACK_FILES)
  for (const name of days) {
    const record = store.read(name.slice(0, 10))
    if (record !== null && record.status === 'ready') return record
  }
  return null
}

/**
 * The Host half's side: answers the desk and runs the tool once a day, on the same terms as the advice
 * (see AdviceService): due from `at` until a run succeeds, failed runs retried, only while dsh is open.
 */
export class NasdaqService {
  constructor({ dir, settings, clock = () => new Date(), runCommand = runNasdaqProcess,
    checkEveryMs = 5 * 60 * 1000, firstCheckAfterMs = 20 * 1000, retryAfterMs = 30 * 60 * 1000, maxFailures = 3 }) {
    this.settings = normalizeNasdaqSettings(settings)
    this.store = new AdviceStore({ dir, clock, name: NASDAQ_DIRNAME, staleAfterMs: (this.settings.timeoutMinutes + 5) * 60 * 1000 })
    this.runCommand = runCommand
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

  /** `record` is today's, which says how today's run went; `latest` holds the numbers the desk shows. */
  status() {
    const date = this.store.today()
    const running = this.enabled ? this.store.running() : null
    return {
      enabled: this.enabled,
      date,
      at: this.settings.at,
      running: running === null ? null : { started_at: running.started_at, trigger: running.trigger },
      record: this.enabled ? this.store.read(date) : null,
      latest: this.enabled ? latestReady(this.store) : null,
      logPath: this.store.logPathOf(date),
    }
  }

  due() {
    return this.enabled && dayIsDue(this.store, this.settings.at, { maxFailures: this.maxFailures, retryAfterMs: this.retryAfterMs })
  }

  /** Start a run in the background. @returns whether it started (false: off, or another run is going). */
  run(trigger) {
    if (!this.enabled) return false
    const pending = startNasdaq({ store: this.store, settings: this.settings, trigger, signal: this.abort.signal, runCommand: this.runCommand })
    if (pending === null) return false
    this.current = pending.catch((error) => { console.error('dsh-plugin-control-panel: nasdaq run failed', error) })
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
