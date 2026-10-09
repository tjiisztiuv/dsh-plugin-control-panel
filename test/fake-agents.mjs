/**
 * Fake `claude` and `opencode` executables for the advice tests, and a fake nasdaq_valuation tool for the
 * Nasdaq line, so the runners' real child-process paths run without calling a model or the network.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ADVICE = {
  day: '训练日',
  sport: { headline: '轻松跑 6 km · 心率 ≤145', items: ['先热身 10 分钟', '跑后拉伸腘绳肌'] },
  diet: { headline: '训练日 · 约 1900 kcal', items: ['早餐：燕麦 50 g + 鸡蛋 2 个', '饮水 2500 ml，跑后补 600 ml'] },
  note: '最近没有训练记录，按常用周结构安排。',
}

/**
 * A fake agent executable in `dir`. It records its arguments, stdin, cwd, and permission override in
 * `<name>.capture.json`, and behaves as `<name>.mode` says: ok (default), fail, garbage, or sleep.
 */
export function fakeAgent(dir, name) {
  const path = join(dir, name)
  const answer = name === 'claude'
    ? `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        result: '好的。\\n\`\`\`json\\n' + JSON.stringify(ADVICE) + '\\n\`\`\`' }))`
    : `for (const event of [{ type: 'step_start' }, { type: 'text', part: { text: JSON.stringify(ADVICE) } }, { type: 'step_finish' }])
         console.log(JSON.stringify(event))`
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const ADVICE = ${JSON.stringify(ADVICE)}
const own = suffix => path.join(__dirname, '${name}.' + suffix)
let input = ''
const done = () => {
  fs.writeFileSync(own('capture.json'), JSON.stringify({
    args: process.argv.slice(2), input, cwd: process.cwd(), permission: process.env.OPENCODE_PERMISSION ?? null,
  }))
  const mode = fs.existsSync(own('mode')) ? fs.readFileSync(own('mode'), 'utf8').trim() : 'ok'
  if (mode === 'fail') { process.stderr.write('starting\\nError: rate limit reached\\n'); process.exit(1) }
  if (mode === 'garbage') {
    console.log(${name === 'claude'}
      ? JSON.stringify({ type: 'result', is_error: false, result: '我没法按格式回答' })
      : JSON.stringify({ type: 'text', part: { text: '我没法按格式回答' } }))
    return
  }
  if (mode === 'sleep') { setTimeout(() => {}, 60000); return }
  ${answer}
}
if (${name === 'claude'}) process.stdin.on('data', chunk => { input += chunk }).on('end', done)
else done()
`)
  chmodSync(path, 0o755)
  return {
    path,
    mode: (value) => { writeFileSync(join(dir, `${name}.mode`), value) },
    capture: () => JSON.parse(readFileSync(join(dir, `${name}.capture.json`), 'utf8')),
  }
}

/**
 * A fake mail command named `mail-me` in `dir`. It records its arguments and stdin in `mail-me.capture.json`
 * and, when `mail-me.mode` says fail, exits 1 the way scripts/mail-me does after its last retry.
 */
export function fakeMailer(dir) {
  const path = join(dir, 'mail-me')
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const own = suffix => path.join(__dirname, 'mail-me.' + suffix)
let input = ''
process.stdin.on('data', chunk => { input += chunk }).on('end', () => {
  fs.writeFileSync(own('capture.json'), JSON.stringify({ args: process.argv.slice(2), input }))
  const mode = fs.existsSync(own('mode')) ? fs.readFileSync(own('mode'), 'utf8').trim() : 'ok'
  if (mode === 'fail') {
    process.stderr.write('mail-me: 第 1 次发送失败（TimeoutError: timed out），20s 后重试\\nmail-me: 发送失败（试了 3 次）：TimeoutError: timed out\\n')
    process.exit(1)
  }
})
`)
  chmodSync(path, 0o755)
  return {
    path,
    mode: (value) => { writeFileSync(join(dir, 'mail-me.mode'), value) },
    capture: () => JSON.parse(readFileSync(join(dir, 'mail-me.capture.json'), 'utf8')),
  }
}

/** The numbers the fake nasdaq_valuation tool writes: the 2026-10-08 session against the 10-07 close. */
export const NASDAQ = { report_date: '2026-10-08', close: 30725.81, prev_close: 31160.08, valuation_score: 6.3, sma_score: 5 }

/**
 * A fake nasdaq_valuation tool: an executable `fake-main` in `dir` that, run with `dir` as its cwd, writes
 * latest_signals.json and cache/ndx_daily.csv the way main.py does. It records its arguments, cwd, and
 * PYTHONIOENCODING in `fake-main.capture.json`, and behaves as `fake-main.mode` says: ok (default), fail
 * (exit 1 with a traceback's last line), silent (exit 0 without writing), or nocache (no bar cache).
 */
export function fakeNasdaqTool(dir) {
  const path = join(dir, 'fake-main')
  const signals = {
    schema: 1, report_date: NASDAQ.report_date, target_date: null,
    signals: { valuation_score: NASDAQ.valuation_score, sma_score: NASDAQ.sma_score, fear_greed: 37.9, ndx_close: NASDAQ.close },
    readings: {}, data_sources: [], report_text: '',
  }
  const csv = [
    'Date,Open,High,Low,Close,Volume,source',
    '2026-10-06,31255.4,31361.3,31208.1,31224.470703125,8451470000.0,yfinance',
    `2026-10-07,30976.25,31170.1,30904.4,${NASDAQ.prev_close},7315500000.0,yfinance`,
    `2026-10-08,30985.2,31125.1,30556.4,${NASDAQ.close},8820120000.0,yfinance`,
  ].join('\n')
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs')
const path = require('path')
const own = suffix => path.join(__dirname, 'fake-main.' + suffix)
fs.writeFileSync(own('capture.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), encoding: process.env.PYTHONIOENCODING ?? null }))
const mode = fs.existsSync(own('mode')) ? fs.readFileSync(own('mode'), 'utf8').trim() : 'ok'
console.log('Nasdaq 100 Daily Valuation (纳指100乖离分位)')
if (mode === 'fail') { process.stderr.write('Traceback (most recent call last):\\nConnectionError: yfinance unreachable\\n'); process.exit(1) }
if (mode === 'silent') process.exit(0)
fs.writeFileSync('latest_signals.json', JSON.stringify({ ...${JSON.stringify(signals)}, generated_at: new Date().toISOString() }))
if (mode !== 'nocache') {
  fs.mkdirSync('cache', { recursive: true })
  fs.writeFileSync(path.join('cache', 'ndx_daily.csv'), ${JSON.stringify(csv)} + '\\n')
}
`)
  chmodSync(path, 0o755)
  return {
    path,
    mode: (value) => { writeFileSync(join(dir, 'fake-main.mode'), value) },
    capture: () => JSON.parse(readFileSync(join(dir, 'fake-main.capture.json'), 'utf8')),
  }
}
