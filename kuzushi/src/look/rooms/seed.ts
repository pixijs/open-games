/** A steady seed from a name, so a room's drawings come out the same every time it is built. */
export const seedOf = (name: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}
