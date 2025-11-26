import express from 'express'
import { experimentController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import experimentValidation from '../../validations/experiment.validation.js'
import validate from '../../middlewares/validate.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Experiment
 *   description: Experiment management and execution
 */

/**
 * @swagger
 * /experiments:
 *   post:
 *     summary: Create a new experiment
 *     description: Creates a new experiment based on a base conversation with optional agent modifications
 *     tags: [Experiment]
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
 *               - description
 *               - baseConversation
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name of the experiment
 *                 example: "Agent Response Time Test"
 *               description:
 *                 type: string
 *                 description: Description of what the experiment is testing
 *                 example: "Testing how agents respond under different configurations"
 *               baseConversation:
 *                 type: string
 *                 description: ID of the base conversation to use for the experiment
 *                 example: "6123456789abcdef0123456b"
 *               agentModifications:
 *                 type: array
 *                 description: Array of agent modifications for the experiment
 *                 items:
 *                   $ref: '#/components/schemas/AgentModification'
 *               executedAt:
 *                 type: string
 *                 format: date-time
 *                 description: If provided, marks this as a past experiment (cannot be used with agentModifications)
 *                 example: "2021-11-30T01:51:01.639Z"
 *     responses:
 *       201:
 *         description: Experiment created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Experiment'
 *       400:
 *         description: Bad request - Invalid input data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               baseConversationNotFound:
 *                 value:
 *                   code: 400
 *                   message: "Base conversation not found"
 *               agentNotFound:
 *                 value:
 *                   code: 400
 *                   message: "Agent {agentId} not found in base conversation"
 *               conflictingParams:
 *                 value:
 *                   code: 400
 *                   message: "Cannot provide agent modifications for past experiment"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router
  .route('/')
  .post(auth('createExperiment'), validate(experimentValidation.createExperiment), experimentController.createExperiment)

/**
 * @swagger
 * /experiments/{experimentId}/run:
 *   post:
 *     summary: Run an experiment
 *     description: Executes an experiment by running the configured agent modifications against the base conversation
 *     tags: [Experiment]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: experimentId
 *         in: path
 *         required: true
 *         description: ID of the experiment to run
 *         schema:
 *           type: string
 *           example: "6123456789abcdef0123456a"
 *     responses:
 *       200:
 *         description: Experiment executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Experiment'
 *       400:
 *         description: Bad request - Experiment cannot be run
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               alreadyCompleted:
 *                 value:
 *                   code: 400
 *                   message: "Experiment has already run"
 *               noResultConversation:
 *                 value:
 *                   code: 400
 *                   message: "Experiment does not have a result conversation"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Experiment not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 404
 *               message: "Experiment not found"
 */
router.route('/:experimentId/run').post(auth('runExperiment'), experimentController.runExperiment)

/**
 * @swagger
 * /experiments/{experimentId}:
 *   get:
 *     summary: Get experiment details
 *     description: Retrieves detailed information about a specific experiment
 *     tags: [Experiment]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: experimentId
 *         in: path
 *         required: true
 *         description: ID of the experiment to retrieve
 *         schema:
 *           type: string
 *           example: "6123456789abcdef0123456a"
 *     responses:
 *       200:
 *         description: Experiment details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Experiment'
 *                 - type: object
 *                   properties:
 *                     resultConversation:
 *                       $ref: '#/components/schemas/Conversation'
 *                     baseConversation:
 *                       $ref: '#/components/schemas/Conversation'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/:experimentId').get(auth('getExperiment'), experimentController.getExperiment)

/**
 * @swagger
 * /experiments/{experimentId}/results:
 *   get:
 *     summary: Generate experiment results report
 *     description: Generates and returns a formatted report of experiment results based on the specified report type
 *     tags: [Experiment]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: experimentId
 *         in: path
 *         required: true
 *         description: ID of the experiment to generate results for
 *         schema:
 *           type: string
 *           example: "6123456789abcdef0123456a"
 *       - name: reportName
 *         in: query
 *         required: true
 *         description: Type of report to generate
 *         schema:
 *           type: string
 *           enum: [periodicResponses, directMessageResponses]
 *           example: "periodicResponses"
 *       - name: format
 *         in: query
 *         required: false
 *         description: Format of the report output
 *         schema:
 *           type: string
 *           enum: [text]
 *           default: text
 *           example: "text"
 *     responses:
 *       200:
 *         description: Report generated successfully
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               description: Formatted experiment report
 *               example: |
 *                 Experiment: Agent Response Time Test
 *                 Description: Testing how agents respond under different configurations
 *
 *                 Agent: Assistant Bot
 *                 Messages: 5
 *                 Participants: 3
 *
 *                 [Detailed report content...]
 *       400:
 *         description: Bad request - Invalid report name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 400
 *               message: "Unknown report name: invalidReport"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Experiment or template not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               experimentNotFound:
 *                 value:
 *                   code: 404
 *                   message: "Experiment not found"
 *               templateNotFound:
 *                 value:
 *                   code: 404
 *                   message: "Template not found: reportName.format.hbs"
 */
router
  .route('/:experimentId/results')
  .get(
    auth('getExperimentResults'),
    validate(experimentValidation.getExperimentResults),
    experimentController.getExperimentResults
  )

export default router
