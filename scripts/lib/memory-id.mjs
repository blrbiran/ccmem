// The one parser for a memory id argument: "123" or "m123", nothing else.
// parseInt used to read "1abc" and "1.9" as #1 and "m12x" as #12, so a typo
// forgot or pinned a different memory. Returns null for anything malformed.
export function parseMemoryId(id) {
  const match = /^m?(\d+)$/.exec(String(id ?? ''));
  const value = match ? Number(match[1]) : null;
  return Number.isSafeInteger(value) ? value : null;
}
