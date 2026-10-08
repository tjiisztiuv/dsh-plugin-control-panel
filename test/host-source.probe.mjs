/**
 * Compatibility probe against a DeepSeek Harness source checkout.
 *
 * Runs this bundle's manifest and slot registrations through the host's own code: the plugin
 * compatibility gate, the `dsh.client` parser, and the slot registry. Set DSH_SRC to the checkout
 * and run `npm run test:host` after pulling a new host version. Skipped when DSH_SRC is unset.
 *
 * It needs Node's TypeScript stripping (`--experimental-strip-types`, Node >= 22.6) because it
 * imports the host's `.ts` sources directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadDefinition, React } from './fake-host.mjs'
import { adviceRoutes, inboxRoutes, memoRoutes } from '../index.js'

const root = process.env.DSH_SRC ? resolve(process.env.DSH_SRC) : undefined
const skip = root === undefined ? 'DSH_SRC is not set' : !existsSync(join(root, 'packages')) ? `${root} is not a DSH checkout` : false
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const hostModule = path => import(pathToFileURL(join(root, path)).href)

test('the running host version satisfies this bundle\'s dsh peer range', { skip }, async () => {
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await hostModule('packages/boot/app-boot/src/plugin-compatibility.ts')
  const runtime = getDshRuntimeVersion()
  const verdict = evaluatePluginCompatibility(manifest, {}, runtime)
  assert.equal(verdict, undefined, `dsh ${runtime} refuses peers ${JSON.stringify(verdict?.peers)}`)
})

test('the host accepts the dsh.client declaration and finds the client bundle', { skip }, async () => {
  const { parseDshClient } = await hostModule('packages/client/modules/src/client/manifest.ts')
  const declaration = parseDshClient(manifest.name, manifest.dsh.client)
  assert.equal(declaration.platform, 'web')
  assert.equal(typeof manifest.exports['./client'], 'string')
  for (const name of declaration.inject ?? []) {
    const directory = name.replace('@deepseek-ai/dsh-client-', '')
    assert.ok(existsSync(join(root, 'packages/client', directory, 'package.json')), `${name} is no longer a client package`)
  }
})

test('the host slot registry accepts all four registrations beside the host\'s own panels', { skip }, async () => {
  const { SlotCore, resolveSlotLabel } = await hostModule('packages/client/ui-slots/src/index.ts')
  const core = new SlotCore()
  const Occupant = () => null
  // The declarations ui-layout and ui-sidebar make, and the two panels the default Web composition ships.
  core.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, sidebar: { kind: 'single', scope: 'root' } } }, Occupant)
  core.register({ name: 'sidebar', children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } } }, Occupant)
  for (const [id, order] of [['plugins', 0], ['schedules', 10]]) {
    core.register({ name: 'main', key: id }, Occupant)
    core.register({ name: 'sidebar.panellist', id, order, label: () => id }, Occupant)
  }

  // The Client half asks its Host half for the unread count as soon as it is applied.
  globalThis.fetch = async () => new Response('{}', { status: 404 })
  const plugin = loadDefinition().factory(name => (name === 'react' ? React : assert.fail(`unexpected module ${name}`)))
  plugin.apply({
    effect(callback) { callback() },
    locale: { register: () => () => {}, bind: () => key => ({ panel: '控制面板', today: '今日' })[key] ?? key },
    slots: { inject: (owner, callback) => callback(), register: (options, component) => core.register(options, component) },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    uiWorkspace: {},
    layout: {},
  })

  for (const key of ['control-panel', 'control-panel-today']) {
    assert.ok(core.entries('main').some(entry => entry.options.key === key), `no main panel ${key}`)
  }
  const panels = core.entriesOfSlot('sidebar.panellist')
    .map(({ options }) => ({ id: options.id, order: options.order ?? 0, label: resolveSlotLabel(options.label) }))
    .sort((a, b) => a.order - b.order)
  assert.deepEqual(panels.map(panel => panel.id), ['plugins', 'schedules', 'control-panel', 'control-panel-today'])
  assert.deepEqual(panels.slice(2).map(panel => panel.label), ['控制面板', '今日'])
})

test('the host\'s route registry would accept the Host half\'s routes', { skip }, () => {
  // Read from the source text: importing the Connection service needs a built checkout.
  const source = readFileSync(join(root, 'packages/client/connection/src/rpc-host.ts'), 'utf8')
  const pattern = /ENDPOINT_SEGMENT_PATTERN = (\/.+\/)\n/.exec(source)
  assert.ok(pattern, 'the endpoint segment pattern moved')
  const segment = new RegExp(pattern[1].slice(1, -1))
  const methods = /export type ConnectionFetchMethod = (.+)\n/.exec(
    readFileSync(join(root, 'packages/client/connection/src/rpc.ts'), 'utf8'))
  assert.ok(methods, 'the Fetch method type moved')
  for (const route of [...inboxRoutes({}), ...memoRoutes({}), ...adviceRoutes({})]) {
    assert.match(`control-panel.${route.suffix}`, segment)
    for (const method of route.methods) assert.ok(methods[1].includes(`'${method}'`), `${method} is no longer a route method`)
  }
})
