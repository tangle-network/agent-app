/**
 * One recorded journey through a running agent app: signed-in recorded
 * contexts, chapters, a person's pacing, desktop and phone screenshots,
 * measured chat turns, and a `finish()` that turns the recording into files
 * that are safe to copy off the host.
 *
 *     const j = await startJourney('core-path')            // reads journeys.config.mjs
 *     const page = await j.open('founder', 'member')       // recorded, already signed in
 *     await j.step('Founder opens the workspace', () => page.goto('/app'), page)
 *     await j.shot('home', page)                           // home-desktop.png + home-phone.png
 *     const turn = await j.sendNew(page, 'Research …', { from: `/app/${ws}/chat/new` })
 *     await j.finish()                                     // mp4s, srt, highlights, scrubbed trace, timings
 *
 * Output, all safe to copy (finish() refuses otherwise):
 *   <outDir>/<id>/video/<label>-full.mp4  <label>-highlights.mp4  <label>.srt  <label>-trace.zip
 *   <outDir>/<id>/<name>-desktop.png  <name>-phone.png  timings.json  chapters.json  turns/*.md
 * Raw webm and unscrubbed traces stay in <stateDir>/raw on the host.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { loadJourneysConfig, resolveJourneysConfig, threadRouteIn, type JourneysConfig, type ResolvedJourneysConfig, type ThreadRoute } from './config.js'
import { scoreTurn, turnLooksActive, TurnEvidence, type TranscriptSnapshot, type TurnOutcome } from './score.js'
import { assertNoSecrets, scrubTrace } from './scrub.js'
import { clickUntilSubmitted, createSubmissionTracker, settleText } from './send.js'
import { secretNeedles, storageStateFor } from './session.js'
import { postProcessVideo, type Chapter } from './video.js'

export const DESKTOP = { width: 1440, height: 900 }
export const PHONE = { width: 390, height: 844 }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const secs = (ms: number) => Math.round(ms / 100) / 10

/** A visible pointer so a viewer can follow clicks in a headless recording. Hidden for screenshots. */
const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('__journey_cursor') || !document.body) return
    const dot = document.createElement('div')
    dot.id = '__journey_cursor'
    dot.setAttribute('aria-hidden', 'true')
    Object.assign(dot.style, { position: 'fixed', zIndex: '2147483647', width: '24px', height: '24px',
      margin: '-12px 0 0 -12px', borderRadius: '50%', background: 'rgba(255,72,48,.28)',
      border: '2px solid rgba(255,72,48,.95)', pointerEvents: 'none', left: (window.__jx ?? -100) + 'px',
      top: (window.__jy ?? -100) + 'px', transition: 'transform .12s ease-out' })
    document.body.appendChild(dot)
  }
  addEventListener('mousemove', (e) => { window.__jx = e.clientX; window.__jy = e.clientY
    const d = document.getElementById('__journey_cursor'); if (d) { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px' } }, true)
  addEventListener('mousedown', () => { const d = document.getElementById('__journey_cursor'); if (d) d.style.transform = 'scale(.55)' }, true)
  addEventListener('mouseup', () => { const d = document.getElementById('__journey_cursor'); if (d) d.style.transform = 'scale(1)' }, true)
  // After hydration, so the framework never meets a node it did not render.
  addEventListener('load', () => setTimeout(install, 1500))
  setInterval(install, 2000)
})()`

interface Recorded {
  label: string
  identity: string
  context: BrowserContext
  page: Page
  t0: number
  rawDir: string
}

export interface TurnRecord {
  label: string
  prompt: string
  threadId: string | null
  sentAt: string
  /** Seconds from the Send press. */
  firstProgressS: number | null
  firstProgressText: string | null
  firstTextS: number | null
  /** Seconds from Send to the first failure evidence on the page, if any appeared. */
  firstFailureS: number | null
  completeS: number | null
  outcome: TurnOutcome
  /** Plain words for what went wrong, or null for a completed turn. */
  error: string | null
  /** Every piece of failure evidence the turn added. */
  failures: string[]
  replyChars: number
  /** Distinct status lines the transcript showed, with when they appeared. */
  stages: { s: number; text: string }[]
  /** Seconds from Send at which the journey pressed Stop, if it did. */
  stopPressedS: number | null
  replyFile: string | null
}

export interface StepRecord {
  caption: string
  label: string | null
  startS: number
  durationS: number
  ok: boolean
  error?: string
}

export interface SendOptions {
  caption?: string
  timeoutMs?: number
  /** Keystroke delay for the prompt. */
  delay?: number
  /** Press Stop at first text, or this many seconds after Send. */
  stopAfter?: 'first-text' | number
}

/** What the page shows right now, read in one evaluate. */
interface PageReading extends TranscriptSnapshot {
  status: string[]
  assistantChars: number
  transcriptChars: number
  stopVisible: boolean
}

export class Journey {
  readonly outDir: string
  readonly rawDir: string
  readonly chapters: Chapter[] = []
  readonly steps: StepRecord[] = []
  readonly turns: TurnRecord[] = []
  private recorded: Recorded[] = []
  private phones = new Map<string, BrowserContext>()
  private readonly startedAt = Date.now()

  constructor(readonly id: string, readonly config: ResolvedJourneysConfig, readonly browser: Browser, private readonly opts: { cursor: boolean }) {
    this.outDir = join(config.outDir, id)
    this.rawDir = join(config.stateDir, 'raw', `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(join(this.outDir, 'video'), { recursive: true })
    mkdirSync(join(this.outDir, 'turns'), { recursive: true })
    mkdirSync(this.rawDir, { recursive: true, mode: 0o700 })
  }

  /**
   * A recorded, traced 1440x900 context. A config identity starts signed in
   * from the cached session (no login form is ever recorded); `'anon'` starts
   * signed out, for public pages. Open at most two per journey.
   */
  async open(label: string, identity: string, opts: { fresh?: boolean } = {}): Promise<Page> {
    if (this.recorded.some((r) => r.label === label)) throw new Error(`a context labelled ${label} is already open`)
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) throw new Error('context label: lowercase letters, digits and dashes')
    const storageState = identity === 'anon' ? undefined : (await storageStateFor(this.config, identity, opts)).path
    const rawDir = join(this.rawDir, label)
    const context = await this.browser.newContext({
      baseURL: this.config.baseUrl,
      storageState,
      viewport: DESKTOP,
      recordVideo: { dir: rawDir, size: DESKTOP },
      locale: 'en-US',
      timezoneId: 'America/Denver',
    })
    context.setDefaultTimeout(20_000)
    context.setDefaultNavigationTimeout(60_000)
    if (this.opts.cursor) await context.addInitScript(CURSOR_SCRIPT)
    if (process.env.JOURNEY_DEBUG_CLOCK === '1') {
      // Wall-clock seconds since recording start on every frame, for calibrating captions.
      await context.addInitScript((t0: number) => {
        setInterval(() => {
          let d = document.getElementById('__journey_clock')
          if (!d && document.body) {
            d = document.createElement('div')
            d.id = '__journey_clock'
            Object.assign(d.style, { position: 'fixed', left: '50%', top: '0', zIndex: '2147483647', font: 'bold 20px monospace', background: '#ff0', color: '#000', padding: '2px 6px', pointerEvents: 'none' })
            document.body.appendChild(d)
          }
          if (d) d.textContent = ((Date.now() - t0) / 1000).toFixed(1)
        }, 100)
      }, Date.now())
    }
    await context.tracing.start({ screenshots: true, snapshots: true, title: `${this.id} ${label}` })
    const page = await context.newPage()
    this.recorded.push({ label, identity, context, page, t0: Date.now(), rawDir })
    return page
  }

  private recordedFor(page?: Page): Recorded {
    const r = page ? this.recorded.find((x) => x.page === page) : this.recorded[0]
    if (!r) throw new Error('no recorded context for that page; call open() first')
    return r
  }

  /** A chapter at this instant: one plain line, shown in the caption bar and the .srt. */
  mark(caption: string, page?: Page): void {
    const label = page ? this.recordedFor(page).label : null
    this.chapters.push({ at: Date.now(), caption, label, kind: 'step' })
    console.log(`[${secs(Date.now() - this.startedAt).toFixed(1)}s] ${label ? `${label}: ` : ''}${caption}`)
  }

  /** A timed step with its own chapter. A failure is recorded, captioned, then rethrown. */
  async step<T>(caption: string, work: () => Promise<T>, page?: Page): Promise<T> {
    this.mark(caption, page)
    const start = Date.now()
    const entry: StepRecord = { caption, label: page ? this.recordedFor(page).label : null, startS: secs(start - this.startedAt), durationS: 0, ok: true }
    this.steps.push(entry)
    try {
      return await work()
    } catch (error) {
      entry.ok = false
      entry.error = String((error as Error)?.message ?? error).slice(0, 400)
      this.mark(`Step failed: ${caption}`, page)
      throw error
    } finally {
      entry.durationS = secs(Date.now() - start)
    }
  }

  /** A waiting span: real speed in the full video, sped up and labelled in the highlights. */
  async wait<T>(caption: string, work: () => Promise<T>, page?: Page): Promise<T> {
    const label = page ? this.recordedFor(page).label : null
    const chapter: Chapter = { at: Date.now(), caption, label, kind: 'wait', until: Date.now() }
    this.chapters.push(chapter)
    console.log(`[${secs(Date.now() - this.startedAt).toFixed(1)}s] ${label ? `${label}: ` : ''}(wait) ${caption}`)
    try {
      return await work()
    } finally {
      chapter.until = Date.now()
    }
  }

  pause(ms = 700): Promise<void> {
    return sleep(ms)
  }

  /** Move the visible pointer there, pause, click, pause. */
  async click(target: Locator, opts: { pauseAfter?: number } = {}): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (box) await target.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 })
    await sleep(250)
    await target.click()
    await sleep(opts.pauseAfter ?? 600)
  }

  /** Type at a readable pace into an input or textarea. */
  async type(target: Locator, text: string, opts: { delay?: number } = {}): Promise<void> {
    await this.click(target, { pauseAfter: 200 })
    const delay = opts.delay ?? 28
    await target.pressSequentially(text, { delay, timeout: 30_000 + text.length * (delay + 60) })
    await sleep(400)
  }

  /** The composer's message input. */
  composerInput(page: Page): Locator {
    return page.locator(this.config.chat.composer).getByRole('textbox', { name: this.config.chat.inputName })
  }

  private composerButton(page: Page, name: string): Locator {
    return page.locator(this.config.chat.composer).getByRole('button', { name, exact: true })
  }

  /**
   * Type into the chat composer at a readable pace. A line break is typed as
   * Shift+Enter, because Enter sends. Retries fast when hydration dropped
   * keystrokes. Never `fill()` a rich-text composer.
   */
  async typePrompt(page: Page, prompt: string, opts: { delay?: number } = {}): Promise<void> {
    const box = this.composerInput(page)
    await box.waitFor({ state: 'visible', timeout: 30_000 })
    await sleep(1_200)
    const delay = opts.delay ?? (prompt.length > 400 ? 8 : 22)
    const want = prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.click(box, { pauseAfter: 150 })
      await box.press('ControlOrMeta+a')
      await box.press('Backspace')
      const lines = prompt.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) await box.press('Shift+Enter')
        // Sized by length: a loaded host types slower than the context's 20 s default allows.
        const line = lines[i]!
        if (line) await box.pressSequentially(line, { delay: attempt === 0 ? delay : 0, timeout: 30_000 + line.length * (delay + 60) })
      }
      const text = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
      if (text.includes(want)) return
      await sleep(1_000)
    }
    throw new Error('the composer never held the prompt')
  }

  /**
   * Which parts of the chat contract this page shows, without sending
   * anything. Run it on a second app before trusting turn timings there.
   */
  async checkChatContract(page: Page): Promise<Record<'transcript' | 'composer' | 'input' | 'send', boolean>> {
    const visible = (l: Locator) => l.first().isVisible().catch(() => false)
    return {
      transcript: await visible(page.locator(this.config.chat.transcript)),
      composer: await visible(page.locator(this.config.chat.composer)),
      input: await visible(this.composerInput(page)),
      send: await visible(this.composerButton(page, this.config.chat.sendName)),
    }
  }

  /**
   * Desktop screenshot of the recorded page, then the same URL in a phone
   * context (390x844, same identity). Look at both before judging the screen.
   */
  async shot(name: string, page?: Page, opts: { phone?: boolean; fullPage?: boolean; phoneUrl?: string } = {}): Promise<{ desktop: string; phone?: string }> {
    const r = this.recordedFor(page)
    const slug = name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
    const desktop = join(this.outDir, `${slug}-desktop.png`)
    const cursor = (display: string) => r.page.evaluate((d) => { const c = document.getElementById('__journey_cursor'); if (c) c.style.display = d }, display).catch(() => {})
    await cursor('none')
    await r.page.screenshot({ path: desktop, fullPage: opts.fullPage ?? false })
    await cursor('')
    if (opts.phone === false) return { desktop }
    const phonePath = join(this.outDir, `${slug}-phone.png`)
    let ctx = this.phones.get(r.identity)
    if (!ctx) {
      const storageState = r.identity === 'anon' ? undefined : (await storageStateFor(this.config, r.identity)).path
      ctx = await this.browser.newContext({ baseURL: this.config.baseUrl, storageState, viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'America/Denver' })
      this.phones.set(r.identity, ctx)
    }
    const phone = await ctx.newPage()
    try {
      await phone.goto(opts.phoneUrl ?? r.page.url(), { waitUntil: 'load' })
      await phone.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
      await sleep(1_500)
      await phone.screenshot({ path: phonePath, fullPage: opts.fullPage ?? false })
    } finally {
      await phone.close()
    }
    return { desktop, phone: phonePath }
  }

  private budgetTurn(): void {
    if (this.turns.length >= this.config.maxTurns) {
      throw new Error(`this journey already sent ${this.turns.length} chat turns, its budget (maxTurns ${this.config.maxTurns})`)
    }
  }

  /**
   * Start a new thread: open `from` when given, type the prompt, press Send
   * like a person (again only while the page has not submitted; never deletes
   * a duplicate), wait for the thread, then measure the turn.
   */
  async sendNew(page: Page, prompt: string, opts: SendOptions & { from?: string } = {}): Promise<TurnRecord> {
    this.budgetTurn()
    if (opts.from && !page.url().startsWith(new URL(opts.from, this.config.baseUrl).href)) await page.goto(opts.from)
    await this.typePrompt(page, prompt, { delay: opts.delay })
    const send = this.composerButton(page, this.config.chat.sendName)
    await send.waitFor({ state: 'visible' })
    const box = await send.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 })
    await sleep(400)
    const before = await this.read(page)
    const evidence = new TurnEvidence(this.patterns(), prompt)
    evidence.begin(before)
    const tracker = createSubmissionTracker(page.url(), this.config.chat.sendPaths)
    const count = (request: { method(): string; url(): string }) => tracker.observe(request.method(), request.url())
    page.on('request', count)
    this.mark(opts.caption ?? `Sends: "${oneLine(prompt, 90)}"`, page)
    const sentAt = Date.now()
    const onThread = () => threadRouteIn(page.url(), this.config) !== null
    try {
      await clickUntilSubmitted({
        landed: () => tracker.count > 0 || onThread(),
        ready: () => send.click({ trial: true, timeout: 5_000 }),
        click: () => send.click({ timeout: 5_000 }),
        wait: () => page.waitForRequest((r) => tracker.matches(r.method(), r.url()), { timeout: 1_000 }).then(() => undefined).catch(() => undefined),
        attempts: 15,
      })
      if (this.config.chat.threadPath) await page.waitForURL((url) => threadRouteIn(url.href, this.config) !== null, { timeout: 45_000 })
    } catch (error) {
      return this.notSent(page, prompt, sentAt, String((error as Error).message).slice(0, 300))
    } finally {
      page.off('request', count)
    }
    if (tracker.count > 1) console.warn(`the composer submitted ${tracker.count} times; a duplicate thread may exist (left in place)`)
    return this.measureTurn(page, prompt, sentAt, evidence, before, 0, opts)
  }

  /** A follow-up in the open thread: type, one Send press, measure. */
  async sendInThread(page: Page, prompt: string, opts: SendOptions = {}): Promise<TurnRecord> {
    this.budgetTurn()
    await this.typePrompt(page, prompt, { delay: opts.delay })
    const send = this.composerButton(page, this.config.chat.sendName)
    const before = await this.read(page)
    const evidence = new TurnEvidence(this.patterns(), prompt)
    evidence.begin(before)
    const tracker = createSubmissionTracker(page.url(), this.config.chat.sendPaths)
    const posted = page.waitForRequest((r) => tracker.matches(r.method(), r.url()), { timeout: 30_000 })
    this.mark(opts.caption ?? `Follows up: "${oneLine(prompt, 90)}"`, page)
    const sentAt = Date.now()
    await this.click(send, { pauseAfter: 0 })
    const sent = await posted.then(() => true).catch(() => false)
    if (!sent) return this.notSent(page, prompt, sentAt, 'no chat request within 30 s of pressing Send')
    return this.measureTurn(page, prompt, sentAt, evidence, before, Math.max(0, before.assistantChars), opts)
  }

  private patterns() {
    return { failure: this.config.chat.failureText, stopped: this.config.chat.stoppedText }
  }

  private blankTurn(page: Page, prompt: string, sentAt: number): TurnRecord {
    return {
      label: this.recordedFor(page).label, prompt, threadId: threadRouteIn(page.url(), this.config)?.threadId ?? null,
      sentAt: new Date(sentAt).toISOString(), firstProgressS: null, firstProgressText: null, firstTextS: null, firstFailureS: null, completeS: null,
      outcome: 'timeout', error: null, failures: [], replyChars: 0, stages: [], stopPressedS: null, replyFile: null,
    }
  }

  private notSent(page: Page, prompt: string, sentAt: number, why: string): TurnRecord {
    const t = { ...this.blankTurn(page, prompt, sentAt), ...scoreTurn({ notSent: why, timedOut: false, evidence: { failures: [], stopped: [], retryAppeared: false }, replyChars: 0, stopPressed: false }) }
    this.turns.push(t)
    this.mark(`Turn not sent: ${oneLine(why, 90)}`, page)
    return t
  }

  /** One read of the transcript, composer and failure marks. */
  private async read(page: Page): Promise<PageReading> {
    const c = this.config.chat
    const { assistant, ...reading } = await page.evaluate((c) => {
      const clean = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()
      const region = document.querySelector<HTMLElement>(c.transcript)
      const text = region?.innerText ?? ''
      const within = (sel: string) => (region ? Array.from(region.querySelectorAll(sel)) : [])
      const status = within(c.status).map(clean).filter(Boolean)
      // textContent, not innerText: a failure's collapsed details (the code) count too.
      const failureNodes = within(c.failureNodes).map(clean).filter(Boolean)
      const retry = new RegExp(c.retrySource, c.retryFlags)
      const retryButtons = within('button').filter((b) => retry.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim())).length
      const assistant = c.assistant
        ? Array.from(document.querySelectorAll<HTMLElement>(c.assistant)).map((e) => e.innerText).join('\n').trim().length
        : -1
      const composer = document.querySelector(c.composer)
      const stopVisible = composer !== null && Array.from(composer.querySelectorAll('button')).some((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === c.stopName && b.getClientRects().length > 0)
      return { lines: text.split('\n').map((l) => l.trim()).filter(Boolean), failureNodes, retryButtons, status, assistant, transcriptChars: text.trim().length, stopVisible }
    }, { transcript: c.transcript, status: c.status, failureNodes: c.failureNodes, retrySource: c.retryName.source, retryFlags: c.retryName.flags, assistant: c.assistant, composer: c.composer, stopName: c.stopName })
    return { ...reading, assistantChars: assistant }
  }

  private async runningTurns(page: Page, route: ThreadRoute | null): Promise<string[] | null> {
    if (!route || !this.config.chat.runningTurns) return null
    const res = await page.request.get(this.config.chat.runningTurns(route))
    if (!res.ok()) throw new Error(`running turns answered ${res.status()}`)
    const body = (await res.json()) as { running?: unknown }
    if (!Array.isArray(body.running)) throw new Error('running turns returned no `running` array')
    return body.running.map(String)
  }

  /**
   * Time to first visible progress (a new status line or reply text), first
   * reply text, and the turn's end, polled every 300 ms. The turn has ended
   * when, for two reads in a row, {@link turnLooksActive} is false and, where
   * the app lists running turns, the server lists none. Status lines already
   * on the page before Send are not progress. The outcome comes from
   * {@link scoreTurn}.
   */
  private async measureTurn(page: Page, prompt: string, sentAt: number, evidence: TurnEvidence, before: PageReading, baselineChars: number, opts: SendOptions): Promise<TurnRecord> {
    const t = this.blankTurn(page, prompt, sentAt)
    this.turns.push(t)
    const route = threadRouteIn(page.url(), this.config)
    t.threadId = route?.threadId ?? null
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000
    const since = () => secs(Date.now() - sentAt)
    const standingStatus = new Set(before.status)
    // Without an assistant selector, reply text is transcript growth from the
    // first read after Send (the person's own message is on the page by then).
    let growthBase: number | null = null
    let growth = 0
    let sawActive = false
    let quiet = 0
    let lastServerCheck = 0
    let serverRunning: string[] | null = null
    let lastStage = ''
    let lastStatus = ''
    let statusChangedAt = Date.now()
    let finished = false
    await this.wait('Waiting for the agent', async () => {
      while (Date.now() - sentAt < timeoutMs) {
        const s = await this.read(page).catch(() => null)
        if (s) {
          const shown = evidence.observe(s)
          if (shown.length) {
            t.firstFailureS ??= since()
            this.mark(`Failure shown after ${since()} s: ${oneLine(shown[0]!, 90)}`, page)
          }
          const status = s.status.filter((line) => !standingStatus.has(line))
          growthBase ??= s.transcriptChars
          const chars = s.assistantChars >= 0 ? s.assistantChars - baselineChars : s.transcriptChars - growthBase - status.join(' ').length
          growth = Math.max(growth, chars)
          const stage = status.join(' | ').replace(/\b\d+(\.\d+)?\s?s\b/g, '').trim()
          if (stage && stage !== lastStage) {
            t.stages.push({ s: since(), text: status.join(' | ').slice(0, 160) })
            lastStage = stage
          }
          // Raw text, timers included: a ticking "Preparing your workspace… 31s" is changing.
          if (status.join(' | ') !== lastStatus) {
            lastStatus = status.join(' | ')
            statusChangedAt = Date.now()
          }
          if (t.firstProgressS === null && (status.length || chars > 0)) {
            t.firstProgressS = since()
            t.firstProgressText = status[0] ?? 'reply text'
            this.mark(`First visible progress after ${t.firstProgressS} s: ${oneLine(t.firstProgressText, 70)}`, page)
          }
          if (t.firstTextS === null && chars > 0) {
            t.firstTextS = since()
            this.mark(`First text after ${t.firstTextS} s`, page)
          }
          const stopDue = opts.stopAfter === 'first-text' ? t.firstTextS !== null : typeof opts.stopAfter === 'number' && since() >= opts.stopAfter
          if (t.stopPressedS === null && stopDue && s.stopVisible) {
            t.stopPressedS = since()
            this.mark(`Presses Stop after ${t.stopPressedS} s`, page)
            await this.click(this.composerButton(page, this.config.chat.stopName), { pauseAfter: 200 }).catch((e) => console.warn(`Stop press failed: ${e}`))
          }
          if (status.length > 0) sawActive = true
          const active = turnLooksActive({ stopVisible: s.stopVisible, statusLines: status.length, msSinceStatusChanged: Date.now() - statusChangedAt })
          quiet = active ? 0 : quiet + 1
        }
        if (route && this.config.chat.runningTurns && Date.now() - lastServerCheck > 2_000) {
          lastServerCheck = Date.now()
          // A failed read never implies the turn ended.
          serverRunning = await this.runningTurns(page, route).catch(() => serverRunning)
          if (serverRunning?.length) sawActive = true
        }
        const started = sawActive || t.firstTextS !== null || Date.now() - sentAt > 45_000
        const serverDone = !this.config.chat.runningTurns || !route || serverRunning?.length === 0
        if (started && quiet >= 2 && serverDone) {
          finished = true
          return
        }
        await sleep(300)
      }
    }, page)
    t.completeS = finished ? since() : null
    // Render lag only: the turn has ended, so wait for the transcript to stop changing before judging it.
    await settleText(() => this.read(page).then((r) => `${r.transcriptChars}:${r.failureNodes.length}:${r.retryButtons}`))
    evidence.observe(await this.read(page))
    const finalText = this.config.chat.assistant ? await this.replyText(page) : ''
    t.replyChars = this.config.chat.assistant ? Math.max(0, finalText.length - baselineChars) : Math.max(0, growth)
    Object.assign(t, scoreTurn({ timedOut: !finished, evidence: evidence.added(), replyChars: t.replyChars, stopPressed: t.stopPressedS !== null }))
    const n = this.turns.length
    t.replyFile = join('turns', `${String(n).padStart(2, '0')}-${t.label}.md`)
    const reply = this.config.chat.assistant ? finalText.slice(baselineChars).trim() : '(this app configures no assistant selector; read the reply in the video or the trace)'
    const failures = t.failures.length ? `\n\n## Failure evidence\n\n${t.failures.map((f) => `- ${f}`).join('\n')}` : ''
    writeFileSync(join(this.outDir, t.replyFile), `# Turn ${n} (${t.label})\n\n## Prompt\n\n${prompt}\n\n## Reply (${t.outcome})\n\n${reply}${failures}\n`)
    this.mark(
      t.outcome === 'completed'
        ? `Turn complete after ${t.completeS} s (${t.replyChars} chars)`
        : `Turn ${t.outcome.toUpperCase()} after ${t.completeS ?? since()} s${t.error ? `: ${oneLine(t.error, 80)}` : ''}`,
      page,
    )
    return t
  }

  private async replyText(page: Page): Promise<string> {
    const sel = this.config.chat.assistant
    if (!sel) return ''
    return settleText(async () => (await page.locator(sel).allInnerTexts()).join('\n').trim())
  }

  /**
   * Close everything, then per context: a captioned full .mp4, a highlights cut
   * (at most 178 s, long waits sped up and labelled), an .srt and a scrubbed
   * trace.zip; plus timings.json and chapters.json. Refuses (throws) when any
   * output file still holds a password or cookie value.
   */
  async finish(opts: { speedup2x?: boolean } = {}): Promise<{ outDir: string; files: string[] }> {
    for (const ctx of this.phones.values()) await ctx.close().catch(() => {})
    const files: string[] = []
    // Stop every recording first, so one context's video does not run on through another's processing.
    const stopped: { r: Recorded; rawTrace: string; webm: string | null; endedAt: number }[] = []
    for (const r of this.recorded) {
      const endedAt = Date.now()
      const rawTrace = join(r.rawDir, 'trace.raw.zip')
      await r.context.tracing.stop({ path: rawTrace }).catch((e) => console.warn(`tracing.stop failed for ${r.label}: ${e}`))
      const video = r.page.video()
      await r.context.close()
      stopped.push({ r, rawTrace, webm: video ? await video.path().catch(() => null) : null, endedAt })
    }
    const needles = secretNeedles(this.config)
    for (const { r, rawTrace, webm, endedAt } of stopped) {
      if (webm) {
        files.push(...postProcessVideo({
          webm, workDir: r.rawDir, videoDir: join(this.outDir, 'video'), label: r.label, t0: r.t0,
          wallSeconds: (endedAt - r.t0) / 1000, chapters: this.chapters.filter((c) => c.label === null || c.label === r.label),
          speedup2x: opts.speedup2x ?? false,
        }))
      }
      try {
        const clean = join(this.outDir, 'video', `${r.label}-trace.zip`)
        const result = scrubTrace(rawTrace, clean, [...needles.hard, ...needles.soft])
        console.log(`trace ${r.label}: ${result.entries} entries, ${result.dropped} sensitive bodies dropped, ${result.rewritten} rewritten`)
        files.push(clean)
      } catch (error) {
        console.warn(`trace ${r.label} not written: ${(error as Error).message}`)
      }
    }
    writeFileSync(join(this.outDir, 'chapters.json'), JSON.stringify(this.chapters.map((c) => ({ ...c, at: new Date(c.at).toISOString(), until: c.until ? new Date(c.until).toISOString() : undefined, offsetS: secs(c.at - this.startedAt) })), null, 2))
    writeFileSync(join(this.outDir, 'timings.json'), JSON.stringify({ journey: this.id, app: this.config.app, base: this.config.baseUrl, startedAt: new Date(this.startedAt).toISOString(), wallS: secs(Date.now() - this.startedAt), steps: this.steps, turns: this.turns }, null, 2))
    await this.browser.close()
    assertNoSecrets(this.outDir, needles)
    console.log(`\n${this.id}: ${this.steps.length} steps, ${this.turns.length} turns, wall ${secs(Date.now() - this.startedAt)} s`)
    for (const t of this.turns) {
      console.log(`  turn[${t.label}] ${t.outcome}: progress ${t.firstProgressS ?? '-'} s, first text ${t.firstTextS ?? '-'} s, end ${t.completeS ?? '-'} s, ${t.replyChars} chars${t.error ? ` | ${oneLine(t.error, 100)}` : ''}`)
    }
    const host = process.env.JOURNEYS_HOST_ALIAS ?? hostname()
    console.log(`output: ${this.outDir}\ncopy it (run where you will watch it):\n  rsync -a ${host}:${this.outDir}/ "<dest>/${this.id}/"`)
    return { outDir: this.outDir, files }
  }
}

export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Open a journey. Without `config`, reads `journeys.config.mjs` from the working directory. */
export async function startJourney(id: string, opts: { config?: JourneysConfig | ResolvedJourneysConfig; cursor?: boolean; headless?: boolean } = {}): Promise<Journey> {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id)) throw new Error('journey id: lowercase letters, digits and dashes')
  const config = opts.config ? resolveJourneysConfig(opts.config) : await loadJourneysConfig()
  let chromium
  try {
    chromium = (await import('playwright')).chromium
  } catch {
    throw new Error('journeys need the optional `playwright` peer: install playwright in the app that runs them')
  }
  const browser = await chromium.launch({ headless: opts.headless ?? true })
  return new Journey(id, config, browser, { cursor: opts.cursor ?? true })
}
