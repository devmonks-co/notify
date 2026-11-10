/** Small synchronous 3x53-bit string hash (cyrb53), hex. Not cryptographic: used for stable dedupe keys. */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashParts(parts: (string | undefined)[]): string {
  const s = parts.map((p) => p ?? '').join('\u001f');
  return [cyrb53(s, 1), cyrb53(s, 2), cyrb53(s, 3)].map((n) => n.toString(16).padStart(14, '0')).join('');
}
