/** Node's `crypto` for Colyseus in a tab: only its static-file router hashes, and a tab serves no files */
export function createHash(): never {
  throw new Error('createHash is not available in the browser');
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];

  return diff === 0;
}
