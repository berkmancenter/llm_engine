import express from 'express'
import { userController } from '../../controllers/index.js'
import userValidation from '../../validations/user.validation.js'
import validate from '../../middlewares/validate.js'
import auth from '../../middlewares/auth.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: User
 *   description: User management and preferences
 */

/**
 * @swagger
 * /users/user/{userId}:
 *   get:
 *     summary: Retrieve a user by ID
 *     description: Get user details. Users can only request their own details.
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: The ID of the user
 *         schema:
 *           type: string
 *           example: "5ebac534954b54139806c112"
 *     responses:
 *       200:
 *         description: User object with reputation status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/user/:userId').get(auth('getUser'), userController.getUser)

/**
 * @swagger
 * /users:
 *   put:
 *     summary: Update user information
 *     description: Update user details including username, password, and email
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 description: ID of the user to update
 *                 example: "5ebac534954b54139806c112"
 *               username:
 *                 type: string
 *                 description: New username
 *                 example: "newusername"
 *               password:
 *                 type: string
 *                 description: New password
 *                 example: "newPassword123"
 *               email:
 *                 type: string
 *                 format: email
 *                 description: New email address
 *                 example: "newemail@example.com"
 *     responses:
 *       200:
 *         description: Updated user object with reputation status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: Username or email already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/', auth('manageAccount'), validate(userValidation.updateUser), userController.updateUser)

/**
 * @swagger
 * /users/pseudonyms:
 *   get:
 *     summary: Get user's pseudonyms
 *     description: Returns all active pseudonyms for the authenticated user
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of user's active pseudonyms
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Pseudonym'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/pseudonyms').get(auth('managePseudonym'), userController.getPseudonyms)

/**
 * @swagger
 * /users/pseudonyms:
 *   post:
 *     summary: Add a new pseudonym
 *     description: Add a new pseudonym for the user and set it as active. Users are limited to 5 pseudonyms maximum.
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - pseudonym
 *             properties:
 *               token:
 *                 type: string
 *                 description: Unique token for the pseudonym
 *                 example: "b019d20aa74a16c8c68701cc2937c8a76bc6cdc6247d51cf80bb3d1f27f6ac3f"
 *               pseudonym:
 *                 type: string
 *                 description: Display name for the pseudonym
 *                 example: "Profound Red Rattlesnake"
 *     responses:
 *       201:
 *         description: Array of user's pseudonyms including the newly created one
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Pseudonym'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         description: Pseudonym limit reached (maximum 5)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.route('/pseudonyms').post(auth('managePseudonym'), userController.addPseudonym)

/**
 * @swagger
 * /users/pseudonyms/activate:
 *   put:
 *     summary: Activate a pseudonym
 *     description: Set a specific pseudonym as active (deactivates all others)
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: Token of the pseudonym to activate
 *                 example: "b019d20aa74a16c8c68701cc2937c8a76bc6cdc6247d51cf80bb3d1f27f6ac3f"
 *     responses:
 *       200:
 *         description: Array of user's pseudonyms with updated active status
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Pseudonym'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         description: Pseudonym not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.route('/pseudonyms/activate').put(auth('managePseudonym'), userController.activatePseudonym)

/**
 * @swagger
 * /users/pseudonyms/{pseudonymId}:
 *   delete:
 *     summary: Delete a pseudonym
 *     description: Delete a pseudonym. If the pseudonym has been used in messages, it will be soft-deleted. Otherwise, it will be hard-deleted.
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pseudonymId
 *         required: true
 *         description: The ID of the pseudonym to delete
 *         schema:
 *           type: string
 *           example: "60a7c8b8f8c9a40015c5e8c3"
 *     responses:
 *       200:
 *         description: Pseudonym deleted successfully
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/pseudonyms/:pseudonymId').delete(auth('managePseudonym'), userController.deletePseudonym)

/**
 * @swagger
 * /users/user/{userId}/preferences/export:
 *   put:
 *     summary: Update data export opt-out preference
 *     description: Update user's preference for opting out of data exports. Only available when export opt-out feature is enabled.
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: The ID of the user
 *         schema:
 *           type: string
 *           example: "5ebac534954b54139806c112"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - optOut
 *             properties:
 *               optOut:
 *                 type: boolean
 *                 description: Whether to opt out of data exports
 *                 example: true
 *     responses:
 *       200:
 *         description: Updated export preference
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dataExportOptOut:
 *                   type: boolean
 *                   description: Current opt-out status
 *                   example: true
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Cannot update preferences for another user or feature disabled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/user/:userId/preferences/export').put(auth('manageAccount'), userController.updateDataExportPreference)

/**
 * @swagger
 * /users/user/{userId}/preferences/export:
 *   get:
 *     summary: Get data export opt-out preference
 *     description: Retrieve user's current data export opt-out preference. Only available when export opt-out feature is enabled.
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: The ID of the user
 *         schema:
 *           type: string
 *           example: "5ebac534954b54139806c112"
 *     responses:
 *       200:
 *         description: Current export preference
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dataExportOptOut:
 *                   type: boolean
 *                   description: Current opt-out status
 *                   example: false
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Cannot get preferences for another user or feature disabled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 403
 *               message: "Export opt-out feature is disabled"
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.route('/user/:userId/preferences/export').get(auth('manageAccount'), userController.getDataExportPreference)

/**
 * @swagger
 * /users/user/{userId}/exports:
 *   get:
 *     summary: Get export audit log
 *     description: Retrieve the audit log of all data exports that included the user's data
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         description: The ID of the user
 *         schema:
 *           type: string
 *           example: "5ebac534954b54139806c112"
 *     responses:
 *       200:
 *         description: Export audit log entries sorted by export date (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 audits:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       conversationName:
 *                         type: string
 *                         description: Name of the exported conversation
 *                         example: "My favorite dog discussion"
 *                       exporterUsername:
 *                         type: string
 *                         description: Username of the person who performed the export
 *                         example: "admin_user"
 *                       format:
 *                         type: string
 *                         description: Export format used
 *                         example: "JSON"
 *                       exportDate:
 *                         type: string
 *                         format: date-time
 *                         description: When the export was performed
 *                         example: "2023-12-01T10:30:00.000Z"
 *                       messageCount:
 *                         type: number
 *                         description: Number of messages in the export
 *                         example: 25
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Cannot get audit log for another user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 403
 *               message: "Cannot get audit log for another user"
 */
router.route('/user/:userId/exports').get(auth('manageAccount'), userController.getExportAuditLog)

export default router
