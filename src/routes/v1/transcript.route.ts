import express from 'express'
import { transcriptController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'

const router = express.Router()

/*
 * All four controls gate on `getConversation`, a right every participant holds, and leave the
 * real decision to transcriptService. Moderators are ordinary participants whose access comes
 * from the moderator channel's passcode in their link, so a role check at the door would turn
 * every one of them away. The `getTranscript`, `deleteTranscript`, `pauseTranscript` and
 * `resumeTranscript` rights belong to admins alone, and the service reads holding one as
 * "may do this without presenting a passcode".
 */

/**
 * @swagger
 * tags:
 *   name: Transcript
 *   description: Transcript management and control
 */

/**
 * @swagger
 * /transcript/{conversationId}:
 *   get:
 *     summary: Get transcript
 *     description: Returns the transcript for a given conversation. Use Accept header to specify format (text/plain).
 *     tags: [Transcript]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to get transcript from
 *         schema:
 *           type: string
 *       - in: query
 *         name: channel
 *         required: false
 *         description: >
 *           Channel credential as `<name>,<passcode>`. Callers without the admin transcript
 *           rights must present the conversation's moderator channel, e.g. `moderator,ab12cd34`.
 *         schema:
 *           type: string
 *       - in: header
 *         name: Accept
 *         schema:
 *           type: string
 *           example: text/plain
 *         description: Content type requested (currently supports text/plain)
 *     responses:
 *       200:
 *         description: Transcript in requested format
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       406:
 *         description: Requested format not supported
 *       403:
 *         description: Caller holds no transcript right and presented no valid moderator passcode
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId').get(auth('getConversation'), transcriptController.getTranscript)

/**
 * @swagger
 * /transcript/{conversationId}:
 *   delete:
 *     summary: Delete a transcript
 *     description: Delete all associated transcript data (datastore, embeddings, etc.) for a given conversation.
 *     tags: [Transcript]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation with transcript to delete
 *         schema:
 *           type: string
 *       - in: query
 *         name: channel
 *         required: false
 *         description: >
 *           Channel credential as `<name>,<passcode>`. Callers without the admin transcript
 *           rights must present the conversation's moderator channel, e.g. `moderator,ab12cd34`.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Conversation transcript deleted successfully
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Caller holds no transcript right and presented no valid moderator passcode
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId').delete(auth('getConversation'), transcriptController.deleteTranscript)

/**
 * @swagger
 * /transcript/{conversationId}/pause:
 *   post:
 *     summary: Pause a conversation transcript
 *     description: Pauses recording of a transcript
 *     tags: [Transcript]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to pause
 *         schema:
 *           type: string
 *       - in: query
 *         name: channel
 *         required: false
 *         description: >
 *           Channel credential as `<name>,<passcode>`. Callers without the admin transcript
 *           rights must present the conversation's moderator channel, e.g. `moderator,ab12cd34`.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Recording paused successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Caller holds no transcript right and presented no valid moderator passcode
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId/pause').post(auth('getConversation'), transcriptController.pauseTranscript)

/**
 * @swagger
 * /transcript/{conversationId}/resume:
 *   post:
 *     summary: Resume transcription
 *     description: Resumes paused transcription
 *     tags: [Transcript]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation with transcript to resume
 *         schema:
 *           type: string
 *       - in: query
 *         name: channel
 *         required: false
 *         description: >
 *           Channel credential as `<name>,<passcode>`. Callers without the admin transcript
 *           rights must present the conversation's moderator channel, e.g. `moderator,ab12cd34`.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transcript resumed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Caller holds no transcript right and presented no valid moderator passcode
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId/resume').post(auth('getConversation'), transcriptController.resumeTranscript)

export default router
