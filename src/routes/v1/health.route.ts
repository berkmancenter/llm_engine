import express from 'express'
import healthController from '../../controllers/health.controller.js'

const router = express.Router()
/**
 * @swagger
 * tags:
 *   name: Health
 *   description: Server health information
 */

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Verfies the server is active
 *     tags: [Health]
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *               status:
 *                 type: string
 *                 description: Always returns OK
 *               timestamp:
 *                 type: date-time
 *                 description: The current time
 *               uptime:
 *                 type: number
 *                 description: The number of seconds the server has been up
 *
 */
router.route('/').get(healthController.checkHealth)

export default router
