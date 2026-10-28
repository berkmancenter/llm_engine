import express from 'express'
import validate from '../../middlewares/validate.js'
import organizerConfirmationValidation from '../../validations/organizerConfirmation.validation.js'
import { organizerConfirmationController } from '../../controllers/index.js'
import { organizerConfirmationLimiter } from '../../middlewares/rateLimiter.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: OrganizerConfirmation
 *   description: >
 *     Confirms a Zoom-relayed calendar invite's resolved organizer. Zoom's own Reply-To header is
 *     never verified to belong to who it claims, so a conversation created from one stays a
 *     draft (and never auto-starts) until the resolved organizer clicks through from their inbox.
 */

/**
 * @swagger
 * /organizer-confirmation:
 *   get:
 *     summary: Validate an organizer-confirmation link
 *     description: >
 *       Public. Does not consume the token — mail scanners (Proofpoint, Safe Links) pre-fetch
 *       emailed links with a GET, so this path must be safe to repeat; only the confirm POST
 *       below actually activates the event.
 *     tags: [OrganizerConfirmation]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         description: Confirmation token from the emailed link
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Conversation summary and a one-time nonce
 *       410:
 *         description: Confirmation link is invalid or has expired
 *       400:
 *         description: Token missing
 */
router.get(
  '/',
  organizerConfirmationLimiter,
  validate(organizerConfirmationValidation.getConfirmation),
  organizerConfirmationController.getConfirmation
)

/**
 * @swagger
 * /organizer-confirmation/confirm:
 *   post:
 *     summary: Confirm the organizer and activate the event
 *     description: >
 *       Public. Burns the single-use confirmation token. Requires both the token and the nonce
 *       issued by the validate GET, so a token skimmed from a log or scanner queue cannot
 *       complete the flow on its own.
 *     tags: [OrganizerConfirmation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - nonce
 *             properties:
 *               token:
 *                 type: string
 *               nonce:
 *                 type: string
 *     responses:
 *       200:
 *         description: Organizer confirmed
 *       403:
 *         description: Nonce is missing, wrong, or expired — fetch a fresh one and retry
 *       410:
 *         description: Confirmation link is invalid or has expired
 *       400:
 *         description: Token or nonce missing
 */
router.post(
  '/confirm',
  organizerConfirmationLimiter,
  validate(organizerConfirmationValidation.confirmOrganizer),
  organizerConfirmationController.confirmOrganizer
)

export default router
