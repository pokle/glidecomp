import Sqids from "sqids";

const MIN_LENGTH = 4;

let cached: { alphabet: string; sqids: Sqids } | null = null;

function getInstance(alphabet: string): Sqids {
  if (cached && cached.alphabet === alphabet) return cached.sqids;
  const sqids = new Sqids({ alphabet, minLength: MIN_LENGTH });
  cached = { alphabet, sqids };
  return sqids;
}

export function encodeId(alphabet: string, id: number): string {
  return getInstance(alphabet).encode([id]);
}

export function decodeId(alphabet: string, encoded: string): number | null {
  const sqids = getInstance(alphabet);
  const numbers = sqids.decode(encoded);
  if (numbers.length !== 1) return null;
  // Verify round-trip to reject crafted strings
  if (sqids.encode(numbers) !== encoded) return null;
  return numbers[0];
}
