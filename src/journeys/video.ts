/**
 * A recording turned into files a person can watch.
 *
 *   <label>-full.mp4        H.264, the whole session at real speed, with an 84 px
 *                           caption bar under the UI: the chapter line and an elapsed clock
 *   <label>.srt             the same chapters as a sidecar caption file
 *   <label>-highlights.mp4  at most 178 s: waits and idle stretches sped up, and the caption
 *                           says by how much ("[01:09] First text after 23 s   » 4.2x, 21 s real (whole wait 41 s)")
 *   <label>-x2.mp4          optional: the full video at 2x
 *
 * Captions sit in their own bar so they never cover the composer or a toast.
 * Needs `ffmpeg` and `ffprobe` on PATH; work runs at nice 10 on 2 threads.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface Chapter {
  /** Epoch ms. */
  at: number
  caption: string
  /** Context label, or null for every context. */
  label: string | null
  kind: 'step' | 'wait'
  /** Epoch ms a wait ended. */
  until?: number
}

export interface Cue {
  start: number
  end: number
  text: string
}

export interface HighlightSegment {
  /** Source range, seconds. */
  a: number
  b: number
  /** Speed-up factor. */
  k: number
  text: string
}

const W = 1440
const H = 900
const BAR = 84
export const MAX_HIGHLIGHTS_S = 178

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
  '/System/Library/Fonts/Menlo.ttc',
]

function monoFont(): string | null {
  const configured = process.env.JOURNEYS_FONT_MONO
  if (configured && existsSync(configured)) return configured
  return FONT_CANDIDATES.find((path) => existsSync(path)) ?? null
}

function ff(args: string[]): void {
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
}

export function probeSeconds(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).trim()
  const n = Number(out)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`ffprobe could not read the duration of ${file}: ${out}`)
  return n
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0')
const mmss = (s: number) => `${pad2(s / 60)}:${pad2(s % 60)}`
const srtTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000))
  return `${pad2(ms / 3_600_000)}:${pad2((ms / 60_000) % 60)}:${pad2((ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`
}
const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  return `${Math.floor(cs / 360_000)}:${pad2((cs / 6000) % 60)}:${pad2((cs / 100) % 60)}.${String(cs % 100).padStart(2, '0')}`
}
const humanSeconds = (s: number) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`)

/** Chapters on the video's own clock; each caption holds until the next. */
export function chapterCues(chapters: readonly Chapter[], t0: number, duration: number): Cue[] {
  const points = chapters
    .map((c) => ({ ...c, s: (c.at - t0) / 1000, e: c.until ? (c.until - t0) / 1000 : undefined }))
    .filter((c) => c.s < duration)
    .sort((a, b) => a.s - b.s)
  const cues: Cue[] = []
  for (let i = 0; i < points.length; i += 1) {
    const c = points[i]!
    const start = Math.max(0, c.s)
    const end = Math.min(duration, points[i + 1]?.s ?? duration)
    if (end - start < 0.05) continue
    const text = c.kind === 'wait' && c.e !== undefined ? `${c.caption} (real wait ${humanSeconds(c.e - c.s)})` : c.caption
    cues.push({ start, end, text })
  }
  return cues
}

function srtText(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')
}

function assText(cues: readonly Cue[]): string {
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N')
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H + BAR}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Bar,DejaVu Sans,26,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,28,200,14,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  return head + cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Bar,,0,0,0,,${esc(c.text)}`).join('\n') + '\n'
}

/**
 * The highlights cut: which source ranges, at what speed, under which caption.
 * A wait longer than 6 s plays in about 5 s; an idle stretch longer than 15 s
 * plays in about 10 s; then everything scales to fit {@link MAX_HIGHLIGHTS_S}.
 */
