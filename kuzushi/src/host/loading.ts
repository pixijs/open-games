declare global {
  interface Window {
    /** The loader, for screenshots: `set` moves its bar (0 to 1), `finish` plays its outro. Gone with the loader. */
    __loading?: { set(done: number): void; finish(): Promise<void> }
  }
}

/** The DOM loader that `index.html` paints before any script, over the canvas until the game has loaded. */
export interface Loader {
  /** Moves the bar to `done` (0 to 1); it never goes back. */
  progress(done: number): void
  /** Plays the outro over what the canvas shows, then removes the loader. With `?loading=hold` the loader stays. */
  finish(): Promise<void>
  /** Shows that loading failed, with the error's first line. */
  fail(error: unknown): void
}

/** Takes over `#loading` from `index.html`, whose styles draw it (docs/DESIGN.md, Loading). */
export const attachLoader = (): Loader => {
  const root = document.getElementById("loading")
  if (root === null) throw new Error("index.html needs #loading")
  const hold = new URLSearchParams(location.search).get("loading") === "hold"
  const write = (selector: string, text: string) => {
    for (const each of root.querySelectorAll(selector)) each.textContent = text
  }
  const set = (done: number) => {
    const share = Math.min(1, Math.max(0, done))
    const percent = Math.round(share * 100)
    root.style.setProperty("--p", `${share}`)
    root.setAttribute("aria-valuenow", `${percent}`)
    write(".pct", `${percent}%`)
  }
  const outro = async () => {
    root.classList.add("out")
    const finite = root.getAnimations({ subtree: true }).filter((each) => Number.isFinite(each.effect?.getComputedTiming().endTime))
    await Promise.all(finite.map((each) => each.finished))
    root.remove()
    delete window.__loading
  }
  window.__loading = { set, finish: outro }
  let shown = 0
  return {
    progress: (done) => {
      if (done <= shown) return
      shown = done
      set(done)
    },
    finish: async () => {
      if (!hold) await outro()
    },
    fail: (error) => {
      root.dataset.state = "error"
      write(".say", "FAILED TO LOAD")
      write(".why", `${error instanceof Error ? error.message : error}`.split("\n")[0] ?? "")
    }
  }
}
