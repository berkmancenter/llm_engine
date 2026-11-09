import express from 'express'
import auth from '../../middlewares/auth.js'
import validate from '../../middlewares/validate.js'
import unpackValidation from '../../validations/unpack.validation.js'
import { unpackController } from '../../controllers/index.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Unpack
 *   description: Participants ask the event assistant to explain a passage of the live transcript
 */

/**
 * @swagger
 * /unpack/{conversationId}/preview:
 *   post:
 *     summary: Preview an explanation of a transcript passage
 *     description: >
 *       Explains the passage a participant selected and records their ask. The browser sends only chunk IDs and
 *       character positions; the server rebuilds the quote from the saved transcript and widens it to whole
 *       sentences, so people who select roughly the same words share one saved explanation. The first request
 *       for a passage waits for the AI model, up to about 25 seconds before answering unpackFailed; the
 *       explanation is still saved for a retry. Later requests are answered from the saved copy. Each
 *       participant can preview a limited number of different passages per minute.
 *     tags: [Unpack]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/UnpackSelection'
 *               - $ref: '#/components/schemas/UnpackTranscriptPasscode'
 *     responses:
 *       200:
 *         description: The explanation, ready to preview
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnpackPreview'
 *       400:
 *         $ref: '#/components/responses/UnpackRefused'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/UnpackRefused'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/UnpackRefused'
 *       429:
 *         $ref: '#/components/responses/UnpackRefused'
 *       503:
 *         $ref: '#/components/responses/UnpackRefused'
 */
router
  .route('/:conversationId/preview')
  .post(auth('createMessage'), validate(unpackValidation.previewPassage), unpackController.previewPassage)

/**
 * @swagger
 * /unpack/{conversationId}/send:
 *   post:
 *     summary: Send a passage's explanation
 *     description: >
 *       Posts the saved explanation of a passage to the chosen destination as an `unpack_explanation` card from
 *       the event assistant. Works before the preview has finished, or without one: the choice is stored and the
 *       card posts as soon as the explanation is written (`status: pending`). Sending the same passage again
 *       posts nothing new and returns the existing card's message ID. If the card can't be posted, for example
 *       because the event is locked, the request fails and can be sent again. Only `privateChat` is accepted
 *       for now.
 *     tags: [Unpack]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/UnpackSelection'
 *               - $ref: '#/components/schemas/UnpackTranscriptPasscode'
 *               - type: object
 *                 required:
 *                   - destination
 *                 properties:
 *                   destination:
 *                     type: string
 *                     enum: [privateChat]
 *     responses:
 *       202:
 *         description: The card was posted, or will be once the explanation is written
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnpackSendResult'
 *       400:
 *         $ref: '#/components/responses/UnpackRefused'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/UnpackRefused'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/UnpackRefused'
 *       429:
 *         $ref: '#/components/responses/UnpackRefused'
 *       503:
 *         $ref: '#/components/responses/UnpackRefused'
 */
router
  .route('/:conversationId/send')
  .post(auth('createMessage'), validate(unpackValidation.sendPassage), unpackController.sendPassage)

export default router
