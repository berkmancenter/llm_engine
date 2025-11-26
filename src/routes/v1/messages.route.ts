import express from 'express'
import { messageController } from '../../controllers/index.js'
import messageValidation from '../../validations/message.validation.js'
import validate from '../../middlewares/validate.js'
import auth from '../../middlewares/auth.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Message
 *   description: Manage application Messages
 */

/**
 * @swagger
 * /messages:
 *   post:
 *     summary: Create a new message
 *     description: Creates a new message in a conversation. The message will be processed by agents if enabled.
 *     tags: [Message]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - body
 *               - conversation
 *             properties:
 *               body:
 *                 type: string
 *                 description: The message content
 *               conversation:
 *                 type: string
 *                 description: ID of the conversation to post the message to
 *               bodyType:
 *                 type: string
 *                 description: Type of message body (optional)
 *                 enum: [text, json]
 *               channels:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     passcode:
 *                       type: string
 *                 description: Channels to post the message to
 *     responses:
 *       201:
 *         description: Message created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       400:
 *         description: Bad request - conversation locked or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       422:
 *         description: Unprocessable Entity - message rejected by agent
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', auth('createMessage'), validate(messageValidation), messageController.createMessage)

/**
 * @swagger
 * /messages/{conversationId}:
 *   get:
 *     summary: Get messages from a conversation
 *     description: Returns all visible messages from a specific conversation, optionally filtered by channels
 *     tags: [Message]
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to get messages from
 *         schema:
 *           type: string
 *       - in: query
 *         name: channel
 *         required: false
 *         description: Channel name and optional passcode (format "channelName,passcode"). Can be specified multiple times for multiple channels.
 *         schema:
 *           oneOf:
 *             - type: string
 *             - type: array
 *               items:
 *                 type: string
 *         example: "general,secretcode"
 *     responses:
 *       200:
 *         description: Array of messages from the conversation
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:conversationId').get(messageController.conversationMessages)

/**
 * @swagger
 * /messages/{messageId}/vote:
 *   post:
 *     summary: Vote on a message
 *     description: Upvote or downvote a message. Users cannot vote on their own messages or vote multiple times on the same message.
 *     tags: [Message]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         description: ID of message to apply vote to
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *               - direction
 *             properties:
 *               status:
 *                 type: boolean
 *                 description: true to add vote, false to remove vote
 *               direction:
 *                 type: string
 *                 enum: [up, down]
 *                 description: Direction of the vote
 *     responses:
 *       200:
 *         description: Message object with updated vote counts
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Message'
 *       400:
 *         description: Bad request - cannot vote on own message, already voted, or message not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.route('/:messageId/vote').post(auth('vote'), messageController.vote)

/**
 * @swagger
 * /messages/{messageId}/replies:
 *   get:
 *     summary: Get replies to a message
 *     description: Returns all visible replies to a specific message, sorted by creation time
 *     tags: [Message]
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         description: ID of the parent message to get replies for
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of reply messages
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:messageId/replies').get(messageController.messageReplies)

export default router
