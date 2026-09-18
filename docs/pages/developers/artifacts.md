## Artifacts

An artifact is something a conversation produces that outlives it: a concept map of what an event discussed, or a document an organizer writes up afterwards. Messages are the record of what was said. An artifact is a shared object built from that record. Each artifact has a type, belongs to one topic or one conversation, and keeps every revision as a numbered version.

### The data model

An `Artifact` has:

| Field                  | Meaning                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `type`                 | The kind of artifact. Today: `ConceptGraphArtifact` or `DocumentArtifact`. Clients pick a renderer from this value. |
| `scope`                | `conversation` for a single event, `topic` for a whole series.                                                      |
| `topic`                | Always set, even for a conversation-scoped artifact, so a topic listing is one query.                               |
| `conversation`         | Set only when `scope` is `conversation`.                                                                            |
| `title`, `description` | What a client shows in a list.                                                                                      |
| `currentVersion`       | The version a plain read returns.                                                                                   |
| `currentVersionNumber` | The highest version number claimed so far. Starts at 0 and also acts as the allocator for the next number.          |
| `locked`               | When true, no further versions can be appended. The artifact and its history stay readable.                         |
| `createdBy`            | The user or agent that made it.                                                                                     |

An `ArtifactVersion` holds one revision: the `payload`, a 1-based `versionNumber`, who wrote it, an optional `note`, and a creation time. Nothing ever edits a version. A new revision is always a new version, so an artifact's history is the full list of its versions.

The payload's shape depends on the type. `src/models/artifact.model/registry.ts` is the single place that lists every type and the Joi schema its payload must satisfy. Adding a new type means adding a discriminator model and one registry entry; the routes, controller, and service are generic and look the payload rule up by `type`.

A concept graph payload has three node arrays:

- `concepts`: ideas or entities, each with a stable `id` and a `label`.
- `contributions`: relationships between concepts, stored as nodes rather than edges so one contribution can join three or more concepts. Each has a `kind` (the short label a client renders) and an optional `statement` (the sentence behind it).
- `originPrompts`: the questions or prompts a concept or contribution came out of.

Ids must be unique across all three arrays, and every reference (a contribution's `concepts`, a node's `origin`) must resolve. The registry enforces both, because the payload is stored as a Mixed field and nothing else would.

Any node may carry `provenance`: a `conversationId`, `messageId`, or `pseudonym`. Clients must never render `messageId` or `pseudonym`. Graphs are built from events held under the Chatham House Rule, and either field re-identifies a participant to anyone holding the read passcode. `conversationId` is safe to draw and is what lets a series graph colour nodes by the session that raised them.

### Reading an artifact

Every read (list, current version, history, one version) passes the same guard. Three kinds of caller get through:

1. An administrator, meaning any user holding the `manageArtifacts` right.
2. The owner of the conversation or of its topic.
3. Anyone presenting the container's artifact passcode in the `artifactPasscode` query parameter.

The third path is how a client shows an artifact to a participant who may never have signed in: the passcode rides in a link. Participants hold the `getArtifact` and `listArtifacts` rights by default, so an authenticated participant with the passcode can read too.

Each topic and each conversation has its own artifact passcode. The server mints it the first time someone creates an artifact in that container. It is separate from a private topic's `passcode`, so handing someone the read key to a series' graph does not also let them into the topic. Until an artifact exists, a container has no passcode and refuses everyone except its owners and administrators.

A missing passcode, a wrong passcode, and an unknown artifact id all return the same 403 with the same message. A client therefore cannot tell whether an artifact exists, only that it may not read it, and should say "this needs a passcode" rather than "not found".

A topic listing returns the topic-scoped artifacts to a passcode holder. Only the topic owner and administrators also see the artifacts of the topic's individual conversations in that list, because the topic passcode does not open a conversation artifact and the list must not return what the single read would refuse.

### Writing an artifact

A passcode never authorizes a write. Everyone who can see the artifact holds the read key, so accepting it for writes would let any reader rewrite what they were shown.

- A topic-scoped artifact needs an administrator.
- A conversation-scoped artifact needs the conversation owner, the topic owner, or an administrator.
- An agent may write to its own conversation and to that conversation's topic.

