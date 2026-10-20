/**
 * dsh-plugin-session-fulltext
 *
 * Adds literal, case-insensitive full-text (substring) search over Session
 * history to the DSH sidebar.
 *
 * Why this exists: DSH ships an optional SQLite FTS5 content index
 * (`@deepseek-ai/dsh-session-query-sqlite`). It is off by default, and when it
 * is enabled it tokenizes with FTS5 `unicode61`, whose CJK behavior is
 * unusable for real queries — a run of Chinese characters becomes ONE token,
 * so searching "搜索" never matches a message containing "全文搜索".
 *
 * This plugin leaves the mounted Session Query service (exact reads, titles,
 * traces, filters) untouched and only replaces its `searchSessions` method with
 * a substring scan over the current user/assistant messages. Every language
 * matches anywhere in the text, including 1-2 character Chinese queries.
 *
 * Implementation notes:
 * - Documents come from the inherited `ctx.sessionQuery.filterEvents()` read,
 *   so authorization, live/persisted preference, and text extraction stay in
 *   core code.
 * - Extracted messages are cached per Session and invalidated by the live
 *   Session's `seq` (a persisted-only Session never changes).
 * - A background warm-up builds the cache shortly after startup, so the first
 *   sidebar query is already fast. Until warm-up reaches a Session, a query
 *   loads that Session on demand.
 *
 * Zero dependencies: everything is reached through cordis services, so the
 * plugin resolves against the running DSH installation only.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-plugin-session-fulltext'

/** Services the patch needs: the query service we wrap and the live store. */
export const inject = ['sessionQuery', 'sessions']

