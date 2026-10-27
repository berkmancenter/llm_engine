import logger from '../../config/logger.js'
import organizerConfirmationService from '../../services/eventSetup/organizerConfirmation.service.js'

const expireUnconfirmedConversations = async () => {
  try {
    await organizerConfirmationService.expireUnconfirmedConversations()
  } catch (err) {
    logger.error('Error occurred expiring unconfirmed Zoom-relayed conversations', err)
  }
}

const organizerConfirmationHandlers = {
  expireUnconfirmedConversations
}
export default organizerConfirmationHandlers
