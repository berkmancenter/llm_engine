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

export default router