const SEARCH_TYPES = ['user/message', 'assistant/message']
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SNIPPET_CHARS = 240
const SNIPPET_LEAD = 60
const WARMUP_DELAY_MS = 2500

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const service = ctx.sessionQuery
  const sessions = ctx.sessions
  if (service === undefined || sessions === undefined) return
  if (service.__dshFulltextSearchInstalled === true) return

  const snippetChars = positiveInt(config.snippetChars, SNIPPET_CHARS)
  const warmupDelayMs = Number.isSafeInteger(config.warmupDelayMs)
    ? Math.max(0, config.warmupDelayMs)
    : WARMUP_DELAY_MS
  const configuredTypes = Array.isArray(config.types) && config.types.length > 0
    ? config.types.map(String)
    : SEARCH_TYPES
  const indexedTypes = new Set(configuredTypes)
  const debug = config.debug === true
  const debugLog = debug ? createDebugLog() : () => {}

  const originalListSessions = service.listSessions.bind(service)
  const originalFilterEvents = service.filterEvents.bind(service)
  const originalSearchSessions = service.searchSessions.bind(service)

  /** sessionId -> { version, header, docs: Array<{type,seq,time,text}> } */
  const cache = new Map()
  /** Session ids whose cache entry is being rebuilt right now. */
  const inflight = new Map()
  let warmupRunning = false
  let disposed = false

  const versionOf = (record) => {
    const live = sessions.get(record.header.id)
    return live === undefined ? 'p' : `l${String(live.seq)}`
  }

  const loadDocs = (record) => {
    const id = record.header.id
    const version = versionOf(record)
    const hit = cache.get(id)
    if (hit !== undefined && hit.version === version) return Promise.resolve(hit)
    const pending = inflight.get(id)
    if (pending !== undefined) return pending
    const load = (async () => {
      let docs = []
      try {
        const filtered = await originalFilterEvents(id, [])
        docs = filtered
          .filter((doc) => doc.surface === 'current' && indexedTypes.has(doc.type) === true)
          .map((doc) => ({ type: doc.type, seq: doc.seq, time: doc.time, text: doc.text }))
      } catch {
        // A corrupt or concurrently-removed Session must not fail the search;
        // it simply contributes no documents.
        docs = []
      }
      const entry = { version, header: record.header, docs }
      cache.set(id, entry)
      return entry
    })().finally(() => inflight.delete(id))
    inflight.set(id, load)
    return load
  }

  const warmup = async () => {
    if (warmupRunning || disposed) return
    warmupRunning = true
    try {
      const records = await originalListSessions()
      for (const record of records) {
        if (disposed) return
        if (record.header.cwd === undefined) continue
        const id = record.header.id
        const known = cache.get(id)
        if (known !== undefined && known.version === versionOf(record)) continue
        await loadDocs(record)
        await new Promise((resolve) => setImmediate(resolve))
      }
    } catch {
      // Warm-up is best-effort; on-demand loading covers anything missed.
    } finally {
      warmupRunning = false
      debugLog(`warmup done: ${String(cache.size)} sessions cached`)
    }
  }

  const warmupTimer = setTimeout(() => { void warmup() }, warmupDelayMs)
  if (typeof warmupTimer.unref === 'function') warmupTimer.unref()

  /**
   * @param {unknown} request
   * @param {{ signal?: AbortSignal }} [options]
   */
  const searchSessions = async (request, options = {}) => {
    const signal = options.signal
    const query = String(request?.query ?? '').trim()
    if (query.length === 0) return { items: [] }
    const terms = query.split(/\s+/u).filter((term) => term.length > 0)
    const needles = terms.map((term) => term.toLowerCase())
    const limit = clampLimit(request?.limit)
    const eventFilters = parseEventFilters(request?.eventFilters)
    const sessionFilters = parseSessionFilters(request?.sessionFilters)

    // Every cached document is on the current surface; a request that excludes
    // `current` can only come from a caller this plugin does not serve.
    if (eventFilters.surfaces !== undefined && eventFilters.surfaces.has('current') === false) {
      return originalSearchSessions(request, options)
    }

    signal?.throwIfAborted?.()
    const records = await originalListSessions(signal)
    signal?.throwIfAborted?.()

    const ranked = []
    for (const record of records) {
      if (disposed) break
      signal?.throwIfAborted?.()
      if (record.header.cwd === undefined) continue
      if (!matchesSessionFilters(record.header, sessionFilters)) continue
      const entry = await loadDocs(record)
      if (entry.docs.length === 0) continue
      const best = pickBest(entry.docs, needles, eventFilters)
      if (best === undefined) continue
      ranked.push({
        header: record.header,
        doc: best.doc,
        count: best.count,
        index: best.index,
      })
    }

    ranked.sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      if (right.doc.time !== left.doc.time) return right.doc.time - left.doc.time
      return right.header.createdAt - left.header.createdAt
    })

    debugLog(`search ${JSON.stringify(query)} -> ${String(ranked.length)} sessions`)
    return {
      items: ranked.slice(0, limit).map((hit) => ({
        header: hit.header,
        bestMatch: {
          sessionId: hit.header.id,
          seq: hit.doc.seq,
          type: hit.doc.type,
          surface: 'current',
          snippet: makeSnippet(hit.doc.text, needles, snippetChars),
        },
      })),
    }
  }

  service.searchSessions = async (request, options) => searchSessions(request, options)
  service.__dshFulltextSearchInstalled = true
  debugLog(`activated (cached session dir ${process.env.DSH_HOME ?? join(homedir(), '.dsh')})`)

  // A packaged Host has no build watcher, so the browser half's bundle revision
  // would stay frozen at the revision captured when this plugin first mounted.
  // Publish the sibling bundle through `clientModules.rebuilt` (the graph's
  // documented update hook) whenever this Host half restarts, which is where an
  // edited `../session-fulltext-reveal/lib/client.js` needs to reach an already
  // open page without an application restart.
  const refreshClientBundle = () => {
    try {
      const modules = ctx.get('clientModules')
      if (modules !== undefined && typeof modules.rebuilt === 'function') {
        modules.rebuilt('dsh-plugin-session-fulltext-reveal')
      }
    } catch {
      // A composition without the Web module graph (headless/ACP) has nothing
      // to refresh; the search patch stays valid there.
    }
  }
  const refreshTimer = setTimeout(refreshClientBundle, 900)

  // `dsh-client-modules` caches each package's `dsh.client` declaration from the
  // moment its Loader row first started, so a package upgraded from "Host half
  // only" to "Host + browser half" would keep serving no browser bundle until
  // the next application restart. Re-read this package's declaration through
  // the module graph's own flush path and publish the resulting graph instead.
  let clientGraphTries = 0
  const ensureClientBundle = () => {
    clientGraphTries += 1
    try {
      const modules = ctx.get('clientModules')
      if (modules === undefined || typeof modules.flush !== 'function') {
        if (clientGraphTries < 6) setTimeout(ensureClientBundle, 800)
        return
      }
      const table = modules.table
      if (table !== undefined && typeof table.has === 'function' && table.has('dsh-plugin-session-fulltext')) return
      if (modules.pkgMeta !== undefined && typeof modules.pkgMeta.clear === 'function') modules.pkgMeta.clear()
      if (modules.dirty !== undefined && typeof modules.dirty.add === 'function') modules.dirty.add('dsh-plugin-session-fulltext')
      modules.flush((error) => debugLog(`client graph refresh failed: ${String(error)}`))
      debugLog('client graph refresh requested')
    } catch (error) {
      debugLog(`client graph refresh skipped: ${String(error)}`)
    }
  }
  const clientGraphTimer = setTimeout(ensureClientBundle, 1200)

  ctx.effect(() => () => {
    disposed = true
    clearTimeout(warmupTimer)
    clearTimeout(refreshTimer)
    clearTimeout(clientGraphTimer)
    if (service.__dshFulltextSearchInstalled === true) {
      service.searchSessions = originalSearchSessions
      delete service.__dshFulltextSearchInstalled
    }
    cache.clear()
    inflight.clear()
  }, 'session-fulltext: search override')
}

