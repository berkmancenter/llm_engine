import express from 'express'
import auth from '../../middlewares/auth.js'
import validate from '../../middlewares/validate.js'
import artifactValidation from '../../validations/artifact.validation.js'
import { artifactController } from '../../controllers/index.js'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: Artifact
 *   description: >-
 *     Shared data objects that emerge from one or more conversations. An artifact is scoped
 *     either to a single conversation or to a whole topic, and may be built live while the
 *     conversation runs or prepared afterwards. Every revision is retained: reads return the
 *     latest version by default, and the full history stays available.
 *
 *     Reads are authorized by the container's artifact passcode, passed as the
 *     `artifactPasscode` query parameter, so a client can load an artifact for someone who
 *     has never signed in. The conversation or topic owner, and administrators, may read
 *     without one. The passcode is minted when a container's first artifact is created and
 *     returned in that response.
 */

/**
 * @swagger
 * /artifacts:
 *   post:
 *     summary: Create an artifact
 *     description: >-
 *       Creates an artifact for exactly one topic or one conversation, together with its
 *       first version. A topic-scoped artifact requires administrator rights; a
 *       conversation-scoped one requires the conversation's owner, its topic's owner, or an
 *       administrator. The response carries the container's `artifactPasscode`, which is
 *       what a client must then present to read the artifact — this is the only response
 *       that returns it.
 *     tags: [Artifact]
 *     operationId: createArtifact
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - title
 *               - payload
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [DocumentArtifact]
 *                 description: Which kind of artifact to create, which determines the shape of `payload`
 *                 example: DocumentArtifact
 *               topicId:
 *                 type: string
 *                 description: Scope the artifact to this topic. Mutually exclusive with conversationId.
 *                 example: '61b7ea6aa771004e80ed4409'
 *               conversationId:
 *                 type: string
 *                 description: Scope the artifact to this conversation. Mutually exclusive with topicId.
 *                 example: '6733fe79ca20209f1fa02168'
 *               title:
 *                 type: string
 *                 example: 'Shared priorities'
 *               description:
 *                 type: string
 *                 example: 'What the group agreed matters most, updated as the session runs'
 *               payload:
 *                 type: object
 *                 description: 'First version''s content. For DocumentArtifact: { body: string }.'
 *                 additionalProperties: true
 *                 example:
 *                   body: 'The group converged on three priorities...'
 *               note:
 *                 type: string
 *                 description: Free-text note recorded against this version
 *                 example: 'Initial draft'
 *           examples:
 *             conversationDocument:
 *               summary: A document artifact for one conversation
 *               value:
 *                 type: DocumentArtifact
 *                 conversationId: '6733fe79ca20209f1fa02168'
 *                 title: 'Shared priorities'
 *                 payload:
 *                   body: 'The group converged on three priorities...'
 *             topicDocument:
 *               summary: A document artifact spanning a topic's conversations
 *               value:
 *                 type: DocumentArtifact
 *                 topicId: '61b7ea6aa771004e80ed4409'
 *                 title: 'Themes across the series'
 *                 payload:
 *                   body: 'Across all six sessions, participants returned to...'
 *     responses:
 *       '201':
 *         description: Artifact created, with its first version and the container's read passcode
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Artifact'
 *                 - type: object
 *                   properties:
 *                     artifactPasscode:
 *                       type: string
 *                       description: >-
 *                         The passcode a client must present to read artifacts in this
 *                         container. Returned only here.
 *                       example: 'Xk3fA9dQ'
 *       '400':
 *         description: Unsupported artifact type, invalid payload for the type, or not exactly one of topicId/conversationId
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
router
  .route('/')
  .post(auth('manageArtifacts'), validate(artifactValidation.createArtifact), artifactController.createArtifact)

/**
 * @swagger
 * /artifacts:
 *   get:
 *     summary: List the artifacts for a topic or conversation
 *     description: >-
 *       Every artifact in the container, newest first, each with its current version
 *       populated so a client can render the whole set without a request per artifact. A
 *       topic listing includes artifacts scoped to that topic's conversations.
 *     tags: [Artifact]
 *     operationId: listArtifacts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: topicId
 *         in: query
 *         description: List this topic's artifacts. Mutually exclusive with conversationId.
 *         schema:
 *           type: string
 *           example: '61b7ea6aa771004e80ed4409'
 *       - name: conversationId
 *         in: query
 *         description: List this conversation's artifacts. Mutually exclusive with topicId.
 *         schema:
 *           type: string
 *           example: '6733fe79ca20209f1fa02168'
 *       - name: artifactPasscode
 *         in: query
 *         description: >-
 *           The container's artifact passcode. Required unless the caller owns the
 *           conversation or topic, or is an administrator.
 *         schema:
 *           type: string
 *           example: 'Xk3fA9dQ'
 *     responses:
 *       '200':
 *         description: The container's artifacts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Artifact'
 *       '400':
 *         description: Not exactly one of topicId/conversationId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         description: >-
 *           Missing or incorrect passcode, or no such container. Deliberately
 *           indistinguishable, so the endpoint cannot be used to discover which topics and
 *           conversations exist or have artifacts.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.route('/').get(auth('listArtifacts'), validate(artifactValidation.listArtifacts), artifactController.listArtifacts)

/**
 * @swagger
 * /artifacts/passcode:
 *   get:
 *     summary: Get the artifact read passcode for a topic or conversation
 *     description: >-
 *       The passcode a client must present to read the container's artifacts, minting one if
 *       the container does not have it yet. Lets an owner recover the key after the create
 *       response, and build an artifact link before the first artifact exists.
 *
 *       Authorized like a write rather than a read — the same rights that let a caller
 *       create artifacts in this container — because handing out the read key is the
 *       owner's decision to make. The passcode appears in no other response: it is kept out
 *       of the serialized topic and conversation on purpose.
 *
 *       Registered ahead of `/artifacts/{artifactId}` so `passcode` is not read as an id.
 *     tags: [Artifact]
 *     operationId: getArtifactPasscode
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: topicId
 *         in: query
 *         description: Mutually exclusive with conversationId
 *         schema:
 *           type: string
 *           example: '61b7ea6aa771004e80ed4409'
 *       - name: conversationId
 *         in: query
 *         description: Mutually exclusive with topicId
 *         schema:
 *           type: string
 *           example: '6733fe79ca20209f1fa02168'
 *     responses:
 *       '200':
 *         description: The container's artifact passcode
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artifactPasscode:
 *                   type: string
 *                   example: 'Xk3fA9dQ'
 *       '400':
 *         description: Not exactly one of topicId/conversationId
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
router
  .route('/passcode')
  .get(auth('manageArtifacts'), validate(artifactValidation.getContainerPasscode), artifactController.getContainerPasscode)

/**
 * @swagger
 * /artifacts/{artifactId}:
 *   get:
 *     summary: Fetch an artifact at its latest version
 *     description: >-
 *       The artifact with `currentVersion` populated. This is the default read; use the
 *       versions endpoints to reach earlier revisions.
 *     tags: [Artifact]
 *     operationId: getArtifact
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: artifactId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: '6750a665664156091cdf5a31'
 *       - name: artifactPasscode
 *         in: query
 *         description: Required unless the caller owns the container or is an administrator
 *         schema:
 *           type: string
 *           example: 'Xk3fA9dQ'
 *     responses:
 *       '200':
 *         description: The artifact at its latest version
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Artifact'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         description: Missing or incorrect passcode, or no such artifact — deliberately indistinguishable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router
  .route('/:artifactId')
  .get(auth('getArtifact'), validate(artifactValidation.getArtifact), artifactController.getArtifact)

/**
 * @swagger
 * /artifacts/{artifactId}/versions:
 *   post:
 *     summary: Append a new version to an artifact
 *     description: >-
 *       Writes a new version and makes it current. Nothing is overwritten — the previous
 *       version stays in the history. Requires the same rights as creating the artifact;
 *       the read passcode never authorizes a write. Refused when the artifact is locked.
 *     tags: [Artifact]
 *     operationId: appendArtifactVersion
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: artifactId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: '6750a665664156091cdf5a31'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - payload
 *             properties:
 *               payload:
 *                 type: object
 *                 description: 'The new version''s content, in the artifact type''s shape. For DocumentArtifact: { body: string }.'
 *                 additionalProperties: true
 *                 example:
 *                   body: 'Revised after the second breakout...'
 *               note:
 *                 type: string
 *                 example: 'Folded in the breakout notes'
 *     responses:
 *       '201':
 *         description: The newly appended version
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ArtifactVersion'
 *       '400':
 *         description: Invalid payload for the artifact's type, or the artifact is locked
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
 *   get:
 *     summary: List every version of an artifact
 *     description: The artifact's full saved history, newest first by default, paginated.
 *     tags: [Artifact]
 *     operationId: listArtifactVersions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: artifactId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: '6750a665664156091cdf5a31'
 *       - name: artifactPasscode
 *         in: query
 *         description: Required unless the caller owns the container or is an administrator
 *         schema:
 *           type: string
 *           example: 'Xk3fA9dQ'
 *       - name: sortBy
 *         in: query
 *         description: 'Sort criteria in the form field:(asc|desc)'
 *         schema:
 *           type: string
 *           default: 'versionNumber:desc'
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 10
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *     responses:
 *       '200':
 *         description: A page of the artifact's versions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ArtifactVersion'
 *                 page:
 *                   type: number
 *                 limit:
 *                   type: number
 *                 totalPages:
 *                   type: number
 *                 totalResults:
 *                   type: number
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         description: Missing or incorrect passcode, or no such artifact — deliberately indistinguishable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router
  .route('/:artifactId/versions')
  .post(auth('manageArtifacts'), validate(artifactValidation.appendVersion), artifactController.appendVersion)
  .get(auth('getArtifact'), validate(artifactValidation.listVersions), artifactController.listVersions)

/**
 * @swagger
 * /artifacts/{artifactId}/versions/{versionNumber}:
 *   get:
 *     summary: Fetch one numbered version of an artifact
 *     description: For a client showing a specific point in an artifact's history.
 *     tags: [Artifact]
 *     operationId: getArtifactVersion
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: artifactId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: '6750a665664156091cdf5a31'
 *       - name: versionNumber
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *           example: 2
 *       - name: artifactPasscode
 *         in: query
 *         description: Required unless the caller owns the container or is an administrator
 *         schema:
 *           type: string
 *           example: 'Xk3fA9dQ'
 *     responses:
 *       '200':
 *         description: That version of the artifact
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ArtifactVersion'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         description: Missing or incorrect passcode, or no such artifact — deliberately indistinguishable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       '404':
 *         description: The artifact has no version with that number
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router
  .route('/:artifactId/versions/:versionNumber')
  .get(auth('getArtifact'), validate(artifactValidation.getVersion), artifactController.getVersion)

export default router
