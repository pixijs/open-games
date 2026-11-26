/**
 * The floor on screen, as effects need to know it. look's world writes it each frame; look's actors and vfx read it.
 * The host makes one and hands it to every install as `HostContext.ground`.
 */
export interface Ground {
  /**
   * A near-white floor (The Void's slabs). Additive glows and thin red lines drawn for darker floors wash out on it, so
   * orbs and telegraph lines draw with ink edges there instead.
   */
  pale: boolean
}

export const makeGround = (): Ground => ({ pale: false })