function clampLimit(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(numeric)))
}

function positiveInt(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const truncated = Math.trunc(numeric)
  return truncated > 0 ? truncated : fallback
}

function parseEventFilters(filters) {
  const result = { types: undefined, surfaces: undefined }
  if (!Array.isArray(filters)) return result
  for (const filter of filters) {
    if (filter?.kind === 'type' && Array.isArray(filter.values)) {
      result.types = new Set(filter.values.map(String))
    } else if (filter?.kind === 'surface' && Array.isArray(filter.values)) {
      result.surfaces = new Set(filter.values.map(String))
    }
  }
  return result
}

function parseSessionFilters(filters) {
  const result = { ids: undefined, cwds: undefined }
  if (!Array.isArray(filters)) return result
  for (const filter of filters) {
    if (filter?.kind === 'id' && Array.isArray(filter.values)) {
      result.ids = new Set(filter.values.map(String))
    } else if (filter?.kind === 'cwd' && Array.isArray(filter.values)) {
      result.cwds = new Set(filter.values.map(String))
    }
  }
  return result
}

function matchesSessionFilters(header, filters) {
  if (filters.ids !== undefined && filters.ids.has(header.id) === false) return false
  if (filters.cwds !== undefined && filters.cwds.has(header.cwd) === false) return false
  return true
}

/**
 * Find the single best matching document for one Session.
 * @param {Array<{type: string, seq: number, time: number, text: string}>} docs
 * @param {string[]} needles lower-cased search terms; every term must appear
 * @param {{types?: Set<string>}} eventFilters
 * @returns {{ doc: {type: string, seq: number, time: number, text: string}, count: number, index: number } | undefined}
 */
function pickBest(docs, needles, eventFilters) {
  let best
  for (const doc of docs) {
    if (eventFilters.types !== undefined && eventFilters.types.has(doc.type) === false) continue
    const haystack = doc.text.toLowerCase()
    let index = -1
    let matchesAll = true
    for (const needle of needles) {
      const at = haystack.indexOf(needle)
      if (at < 0) { matchesAll = false; break }
      if (index < 0 || at < index) index = at
    }
    if (!matchesAll) continue
    const count = countOccurrences(haystack, needles[0])
    if (best === undefined || count > best.count || (count === best.count && doc.time > best.doc.time)) {
      best = { doc, count, index }
    }
  }
  return best
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

/**
 * Build a single-line excerpt around the first match.
 * @param {string} text raw document text
 * @param {string[]} needles lower-cased search terms
 * @param {number} maxChars excerpt length bound
 * @returns {string}
 */
function makeSnippet(text, needles, maxChars) {
  const normalized = text.replace(/\s+/gu, ' ')
  const lowered = normalized.toLowerCase()
  let index = -1
  for (const needle of needles) {
    const at = lowered.indexOf(needle)
    if (at >= 0 && (index < 0 || at < index)) index = at
  }
  const start = Math.max(0, (index >= 0 ? index : 0) - SNIPPET_LEAD)
  const end = Math.min(normalized.length, start + maxChars)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < normalized.length ? '…' : ''
  return prefix + normalized.slice(start, end).trim() + suffix
}

/**
 * Opt-in debug log next to the DSH home, used to confirm that the running Host
 * picked the plugin up after an HMR reload. Plain append-only; never throws.
 * @returns {(message: string) => void}
 */
function createDebugLog() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'session-fulltext.log')
  return (message) => {
    try {
      mkdirSync(home, { recursive: true })
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // Debug logging must never affect search behavior.
    }
  }
}
