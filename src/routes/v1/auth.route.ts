import express from 'express'
import validate from '../../middlewares/validate.js'
import authValidation from '../../validations/auth.validation.js'
import { authController, inviteController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import { inviteConsumeLimiter } from '../../middlewares/rateLimiter.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication management
 */

/**
 * @swagger
 * /auth/newPseudonym:
 *   get:
 *     summary: Generate a new pseudonym and token
 *     description: Returns a random pseudonym and token for user registration
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Successfully generated pseudonym and token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: Unique token for pseudonym validation
 *                 pseudonym:
 *                   type: string
 *                   description: Generated pseudonym
 */
router.route('/newPseudonym').get(authController.newPseudonym)

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     description: Register a new user with username, email, password, and pseudonym
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *               - token
 *               - pseudonym
 *               - email
 *             properties:
 *               username:
 *                 type: string
 *                 description: Unique username for the user
 *                 example: "fakejake"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User password (will be hashed)
 *                 minLength: 8
 *                 example: "password123"
 *               token:
 *                 type: string
 *                 description: Token obtained from /newPseudonym endpoint
 *                 example: "b019d20aa74a16c8c68701cc2937c8a76bc6cdc6247d51cf80bb3d1f27f6ac3f"
 *               pseudonym:
 *                 type: string
 *                 description: Pseudonym obtained from /newPseudonym endpoint
 *                 example: "Profound Red Rattlesnake"
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address
 *                 example: "fake@example.com"
 *               dataExportOptOut:
 *                 type: boolean
 *                 description: Opt out of data export (defaults to false)
 *     responses:
 *       201:
 *         description: User successfully registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 tokens:
 *                   $ref: '#/components/schemas/AuthTokens'
 *       400:
 *         description: Invalid token or validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Username or email already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               username_conflict:
 *                 summary: Username already taken
 *                 value:
 *                   code: 409
 *                   message: "Username is already registered"
 *               email_conflict:
 *                 summary: Email already taken
 *                 value:
 *                   code: 409
 *                   message: "Email address is already registered"
 */
router.post('/register', validate(authValidation.register), authController.register)

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     description: Authenticate user with username and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 description: User's username
 *                 example: "fakejake"
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User's password
 *                 example: "password123"
 *     responses:
 *       200:
 *         description: Successfully authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 tokens:
 *                   $ref: '#/components/schemas/AuthTokens'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: "Incorrect username or password"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login', validate(authValidation.login), authController.login)

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: User logout
 *     description: Logout user by invalidating refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Refresh token to invalidate
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       204:
 *         description: Successfully logged out
 *       404:
 *         description: Refresh token not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 404
 *               message: "Not found"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/logout', validate(authValidation.logout), authController.logout)

/**
 * @swagger
 * /auth/refresh-tokens:
 *   post:
 *     summary: Refresh authentication tokens
 *     description: Generate new access and refresh tokens using a valid refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Valid refresh token
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Tokens refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthTokens'
 *       401:
 *         description: Invalid or expired refresh token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: "Please log in"
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/refresh-tokens', validate(authValidation.refreshTokens), authController.refreshTokens)

/**
 * @swagger
 * /auth/ping:
 *   get:
 *     summary: Ping endpoint for authentication testing
 *     description: Test endpoint to verify authentication middleware is working
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: string
 *               example: "pong"
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.route('/ping').get(auth('ping'), authController.ping)

/**
 * @swagger
 * /auth/forgotPassword:
 *   post:
 *     summary: Request password reset
 *     description: Send a password reset email to the user's registered email address
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's registered email address
 *                 example: "fake@example.com"
 *     responses:
 *       204:
 *         description: Password reset email sent (if email exists)
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/forgotPassword', validate(authValidation.sendPasswordReset), authController.sendPasswordReset)

/**
 * @swagger
 * /auth/resetPassword:
 *   post:
 *     summary: Reset user password
 *     description: Reset user's password using a valid reset token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *                 description: Password reset token from email
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *               password:
 *                 type: string
 *                 format: password
 *                 description: New password
 *                 minLength: 8
 *                 example: "newpassword123"
 *     responses:
 *       204:
 *         description: Password reset successfully
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid or expired reset token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               code: 401
 *               message: "User not found"
 */
router.post('/resetPassword', validate(authValidation.resetPassword), authController.resetPassword)

/**
 * @swagger
 * /auth/invite:
 *   get:
 *     summary: Validate a member invite link without consuming it
 *     description: >
 *       Public. Checks the invite token from the emailed link and returns who it is for,
 *       which conversation it opens, and a one-time nonce the set-password submit must
 *       echo back. Deliberately repeatable: corporate mail scanners pre-open links with a
 *       GET before the person ever clicks, so only the consume POST burns the token.
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         description: Invite token from the emailed link
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Member name and email, conversation, and a one-time nonce
 *       401:
 *         description: Invite link is invalid or has expired
 *       400:
 *         description: Token missing
 */
router.get('/invite', inviteConsumeLimiter, validate(authValidation.getInvite), inviteController.getInvite)

/**
 * @swagger
 * /auth/invite/consume:
 *   post:
 *     summary: Consume a member invite
 *     description: >
 *       Public. Burns the single-use invite token. Requires both the token and the nonce
 *       issued by the validate GET, so a token skimmed from a log or scanner queue cannot
 *       complete the flow on its own. Account provisioning and session issuance follow in
 *       later work; today this endpoint only consumes.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - nonce
 *             properties:
 *               token:
 *                 type: string
 *               nonce:
 *                 type: string
 *     responses:
 *       200:
 *         description: Invite consumed
 *       401:
 *         description: Invite link is invalid, expired, already used, or the nonce does not match
 *       400:
 *         description: Token or nonce missing
 */
router.post('/invite/consume', inviteConsumeLimiter, validate(authValidation.consumeInvite), inviteController.consumeInvite)

export default router
