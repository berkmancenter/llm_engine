import express from 'express'
import { conversationsController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import conversationValidation from '../../validations/conversation.validation.js'
import validate from '../../middlewares/validate.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Conversation
 *   description: Conversation management
 */

/**
 * @swagger
 * /conversations:
 *   post:
 *     summary: Create a new conversation
 *     tags:
 *       - Conversation
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name of the conversation
 *               topicId:
 *                 type: string
 *                 description: ID of the parent topic
 *               enableDMs:
 *                 type: boolean
 *                 description: Whether direct messages are enabled
 *               agentTypes:
 *                 type: array
 *                 description: Array of agent types to create for this conversation
 *                 items:
 *                   oneOf:
 *                     - type: string
 *                     - type: object
 *                       properties:
 *                         name:
 *                           type: string
 *                         properties:
 *                           type: object
 *                           description: Properties to set on the Agent (ex. llmPlatform, llmModel)
 *                           additionalProperties: true
 *               adapters:
 *                 type: array
 *                 description: Array of adapter configurations
 *                 items:
 *                   $ref: '#/components/schemas/Adapter'
 *               channels:
 *                 type: array
 *                 description: Array of channel configurations
 *                 items:
 *                   $ref: '#/components/schemas/Channel'
 *               scheduledTime:
 *                 type: string
 *                 format: date-time
 *                 description: When the conversation should start (if scheduled)
 *           examples:
 *             zoomEventAssistant:
 *               summary: Create Zoom eventAssistant conversation
 *               description: Example showing how to create a conversation with Zoom integration and eventAssistant agent
 *               value:
 *                 name: "Where are all the aliens?"
 *                 topicId: "{{topicId}}"
 *                 agentTypes:
 *                   - name: "eventAssistant"
 *                 channels:
 *                   - name: "transcript"
 *                 enableDMs:
 *                   - "agents"
 *                 adapters:
 *                   - type: "zoom"
 *                     config:
 *                       meetingUrl: "{{ZOOM_MEETING_URL}}"
 *                       botName: "Ask Privately"
 *                     dmChannels:
 *                       - direct: true
 *                         agent: "eventAssistant"
 *                         direction: "both"
 *                     audioChannels:
 *                       - name: "transcript"
 *             nextspaceBackChannel:
 *               summary: Create Nextspace backChannel conversation
 *               description: Example showing how to create a scheduled conversation with multiple agents (with custom properties) and channels for backchannel insights
 *               value:
 *                 name: "Cutting Through the Hype Cloud: The Deeper Questions We Need to Ask About AI"
 *                 topicId: "{{topicId}}"
 *                 agentTypes:
 *                   - name: "backChannelMetrics"
 *                     properties:
 *                       agentConfig:
 *                         reportingThreshold: 1
 *                   - name: "backChannelInsights"
 *                     properties:
 *                       agentConfig:
 *                         reportingThreshold: 2
 *                         maxInsights: 3
 *                       triggers:
 *                         periodic:
 *                           timerPeriod: 300
 *                 channels:
 *                   - name: "moderator"
 *                   - name: "participant"
 *                   - name: "transcript"
 *                 enableDMs:
 *                   - "agents"
 *                 adapters:
 *                   - type: "zoom"
 *                     config:
 *                       meetingUrl: "{{ZOOM_MEETING_URL}}"
 *                       botName: "Backchannel"
 *                     audioChannels:
 *                       - name: "transcript"
 *                 scheduledTime: "2025-09-10T16:20:00Z"
 *     responses:
 *       201:
 *         description: Conversation created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       400:
 *         description: Bad request - missing required fields or invalid topic
 *       403:
 *         description: Forbidden - conversation creation not allowed
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/').post(auth('createConversation'), conversationsController.createConversation)

/**
 * @swagger
 * /conversations/from-type:
 *   post:
 *     summary: Create a conversation from a conversation type
 *     description: Create a conversation using a predefined conversation type specification. This simplifies conversation creation by requiring only high-level parameters while the type handles internal configuration.
 *     tags:
 *       - Conversation
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - name
 *               - platforms
 *               - topicId
 *             properties:
 *               type:
 *                 type: string
 *                 description: Name of the conversation type (e.g., 'eventAssistant')
 *                 example: eventAssistant
 *               name:
 *                 type: string
 *                 description: Name of the conversation
 *                 example: "Tech Conference Q&A"
 *               platforms:
 *                 type: array
 *                 description: Array of platforms to use for adapters (e.g., ['zoom'], ['zoom', 'nextspace'])
 *                 items:
 *                   type: string
 *                 example: ["zoom"]
 *               topicId:
 *                 type: string
 *                 description: ID of the parent topic
 *                 example: "507f1f77bcf86cd799439011"
 *               properties:
 *                 type: object
 *                 description: Type-specific properties as defined by the conversation type
 *                 additionalProperties: true
 *                 example:
 *                   zoomMeetingUrl: "https://zoom.us/j/123456789"
 *                   botName: "Conference Assistant"
 *                   llmModel:
 *                     name: "gpt-4"
 *                     platform: "openai"
 *               scheduledTime:
 *                 type: string
 *                 format: date-time
 *                 description: When the conversation should start (if scheduled)
 *                 example: "2025-11-01T10:00:00Z"
 *           examples:
 *             eventAssistantZoom:
 *               summary: Create event assistant with Zoom
 *               description: Create an eventAssistant conversation with Zoom integration
 *               value:
 *                 type: "eventAssistant"
 *                 name: "Tech Conference Q&A"
 *                 platforms: ["zoom"]
 *                 topicId: "507f1f77bcf86cd799439011"
 *                 properties:
 *                   zoomMeetingUrl: "https://zoom.us/j/123456789"
 *                   botName: "Ask Privately"
 *                   llmModel:
 *                     name: "gpt-4"
 *                     platform: "openai"
 *             eventAssistantMultiplePlatforms:
 *               summary: Create event assistant with multiple platforms
 *               description: Create an eventAssistant conversation with multiple platform integrations
 *               value:
 *                 type: "eventAssistant"
 *                 name: "Multi-Platform Conference"
 *                 platforms: ["zoom", "default"]
 *                 topicId: "507f1f77bcf86cd799439011"
 *                 properties:
 *                   zoomMeetingUrl: "https://zoom.us/j/123456789"
 *             eventAssistantScheduled:
 *               summary: Create scheduled event assistant
 *               description: Create a scheduled eventAssistant conversation
 *               value:
 *                 type: "eventAssistant"
 *                 name: "Tomorrow's Panel Discussion"
 *                 platforms: ["zoom"]
 *                 topicId: "507f1f77bcf86cd799439011"
 *                 properties:
 *                   zoomMeetingUrl: "https://zoom.us/j/987654321"
 *                 scheduledTime: "2025-11-01T14:00:00Z"
 *     responses:
 *       201:
 *         description: Conversation created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       400:
 *         description: Bad request - missing required fields, invalid properties, or unsupported platform
 *       403:
 *         description: Forbidden - conversation creation not allowed
 *       404:
 *         description: Conversation type not found
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/from-type').post(auth('createConversation'), conversationsController.createConversationFromType)

/**
 * @swagger
 * /conversations:
 *   get:
 *     summary: Get all public conversations
 *     description: Returns all conversations from non-deleted topics
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Public conversations array
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Conversation'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/').get(auth('publicConversations'), conversationsController.allPublic)

/**
 * @swagger
 * /conversations/userConversations:
 *   get:
 *     summary: Get user's conversations
 *     description: Returns all conversations owned by or followed by the logged-in user
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User conversations array
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                  $ref: '#/components/schemas/Conversation'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/userConversations').get(auth('userConversations'), conversationsController.userConversations)

/**
 * @swagger
 * /conversations/active:
 *   get:
 *     summary: Get active conversations
 *     description: Returns all currently active conversations from non-deleted topics
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active conversations array
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Conversation'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/active').get(auth('activeConversations'), conversationsController.activeConversations)

/**
 * @swagger
 * /conversations/{conversationId}:
 *   get:
 *     summary: Get a specific conversation
 *     description: Returns detailed information about a conversation including agents and channels
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to retrieve
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Conversation details
 *         content:
 *           application/json:
 *             schema:
 *                 $ref: '#/components/schemas/Conversation'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId').get(auth('getConversation'), conversationsController.getConversation)

/**
 * @swagger
 * /conversations/{conversationId}/agent/{agentId}:
 *   patch:
 *     summary: Update conversation agent
 *     description: Patch/update a specific agent within a conversation
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation
 *         schema:
 *           type: string
 *       - in: path
 *         name: agentId
 *         required: true
 *         description: ID of the agent to update
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Agent properties to update
 *             additionalProperties: true
 *     responses:
 *       200:
 *         description: Agent updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Agent'
 *       404:
 *         description: Conversation or agent not found
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router
  .route('/:conversationId/agent/:agentId')
  .patch(
    auth('patchConversationAgent'),
    validate(conversationValidation.patchConversationAgent),
    conversationsController.patchConversationAgent
  )

/**
 * @swagger
 * /conversations/{conversationId}/start:
 *   post:
 *     summary: Start a conversation
 *     description: Starts a conversation, activating all associated agents and adapters
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to start
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Conversation started successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Only conversation or topic owner can start conversation
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId/start').post(auth('startConversation'), conversationsController.startConversation)

/**
 * @swagger
 * /conversations/{conversationId}/stop:
 *   post:
 *     summary: Stop a conversation
 *     description: Stops a conversation, deactivating all associated agents and adapters
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to stop
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Conversation stopped successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Only conversation or topic owner can stop conversation
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId/stop').post(auth('stopConversation'), conversationsController.stopConversation)

/**
 * @swagger
 * /conversations/{conversationId}/join:
 *   post:
 *     description: Join conversation as participant and create direct message channels with agents if enabled
 *     tags: [Conversation]
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to join
 *         schema:
 *           type: string
 *     produces:
 *      - application/json
 *     responses:
 *       200:
 *         description: Updated conversation with participant's direct message channels
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               $ref: '#/components/schemas/Conversation'
 *       404:
 *         description: Conversation not found
 *       401:
 *         description: Unauthorized
 */
router.route('/:conversationId/join').post(auth('joinConversation'), conversationsController.joinConversation)
/**
 * @swagger
 * /conversations/topic/{topicId}:
 *   get:
 *     summary: Get conversations by topic
 *     description: Returns all conversations for a specific topic
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: topicId
 *         required: true
 *         description: ID of the parent topic
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Topic conversations array
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Conversation'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/topic/:topicId').get(auth('topicConversations'), conversationsController.getTopicConversations)

/**
 * @swagger
 * /conversations/follow:
 *   post:
 *     summary: Follow or unfollow a conversation
 *     description: Add or remove the user as a follower of a conversation
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *               - conversationId
 *             properties:
 *               status:
 *                 type: boolean
 *                 description: True to follow, false to unfollow
 *               conversationId:
 *                 type: string
 *                 description: ID of the conversation to follow/unfollow
 *     responses:
 *       200:
 *         description: Follow status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: string
 *               example: "ok"
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/follow').post(auth('followConversation'), conversationsController.follow)

/**
 * @swagger
 * /conversations:
 *   put:
 *     summary: Update a conversation
 *     description: Update conversation properties
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *               $ref: '#/components/schemas/Conversation'
 *
 *     responses:
 *       200:
 *         description: Conversation updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Conversation'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Only conversation or topic owner can update
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router
  .route('/')
  .put(
    auth('updateConversation'),
    validate(conversationValidation.updateConversation),
    conversationsController.updateConversation
  )

/**
 * @swagger
 * /conversations/{conversationId}:
 *   delete:
 *     summary: Delete a conversation
 *     description: Delete a conversation and all associated data (messages, agents, adapters, channels)
 *     tags: [Conversation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation to delete
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Conversation deleted successfully
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       403:
 *         description: Only conversation or topic owner can delete
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/:conversationId').delete(auth('deleteConversation'), conversationsController.deleteConversation)

export default router
