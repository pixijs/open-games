import { css } from "../art/palette.ts"
import { el } from "../ui/dom.ts"

/** What a stretch of a lane shows. */
export type Tone = "windup" | "active" | "recover" | "telegraph" | "attack" | "rest" | "stagger" | "guard" | "stance" | "dash" | "safe" | "move"

const FILL: Readonly<Record<Tone, string>> = {
  windup: "rgba(242, 239, 232, 0.32)",
  active: css("red"),
  recover: css("concrete600"),
  telegraph: "rgba(255, 46, 63, 0.38)",
  attack: css("red"),
  rest: css("concrete700"),
  stagger: "rgba(242, 239, 232, 0.6)",
  guard: css("paper"),
  stance: css("concrete500"),
  dash: "rgba(242, 239, 232, 0.82)",
  safe: "rgba(242, 239, 232, 0.2)",
  move: css("concrete800")
}

/** Tones whose label is drawn dark, on a light fill. */
const LIGHT: ReadonlySet<Tone> = new Set(["guard", "dash", "stagger"])

export interface Lane {
  readonly id: string
  readonly label: string
}

interface Segment {
  from: number
  to: number
  readonly tone: Tone
  readonly label: string
}

interface Mark {
  readonly step: number
  readonly lane: string
  readonly label: string
  readonly hot: boolean
}

/**
 * A strip of lanes along the gameplay clock, one column per step: each lane is sampled every frame with what it
 * shows, equal stretches join into segments labelled with their length in steps, and marks pin moments (a hit, a
 * parry) to a step. A trace longer than the span squeezes to fit.
 */
export interface Timeline {
  readonly element: HTMLElement
  /** Shows the timeline with `lanes` and a span of `span` steps, or hides it with null. */
  setup(title: string, lanes: ReadonlyArray<Lane> | null, span?: number): void
  /** Starts a fresh trace at gameplay step `step`. */
  begin(step: number): void
  /** What `lane` shows at gameplay step `step`; null shows nothing. */
  sample(step: number, lane: string, tone: Tone | null, label?: string): void
  mark(step: number, lane: string, label: string, hot?: boolean): void
  /** The step the playhead stands on. */
  playhead(step: number): void
  draw(): void
}

const ROW = 18
const RULER = 16
const LABELS = 62
const FONT = '"Barlow Condensed", "Arial Narrow", sans-serif'

