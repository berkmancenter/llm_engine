import express from 'express'
import { configController } from '../../controllers/index.js'

const router = express.Router()
/**
 * @swagger
 * tags:
 *   name: Config
 *   description: Configuration management
 */

/**
 * @swagger
 * /config:
 *   get:
 *     summary: Get a subset of configuration properties, including available agent types and LLM Platforms
 *     tags: [Config]
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 */
router.route('/').get(configController.getConfig)
export default router
