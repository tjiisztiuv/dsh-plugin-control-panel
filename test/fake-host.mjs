/**
 * A stand-in for the parts of the DSH Web client this plugin touches, so the Client half can be loaded,
 * rendered, and driven in plain Node. It checks this plugin's own logic; it cannot tell whether the real
 * host still has these interfaces.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as hostHalf from '../index.js'
import { InboxStore } from '../inbox-store.js'
import { MemoStore } from '../memo-store.js'

const require = createRequire(import.meta.url)
export const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/** Evaluate client.js the way the browser does and return what it handed to the module loader. */
export function loadDefinition() {
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  new Function('window', readFileSync(CLIENT_PATH, 'utf8'))(window)
  return definition
}

/**
 * Run the real Host half on a fresh inbox directory and point the global `fetch` at its routes, the way
 * the page's same-origin requests reach them. `state.hostMissing` leaves every route unregistered;
 * `state.hostConfig` adds to the row config, e.g. `{ advice: { cwd } }`.
 * @returns the inbox directory.
 */
function mountHostHalf(state, disposers) {
  const inboxDir = state.inboxDir ?? mkdtempSync(join(tmpdir(), 'dshcp-panel-'))
  const routes = new Map()
  if (!state.hostMissing) {
    hostHalf.apply({
      effect(callback) { disposers.push(callback()) },
      connection: { fetch: { register(route) { routes.set(route.path, route); return async () => {} } } },
    }, { inboxDir, ...state.hostConfig })
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1:3080/')
    const route = routes.get(url.pathname)
    const method = init.method ?? 'GET'
    if (route === undefined || !route.methods.includes(method)) return new Response('', { status: 404 })
    return route.fetch(new Request(url, init))
  }
  return inboxDir
}

/**
 * Mount both halves of the plugin against fake services.
 * @param state - `workspaces`, `sessions`, `statuses` snapshots, plus `promptResult`, `connectError`,
 *   and `hostMissing`.
 */