export function highlightPlan(chapters: readonly Chapter[], t0: number, duration: number): HighlightSegment[] {
  const pts = chapters
    .map((c) => ({ ...c, s: Math.max(0, (c.at - t0) / 1000), e: c.until ? (c.until - t0) / 1000 : undefined }))
    .sort((x, y) => x.s - y.s)
  const cuts = new Set<number>([0, duration])
  for (const p of pts) {
    if (p.s < duration) cuts.add(Math.round(p.s * 10) / 10)
    if (p.e !== undefined && p.e < duration) cuts.add(Math.round(p.e * 10) / 10)
  }
  const bounds = [...cuts].sort((x, y) => x - y)
  const segs: { a: number; b: number; k: number; text: string; wait: boolean; whole: number }[] = []
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const a = bounds[i]!
    const b = bounds[i + 1]!
    if (b - a < 0.15) continue
    const wait = [...pts].reverse().find((p) => p.kind === 'wait' && p.e !== undefined && p.s <= a + 0.05 && a < p.e - 0.05)
    // The latest step caption wins (e.g. "First text after 31 s" inside a wait); the wait adds its total.
    const step = [...pts].reverse().find((p) => p.kind === 'step' && p.s <= a + 0.05 && (!wait || p.s >= wait.s - 0.05))
    const len = b - a
    const k = wait ? (len > 6 ? len / 5 : 1) : len > 15 ? len / 10 : 1
    segs.push({ a, b, k, text: step?.caption ?? wait?.caption ?? '', wait: Boolean(wait), whole: wait?.e !== undefined ? wait.e - wait.s : 0 })
  }
  const shown = segs.reduce((n, s) => n + (s.b - s.a) / s.k, 0)
  const f = shown > MAX_HIGHLIGHTS_S ? shown / MAX_HIGHLIGHTS_S : 1
  return segs.map((s) => {
    const k = s.k * f
    const len = s.b - s.a
    const x = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10
    const speed = k > 1.05 ? `   » ${x}x, ${humanSeconds(len)} real${s.wait ? ` (whole wait ${humanSeconds(s.whole)})` : ''}` : ''
    return { a: s.a, b: s.b, k, text: `[${mmss(s.a)}] ${s.text}${speed}` }
  })
}

interface PostProcessInput {
  webm: string
  /** Raw working folder on the host; keeps the webm and chapters for a rebuild. */
  workDir: string
  videoDir: string
  label: string
  /** Epoch ms the recorded page was created. */
  t0: number
  wallSeconds: number
  chapters: readonly Chapter[]
  speedup2x: boolean
}

export function postProcessVideo(o: PostProcessInput): string[] {
  mkdirSync(o.videoDir, { recursive: true })
  const keep = join(o.workDir, `${o.label}.webm`)
  if (o.webm !== keep) copyFileSync(o.webm, keep)
  writeFileSync(join(o.workDir, `${o.label}.chapters.json`), JSON.stringify({ t0: o.t0, wallSeconds: o.wallSeconds, chapters: o.chapters }))
  return renderAll(keep, o.workDir, o.videoDir, o.label, o.t0, o.chapters, o.speedup2x, o.wallSeconds)
}

/** Re-render from a raw folder after editing `<label>.chapters.json` by hand. */
export function rebuildVideo(rawLabelDir: string, videoDir: string, label: string, speedup2x: boolean): string[] {
  const meta = JSON.parse(readFileSync(join(rawLabelDir, `${label}.chapters.json`), 'utf8')) as { t0: number; wallSeconds: number; chapters: Chapter[] }
  return renderAll(join(rawLabelDir, `${label}.webm`), rawLabelDir, videoDir, label, meta.t0, meta.chapters, speedup2x, meta.wallSeconds)
}

