import express from 'express'
import auth from '../../../middlewares/auth.js'
import pollsController from '../../../controllers/poll.controller/index.js'
import pollValidation from '../../../validations/poll.validation/index.js'
import validate from '../../../middlewares/validate.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Poll
 *   description: Interact with application Polls
 */

/**
 * @swagger
 * /polls:
 *   post:
 *     summary: Create a new poll
 *     description: Create a new poll with configurable options for voting, visibility, and results display
 *     tags: [Poll]
 *     operationId: createPoll
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - topicId
 *             properties:
 *               title:
 *                 type: string
 *                 description: The title of the poll
 *                 example: "Where should we go to lunch?"
 *               description:
 *                 type: string
 *                 description: Detailed description of the poll
 *                 example: "This is a poll to decide where we should go to lunch"
 *               topicId:
 *                 type: string
 *                 description: ID of the topic this poll belongs to
 *                 example: "6733fe79ca20209f1fa02168"
 *               choices:
 *                 type: array
 *                 description: Predefined choices for the poll
 *                 items:
 *                   type: object
 *                   required:
 *                     - text
 *                   properties:
 *                     text:
 *                       type: string
 *                       example: "Pizza Place"
 *                 example:
 *                   - text: "Pizza Place"
 *                   - text: "Burger Joint"
 *                   - text: "Sushi Restaurant"
 *               multiSelect:
 *                 type: boolean
 *                 description: Whether users can select multiple choices
 *                 default: false
 *                 example: false
 *               allowNewChoices:
 *                 type: boolean
 *                 description: Whether users can add new choices
 *                 default: false
 *                 example: true
 *               choicesVisible:
 *                 type: boolean
 *                 description: Whether choices are visible to users
 *                 default: true
 *                 example: true
 *               responsesVisible:
 *                 type: boolean
 *                 description: Whether individual responses are visible
 *                 default: true
 *                 example: true
 *               responseCountsVisible:
 *                 type: boolean
 *                 description: Whether response counts are visible
 *                 default: true
 *                 example: true
 *               responsesVisibleToNonParticipants:
 *                 type: boolean
 *                 description: Whether responses are visible to non-participants
 *                 default: false
 *                 example: false
 *               onlyOwnChoicesVisible:
 *                 type: boolean
 *                 description: Whether users can only see results for choices they selected
 *                 default: false
 *                 example: false
 *               threshold:
 *                 type: number
 *                 description: Minimum number of responses before results become visible
 *                 example: 10
 *               expirationDate:
 *                 type: string
 *                 format: date
 *                 description: When the poll expires (ISO date format)
 *                 example: "2024-11-20"
 *               whenResultsVisible:
 *                 type: string
 *                 enum: [always, thresholdOnly, expirationOnly, thresholdAndExpiration]
 *                 description: When poll results become visible
 *                 example: "thresholdAndExpiration"
 *           examples:
 *             singleSelectClosedPoll:
 *               summary: Single select closed poll
 *               value:
 *                 title: "Single select closed poll"
 *                 description: "Poll description here"
 *                 topicId: "{{defaultTopic}}"
 *                 allowNewChoices: false
 *                 multiSelect: false
 *                 choicesVisible: true
 *                 threshold: 10
 *                 expirationDate: "2024-11-20"
 *                 choices:
 *                   - text: "Choice 1"
 *                   - text: "Choice 2"
 *                   - text: "Choice 3"
 *             multiSelectOpenPoll:
 *               summary: Multi-select open poll
 *               value:
 *                 title: "Multiselect open poll"
 *                 description: "Poll description here"
 *                 topicId: "{{defaultTopic}}"
 *                 allowNewChoices: true
 *                 multiSelect: true
 *                 choicesVisible: true
 *                 threshold: 10
 *                 expirationDate: "2024-11-20"
 *             hiddenChoicesPoll:
 *               summary: Poll with hidden choices
 *               value:
 *                 title: "My poll"
 *                 description: "Poll description here"
 *                 topicId: "{{defaultTopic}}"
 *                 allowNewChoices: true
 *                 multiSelect: true
 *                 choicesVisible: false
 *                 threshold: 10
 *                 expirationDate: "2024-11-20"
 *             visibleResponseCountPoll:
 *               summary: Poll with visible response counts
 *               value:
 *                 title: "Vote count visible poll"
 *                 description: "Poll description here"
 *                 topicId: "{{defaultTopic}}"
 *                 allowNewChoices: false
 *                 multiSelect: false
 *                 choicesVisible: true
 *                 responseCountsVisible: true
 *                 threshold: 10
 *                 expirationDate: "2024-11-20"
 *                 choices:
 *                   - text: "Choice 1"
 *                   - text: "Choice 2"
 *                   - text: "Choice 3"
 *     responses:
 *       '201':
 *         description: Poll created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Poll'
 *       '400':
 *         description: Invalid or unsupported poll request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/').post(auth('createPoll'), validate(pollValidation.createPoll), pollsController.createPoll)

/**
 * @swagger
 * /polls:
 *   get:
 *     summary: List polls
 *     description: Retrieve a list of polls with optional filtering and sorting
 *     tags: [Poll]
 *     operationId: listPolls
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: allowNewChoices
 *         in: query
 *         description: Filter polls by whether new choices are allowed
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *           example: 'true'
 *       - name: multiSelect
 *         in: query
 *         description: Filter polls by multi-select capability
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *           example: 'false'
 *       - name: choicesVisible
 *         in: query
 *         description: Filter polls by choice visibility
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *           example: 'true'
 *       - name: responseCountsVisible
 *         in: query
 *         description: Filter polls by response count visibility
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *           example: 'true'
 *       - name: _sort
 *         in: query
 *         description: Sort field and direction (prefix with '-' for descending)
 *         schema:
 *           type: string
 *           example: '-createdAt'
 *         examples:
 *           createdAtDesc:
 *             summary: Sort by creation date (newest first)
 *             value: '-createdAt'
 *           updatedAtAsc:
 *             summary: Sort by update date (oldest first)
 *             value: 'updatedAt'
 *           titleAsc:
 *             summary: Sort by title alphabetically
 *             value: 'title'
 *     responses:
 *       '200':
 *         description: List of polls retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Poll'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/').get(auth('listPolls'), pollsController.listPolls)

/**
 * @swagger
 * /polls/{pollId}:
 *   get:
 *     summary: Inspect a poll
 *     description: Get detailed information about a specific poll, including choices and user's selections
 *     tags: [Poll]
 *     operationId: inspectPoll
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: pollId
 *         in: path
 *         required: true
 *         description: ID of the poll to inspect
 *         schema:
 *           type: string
 *           example: "6750a665664156091cdf5a31"
 *     responses:
 *       '200':
 *         description: Poll details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Poll'
 *                 - type: object
 *                   properties:
 *                     choices:
 *                       type: array
 *                       description: Available choices for the poll (if visible)
 *                       items:
 *                         allOf:
 *                           - $ref: '#/components/schemas/PollChoice'
 *                           - type: object
 *                             properties:
 *                               isSelected:
 *                                 type: boolean
 *                                 description: Whether the current user has selected this choice
 *                                 example: true
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:pollId').get(auth('inspectPoll'), pollsController.inspectPoll)

/**
 * @swagger
 * /polls/{pollId}/respond:
 *   post:
 *     summary: Respond to a poll
 *     description: Submit a response to a poll by selecting or adding a choice
 *     tags: [Poll]
 *     operationId: respondToPoll
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: pollId
 *         in: path
 *         required: true
 *         description: ID of the poll to respond to
 *         schema:
 *           type: string
 *           example: "6750a665664156091cdf5a31"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - choice
 *             properties:
 *               choice:
 *                 type: object
 *                 required:
 *                   - text
 *                 properties:
 *                   text:
 *                     type: string
 *                     description: The choice text (existing or new)
 *                     example: "Pizza Place"
 *                   remove:
 *                     type: boolean
 *                     description: Set to true to remove this choice from your responses
 *                     default: false
 *                     example: false
 *           examples:
 *             respondToPoll:
 *               summary: Submit a poll response
 *               value:
 *                 choice:
 *                   text: "Pizza Place"
 *             removeResponse:
 *               summary: Remove a poll response (before expiration)
 *               value:
 *                 choice:
 *                   text: "Pizza Place"
 *                   remove: true
 *             addNewChoice:
 *               summary: Add and select a new choice
 *               value:
 *                 choice:
 *                   text: "New Restaurant Option"
 *     responses:
 *       '200':
 *         description: Poll response submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PollResponse'
 *       '400':
 *         description: Invalid or unsupported poll request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:pollId/respond').post(auth('respondPoll'), validate(pollValidation.respondPoll), pollsController.respondPoll)

/**
 * @swagger
 * /polls/{pollId}/responses:
 *   get:
 *     summary: Get poll responses
 *     description: Retrieve individual poll responses if allowed by poll settings and visibility rules
 *     tags: [Poll]
 *     operationId: getPollResponses
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: pollId
 *         in: path
 *         required: true
 *         description: ID of the poll to get responses for
 *         schema:
 *           type: string
 *           example: "6750a665664156091cdf5a31"
 *     responses:
 *       '200':
 *         description: Poll responses retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                     description: Response ID
 *                     example: "61b0ffca7d4eb20ee9dcfe8e"
 *                   owner:
 *                     type: string
 *                     description: Username of the person who responded
 *                     example: "john_doe"
 *                   choice:
 *                     type: string
 *                     description: The choice text that was selected
 *                     example: "Pizza Place"
 *                   poll:
 *                     type: string
 *                     description: Poll ID
 *                     example: "6750a665664156091cdf5a31"
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:pollId/responses').get(auth('getPollResponses'), pollsController.getPollResponses)

/**
 * @swagger
 * /polls/{pollId}/responseCounts:
 *   get:
 *     summary: Get poll response counts
 *     description: Retrieve aggregated response counts for poll choices if allowed by poll settings
 *     tags: [Poll]
 *     operationId: getPollResponseCounts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: pollId
 *         in: path
 *         required: true
 *         description: ID of the poll to get response counts for
 *         schema:
 *           type: string
 *           example: "6750a665664156091cdf5a31"
 *     responses:
 *       '200':
 *         description: Poll response counts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: number
 *               description: Map of choice text to response count
 *               example:
 *                 "Pizza Place": 15
 *                 "Burger Joint": 8
 *                 "Sushi Restaurant": 12
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:pollId/responseCounts').get(auth('getPollResponseCounts'), pollsController.getPollResponseCounts)

export default router
