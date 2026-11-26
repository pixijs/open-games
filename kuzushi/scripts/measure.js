// Frame times for screenshot runs. Load it with `{ "evalFile": "scripts/measure.js" }`, then
// `{ "eval": "window.__measure('label', seconds)" }` prints fps, median, p95, p99, max and frames over 20 ms.
(() => {
  window.__measure = (label, seconds) => new Promise((resolve) => {
    const frames = []
    let last = performance.now()
    const end = last + seconds * 1000
    const tick = (now) => {
      frames.push(now - last)
      last = now
      if (now < end) return requestAnimationFrame(tick)
      frames.sort((a, b) => a - b)
      const at = (p) => +frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(2)
      const state = window.__game?.state()
      resolve(JSON.stringify({
        label,
        fps: +(frames.length / seconds).toFixed(1),
        median: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: +frames[frames.length - 1].toFixed(1),
        over20: frames.filter((x) => x > 20).length,
        enemies: state?.enemies.length ?? 0,
        orbs: state?.projectiles ?? 0
      }))
    }
    requestAnimationFrame(tick)
  })
  return "measure ready"
})()
