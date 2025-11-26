import express from 'express'
import { webhookController } from '../../controllers/index.js'
import useAdapter from '../../middlewares/adapter.js'

const router = express.Router()
/**
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Webhook event processing for various adapters
 */

/**
 * @swagger
 * /webhooks/{adapter}:
 *   post:
 *     summary: Process webhook event for specified adapter
 *     description: |
 *       Processes incoming webhook events for various adapters. The adapter type is determined
 *       from the URL path, and the appropriate handler is invoked to process the event.
 *
 *       Supported adapters may include:
 *       - Zoom
 *       - Slack
 *       - Other integration platforms
 *     tags:
 *       - Webhooks
 *     parameters:
 *       - name: adapter
 *         in: path
 *         required: true
 *         description: The adapter type to process the webhook for
 *         schema:
 *           type: string
 *           example: zoom
 *         examples:
 *           zoom:
 *             value: zoom
 *             description: Zoom meeting webhook
 *           slack:
 *             value: slack
 *             description: Slack workspace webhook
 *     requestBody:
 *       description: |
 *         Webhook payload data. The structure varies depending on the adapter type.
 *         Each adapter expects different payload formats based on their respective APIs.
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             description: Dynamic payload structure based on adapter type
 *           examples:
 *             zoom_meeting_started:
 *               summary: Zoom meeting started event
 *               value:
 *                 event: "meeting.started"
 *                 payload:
 *                   account_id: "abc123"
 *                   object:
 *                     uuid: "meeting-uuid-123"
 *                     id: 123456789
 *                     host_id: "host123"
 *                     topic: "Team Meeting"
 *                     start_time: "2023-11-30T10:00:00Z"
 *             slack_message:
 *               summary: Slack message event
 *               value:
 *                 token: "verification-token"
 *                 team_id: "T1234567"
 *                 event:
 *                   type: "message"
 *                   user: "U1234567"
 *                   text: "Hello World"
 *                   channel: "C1234567"
 *                   ts: "1609459200.000100"
 *     responses:
 *       '200':
 *         description: Webhook processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: string
 *               description: "ok"
 *       '400':
 *         description: Invalid or unsupported adapter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 *
 */
router.post('*', useAdapter(), webhookController.processEvent)

export default router
