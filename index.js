/**
 * Host half of the control panel bundle.
 *
 * Serves the inbox and the memos to the Client half over exact `/api` routes, inside the Connection
 * service's authentication fence. inbox-store.js and memo-store.js own the files and their formats.
 *
 * It also runs the daily advice (advice-runner.js): a schedule that asks an agent for today's exercise plan
 * and diet suggestion once a day, and three routes that show it, re-run it, and record that it was seen.
 *
 * Row config in a profile's cordis.patch.yml:
 *   inboxDir             directory holding inbox.jsonl, state.json, todos.json, and advice/; `~` expands.
 *                        Default: $DSH_CONTROL_PANEL_DIR, else ~/.dsh-control-panel
 *   archiveAfterMinutes  minutes from first open to automatic archiving. Default: 30
 *   advice               the daily advice; see advice-runner.js. Off until `advice.cwd` is set
 */
import { AdviceService } from './advice-runner.js'
import { DEFAULT_ARCHIVE_AFTER_MINUTES, InboxStore, defaultInboxDir, expandHome } from './inbox-store.js'
import { MemoStore } from './memo-store.js'

export const name = 'dsh-plugin-control-panel'
export const inject = ['connection']

const ROUTE_PREFIX = '/api/control-panel.'
const VIEWS = ['active', 'archived']

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** The data directory the row's config names, or the default. */
function directoryOf(config, env) {
  const options = config !== null && typeof config === 'object' ? config : {}
  return typeof options.inboxDir === 'string' && options.inboxDir.trim() !== ''
    ? expandHome(options.inboxDir.trim())
    : defaultInboxDir(env)
}

/** Read the row's config into a store; unset or malformed values fall back to the defaults. */
export function createInboxStore(config, env = process.env) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const minutes = Number(options.archiveAfterMinutes)
  return new InboxStore({
    dir: directoryOf(config, env),
    archiveAfterMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_ARCHIVE_AFTER_MINUTES,
  })
}

/** The memo store lives in the same directory as the inbox. */
export function createMemoStore(config, env = process.env) {
  return new MemoStore({ dir: directoryOf(config, env) })
}

/** So does the daily advice. `options` reaches AdviceService, so tests can swap the clock and the agents. */
export function createAdviceService(config, env = process.env, options = {}) {
  const advice = config !== null && typeof config === 'object' ? config.advice : undefined
  return new AdviceService({ dir: directoryOf(config, env), settings: advice, ...options })
}

async function bodyOf(request) {
  const body = await request.json().catch(() => null)
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
}

/** The inbox routes as `{ suffix, methods, handle }`, separate from registration so tests can call them. */
export function inboxRoutes(store) {
  const idOf = async (request) => {
    const body = await request.json().catch(() => null)
    return body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : ''
  }
  return [
    {
      suffix: 'inbox.list',
      methods: ['GET'],
      handle: (request) => {
        const query = new URL(request.url).searchParams
        const view = VIEWS.includes(query.get('view')) ? query.get('view') : 'active'
        const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '', 10) || 50, 1), 500)
        return json({
          items: store.list({ view, limit, unreadOnly: query.get('unread') === '1' }),
          counts: store.counts(),
          archiveAfterMinutes: store.archiveAfterMinutes,
          dir: store.dir,
        })
      },
    },
    { suffix: 'inbox.count', methods: ['GET'], handle: () => json(store.counts()) },
    {
      suffix: 'inbox.item',
      methods: ['GET'],
      handle: (request) => {
        const item = store.get(new URL(request.url).searchParams.get('id') ?? '')
        return item === null ? json({ error: 'message not found' }, 404) : json(item)
      },
    },
    {
      suffix: 'inbox.read',
      methods: ['POST'],
      handle: async (request) => {
        const changed = store.markRead(await idOf(request))
        return json({ changed, counts: store.counts() })
      },
    },
    {
      suffix: 'inbox.archive',
      methods: ['POST'],
      handle: async (request) => {
        const item = store.archive(await idOf(request))
        return item === null ? json({ error: 'message not found' }, 404) : json({ item, counts: store.counts() })
      },
    },
  ]
}

/**
 * The memo routes. Every change answers with the whole list, so the page needs no second request.
 * Only GET and POST exist on the host's route registry, so update and remove are POSTs too.
 */
export function memoRoutes(memos) {
  return [
    { suffix: 'memo.list', methods: ['GET'], handle: () => json({ items: memos.list() }) },
    {
      suffix: 'memo.add',
      methods: ['POST'],
      handle: async (request) => {
        const { text, kind, ref } = await bodyOf(request)
        const item = memos.add({ text, kind, ref })
        return item === null ? json({ error: 'memo text is empty' }, 400) : json({ item, items: memos.list() })
      },
    },
    {
      suffix: 'memo.update',
      methods: ['POST'],
      handle: async (request) => {
        const { id, text, done } = await bodyOf(request)
        if (text === undefined && done === undefined) return json({ error: 'nothing to change: send text or done' }, 400)
        const item = memos.update(typeof id === 'string' ? id : '', { text, done })
        return item === null ? json({ error: 'memo not found, or the new text is empty' }, 404) : json({ item, items: memos.list() })
      },
    },
    {
      suffix: 'memo.remove',
      methods: ['POST'],
      handle: async (request) => {
        const { id } = await bodyOf(request)
        return memos.remove(typeof id === 'string' ? id : '')
          ? json({ items: memos.list() })
          : json({ error: 'memo not found' }, 404)
      },
    },
  ]
}

/**
 * The advice routes. A run started here goes on in the background; the panel polls `advice.today`.
 * `advice.seen` takes the `generated_at` the page showed, so advice written meanwhile still counts as new.
 */
export function adviceRoutes(advice) {
  return [
    { suffix: 'advice.today', methods: ['GET'], handle: () => json(advice.status()) },
    {
      suffix: 'advice.run',
      methods: ['POST'],
      handle: () => {
        if (!advice.enabled) return json({ error: 'advice.cwd is not configured' }, 400)
        return json({ started: advice.run('manual'), ...advice.status() })
      },
    },
    {
      suffix: 'advice.seen',
      methods: ['POST'],
      handle: async (request) => {
        if (!advice.enabled) return json({ error: 'advice.cwd is not configured' }, 400)
        const { generated_at: generatedAt } = await bodyOf(request)
        if (typeof generatedAt !== 'string' || generatedAt === '') return json({ error: 'generated_at is required' }, 400)
        advice.markSeen(generatedAt)
        return json(advice.status())
      },
    },
  ]
}

export function apply(ctx, config) {
  const store = createInboxStore(config)
  const memos = createMemoStore(config)
  const advice = createAdviceService(config)
  ctx.effect(() => advice.start(), 'control-panel: advice schedule')
  for (const route of [...inboxRoutes(store), ...memoRoutes(memos), ...adviceRoutes(advice)]) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE_PREFIX}${route.suffix}`,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await route.handle(request)
        } catch (error) {
          return json({ error: String((error && error.message) || error) }, 500)
        }
      },
    }), `control-panel: ${route.suffix}`)
  }
}
