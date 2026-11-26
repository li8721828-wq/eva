/** Conservative multilingual estimate shared by chat and requirement requests. */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let asciiWordChars = 0
  let symbols = 0
  for (const char of text) {
    const code = char.codePointAt(0) || 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1
    else if (/[A-Za-z0-9_]/.test(char)) asciiWordChars += 1
    else symbols += 1
  }
  return Math.ceil(cjk * 1.15 + asciiWordChars / 3.6 + symbols / 2.2)
}
