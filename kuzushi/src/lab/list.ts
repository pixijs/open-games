import { el } from "../ui/dom.ts"
import { createMenu } from "../ui/menu.ts"
import { ticks } from "../ui/panel.ts"
import { makeModal } from "../ui/screen.ts"
import { SCENE_KEYS } from "./keys.ts"
import type { Scene } from "./scene.ts"

export interface SceneList {
  readonly element: HTMLElement
  show(on: boolean, active?: number): void
}

/**
 * The lab's scene list, in the title menu's style: each scene with what it shows, W/S and Enter or its number to
 * open it, Esc back to the title. It holds the keyboard while it is up.
 */
export const createSceneList = (scenes: ReadonlyArray<Scene>, open: (scene: Scene) => void, leave: () => void): SceneList => {
  const menu = createMenu(scenes.map((scene) => ({ label: scene.title, detail: scene.summary, action: () => open(scene) })), { className: "is-lab" })
  const back = el("button", "k-back", el("kbd", "", "Esc"), el("span", "", "Title"))
  back.type = "button"
  back.addEventListener("click", leave)
  const panel = el("section", "k-panel k-lab-list-panel",
    el("header", "k-panel-head", el("i", "k-panel-mark"), el("span", "k-panel-title", "Lab"), el("span", "k-lab-list-jp", "稽古"), el("span", "k-panel-rule"), back),
    menu.element,
    el("footer", "k-lab-list-foot",
      el("span", "k-hint", el("kbd", "", "W"), el("kbd", "", "S"), " Select"),
      el("span", "k-hint", el("kbd", "", "Enter"), " Open"),
      el("span", "k-hint", el("kbd", "", "1"), "–", el("kbd", "", `${scenes.length}`), " Open")))
  panel.insertAdjacentHTML("afterbegin", ticks)
  const element = el("div", "k-lab-list", el("div", "k-lab-list-scrim"), panel)

  const modal = makeModal(element, "Lab scenes", (event) => {
    if (event.code === "Escape") {
      leave()
      return true
    }
    const numbered = scenes[SCENE_KEYS.findIndex((code) => code === event.code)]
    if (numbered !== undefined) {
      open(numbered)
      return true
    }
    return menu.key(event)
  })

  return {
    element,
    show: (on, active = 0) => {
      element.classList.toggle("is-shown", on)
      if (!on) {
        modal.release()
        return
      }
      menu.reset(active)
      menu.intro()
      modal.focus()
    }
  }
}
