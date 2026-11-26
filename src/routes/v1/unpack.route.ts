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
 *       participant can start a limited number of new explanations per minute; answers from the saved copy
 *       don't count.
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
 *       posts nothing new and returns the existing card's message ID. A locked event refuses the send with
 *       eventLocked. If the card can't be posted for another reason, the request fails and can be sent again.
 *       A send that has to start a new explanation counts toward the same per-minute limit as a preview. Only
 *       `privateChat` is accepted: Group Chat posts start from a Private Chat card, through the share call.
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

/**
 * @swagger
 * /unpack/{conversationId}/share:
 *   post:
 *     summary: Share a Private Chat explanation card to Group Chat
 *     description: >
 *       Posts a copy of one of the participant's own `unpack_explanation` cards from Private Chat to Group Chat,
 *       as the participant's own message under their pseudonym (`fromAgent` is false). The copy is the card as
 *       the participant saw it, with `destination: groupChat` and a `footer` saying the explanation came from the
 *       assistant. Agents don't evaluate or answer it. If a moderator has hidden the participant, the post is
 *       hidden from the room like their other messages, the participant still sees it, and it doesn't stop
 *       anyone else posting the passage. Clearing the transcript deletes these posts, and open clients get a
 *       `message:deleted` event with their IDs. Group Chat never gets two posts about the same
 *       transcript: if a post already covers any chunk of this passage, nothing is posted, the answer is
 *       `status: alreadyPosted` with that post's message ID and the `text` to show. If that post is still being
 *       made, the call waits for it, and answers unpackFailed (503) if it isn't done in 10 seconds. Every 202
 *       answer is also saved on the participant's card as `groupChatShare`. Sharing a card that was
 *       already posted from the same card answers `status: sent` with the existing post's ID. Each participant
 *       can post to Group Chat once every 2 minutes per event, counted from their last post that went
 *       through; an alreadyPosted answer doesn't count. A share during the pre-event window, when participants
 *       can join before the event starts, is refused with eventNotStarted, and a share after the event ends is
 *       refused with eventEnded.
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
 *               - $ref: '#/components/schemas/UnpackTranscriptPasscode'
 *               - type: object
 *                 required:
 *                   - messageId
 *                 properties:
 *                   messageId:
 *                     type: string
 *                     description: ID of the participant's Private Chat `unpack_explanation` card.
 *                   chatPasscode:
 *                     type: string
 *                     description: >-
 *                       The Group Chat channel's passcode, the same one the client uses to read Group Chat.
 *                       Required when Group Chat has one, which it does by default. A missing or wrong
 *                       passcode is refused with 400 and reason wrongPasscode.
 *     responses:
 *       202:
 *         description: The card was posted to Group Chat, or a post about the same passage already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnpackShareResult'
 *       400:
 *         $ref: '#/components/responses/UnpackRefused'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/UnpackRefused'
 *       404:
 *         $ref: '#/components/responses/UnpackRefused'
 *       409:
 *         $ref: '#/components/responses/UnpackRefused'
 *       429:
 *         $ref: '#/components/responses/UnpackRefused'
 *       503:
 *         $ref: '#/components/responses/UnpackRefused'
 */
router
  .route('/:conversationId/share')
  .post(auth('createMessage'), validate(unpackValidation.sharePassage), unpackController.sharePassage)

export default router
