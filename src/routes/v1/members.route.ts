import express from 'express'
import multer from 'multer'
import { memberController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import { memberImportLimiter } from '../../middlewares/rateLimiter.js'
import memberValidation from '../../validations/member.validation.js'
import validate from '../../middlewares/validate.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } })

/**
 * @swagger
 * tags:
 *   name: Members
 *   description: Conversation member roster management
 */

/**
 * @swagger
 * /members/{conversationId}/import:
 *   post:
 *     summary: Import a CSV member roster into a conversation
 *     description: >
 *       Admin-only. Parses an uploaded CSV of invited members (first name, last name,
 *       email, bio, interests) entirely in memory — the file is never written to disk.
 *       Re-importing the same file updates existing records by email rather than
 *       duplicating them, and never re-invites anyone.
 *     tags: [Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation the roster belongs to
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: CSV file to import (max 2MB)
 *     responses:
 *       200:
 *         description: Import result with added/updated/skipped/failed counts and per-row errors
 *       400:
 *         description: No file provided, malformed CSV, or an ineligible conversation type
 *       404:
 *         description: Conversation not found
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router
  .route('/:conversationId/import')
  .post(
    memberImportLimiter,
    auth('manageMembers'),
    upload.single('file'),
    validate(memberValidation.importMembers),
    memberController.importMembers
  )

export default router
