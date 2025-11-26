const waitFor = async (callback, timeout = 5000) => {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      return await callback() // Condition met
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50)) // Wait a bit
    }
  }

  throw new Error('Timeout exceeded')
}

export default waitFor
