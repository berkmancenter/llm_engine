import express from 'express'
import multer from 'multer'
import { memberController, inviteController } from '../../controllers/index.js'
import auth from '../../middlewares/auth.js'
import { memberImportLimiter, inviteSendLimiter } from '../../middlewares/rateLimiter.js'
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

/**
 * @swagger
 * /members/{conversationId}/invites:
 *   post:
 *     summary: Email an invite link to every not-yet-invited member of a conversation
 *     description: >
 *       Admin-only. Mails every imported member who has never been successfully invited
 *       (inviteState 'pending' or 'failed') a single-use set-password link in one batch.
 *       Members already marked 'invited' are never re-mailed by this endpoint; use the
 *       per-member resend for that. Returns per-recipient failures so a bounced invite
 *       is visible rather than silent.
 *     tags: [Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: conversationId
 *         required: true
 *         description: ID of the conversation whose members to invite
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sent/failed counts plus per-recipient failures
 *       404:
 *         description: Conversation not found
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       501:
 *         description: Outbound batch email is not configured yet
 */
router
  .route('/:conversationId/invites')
  .post(inviteSendLimiter, auth('manageMembers'), validate(memberValidation.sendInvites), inviteController.sendInvites)

/**
 * @swagger
 * /members/invites/{membershipId}/resend:
 *   post:
 *     summary: Re-send one member's invite link
 *     description: >
 *       Admin-only. Invalidates the member's outstanding invite link and mails a fresh
 *       one. Refused once the member has joined, because a live invite link for an
 *       already-provisioned account could take the account over.
 *     tags: [Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: membershipId
 *         required: true
 *         description: ID of the membership record to re-invite
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sent/failed count for the one recipient
 *       400:
 *         description: Member has already joined
 *       404:
 *         description: Membership not found
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       501:
 *         description: Outbound batch email is not configured yet
 */
router
  .route('/invites/:membershipId/resend')
  .post(inviteSendLimiter, auth('manageMembers'), validate(memberValidation.resendInvite), inviteController.resendInvite)

export default router
