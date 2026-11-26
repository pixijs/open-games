/** An element with a class and children. */
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: ReadonlyArray<Node | string>): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== "") node.className = className
  node.append(...children)
  return node
}

/** Parses trusted markup written in this folder into one element. */
export const fromMarkup = <T extends Element = HTMLElement>(markup: string): T => {
  const template = document.createElement("template")
  template.innerHTML = markup.trim()
  const node = template.content.firstElementChild
  if (node === null) throw new Error("fromMarkup: empty markup")
  return node as T
}

/** The element under `root` matching `selector`; throws when the markup and the code disagree. */
export const pick = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const node = root.querySelector<T & Element>(selector)
  if (node === null) throw new Error(`ui: no ${selector}`)
  return node
}

export const pickAll = <T extends Element = HTMLElement>(root: ParentNode, selector: string): Array<T> =>
  Array.from(root.querySelectorAll<T & Element>(selector))
