// Preview has its own identity boundary. Never accept caller-supplied identity headers.
export function previewAllowed(expected: string | undefined, access: { aud?: string } | undefined): boolean {
  return typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) && access?.aud === expected;
}
