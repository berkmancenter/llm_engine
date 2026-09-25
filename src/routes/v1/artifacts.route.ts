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
 *                 enum: [DocumentArtifact, ConceptGraphArtifact]
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
 *                 oneOf:
 *                   - $ref: '#/components/schemas/ConceptGraphPayload'
 *                   - type: object
 *                     additionalProperties: true
 *                 description: >-
 *                   First version's content, in the shape the chosen `type` requires. A
 *                   DocumentArtifact takes `{ body: string }`; a ConceptGraphArtifact takes
 *                   a ConceptGraphPayload.
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
 *             conceptGraph:
 *               summary: A concept graph, including a contribution joining three concepts
 *               value:
 *                 type: ConceptGraphArtifact
 *                 conversationId: '6733fe79ca20209f1fa02168'
 *                 title: 'Concepts and contributions'
 *                 payload:
 *                   originPrompts:
 *                     - id: 'p1'
 *                       text: 'What has to be trustworthy for a credential to mean anything?'
 *                   concepts:
 *                     - id: 'c-issuer'
 *                       label: 'Issuer'
 *                       origin: 'p1'
 *                     - id: 'c-verifier'
 *                       label: 'Verifier'
 *                     - id: 'c-trust-registry'
 *                       label: 'Trust Registry'
 *                       provenance:
 *                         messageId: '6750a665664156091cdf5a31'
 *                         pseudonym: 'Bold Aardvark'
 *                   contributions:
 *                     - id: 'k8'
 *                       kind: 'listed in'
 *                       concepts: ['c-issuer', 'c-trust-registry']
 *                     - id: 'k15'
 *                       kind: 'co-governs'
 *                       concepts: ['c-issuer', 'c-verifier', 'c-trust-registry']
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
 * /artifacts/generate:
 *   post:
 *     summary: Build or refine a concept graph
 *     description: >-
 *       With a `conversationId`, reads that event's transcript and group chat and writes a
 *       ConceptGraphArtifact for it. With a `topicId`, folds every conversation in the series
 *       into one topic-scoped graph — which is also how a series predating this feature gets
 *       backfilled.
 *
 *       Both run automatically when a conversation with the Concept Cartographer agent stops:
 *       the event gets its own graph, and the topic's graph is refined with it. A series
 *       unfolds over time, so the topic graph accumulates a version per event rather than
 *       being rebuilt, and the sequence of versions records how the series' understanding
 *       developed. Concepts keep stable ids across versions, so two can be diffed.
 *
 *       Safe to re-run, and re-running is how a poor extraction gets redone: the second run
 *       appends a new version to the existing graph rather than replacing it or creating a
 *       duplicate, so both extractions stay readable and comparable.
 *
 *       An ordinary re-run of a topic still folds the graph's current version in as a source,
 *       which means a concept already folded away by the size cap stays folded even after
 *       raising it. `reset` (topicId only) skips that: it recomputes the whole series from its
 *       raw transcripts alone, ignoring the current graph entirely. It still only ever appends
 *       a new version, so the pre-reset graph is never lost — it's just no longer what the new
 *       one was built from. Costs a full backfill every time, so this is an operator escape
 *       hatch, not something to reach for routinely.
 *
 *       The event is treated as running under the Chatham House Rule. Nothing in the output
 *       names or otherwise identifies anyone who took part, and statements are paraphrased —
 *       a verbatim quotation survives only inside quotation marks and only when it identifies
 *       no one.
 *
 *       Registered ahead of `/artifacts/{artifactId}` so `generate` is not read as an id.
 *
 *       Runs in a background job rather than inline in this request, since the pipeline can
 *       run long enough to exceed the load balancer's backend timeout. This call only claims
 *       (or creates) the target artifact and enqueues the run, answering 202 immediately with
 *       `generationStatus: 'pending'`. A generation already in flight for this artifact is a
 *       no-op: the same, still-pending artifact comes back rather than a second job. Poll
 *       `GET /artifacts/{artifactId}` or listen for the `artifact:version` (done) /
 *       `artifact:generationFailed` (errored, or too little to map) socket events on the
 *       conversation's room to see the claim resolve.
 *     tags: [Artifact]
 *     operationId: generateConceptGraph
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               conversationId:
 *                 type: string
 *                 description: The finished conversation to map. Mutually exclusive with topicId.
 *                 example: '6733fe79ca20209f1fa02168'
 *               topicId:
 *                 type: string
 *                 description: >-
 *                   The series to refine, folding in every conversation under it. Mutually
 *                   exclusive with conversationId.
 *                 example: '61b7ea6aa771004e80ed4409'
 *               reset:
 *                 type: boolean
 *                 default: false
 *                 description: >-
 *                   Only valid alongside topicId. Recomputes the series graph from its raw
 *                   transcripts alone, ignoring the current version, so a concept already
 *                   folded away by a since-raised CONCEPT_CAP is reconsidered rather than
 *                   staying folded. The pre-reset graph is kept as the previous version, not
 *                   overwritten. Not exposed in any client UI — an operator action, meant to
 *                   be rare.
 *     responses:
 *       '202':
 *         description: >-
 *           The generation run was claimed and enqueued (or was already in flight). The
 *           artifact returned here is a snapshot at claim time — `generationStatus` is
 *           `pending`, and `currentVersion`/`currentVersionNumber` still reflect whatever
 *           the artifact had before this call, or are absent entirely on a first-ever
 *           generation. Poll `GET /artifacts/{artifactId}` or listen on the socket for the
 *           result: `artifact:version` once a new version is written, or
 *           `artifact:generationFailed` if the run errored or found too little of the
 *           record to map.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 generated:
 *                   type: boolean
 *                   example: true
 *                 artifact:
 *                   $ref: '#/components/schemas/Artifact'
 *                 status:
 *                   type: string
 *                   enum: [ready, pending, failed]
 *                   description: Echoes the returned artifact's generationStatus, which is 'pending' immediately after a fresh claim
 *                   example: pending
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 *       '403':
 *         $ref: '#/components/responses/Forbidden'
 *       '404':
 *         $ref: '#/components/responses/NotFound'
 */
router
  .route('/generate')
  .post(auth('manageArtifacts'), validate(artifactValidation.generateConceptGraph), artifactController.generateConceptGraph)

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
 *                 oneOf:
 *                   - $ref: '#/components/schemas/ConceptGraphPayload'
 *                   - type: object
 *                     additionalProperties: true
 *                 description: >-
 *                   The new version's content, in the shape the artifact's own `type`
 *                   requires. A version replaces the payload wholesale rather than patching
 *                   it, so a concept graph sends the whole graph each time.
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
