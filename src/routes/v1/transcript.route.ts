import express from 'express'
import { transcriptController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'

const router = express.Router()

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
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId').get(auth('getTranscript'), transcriptController.getTranscript)

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
 *     responses:
 *       200:
 *         description: Conversation transcript deleted successfully
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Only conversation or topic owner can delete
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId').delete(auth('deleteTranscript'), transcriptController.deleteTranscript)

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
 *         description: Only conversation or topic owner can pause transcript
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId/pause').post(auth('pauseTranscript'), transcriptController.pauseTranscript)

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
 *         description: Only conversation or topic owner can resume transcript
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId/resume').post(auth('resumeTranscript'), transcriptController.resumeTranscript)

export default router
