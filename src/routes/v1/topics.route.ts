import express from 'express'
import { topicController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import validate from '../../middlewares/validate.js'
import topicValidation from '../../validations/topic.validation.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Topic
 *   description: Manage application Topics
 */

/**
 * @swagger
 * /topics:
 *   post:
 *     summary: Create a new topic
 *     description: Create a topic with specified settings. Private topics get an auto-generated passcode.
 *     tags: [Topic]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - private
 *               - archivable
 *               - archiveEmail
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name of the topic
 *                 example: "My Discussion Topic"
 *               votingAllowed:
 *                 type: boolean
 *                 description: Whether voting is allowed on messages in this topic
 *                 default: true
 *               conversationCreationAllowed:
 *                 type: boolean
 *                 description: Whether users can create new conversations in this topic
 *                 default: true
 *               private:
 *                 type: boolean
 *                 description: Whether the topic is private (requires passcode)
 *                 example: false
 *               archivable:
 *                 type: boolean
 *                 description: Whether the topic can be archived
 *                 example: true
 *               archiveEmail:
 *                 type: string
 *                 format: email
 *                 description: Email address for archive notifications
 *                 example: "admin@example.com"
 *     responses:
 *       201:
 *         description: Topic created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       400:
 *         $ref: '#/components/responses/DuplicateEmail'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.route('/').post(auth('createTopic'), validate(topicValidation.createTopic), topicController.createTopic)

/**
 * @swagger
 * /topics:
 *   put:
 *     summary: Update an existing topic
 *     description: Update topic settings and properties
 *     tags: [Topic]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/Topic'
 *               - type: object
 *                 required:
 *                   - id
 *     responses:
 *       200:
 *         description: Topic updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Topic'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/').put(auth('updateTopic'), validate(topicValidation.updateTopic), topicController.updateTopic)

/**
 * @swagger
 * /topics:
 *   get:
 *     summary: Get all topics accessible to the user
 *     description: Returns all topics that the user owns or has access to (excluding private topics owned by others)
 *     tags: [Topic]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of topics with sorting data
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Topic'
 *
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/').get(auth('allTopics'), topicController.allTopics)

/**
 * @swagger
 * /topics/userTopics:
 *   get:
 *     summary: Get topics owned or followed by the current user
 *     description: Returns topics owned by the user or topics they follow, sorted by activity
 *     tags: [Topic]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user's topics with activity data
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Topic'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/userTopics').get(auth('userTopics'), topicController.userTopics)

/**
 * @swagger
 * /topics/public/{token}:
 *   get:
 *     summary: Get top 10 public topics (no authentication required)
 *     description: Returns the top 10 public topics sorted by activity. Requires a valid conversation token.
 *     tags: [Topic]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         description: Valid conversation token
 *         schema:
 *           type: string
 *           example: "b019d20aa74a16c8c68701cc2937c8a76bc6cdc6247d51cf80bb3d1f27f6ac3f"
 *     responses:
 *       200:
 *         description: Top 10 public topics
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               maxItems: 10
 *               items:
 *                 $ref: '#/components/schemas/Topic'
 *       400:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 400
 *               message: "Invalid or expired login token. Please log in again."
 */
router.route('/public/:token').get(topicController.publicTopics)

/**
 * @swagger
 * /topics/{topicId}:
 *   get:
 *     summary: Get a specific topic by ID
 *     description: Retrieve detailed information about a topic including followers
 *     tags: [Topic]
 *     parameters:
 *       - in: path
 *         name: topicId
 *         required: true
 *         description: ID of the topic to retrieve
 *         schema:
 *           type: string
 *           example: "61b7ea6aa771004e80ed4409"
 *     responses:
 *       200:
 *         description: Topic details
 *         content:
 *           application/json:
 *             schema:
 *                 $ref: '#/components/schemas/Topic'
 *
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:topicId').get(topicController.getTopic)

/**
 * @swagger
 * /topics/{topicId}:
 *   delete:
 *     summary: Soft delete a topic
 *     description: Mark a topic as deleted (soft delete). The topic will no longer be visible but data is preserved.
 *     tags: [Topic]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: topicId
 *         required: true
 *         description: ID of the topic to delete
 *         schema:
 *           type: string
 *           example: "61b7ea6aa771004e80ed4409"
 *     responses:
 *       200:
 *         description: Topic deleted successfully
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:topicId').delete(auth('deleteTopic'), topicController.deleteTopic)

/**
 * @swagger
 * /topics/auth:
 *   post:
 *     summary: Authenticate access to a private topic
 *     description: Verify the passcode for a private topic to gain access
 *     tags: [Topic]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - topicId
 *               - passcode
 *             properties:
 *               topicId:
 *                 type: string
 *                 description: ID of the private topic
 *                 example: "61b7ea6aa771004e80ed4409"
 *               passcode:
 *                 type: string
 *                 description: Passcode for the private topic
 *                 example: "1234567"
 *     responses:
 *       200:
 *         description: Passcode verified successfully
 *       401:
 *         description: Invalid passcode
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: "Invalid passcode"
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/auth').post(validate(topicValidation.authenticate), topicController.authenticate)

/**
 * @swagger
 * /topics/archive:
 *   post:
 *     summary: Archive a topic
 *     description: Archive a topic using a valid archive token to prevent it from being automatically deleted
 *     tags: [Topic]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - topicId
 *               - token
 *             properties:
 *               topicId:
 *                 type: string
 *                 description: ID of the topic to archive
 *                 example: "61b7ea6aa771004e80ed4409"
 *               token:
 *                 type: string
 *                 description: Valid archive token (typically sent via email)
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Topic archived successfully
 *       400:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Topic not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 404
 *               message: "Topic not found"
 */
router.route('/archive').post(validate(topicValidation.archiveTopic), topicController.archiveTopic)

/**
 * @swagger
 * /topics/follow:
 *   post:
 *     summary: Follow or unfollow a topic
 *     description: Toggle following status for a topic. Following a topic adds it to the user's topic list.
 *     tags: [Topic]
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
 *               - topicId
 *             properties:
 *               status:
 *                 type: boolean
 *                 description: true to follow, false to unfollow
 *                 example: true
 *               topicId:
 *                 type: string
 *                 description: ID of the topic to follow/unfollow
 *                 example: "61b7ea6aa771004e80ed4409"
 *     responses:
 *       200:
 *         description: Follow status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: string
 *               example: "ok"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/follow').post(auth('followTopic'), topicController.follow)

export default router
