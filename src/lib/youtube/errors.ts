/** Thrown for anything that should reach the model as a readable tool error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Timing-safe compare, so a shared secret can't be guessed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