Creating an artifact always writes version 1 in the same call, so there is never an artifact with no content. Appending a version claims the next number with a single atomic increment on the artifact, then inserts the version, then moves `currentVersion` forward. Because the number is claimed rather than computed, two concurrent writers never share one. A claim whose insert fails leaves a gap, so treat version numbers as increasing rather than contiguous.

A locked artifact refuses the append with a 400.

### Live updates over the socket

When a version is appended to a conversation-scoped artifact, the server emits `artifact:version` to that conversation's socket room. The notice names the artifact and version, plus its container:

```json
{
  "artifactId": "<artifact id>",
  "versionNumber": 2,
  "scope": "conversation",
  "topicId": "<topic id>",
  "conversationId": "<conversation id>"
}
```

The notice carries no content on purpose. A client re-reads the artifact over REST, presenting its passcode as usual, so the socket never becomes a second path to the payload. A client joins the room with `conversation:join` and an empty `channels` list, which needs no channel passcode, and leaves with `conversation:leave`. Joining the room proves nothing about read access; the REST read still applies the guard.

The server does not broadcast topic-scoped artifacts. There is no topic-wide room, so a client showing a series graph refreshes on demand instead.

### Generating a concept graph

`src/services/conceptGraph` builds a `ConceptGraphArtifact` from an event that has finished. It runs from two places, both through the same service function so the two paths cannot drift:

- **Automatically**, when the Concept Cartographer agent (`src/agents/conceptCartographer`) receives the `conversationStopped` event for its conversation. No conversation type includes this agent by default; add `conceptCartographer` to a conversation's `agentTypes` to enable it. The agent posts nothing to the chat. Its only output is the artifact.
- **On demand**, from `POST /v1/artifacts/generate` with either a `conversationId` or a `topicId` in the body. This needs the `manageArtifacts` right. It is how an administrator re-runs a bad extraction, and how a series that predates the feature gets a graph.

The steps for one conversation:

1. Load the messages on the `transcript` and `chat` channels, oldest first, skipping agent messages. These are the only channels the whole room saw, and the graph is published to everyone holding the passcode, so it must not draw on anything narrower. Fewer than 400 characters in total means nothing to map, and the run returns without writing.
2. Split the record into chunks of roughly 24,000 characters and ask the model named by `CORE_LLM_PLATFORM` and `CORE_LLM_MODEL` to extract concepts, contributions, and origin prompts from each. The event is offered the concept labels its series has already established, so a later event can link to a concept an earlier one raised. One failed chunk is logged and skipped; the graph is a summary, so a partial one still gets written.
3. Assemble the chunks into one graph, merging duplicate concepts and resolving each cited message tag to a real `messageId`.
4. Apply the Chatham House checks. `quoteSafety.ts` does the exact half: any verbatim span must be in quotation marks, a quoted span may carry no identifying detail, and no statement may name a pseudonym, presenter, moderator, or reserved real name the topic knows. `nameScreen.ts` does the judgment half with one batched model call over the surviving text, catching names and affiliations the system never recorded. The screen fails closed: if it errors, every candidate in the batch is dropped.
5. Write the result. If the conversation already has a concept graph, the new payload becomes its next version. Otherwise an artifact is created with version 1.

Re-running is safe and is the intended way to redo an extraction. Both versions stay readable and comparable.

After a conversation's graph is written, the same extraction is folded into the topic's graph. The topic graph is refined rather than rebuilt: the existing payload is read back, merged with the new concepts and contributions, aliases between the two vocabularies are resolved, and the result is saved as the topic artifact's next version. Each event therefore leaves one version behind, and the version history of a series graph records how the series' understanding developed. When `POST /v1/artifacts/generate` is called with a `topicId` and no event has handed over an extraction, the service reads every conversation in the topic in order, carrying the vocabulary forward. That is the slow path and exists for backfilling.

### REST endpoints

All under `/v1/artifacts`. The OpenAPI page at `/v1/docs` on a running server has the full request and response schemas.

