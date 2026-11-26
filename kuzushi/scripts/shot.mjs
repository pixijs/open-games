// Headless screenshots of the running game, with scripted input.
//
//   node scripts/shot.mjs --url http://localhost:5352/ --out shots/title.png
//   node scripts/shot.mjs --url http://localhost:5352/ --size 1280x720 --steps scripts/steps/title.json
//
// --size     viewport, default 1680x800 (a wide 2.1:1 window)
// --dpr      device pixel ratio, default 1; 2 checks the UI's text and lines on a retina screen (shots are then twice the size)
// --wait     ms to wait after the game has loaded (the performance mark "kuzushi:loaded") before the steps, default 1500
// --load-timeout  ms to wait for the game to load before giving up with an error, default 60000
// --steps    a JSON file: an array of steps run in order
//              { "wait": 500 }                      wait ms
//              { "key": "Space" }                   press and release (KeyboardEvent.key or .code names)
//              { "down": "KeyW" } / { "up": "KeyW" }  hold and release
//              { "click": [x, y], "button": "left" } click at viewport pixels
//              { "move": [x, y] }                   move the mouse
//              { "eval": "window.__game.state()" }  run code in the page; its JSON result is printed
//              { "evalFile": "scripts/autopilot.js" } run a script file in the page the same way
//              { "shot": "shots/name.png" }         screenshot now
// --out      final screenshot after the steps (optional when steps take shots)
// --reduced-motion  emulate prefers-reduced-motion: reduce
// --init     a script run in the page before any of the page's own (page.addInitScript), such as scripts/compiles.js
//
// A shot path ending .jpg saves a JPEG: much smaller, so prefer it for frame sequences.
//
// Uses the installed Google Chrome so the game runs on the real GPU, on WebGPU (add ?renderer=webgl to the URL for WebGL). Prints every console error and
// page error, and exits 1 when there was one.
import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { chromium } from "playwright"

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, [])
)

const url = args.url ?? "http://localhost:5352/"
const [width, height] = (args.size ?? "1680x800").split("x").map(Number)
const steps = args.steps ? JSON.parse(readFileSync(args.steps, "utf8")) : []

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [...(process.platform === "darwin" ? ["--use-angle=metal"] : []), "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(args.dpr ?? 1), reducedMotion: "reduced-motion" in args ? "reduce" : "no-preference" })
const errors = []
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`)
})
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))

const shot = async (path) => {
  mkdirSync(dirname(path), { recursive: true })
  await page.screenshot({ path })
  console.log(`shot ${path}`)
}

if (args.init) await page.addInitScript({ path: args.init })
await page.goto(url, { waitUntil: "load" })
const loaded = await page
  .waitForFunction(() => performance.getEntriesByName("kuzushi:loaded").length > 0 || document.querySelector('#loading[data-state="error"]') !== null, null, { timeout: Number(args["load-timeout"] ?? 60000) })
  .then(() => page.evaluate(() => performance.getEntriesByName("kuzushi:loaded").length > 0), () => false)
if (!loaded) {
  const why = await page.evaluate(() => document.querySelector("#loading .why")?.textContent ?? "").catch(() => "")
  console.log(`the game never loaded (no "kuzushi:loaded" mark)${why === "" ? "" : `: ${why}`}`)
  for (const error of errors) console.log(error)
  await browser.close()
  process.exit(1)
}
await page.waitForTimeout(Number(args.wait ?? 1500))

for (const step of steps) {
  if ("wait" in step) await page.waitForTimeout(step.wait)
  else if ("key" in step) await page.keyboard.press(step.key)
  else if ("down" in step) await page.keyboard.down(step.down)
  else if ("up" in step) await page.keyboard.up(step.up)
  else if ("click" in step) await page.mouse.click(step.click[0], step.click[1], { button: step.button ?? "left" })
  else if ("move" in step) await page.mouse.move(step.move[0], step.move[1])
  else if ("eval" in step) console.log(`eval ${JSON.stringify(await page.evaluate(step.eval))}`)
  else if ("evalFile" in step) console.log(`eval ${JSON.stringify(await page.evaluate(readFileSync(step.evalFile, "utf8")))}`)
  else if ("shot" in step) await shot(step.shot)
}

if (args.out) await shot(args.out)
for (const error of errors) console.log(error)
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)
