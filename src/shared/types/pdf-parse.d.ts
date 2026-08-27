declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
  }

  function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>
  export = pdfParse
}