| Method and path                                                  | Right             | Purpose                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /artifacts`                                                | `manageArtifacts` | Create an artifact with its first version. The response is the only one that carries the passcode.                                                             |
| `GET /artifacts?topicId=<id>` or `?conversationId=<id>`          | `listArtifacts`   | List a container's artifacts, newest first, with the current version inlined.                                                                                  |
| `POST /artifacts/generate`                                       | `manageArtifacts` | Build or refine a concept graph for a conversation or a topic. Returns 202 with the artifact, or 200 with `generated: false` when there was too little to map. |
| `GET /artifacts/passcode?topicId=<id>` or `?conversationId=<id>` | `manageArtifacts` | Read (and mint if needed) a container's artifact passcode. Authorized as a write, since it hands out read access.                                              |
| `GET /artifacts/{artifactId}`                                    | `getArtifact`     | One artifact at its current version.                                                                                                                           |
| `POST /artifacts/{artifactId}/versions`                          | `manageArtifacts` | Append a version.                                                                                                                                              |
| `GET /artifacts/{artifactId}/versions`                           | `getArtifact`     | Paginated version history, newest first.                                                                                                                       |
| `GET /artifacts/{artifactId}/versions/{n}`                       | `getArtifact`     | One numbered version.                                                                                                                                          |

Every `GET` accepts `artifactPasscode` as a query parameter.

### Testing locally with a seeded event

A concept graph needs an ended event with a transcript, which normally means running a real Zoom session. `scripts/seedEvent.ts` skips that. It writes a topic, an ended conversation with `transcript` and `chat` channels, a set of participant users, and one transcript message per line straight into your local database. It does not create the artifact; you generate that from the web client afterwards, which is the part you are testing.

From the repository root, with MongoDB running:

```bash
NODE_ENV=development node --loader ts-node/esm scripts/seedEvent.ts --users 4 --owner <your-admin-username>
```

The script prints the new `topicId` and `conversationId` and the artifact page paths for each. Open the event's artifact page in the web client as an administrator and click Generate.

| Flag                   | Meaning                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--topic "<name>"`     | Topic (series) name. Default `Seeded series`.                                                                                                                |
| `--event "<name>"`     | Conversation (event) name. Default `Seeded event`.                                                                                                           |
| `--users N`            | Participant users to create. Speakers in the transcript are rotated over them. Default 4.                                                                    |
| `--transcript <path>`  | A `Speaker: text` file, one utterance per line. Default `scripts/transcripts/living-with-assistants.txt`.                                                    |
| `--generate "<brief>"` | Ask the model named by `CORE_LLM_PLATFORM` and `CORE_LLM_MODEL` to write the transcript instead of reading a file. This is the only path that calls a model. |
| `--owner <username>`   | An existing user to record as owner of the topic and event. Default: the first seeded user. Administrators can read and generate regardless of owner.        |
| `--allow-remote`       | Permit a `MONGODB_URL` that is not localhost. Without it the script refuses.                                                                                 |
| `--clean`              | Delete everything earlier seed runs created (topics, conversations, channels, messages, seeded users), then exit.                                            |

The script refuses to run with `NODE_ENV=production`. Seeded users have no password, so nobody can log in as them.

A full manual test of the flow, from seeding through generating, sharing a passcode link, and watching a regeneration arrive over the socket:

1. Start the API with `yarn dev` and seed an event as above.
2. Start the web client and log in as an administrator.
3. Open the event's artifact page. Expect an empty list and a Generate button, with no passcode prompt.
4. Click Generate. Expect a rendered concept graph, a version history showing version 1, and the button now offering to regenerate.
5. Copy the share link. Expect a URL carrying `artifactPasscode=`. Open it in a private browser window: the graph renders with no login and no administrator controls. Change the passcode to garbage and expect a passcode prompt, never a not-found message.
6. Keep the private window open and click Regenerate in the administrator window. Expect the private window to move to version 2 without a reload.
7. Open the topic's artifact page. Expect the event graph listed and an offer to generate a series graph. Generate it, copy its share link, and open that in the private window: only the series graph is listed there.
8. Run the script with `--clean` to remove the seeded records. Generated artifacts are left in place.
