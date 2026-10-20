/**
 * dsh-plugin-session-fulltext — browser half.
 *
 * Sidebar content search opens a Session but never navigates to the matching
 * event ("selecting a result opens the Session rather than the matching
 * event"). This client plugin adds the missing half:
 *
 *   1. a capture-phase click on a sidebar search-result row remembers the
 *      query while the search box still holds it;
 *   2. after the Session opens, it pages older history in until the query is
 *      found in the transcript, then scrolls the matching row into view;
 *   3. every visible match is painted with the CSS Custom Highlight API and
 *      the matched turn row flashes once.
 *
 * Everything is DOM + public client services (`sessions`), no React and no
 * external modules, so the bundle is hand-written in the client module-loader
 * format the host serves from `/plugins`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-fulltext',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports

    const HIGHLIGHT_NAME = 'dsh-session-fulltext-hit'
    const STYLE_TAG_ID = 'dsh-plugin-session-fulltext/style'
    const FLASH_CLASS = 'dsh-session-fulltext-flash'
    const PROBE_QUERY = 'dsh-fulltext-client-probe'
    const MAX_PAGES = 60
    const MAX_RANGES = 400
    const RESULT_ROW_SELECTOR = '[class*="searchResultRow"]'
    const SEARCH_INPUT_SELECTOR = '[class*="searchInput"]'
    // The shipped placeholder still says "session names" because the stock
    // sidebar search only matched titles. Content search makes that copy wrong.
    const PLACEHOLDER_ZH = '搜索会话名称与内容'
    const PLACEHOLDER_EN = 'Search session names and content'

    const CSS_TEXT = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(255, 196, 0, .55);
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgba(176, 118, 0, .9);
}
.${FLASH_CLASS} {
  animation: dsh-session-fulltext-flash 1.6s ease-out 1;
}
@keyframes dsh-session-fulltext-flash {
  0% { outline: 2px solid rgba(255, 176, 0, .95); outline-offset: 4px; border-radius: 8px; }
  100% { outline: 2px solid rgba(255, 176, 0, 0); outline-offset: 4px; border-radius: 8px; }
}
.dsh-session-fulltext-nav {
  position: fixed;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(38, 38, 44, .94);
  border: .5px solid rgba(255, 255, 255, .16);
  box-shadow: 0 4px 16px rgba(0, 0, 0, .28);
  color: #f2f2f4;
  font-size: 12px;
  line-height: 1;
  font-family: inherit;
  user-select: none;
}
.dsh-session-fulltext-nav-count {
  padding: 0 8px;
  color: rgba(255, 255, 255, .78);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-session-fulltext-nav-btn {
  height: 24px;
  min-width: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
}
.dsh-session-fulltext-nav-btn:hover { background: rgba(255, 255, 255, .14); }
.dsh-session-fulltext-nav-btn:focus-visible { outline: 2px solid #7c8cff; outline-offset: 1px; }
.dsh-session-fulltext-nav-close { min-width: 24px; padding: 0; font-size: 14px; }
`

    exports.inject = ['sessions']

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx
     */
    exports.apply = function apply(ctx) {
      if (typeof document === 'undefined') return
      moduleDisposed = false
      ensureStyle()
      const doc = document
      const disconnectPlaceholder = installSearchPlaceholder()
      /** @type {{ query: string, beforeSession: string | undefined, startedAt: number } | null} */
      let pending = null
      /** @type {{ go: (index: number) => Promise<void>, close: () => void } | null} */
      let matchNavigator = null
      let disposed = false

      const closeNavigator = () => {
        if (matchNavigator === null) return
        const previous = matchNavigator
        matchNavigator = null
        previous.close()
      }

      const onClick = (event) => {
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest(RESULT_ROW_SELECTOR)
        if (row === null) return
        // Archived rows render a hover Unarchive button; a button press is not a
        // navigation and archived rows cannot open.
        if (target.closest('button') !== null) return
        if (row.hasAttribute('aria-description')) return
        const query = readSearchQuery()
        if (query === '') return
        const tree = row.closest('[class*="searchTree"]')
        pending = {
          query,
          beforeSession: currentSessionId(),
          startedAt: Date.now(),
          resultsScroll: tree === null ? 0 : tree.scrollTop,
        }
        // React's own click handler runs in the same dispatch; run after it.
        // The shipped handler clears the query and collapses search on
        // selection, so restore both right away — the reveal and the restored
        // result list are independent.
        setTimeout(() => {
          const request = pending
          pending = null
          if (request === null) return
          closeNavigator()
          restoreSearch(request.query, request.resultsScroll)
          void reveal(request)
        }, 60)
      }

      doc.addEventListener('click', onClick, true)

      // One host round-trip per page load proves this bundle is live (it shows
      // up in the host plugin's debug log) without touching any UI state.
      const probeTimer = setTimeout(() => {
        try {
          const result = ctx.sessions.search(PROBE_QUERY, undefined)
          if (result !== undefined && typeof result.catch === 'function') result.catch(() => {})
        } catch {
          // The probe is optional; a Host without content search ignores it.
        }
      }, 1500)

      /**
       * Resolve the Session the click navigated to, wait for its Chat surface,
       * page history in until the text is loaded, then reveal the first match.
       * @param {{ query: string, beforeSession: string | undefined }} request
       */
      async function reveal(request) {
        const needles = normalizeNeedles(request.query)
        if (needles.length === 0 || disposed) return
        // Switching Sessions repaints the conversation host synchronously; a
        // short window is enough to tell "navigated" from "clicked the Session
        // already on screen", which must start revealing right away.
        const sessionId = await waitFor(() => {
          const current = currentSessionId()
          if (current !== undefined && current !== request.beforeSession) return current
          return undefined
        }, 700) ?? request.beforeSession
        if (sessionId === undefined || disposed) return

        const binding = await waitFor(() => {
          const candidate = ctx.sessions.binding(sessionId)
          return candidate !== undefined && candidate.session !== undefined ? candidate : undefined
        }, 3000)
        if (binding === undefined || disposed) return
        const session = binding.session
        await waitFor(() => {
          const snapshot = session.getSnapshot()
          return snapshot.openState === 'open' ? true : undefined
        }, 3000)
        if (disposed) return

        let root = await waitFor(() => findFlowRoot(sessionId), 3000)
        if (root === undefined) return
        let matches = collectMatches(root, needles)
        let pages = 0
        while (matches.length === 0 && pages < MAX_PAGES) {
          if (disposed) return
          const snapshot = session.getSnapshot()
          if (snapshot.hasMore !== true) break
          pages += 1
          try {
            await session.loadOlder()
          } catch {
            break
          }
          await frame()
          await frame()
          root = findFlowRoot(sessionId) ?? root
          matches = collectMatches(root, needles)
        }
        if (matches.length === 0 || disposed) return

        closeNavigator()
        matchNavigator = createMatchNavigator({ sessionId, needles })
        await matchNavigator.go(0)
      }

      const cleanup = () => {
        disposed = true
        moduleDisposed = true
        disconnectPlaceholder()
        doc.removeEventListener('click', onClick, true)
        clearTimeout(probeTimer)
        closeNavigator()
        clearHighlights()
        const style = doc.getElementById(STYLE_TAG_ID)
        if (style !== null) style.remove()
        delete window.__dshSessionFulltext
      }
      ctx.effect(() => () => cleanup(), 'session-fulltext: client reveal')

      // Manual test hook: `__dshSessionFulltext.reveal('合同', false)`.
      window.__dshSessionFulltext = {
        reveal: (query, clickFirst = false) => {
          if (clickFirst) return { ok: false, reason: 'click simulation is not supported' }
          return reveal({ query, beforeSession: currentSessionId() })
        },
      }
    }

    /**
     * Floating "上一个 / 下一个" navigator over the conversation: re-collects
     * every match inside the opened Session on each step (ranges go stale when
     * React re-renders), highlights all of them, scrolls the active one into
     * view and flashes it. Escape or × clears the highlight.
     * @param {{ sessionId: string, needles: string[] }} input
     * @returns {{ go: (index: number) => Promise<void>, close: () => void }}
     */
    function createMatchNavigator(input) {
      const zh = isChineseUi()
      const el = document.createElement('div')
      el.className = 'dsh-session-fulltext-nav'
      el.setAttribute('role', 'group')
      el.setAttribute('aria-label', zh ? '搜索命中导航' : 'Search match navigation')
      const counter = document.createElement('span')
      counter.className = 'dsh-session-fulltext-nav-count'
      const prev = createNavButton(zh ? '上一个' : 'Prev', zh ? '上一个命中' : 'Previous match')
      const next = createNavButton(zh ? '下一个' : 'Next', zh ? '下一个命中' : 'Next match')
      const closeButton = createNavButton('×', zh ? '关闭并清除高亮' : 'Close and clear highlights')
      closeButton.classList.add('dsh-session-fulltext-nav-close')
      el.append(counter, prev, next, closeButton)
      document.body.appendChild(el)

      let index = 0
      let total = 0
      let closed = false

      const position = () => {
        const scroller = document.querySelector('[data-conversation-scroll]')
        if (scroller === null) {
          el.style.top = '88px'
          el.style.right = '24px'
          return
        }
        const rect = scroller.getBoundingClientRect()
        el.style.top = `${Math.round(rect.top + 10)}px`
        el.style.right = `${Math.round(Math.max(16, window.innerWidth - rect.right + 16))}px`
      }
      const updateCounter = () => {
        counter.textContent = total === 0 ? (zh ? '无命中' : 'No matches') : `${index + 1} / ${total}`
      }
      const go = async (target) => {
        if (closed) return
        if (currentSessionId() !== input.sessionId) {
          closeSelf()
          return
        }
        const root = findFlowRoot(input.sessionId)
        const matches = root === undefined ? [] : collectMatches(root, input.needles)
        if (matches.length === 0) {
          closeSelf()
          return
        }
        total = matches.length
        index = ((target % total) + total) % total
        updateCounter()
        applyHighlight(matches)
        const range = matches[index]
        await scrollToRange(range)
        flashRange(range)
      }
      const closeSelf = () => {
        if (closed) return
        closed = true
        document.removeEventListener('keydown', onKeydown, true)
        window.removeEventListener('resize', position)
        clearInterval(sessionWatch)
        el.remove()
        clearHighlights()
      }
      const onKeydown = (event) => {
        if (event.key === 'Escape') closeSelf()
      }
      const onPrev = () => { void go(index - 1) }
      const onNext = () => { void go(index + 1) }
      prev.addEventListener('click', onPrev)
      next.addEventListener('click', onNext)
      closeButton.addEventListener('click', closeSelf)
      document.addEventListener('keydown', onKeydown, true)
      window.addEventListener('resize', position)
      const sessionWatch = setInterval(() => {
        if (closed) return
        if (currentSessionId() !== input.sessionId) closeSelf()
      }, 1000)
      position()
      updateCounter()
      return { go, close: closeSelf }
    }

    /**
     * @param {string} label visible text
     * @param {string} title tooltip and accessible name
     * @returns {HTMLButtonElement}
     */
    function createNavButton(label, title) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-session-fulltext-nav-btn'
      button.textContent = label
      button.title = title
      button.setAttribute('aria-label', title)
      return button
    }

    /** Active UI language is Chinese (the shipped copy or the document tag). */
    function isChineseUi() {
      const lang = (document.documentElement.lang ?? '').toLowerCase()
      if (lang.startsWith('zh')) return true
      if (lang.startsWith('en')) return false
      const input = document.querySelector(SEARCH_INPUT_SELECTOR)
      return /[\u3400-\u9fff]/u.test(input?.getAttribute('placeholder') ?? '')
    }

    /**
     * Keep the sidebar search input's placeholder in step with what the search
     * now covers (titles and content). The component owns the attribute as a
     * React prop, so a MutationObserver re-applies the copy after every render
     * and follows a language switch.
     * @returns {() => void} disconnect callback
     */
    function installSearchPlaceholder() {
      const patch = (input) => {
        if (!(input instanceof HTMLInputElement)) return
        const current = input.getAttribute('placeholder') ?? ''
        if (current === PLACEHOLDER_ZH || current === PLACEHOLDER_EN) return
        const chinese = /[\u3400-\u9fff]/u.test(current)
          || (document.documentElement.lang ?? '').toLowerCase().startsWith('zh')
        input.setAttribute('placeholder', chinese ? PLACEHOLDER_ZH : PLACEHOLDER_EN)
      }
      const scan = (root) => {
        if (root instanceof HTMLInputElement) patch(root)
        if (root instanceof Element) {
          for (const input of root.querySelectorAll(SEARCH_INPUT_SELECTOR)) patch(input)
        }
      }
      scan(document)
      if (typeof MutationObserver !== 'function') return () => {}
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') patch(mutation.target)
          else for (const node of mutation.addedNodes) scan(node)
        }
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['placeholder'],
      })
      return () => observer.disconnect()
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_TAG_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_TAG_ID
      tag.dataset.plugin = 'dsh-plugin-session-fulltext'
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }

    function readSearchQuery() {
      const inputs = document.querySelectorAll(SEARCH_INPUT_SELECTOR)
      for (const input of inputs) {
        if (input instanceof HTMLInputElement) {
          const value = input.value.trim()
          if (value !== '') return value
        }
      }
      return ''
    }

    /**
    * Reopen the sidebar search and put the query back after DSH's own
    * search-result handler cleared it, so the user can pick the next result
    * without typing again.
    * @param {string} query
    * @param {number} resultsScroll scroll offset of the previous result list
    */
    function restoreSearch(query, resultsScroll) {
      const fill = () => {
        const input = document.querySelector(SEARCH_INPUT_SELECTOR)
        if (!(input instanceof HTMLInputElement)) return
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        if (setter === undefined) return
        setter.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        if (resultsScroll > 0) {
          // The remote content search is debounced; restore the old list
          // offset once the result tree has repainted.
          setTimeout(() => {
            const tree = document.querySelector('[class*="searchTree"]')
            if (tree !== null) tree.scrollTop = resultsScroll
          }, 450)
        }
      }
      const current = document.querySelector(SEARCH_INPUT_SELECTOR)
      const expanded = current instanceof HTMLInputElement && current.tabIndex === 0
      if (expanded) {
        fill()
        return
      }
      const button = [...document.querySelectorAll('button')].find((candidate) => /searchButton/.test(candidate.className))
      if (button === undefined) return
      button.click()
      setTimeout(fill, 90)
    }

    function currentSessionId() {
      const host = document.querySelector('[data-conversation-session]')
      const value = host?.getAttribute('data-conversation-session')
      return value === null || value === undefined || value === '' ? undefined : value
    }

    function findFlowRoot(sessionId) {
      const host = document.querySelector(`[data-conversation-session="${escapeAttribute(sessionId)}"]`)
      if (host === null) return undefined
      const flow = host.querySelector('[data-slot="conversation.chat.flow"]')
        ?? host.querySelector('[data-chat-flow]')
      return flow ?? undefined
    }

    function normalizeNeedles(query) {
      const trimmed = query.trim().toLowerCase()
      if (trimmed === '') return []
      const terms = trimmed.split(/\s+/u).filter((term) => term.length > 0)
      return terms.length === 0 ? [trimmed] : terms
    }

    function collectMatches(root, needles) {
      const ranges = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = node.nodeValue
          if (text === null || text.length === 0) return NodeFilter.FILTER_REJECT
          const parent = node.parentElement
          if (parent === null) return NodeFilter.FILTER_REJECT
          if (parent.closest('style, script, noscript, textarea, [hidden]') !== null) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      let node = walker.nextNode()
      while (node !== null) {
        const text = node.nodeValue ?? ''
        const lower = text.toLowerCase()
        for (const needle of needles) {
          let from = 0
          for (;;) {
            const at = lower.indexOf(needle, from)
            if (at < 0) break
            const range = document.createRange()
            range.setStart(node, at)
            range.setEnd(node, at + needle.length)
            ranges.push(range)
            from = at + needle.length
            if (ranges.length >= MAX_RANGES) return ranges
          }
        }
        node = walker.nextNode()
      }
      return ranges
    }

    function applyHighlight(ranges) {
      if (typeof Highlight !== 'function' || CSS === undefined || CSS.highlights === undefined) return
      try {
        CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
      } catch {
        // A range detached by a concurrent re-render simply yields no highlight.
      }
    }

    function clearHighlights() {
      if (typeof CSS !== 'undefined' && CSS.highlights !== undefined) CSS.highlights.delete(HIGHLIGHT_NAME)
    }

    function isVisible(range) {
      try {
        const rect = range.getBoundingClientRect()
        return rect.width > 0 || rect.height > 0
      } catch {
        return false
      }
    }

    function rowOf(range) {
      const parent = range.startContainer.parentElement
      return parent === null ? null : parent.closest('[data-chat-turn], [data-chat-anchor-key]')
    }

    /**
     * Center the first match in the conversation scrollport. The Chat surface
     * may still be settling its tail-follow after the history page renders, so
     * write the position in a short retry loop until the range reports inside
     * the viewport.
     * @param {Range} range
     */
    async function scrollToRange(range) {
      const scroller = document.querySelector('[data-conversation-scroll]')
      const anchor = range.startContainer.parentElement
      for (let attempt = 0; attempt < 8; attempt++) {
        const box = scroller === null ? undefined : scroller.getBoundingClientRect()
        const rect = range.getBoundingClientRect()
        if (box !== undefined) {
          if (rect.top >= box.top + 16 && rect.bottom <= box.bottom - 16) return
          const delta = rect.top - box.top - box.height / 2 + rect.height / 2
          scroller.scrollTop = Math.max(0, scroller.scrollTop + (Number.isFinite(delta) && delta !== 0 ? delta : 240))
        } else if (anchor !== null) {
          anchor.scrollIntoView({ block: 'center' })
        }
        await frame()
        await frame()
      }
      if (anchor !== null) anchor.scrollIntoView({ block: 'center' })
    }

    function flashRange(range) {
      const row = rowOf(range)
      if (row === null) return
      row.classList.add(FLASH_CLASS)
      setTimeout(() => row.classList.remove(FLASH_CLASS), 2000)
    }

    function frame() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 16)
      })
    }

    /**
     * Poll a probe until it returns a defined value.
     * @template T
     * @param {() => T | undefined} read
     * @param {number} timeoutMs
     * @returns {Promise<T | undefined>}
     */
    function waitFor(read, timeoutMs) {
      return new Promise((resolve) => {
        const started = Date.now()
        const step = () => {
          if (disposedNow()) return resolve(undefined)
          const value = read()
          if (value !== undefined) return resolve(value)
          if (Date.now() - started >= timeoutMs) return resolve(undefined)
          setTimeout(step, 60)
        }
        step()
      })
    }

    // The waiting helper lives at module scope, so it reads disposal through
    // the module-local flag set by cleanup.
    let moduleDisposed = false
    function disposedNow() {
      return moduleDisposed
    }

    function escapeAttribute(value) {
      return String(value).replaceAll('"', '\\"')
    }

    return module.exports
  },
})
