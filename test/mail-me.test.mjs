/**
 * scripts/mail-me without a mail server: `--dry-run` prints the message it would send, so these check where
 * the sender, the recipient, and the credentials come from, and that Chinese text survives the encoding.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PYTHON = '/usr/bin/python3'
const SCRIPT = new URL('../scripts/mail-me', import.meta.url).pathname
const skip = existsSync(PYTHON) ? false : `${PYTHON} is not here`

/** A home directory of its own, so neither the real ~/.config nor QQ_MAIL_* from the shell leak in. */
function home() {
  const root = mkdtempSync(join(tmpdir(), 'dshcp-mail-me-'))
  const env = { PATH: '/usr/bin:/bin', HOME: root, MAIL_ME_CONFIG: join(root, 'config.ini') }
  return { root, env }
}

function mailMe(env, args, input = '') {
  const run = spawnSync(PYTHON, [SCRIPT, ...args], { env, input, encoding: 'utf8' })
  return { code: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** Headers and body of a printed message, with RFC 2047 words and the base64 body decoded. */
function parse(message) {
  const [head, ...rest] = message.split('\n\n')
  const headers = {}
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const at = line.indexOf(':')
    headers[line.slice(0, at)] = line.slice(at + 1).trim()
      .replace(/=\?utf-8\?b\?([^?]*)\?=\s*/gi, (_, encoded) => Buffer.from(encoded, 'base64').toString('utf8'))
  }
  return { headers, body: Buffer.from(rest.join('\n\n').replace(/\s+/g, ''), 'base64').toString('utf8') }
}

test('sends from the [qq_mail] account the credentials file names, to the configured recipient', { skip }, () => {
  const { root, env } = home()
  writeFileSync(join(root, 'qq_mail.ini'), '[qq_mail]\nuser = 10001@qq.com\nauth_code = abcdefghijklmnop\n')
  writeFileSync(env.MAIL_ME_CONFIG, `[mail-me]\nto = me@gmail.com\ncredentials = ~/qq_mail.ini\n`)
  const body = '运动：力量B 上肢+体态\n• 高位下拉 3×12\n\n饮食：恢复周 · 约 2000 kcal\n'
  const run = mailMe(env, ['--dry-run', '今日 10-09 周五：力量B 上肢+体态 · 不练腿 · 约50分钟'], body)
  assert.equal(run.code, 0, run.stderr)
  const { headers, body: text } = parse(run.stdout)
  assert.equal(headers.From, '10001@qq.com')
  assert.equal(headers.To, 'me@gmail.com')
  assert.equal(headers.Subject, '今日 10-09 周五：力量B 上肢+体态 · 不练腿 · 约50分钟')
  assert.match(headers['Content-Type'], /text\/plain; charset="utf-8"/)
  assert.match(headers['Message-ID'], /@qq\.com>$/, 'the Message-ID domain is the sender\'s')
  assert.ok(headers.Date)
  assert.equal(text, body)
  assert.doesNotMatch(run.stdout, /abcdefghijklmnop/)
})

test('-t overrides the recipient, and QQ_MAIL_USER / QQ_MAIL_AUTH_CODE work without a config file', { skip }, () => {
  const { env } = home()
  const run = mailMe({ ...env, QQ_MAIL_USER: '10002@qq.com', QQ_MAIL_AUTH_CODE: 'x' }, ['--dry-run', '-t', 'other@example.com', '备份完成'], 'NAS 增量备份 12.3 GB')
  assert.equal(run.code, 0, run.stderr)
  const { headers, body } = parse(run.stdout)
  assert.deepEqual([headers.From, headers.To, headers.Subject], ['10002@qq.com', 'other@example.com', '备份完成'])
  assert.equal(body, 'NAS 增量备份 12.3 GB')
})

test('credentials can sit in the config file itself', { skip }, () => {
  const { env } = home()
  writeFileSync(env.MAIL_ME_CONFIG, '[mail-me]\nto = me@gmail.com\n\n[qq_mail]\nuser = 10003@qq.com\nauth_code = y\n')
  const run = mailMe(env, ['--dry-run', 's'], 'b')
  assert.equal(run.code, 0, run.stderr)
  assert.equal(parse(run.stdout).headers.From, '10003@qq.com')
})

test('a missing recipient, missing credentials, or a missing credentials file exits 2 and says what to set', { skip }, () => {
  const { root, env } = home()
  const noRecipient = mailMe({ ...env, QQ_MAIL_USER: 'a@qq.com', QQ_MAIL_AUTH_CODE: 'x' }, ['--dry-run', 's'])
  assert.equal(noRecipient.code, 2)
  assert.match(noRecipient.stderr, /不知道发给谁：用 -t 指定/)

  writeFileSync(env.MAIL_ME_CONFIG, '[mail-me]\nto = me@gmail.com\n')
  const noCredentials = mailMe(env, ['--dry-run', 's'])
  assert.equal(noCredentials.code, 2)
  assert.match(noCredentials.stderr, /缺少 QQ 邮箱凭据/)

  writeFileSync(env.MAIL_ME_CONFIG, `[mail-me]\nto = me@gmail.com\ncredentials = ${join(root, 'nope.ini')}\n`)
  const noFile = mailMe(env, ['--dry-run', 's'])
  assert.equal(noFile.code, 2)
  assert.match(noFile.stderr, /找不到 .*nope\.ini/)
})