function renderAll(webm: string, work: string, videoDir: string, label: string, t0: number, chapters: readonly Chapter[], speedup2x: boolean, wallSeconds: number): string[] {
  const clean = join(work, `${label}.clean.mp4`)
  ff(['-i', webm, '-vf', `fps=25,scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-threads', '2', '-an', clean])
  const duration = probeSeconds(clean)
  // Measured 2026-10-11 against a clock burned into the page: video time tracks
  // wall clock from page creation to within 0.2 s.
  if (duration < wallSeconds - 3) console.warn(`video is ${duration.toFixed(1)} s but ${wallSeconds.toFixed(1)} s passed before recording stopped; late captions may be early`)

  const cues = chapterCues(chapters, t0, duration)
  const srt = join(videoDir, `${label}.srt`)
  writeFileSync(srt, srtText(cues))
  const ass = join(work, `${label}.full.ass`)
  writeFileSync(ass, assText(cues))
  const full = join(videoDir, `${label}-full.mp4`)
  const font = monoFont()
  const clock = `drawtext=${font ? `fontfile=${font}` : 'font=monospace'}:text='%{pts\\:hms}':x=w-tw-28:y=h-${BAR / 2}-th/2:fontsize=26:fontcolor=white@0.8`
  ff(['-i', clean, '-vf', `pad=${W}:${H + BAR}:0:0:color=0x111111,ass=${ass},${clock}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', full])

  const plan = highlightPlan(chapters, t0, duration)
  const segDir = join(work, `${label}.segments`)
  mkdirSync(segDir, { recursive: true })
  const list: string[] = []
  const hcues: Cue[] = []
  let at = 0
  plan.forEach((s, i) => {
    const seg = join(segDir, `${String(i).padStart(3, '0')}.mp4`)
    ff(['-ss', s.a.toFixed(3), '-t', (s.b - s.a).toFixed(3), '-i', clean, '-vf', `setpts=PTS/${s.k.toFixed(4)},fps=25`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', seg])
    const len = probeSeconds(seg)
    list.push(`file '${seg}'`)
    hcues.push({ start: at, end: at + len, text: s.text })
    at += len
  })
  const listFile = join(segDir, 'list.txt')
  writeFileSync(listFile, list.join('\n') + '\n')
  const joined = join(work, `${label}.highlights.raw.mp4`)
  ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined])
  const hass = join(work, `${label}.highlights.ass`)
  writeFileSync(hass, assText(hcues))
  const highlights = join(videoDir, `${label}-highlights.mp4`)
  ff(['-i', joined, '-vf', `pad=${W}:${H + BAR}:0:0:color=0x111111,ass=${hass}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', highlights])
  const out = [full, srt, highlights]
  if (speedup2x) {
    const x2 = join(videoDir, `${label}-x2.mp4`)
    ff(['-i', full, '-vf', 'setpts=PTS/2,fps=25', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', x2])
    out.push(x2)
  }
  console.log(`video ${label}: full ${duration.toFixed(1)} s, highlights ${at.toFixed(1)} s from ${plan.length} segments`)
  return out
}

/** Seconds at which to grab frames: one per caption (1.5 s in), at most `max`, evenly spread. */
export function frameTimes(srt: string | null, times: readonly number[], max = 10): number[] {
  let ts = [...times]
  if (!ts.length && srt) {
    ts = srt.split('\n').filter((l) => l.includes('-->')).map((l) => {
      const [h = '0', m = '0', rest = '0'] = l.split(' --> ')[0]!.split(':')
      return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.')) + 1.5
    })
  }
  if (ts.length > max) {
    const step = ts.length / max
    ts = Array.from({ length: max }, (_, i) => ts[Math.floor(i * step)]!)
  }
  return ts
}

/** PNG frames of a video, named by label and timestamp, into `outDir`. */
export function extractFrames(video: string, srtFile: string | null, outDir: string, times: readonly number[], max = 10): string[] {
  const srt = srtFile && existsSync(srtFile) ? readFileSync(srtFile, 'utf8') : null
  return frameTimes(srt, times, max).map((t, i) => {
    const f = join(outDir, `frame-${basename(video).replace(/-full\.mp4$/, '')}-${String(i + 1).padStart(2, '0')}-${mmss(t).replace(':', 'm')}s.png`)
    ff(['-ss', t.toFixed(2), '-i', video, '-frames:v', '1', f])
    return f
  })
}