export const createTimeline = (): Timeline => {
  const head = el("header", "k-lab-timeline-head")
  const canvas = el("canvas")
  const element = el("section", "k-lab-timeline", head, canvas)
  element.hidden = true
  const context = canvas.getContext("2d")

  let lanes: ReadonlyArray<Lane> = []
  let span = 60
  let start = 0
  let cursor = 0
  const segments = new Map<string, Array<Segment>>()
  /** Each lane's last sample: steps skipped between two frames belong to the stretch that ran through them. */
  const sampled = new Map<string, { readonly step: number; readonly tone: Tone | null; readonly label: string }>()
  const marks: Array<Mark> = []

  const draw = () => {
    if (context === null || element.hidden) return
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    const width = canvas.clientWidth
    const height = RULER + lanes.length * ROW + 4
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      canvas.style.height = `${height}px`
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    const latest = Math.max(cursor, ...[...segments.values()].map((list) => list.at(-1)?.to ?? start))
    const shown = Math.max(span, latest - start + 6)
    const first = latest - start + 6 > span ? latest + 6 - shown : start
    const scale = (width - LABELS - 4) / shown
    const x = (step: number) => LABELS + (step - first) * scale

    context.font = `500 10px ${FONT}`
    context.textBaseline = "middle"
    const every = scale >= 7 ? 5 : scale >= 3.5 ? 10 : 30
    for (let step = Math.ceil((first - start) / every) * every; step <= first - start + shown; step += every) {
      const at = x(start + step)
      context.fillStyle = step % (every * 2) === 0 ? "rgba(242, 239, 232, 0.5)" : "rgba(242, 239, 232, 0.22)"
      context.fillRect(Math.round(at), RULER - 5, 1, 5 + lanes.length * ROW)
      if (step % (every * 2) === 0) {
        context.fillStyle = css("concrete300")
        context.fillText(`${step}`, Math.round(at) + 3, RULER / 2 - 1)
      }
    }

    lanes.forEach((lane, row) => {
      const top = RULER + row * ROW
      context.fillStyle = css("concrete300")
      context.font = `500 10px ${FONT}`
      context.fillText(lane.label.toUpperCase(), 0, top + ROW / 2)
      context.fillStyle = "rgba(242, 239, 232, 0.06)"
      context.fillRect(LABELS, top + 2, width - LABELS, ROW - 4)
      for (const segment of segments.get(lane.id) ?? []) {
        const left = Math.max(LABELS, x(segment.from))
        const right = x(segment.to)
        if (right <= LABELS) continue
        context.fillStyle = FILL[segment.tone]
        context.fillRect(left, top + 2, Math.max(1, right - left - 1), ROW - 4)
        const frames = segment.to - segment.from
        const full = `${segment.label} ${frames}`.trim()
        context.font = `600 10px ${FONT}`
        const text = context.measureText(full).width + 6 < right - left ? full : context.measureText(`${frames}`).width + 4 < right - left ? `${frames}` : ""
        if (text === "") continue
        context.fillStyle = LIGHT.has(segment.tone) ? css("ink") : css("paper")
        context.fillText(text.toUpperCase(), left + 3, top + ROW / 2 + 0.5)
      }
    })

    for (const mark of marks) {
      const row = lanes.findIndex((lane) => lane.id === mark.lane)
      if (row < 0 || mark.step < first) continue
      const at = Math.round(x(mark.step))
      const top = RULER + row * ROW
      context.fillStyle = mark.hot ? css("red") : css("paper")
      context.fillRect(at - 1, top, 2, ROW)
      context.font = `700 10px ${FONT}`
      const labelWidth = context.measureText(mark.label).width
      context.fillStyle = "rgba(13, 13, 15, 0.85)"
      context.fillRect(at + 2, top + 3, labelWidth + 6, ROW - 6)
      context.fillStyle = mark.hot ? css("red") : css("paper")
      context.fillText(mark.label.toUpperCase(), at + 5, top + ROW / 2 + 0.5)
    }

    const playhead = x(cursor)
    if (playhead >= LABELS) {
      context.fillStyle = css("red")
      context.fillRect(Math.round(playhead), RULER - 6, 1, 6 + lanes.length * ROW)
    }
  }

  return {
    element,
    setup: (title, next, nextSpan = 60) => {
      element.hidden = next === null
      lanes = next ?? []
      span = nextSpan
      head.textContent = title
      segments.clear()
      sampled.clear()
      marks.length = 0
    },
    begin: (step) => {
      start = step
      cursor = step
      segments.clear()
      sampled.clear()
      marks.length = 0
    },
    sample: (step, lane, tone, label = "") => {
      const before = sampled.get(lane)
      sampled.set(lane, { step, tone, label })
      if (tone === null || step < start) return
      const list = segments.get(lane) ?? []
      segments.set(lane, list)
      const last = list.at(-1)
      const same = before !== undefined && before.tone === tone && before.label === label
      if (last !== undefined && same && last.to >= before.step + 1) {
        last.to = Math.max(last.to, step + 1)
        return
      }
      const from = before === undefined || before.step >= step ? step : Math.max(start, before.step + 1)
      if (last !== undefined && last.to > from) last.to = from
      list.push({ from, to: step + 1, tone, label })
    },
    mark: (step, lane, label, hot = false) => {
      if (step >= start) marks.push({ step, lane, label, hot })
    },
    playhead: (step) => {
      cursor = step
    },
    draw
  }
}
