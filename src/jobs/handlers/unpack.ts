import unpackService from '../../services/unpack.service.js'

/**
 * Finishes a Send that was still pending when it was checked. Safe to re-run: posting claims the ask first,
 * and writing claims the explanation first, so a second run posts and writes nothing new.
 */
const unpackPendingAsk = async (job) => {
  const { askId, attempt = 1 } = job.attrs.data
  await unpackService.finishPendingAsk(askId, attempt)
}

export default { unpackPendingAsk }
