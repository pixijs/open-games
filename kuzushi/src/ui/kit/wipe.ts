import { Graphics, Rectangle } from "pixi.js"

export interface Wipe {
  readonly mask: Graphics
  /** 0 hidden to 1 whole. */
  amount: number
  /** The box it uncovers, in its parent's space. */
  fit(box: Rectangle): void
}

/**
 * A rect mask that wipes a box in from an edge: "left" grows rightward, "right" grows leftward, "top" grows downward,
 * "bottom" grows upward (the altar card's). `amount` is an accessor GSAP tweens; it moves and scales one unit square,
 * never redraws. Wiping off toward an edge is the opposite edge's wipe run back to 0. Put the mask on a wrapper, never a
 * cached node.
 */
export const createWipe = (edge: "left" | "right" | "top" | "bottom"): Wipe => {
  const mask = new Graphics().rect(0, 0, 1, 1).fill(0xffffff)
  let box = new Rectangle()
  let amount = 1
  const place = () => {
    const across = edge === "left" || edge === "right"
    const width = across ? box.width * amount : box.width
    const height = across ? box.height : box.height * amount
    mask.position.set(edge === "right" ? box.right - width : box.x, edge === "bottom" ? box.bottom - height : box.y)
    mask.scale.set(width, height)
  }
  return {
    mask,
    get amount() {
      return amount
    },
    set amount(value) {
      amount = Math.max(0, Math.min(1, value))
      place()
    },
    fit: (next) => {
      box = next.clone()
      place()
    }
  }
}