export function mount(state) {
  const disposers = []
  const inboxDir = mountHostHalf(state, disposers)
  const definition = loadDefinition()
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected module request: ${name}`)
  })
  const calls = []
  const registered = {}
  const dictionaries = {}
  const host = { locale: 'zh' }
  const bind = ns => (key, params) => {
    const template = dictionaries[ns]?.[host.locale]?.[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  const ctx = {
    effect(callback) { disposers.push(callback()) },
    locale: {
      register(ns, dictionary) { dictionaries[ns] = dictionary; return () => { delete dictionaries[ns] } },
      bind,
    },
    slots: {
      inject(owner, callback) { callback() },
      register(options, component) {
        registered[options.name] = { ...registered[options.name], [options.key ?? options.id]: { options, component } }
        return () => {}
      },
    },
    workspaces: { list: { getSnapshot: () => state.workspaces } },
    sessions: {
      list: { getSnapshot: () => state.sessions },
      async using(sessionId, options, operation) {
        calls.push(['using', sessionId, options.source])
        return operation({
          sessionId,
          binding: {
            session: {
              async prompt(content, mode) {
                calls.push(['prompt', sessionId, content, mode])
                return state.promptResult ?? { ok: true, value: { accepted: true } }
              },
            },
          },
        })
      },
    },
    uiWorkspace: {
      async connectWorkspace(workspaceId) {
        calls.push(['connect', workspaceId])
        if (state.connectError) throw new Error(state.connectError)
        return `session-in-${workspaceId}`
      },
      openSession(sessionId) { calls.push(['open', sessionId]) },
    },
    layout: { selectPanel(panelId) { calls.push(['select', panelId]) } },
  }
  plugin.apply(ctx)

  const main = registered.main['control-panel']
  const today = registered.main['control-panel-today']
  const { hooks, ...deskCallbacks } = main.options.inject()
  const { hooks: todayHooks, ...todayCallbacks } = today.options.inject()
  // The two pages' callbacks have distinct names, so tests can reach either page's through one object.
  const callbacks = { ...deskCallbacks, ...todayCallbacks }
  const props = (overrides = {}) => ({
    t: bind(main.options.locale),
    useSessions: selector => selector(state.sessions),
    useSessionStatus: selector => selector(state.statuses),
    useWorkspaces: selector => selector(state.workspaces),
    useDesk: selector => selector(hooks.desk.getSnapshot()),
    useInbox: selector => selector(hooks.inbox.getSnapshot()),
    useMemos: selector => selector(hooks.memos.getSnapshot()),
    useAdvice: selector => selector(hooks.advice.getSnapshot()),
    ...deskCallbacks,
    ...overrides,
  })
  const todayProps = (overrides = {}) => ({
    t: bind(today.options.locale),
    useAdvice: selector => selector(todayHooks.advice.getSnapshot()),
    ...todayCallbacks,
    ...overrides,
  })
  const icon = registered['sidebar.panellist']['control-panel']
  const iconInbox = icon.options.inject().hooks.inbox
  const todayIcon = registered['sidebar.panellist']['control-panel-today']
  const iconAdvice = todayIcon.options.inject().hooks.advice
  return {
    definition, plugin, registered, calls, host, callbacks, dictionaries, inboxDir,
    desk: hooks.desk,
    inbox: hooks.inbox,
    memos: hooks.memos,
    advice: hooks.advice,
    /** A second handle on the same directory, standing in for a script that pushes messages. */
    outside: options => new InboxStore({ dir: inboxDir, ...options }),
    /** The memo file as another tool sharing the directory would read and write it. */
    outsideMemos: () => new MemoStore({ dir: inboxDir }),
    /** The Control Panel page. */
    render: overrides => renderToStaticMarkup(React.createElement(main.component, props(overrides))),
    /** The Today page. */
    renderToday: overrides => renderToStaticMarkup(React.createElement(today.component, todayProps(overrides))),
    renderIcon: size => renderToStaticMarkup(React.createElement(icon.component, {
      size, active: false, useInbox: selector => selector(iconInbox.getSnapshot()),
    })),
    renderTodayIcon: size => renderToStaticMarkup(React.createElement(todayIcon.component, {
      size, active: false, useAdvice: selector => selector(iconAdvice.getSnapshot()),
    })),
    /** Let fire-and-forget work started by a callback (dispatch, inbox requests) finish. */
    settle: async () => { for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setImmediate(resolve)) },
    dispose: () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() },
  }
}

const MINUTE = 60 * 1000

/** Two workspaces and one session of every kind the panel must show or hide. */
export function sampleState(now = Date.now()) {
  const summary = (id, fields) => ({
    id, displayTitle: id, running: false, blank: false, updatedAt: now - 5 * MINUTE, retainedBy: {}, ...fields,
  })
  const byId = {
    's-recent': summary('s-recent', { displayTitle: '写 changelog', updatedAt: now - 10 * MINUTE }),
    's-run': summary('s-run', { displayTitle: '修 pytest 临时目录', running: true, updatedAt: now - 2 * MINUTE }),
    's-wait': summary('s-wait', { displayTitle: '清理下载目录', running: true, updatedAt: now - 30 * MINUTE }),
    's-old': summary('s-old', { displayTitle: '三天前的任务', updatedAt: now - 3 * 24 * 60 * MINUTE }),
    's-blank': summary('s-blank', { displayTitle: '空白会话', blank: true }),
    's-sub': summary('s-sub', { displayTitle: '子智能体会话', origin: 'subagent', parentId: 's-run' }),
    's-arch': summary('s-arch', { displayTitle: '已归档会话' }),
  }
  return {
    sessions: { ids: Object.keys(byId), byId, phase: 'ready', projectionsBySession: {} },
    statuses: new Map([
      ['s-run', { running: true, pendingInteraction: undefined, completionUnread: false }],
      ['s-wait', {
        running: true, completionUnread: false,
        pendingInteraction: { key: 'approval:1', kind: 'approval', sessionId: 's-wait' },
      }],
    ]),
    workspaces: {
      items: [
        { workspaceId: 'ws-a', path: '/work/SimpleAgent', title: 'SimpleAgent', sessionIds: ['s-run', 's-recent', 's-blank', 's-sub', 's-arch'] },
        { workspaceId: 'ws-b', path: '/work/scratch', title: 'scratch', sessionIds: ['s-wait', 's-old'] },
      ],
      archivedSessionIds: ['s-arch'],
      pinnedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
    },
  }
}
