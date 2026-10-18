// PostgreSQL JSON rejects NUL and unpaired UTF-16 surrogates. Both hosts reject
// them at the shared boundary while preserving valid emoji and other Unicode.
export function storableText(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code !== 0 && (code < 0xd800 || code > 0xdfff);
  });
}
export const unicodeMessage = "Expected PostgreSQL-compatible Unicode text";
