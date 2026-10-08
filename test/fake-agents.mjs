/**
 * Fake `claude` and `opencode` executables for the advice tests, so the runner's real child-process path
 * runs without calling a model.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ADVICE = {
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
