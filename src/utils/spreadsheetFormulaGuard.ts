/* Excel/Sheets treats a cell value starting with =, +, -, or @ as a formula — the classic
   "CSV injection" vector. Prefixing with a single quote is the standard mitigation: it
   forces the cell to render as literal text.

   This is applied only when re-exporting data as a spreadsheet/CSV, never at import or
   storage time — guarding on import would corrupt a real name or bio that legitimately
   starts with one of these characters. No export path exists yet in this codebase (the
   only prior CSV-export code, src/services/export.service.ts.unused, is disabled and
   never guarded this), so this ships ready and tested for the future export/invite work
   that will need it. */
const FORMULA_PREFIX_CHARS = new Set(['=', '+', '-', '@'])

const guardFormulaInjection = (value: string): string => {
  if (!value) return value
  return FORMULA_PREFIX_CHARS.has(value[0]) ? `'${value}` : value
}

export default guardFormulaInjection
