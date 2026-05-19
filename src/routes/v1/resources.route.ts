import express from 'express'
import multer from 'multer'
import { resourceController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import resourceValidation from '../../validations/resource.validation.js'
import validate from '../../middlewares/validate.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

/**
 * @swagger
 * tags:
 *   name: Resources
 *   description: Conversation resource management
 */

/**
 * @swagger
 * /resources/{conversationId}/{resourceId}/pdf:
 *   post:
 *     summary: Upload a PDF for a resource
 *     description: Uploads a PDF file for an existing conversation resource. The file is stored on disk and indexed into the background vector collection for use as AI context.
 *     tags: [Resources]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation the resource belongs to
 *         schema:
 *           type: string
 *       - in: path
 *         name: resourceId
 *         required: true
 *         description: ID of the resource to attach the PDF to
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - pdf
 *             properties:
 *               pdf:
 *                 type: string
 *                 format: binary
 *                 description: PDF file to upload (max 50MB)
 *     responses:
 *       204:
 *         description: PDF uploaded and indexed successfully
 *       400:
 *         description: No PDF file provided
 *       404:
 *         description: Resource not found in conversation
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router
  .route('/:conversationId/:resourceId/pdf')
  .post(auth('updateConversation'), upload.single('pdf'), validate(resourceValidation.uploadPdf), resourceController.uploadPdf)

export default router
