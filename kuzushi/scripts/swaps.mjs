// Walks 30 door transitions in one zone, back and forth between its start room and a neighbour, and prints the worst
// frame of each transition and the JS heap (after a forced GC) before and after: a growing heap means a leak.
//
//   node scripts/swaps.mjs http://localhost:5352/ spiral
import { chromium } from "playwright"

const url = process.argv[2] ?? "http://localhost:5352/"
const zone = process.argv[3] ?? "courtyard"
const SWAPS = 30
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [...(process.platform === "darwin" ? ["--use-angle=metal"] : []), "--enable-gpu", "--ignore-gpu-blocklist", "--js-flags=--expose-gc"] })
const page = await browser.newPage({ viewport: { width: 1680, height: 800 }, deviceScaleFactor: 1 })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
await page.goto(url, { waitUntil: "load" })
await page.waitForFunction(() => window.__game !== undefined)
await page.evaluate((zone) => { window.__game.startZone(zone, null, { seed: 7 }); window.__game.invulnerable(true) }, zone)
await page.waitForTimeout(2500)
const result = await page.evaluate(async (count) => {
  const heap = () => { window.gc?.(); return Math.round(performance.memory.usedJSHeapSize / 1048576) }
  const frames = []
  let last = performance.now()
  let running = true
  const tick = () => { const now = performance.now(); frames.push([now, now - last]); last = now; if (running) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))
  const before = heap()
  const target = window.__game.view().room.doors.find((door) => door.to !== null)?.to ?? 1
  const swaps = []
  for (let index = 0; index < count; index++) {
    const to = index % 2 === 0 ? target : 0
    window.__game.enterRoom(to)
    const started = performance.now()
    await window.__game.until((state) => state.transition !== null, 3000)
    await window.__game.until((state) => state.transition === null, 4000)
    const ended = performance.now()
    swaps.push(Math.max(...frames.filter(([at]) => at >= started && at <= ended).map(([, dt]) => dt)))
    window.__game.openDoors()
    await settle()
  }
  running = false
  const after = heap()
  swaps.sort((a, b) => a - b)
  return { before, after, worstFrame: Math.round(swaps[swaps.length - 1]), medianWorst: Math.round(swaps[count >> 1]), swaps: swaps.map(Math.round) }
}, SWAPS)
console.log(JSON.stringify(result))
if (errors.length > 0) console.log("errors", errors.slice(0, 5))
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)
