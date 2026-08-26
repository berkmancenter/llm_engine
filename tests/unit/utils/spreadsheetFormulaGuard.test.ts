import guardFormulaInjection from '../../../src/utils/spreadsheetFormulaGuard.js'

describe('guardFormulaInjection', () => {
  test.each([['='], ['+'], ['-'], ['@']])('prefixes a value starting with %s with a quote', (prefixChar) => {
    const value = `${prefixChar}cmd|'/c calc'!A1`
    expect(guardFormulaInjection(value)).toBe(`'${value}`)
  })

  test('leaves an ordinary value untouched', () => {
    expect(guardFormulaInjection('Ada Lovelace')).toBe('Ada Lovelace')
  })

  test('leaves a value with a legitimate hyphen further in untouched', () => {
    expect(guardFormulaInjection('Mary Jane-Watson')).toBe('Mary Jane-Watson')
  })

  test('leaves an empty string untouched', () => {
    expect(guardFormulaInjection('')).toBe('')
  })
})
