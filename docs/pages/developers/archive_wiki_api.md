# PRD — Archive Wiki API (llm_engine ↔ archive-wiki)

*Status: proposal · Date: 2026-07-16 · Audience: archive stakeholders + engine implementers*

> **AI usage acknowledgement.** This design document was produced collaboratively
> with Claude (Anthropic). The author directed the work — setting the goals,
> parameters, and constraints discussed with the BKC team — and Claude assisted by
> exploring the codebase, drafting the proposal, and refining it under the author's
> review. All decisions and final content are the author's.

## Context

The `archive-historian` work gave this engine's eventHistorian two ways to reach
the BKC archive:

1. **Chroma RAG** — `search_archive` semantic search over an ingested
   `archive-items` collection (`src/utils/loadArchiveItems.ts`,
   `scripts/loadArchiveIntoTopic.ts`, and the framework proposed in
   [archive_rag_ingestion](archive_rag_ingestion.md)).
2. **Wiki routing** — three filesystem tools (`list_archive_wiki_pages`,
   `read_archive_wiki_page`, `get_archive_item` in `src/agents/tools/archive.ts`)
   that navigate the Archive Wiki (`archive/archive-wiki/`) the way a person
   would: consult the synthesis pages, follow `[[wiki-links]]` to items, pull the
   underlying source.

Per the BKC team's decision (staff call, July 2026), we now **shelve the RAG
path** and build on the wiki-routing path alone, evaluating wiki-vs-RAG later.
The routing tools, however, currently read the wiki via a **local filesystem
path** (`ARCHIVE_PATH`), which couples the engine's deployment to a checkout of
the wiki repo. This document specifies a small **Archive Wiki API** — owned by
the wiki, consumed by the engine — that removes that coupling and makes the
archive a proper augmentation service for the engine (and, via MCP, for any
LLM tool-calling client).

Decisions confirmed with the owner: the API lives **inside the archive-wiki
repo** (`archive/archive-wiki/api/`); stack is **Node + TypeScript**, one
process exposing REST and MCP; push-back is an **agent tool invoked on
request** (the wiki's "file good answers back as new pages" workflow);
pushed conversations land in an **`inbox/` drafts folder** for human review,
not directly in the published wiki.

---

## 1. Executive brief (for stakeholders)

We will put a lightweight API in front of the Archive Wiki so the LLM engine
talks to the archive **over HTTP instead of reading its files directly**. The
API works in both directions:

- **Engine → archive (query).** The historian keeps the exact research loop it
  has today — search the wiki, list its pages, read a page, pull a source item —
  but each step is now an API call. Search is **plain wiki search** (keyword /
  lexical over titles, frontmatter, and page bodies), not vector retrieval; the
  Chroma RAG stack stays in the codebase but is switched off for now.
- **Engine → archive (contribute).** When a conversation produces something
  worth keeping, the historian can **file it back into the archive**: the API
  writes a draft markdown page into an `inbox/` folder in the wiki repo, where a
  human curator reviews it before it is promoted into the wiki proper.

The same five functions are also exposed as an **MCP server**, so the archive
plugs into Claude, the engine, or any other MCP-capable client as a standard
tool — one implementation, two doorways.

Explicitly deferred to phase two (not this summer): sensitivity levels on
archive content, and NextSpace-based events. The design leaves the door open
for both. The summer goal after the prototype ships is to **gather feedback on
the historian interaction mode via Slack**.

---

## 2. Goals and non-goals

**Goals**

1. A lightweight HTTP API in the archive-wiki repo exposing the wiki to the
   engine: search, list pages, read page, get item.
2. **Wiki search replaces RAG search** — the `search_archive` capability is
   backed by a lexical index over the wiki, not Chroma.
3. **Push-back**: an endpoint that accepts a conversation/answer and writes a
   reviewable draft into `inbox/` in the wiki repo.
4. An **MCP server** exposing the same five functions as tools.
5. Engine integration by **configuration and tool internals only** — no changes
   to llm_engine data structures (Mongo models, schemas, routes).

**Non-goals (this phase)**

- RAG / Chroma anything — ingestion scripts and `rag.ts` remain in-repo,
  unused for the archive path (shelved, not deleted).
- Sensitivity levels and per-item access control (phase 2; see §8).
- NextSpace-based events (phase 2; see §8).
- Multi-user auth, rate limiting, or public exposure — this is a prototype
  service behind a shared token.
- The Next.js/Sanity app (separate track).

---

## 3. Architecture (for implementers)

```
archive/archive-wiki/                      llm_engine/
├── api/                    HTTP + MCP     src/agents/tools/archive.ts
│   ├── src/core/           pure fns  ◄──── four tools call the API via fetch
│   │   searchWiki()                        (+ new save_conversation_to_archive)
│   │   listPages()                    ◄──── config: ARCHIVE_API_URL/_TOKEN
│   │   readPage()
│   │   getItem()
│   │   saveConversation()
│   ├── src/routes/         REST /v1/*
│   └── src/mcp/            MCP server (Streamable HTTP at /mcp + stdio entry)
├── topics/ people/ orgs/ events/ timeline/   content the API serves
├── items/  raw/archive.json  collection/     item + source resolution
└── inbox/conversations/                      where push-back drafts land
```

- **One core, two doorways.** `api/src/core/` holds five pure functions over
  the wiki checkout. REST routes and MCP tools are both thin wrappers over this
  core — the logic is written once.
- **Package.** `api/` is its own npm package (Node 20+, TypeScript, Express —
  matching llm_engine idiom). It runs on the machine (or container) that has
  the wiki checkout; content stays in git, the API is a stateless view over it.
- **Content access** re-implements what `src/agents/tools/archive.ts` does
  today, unchanged in behavior: wiki sections `topics/ people/ orgs/ events/
  timeline/`; YAML frontmatter parsing; item resolution (`yt_*` ids →
  `collection/txt/youtube/<id>.txt` + `collection/json/youtube.json` metadata;
  numeric ids → `raw/archive.json`); same truncation limits (8,000 chars per
  page, 12,000 per source item).
- **Search** is an in-memory lexical index (MiniSearch or equivalent) built at
  startup over wiki-page frontmatter + bodies and item-stub metadata, with
  `section`/`kind` filters and snippet extraction. A manual `POST /v1/reindex`
  rebuilds it after content changes. The route contract is deliberately
  retrieval-agnostic: the same `/v1/search` shape can be backed by vectors
  later, which is exactly the wiki-vs-RAG evaluation the team deferred.
- **Push-back** writes `inbox/conversations/YYYY-MM-DD-<slug>.md` with YAML
  frontmatter (title, date, source platform, participants, related topic) and
  the conversation body as markdown. `inbox/` is outside the published wiki
  build; the curator promotes worthwhile drafts into `topics/` etc. by hand
  (the convention gets documented in the wiki's `AGENTS.md`).

---

## 4. REST surface (v1, JSON)

| Endpoint | Mirrors | Notes |
| --- | --- | --- |
| `GET /v1/search?q=&section=&limit=` | replaces Chroma `search_archive` | ranked `{section, slug, title, snippet, score}` |
| `GET /v1/pages?section=` | `list_archive_wiki_pages` | slugs + titles + related metadata per section |
| `GET /v1/pages/:section/:slug` | `read_archive_wiki_page` | frontmatter + body, truncated at 8k chars |
| `GET /v1/items/:id` | `get_archive_item` | stub + full source text, truncated at 12k chars |
| `POST /v1/conversations` | new (push-back) | body `{title, date, source, participants?, topic?, markdown}` → writes `inbox/conversations/…`; returns `{slug, path}` |
| `GET /v1/health` | ops | liveness + index stats |
| `POST /v1/reindex` | ops | rebuild the search index |

- **Auth:** one shared bearer token (`ARCHIVE_API_TOKEN` on both sides).
  Required for all `POST`s; configurable (default on) for `GET`s. Deliberately
  minimal for the prototype — this is the seam where phase-2 sensitivity
  enforcement will attach.
- **Errors:** JSON `{error, message}`, 404 for unknown slug/id/section, 401 on
  bad token, 400 on validation failure.

## 5. MCP server

- Built with `@modelcontextprotocol/sdk`; **Streamable HTTP** transport mounted
  at `/mcp` on the same process, plus a stdio entry point for local clients.
- Five tools, 1:1 with the core functions and named what the historian already
  knows: `search_archive`, `list_archive_wiki_pages`, `read_archive_wiki_page`,
  `get_archive_item`, `save_conversation_to_archive`. Tool descriptions carry
  the same routing guidance the historian prompt uses today (list → read →
  get; cite items by id).
- Auth: same bearer token via header.

## 6. llm_engine integration (minimal by design)

No Mongo models, schemas, or routes change. The engine touches three files:

- **`src/agents/tools/archive.ts`** — when `config.archiveApiUrl` is set, the
  four read tools call the API with native `fetch` + `AbortController` (the
  established outbound pattern, see `src/agents/tools/tavilySearch.ts`), with
  retry-on-429/5xx to match. Filesystem mode is used instead whenever only
  `ARCHIVE_PATH` is set — mode is chosen once at tool-construction time from
  config, not per-request, so there is no runtime failover if the API goes
  down while both env vars happen to be set. `search_archive` keeps its name
  (so the archive prompt in `eventHistorian.ts` keeps working) but its
  description is updated to say keyword wiki search, and its implementation
  becomes `GET /v1/search`.

  **Push-back deviates from the original plan below.** Live Slack testing
  during the summer feedback round surfaced that `save_conversation_to_archive`
  as an LLM-invokable tool let a user get *any* casual chat filed into the
  archive just by asking — not the intended "curate real BKC events" workflow.
  It is **not** an LLM tool: `saveEventToArchive` (exported from `archive.ts`)
  is called directly from `eventHistorian.ts`'s existing `onConversationEvent`
  handler, only when a real event `Conversation` concludes with a transcript
  summary, and only after an explicit `access.assertCanRead` privacy check
  (mirroring `vibesAnalyst`'s pattern for the same `conversationStopped`
  trigger) — a private topic is never auto-filed.
- **`src/config/config.ts`** — add `ARCHIVE_API_URL` and `ARCHIVE_API_TOKEN`
  (Joi schema + config mapping + `.env.example`).
- **`src/agents/eventHistorian/eventHistorian.ts`** — the `archiveEnabled` gate
  becomes `archivePath || archiveApiUrl`.

The Chroma ingestion scripts (`loadArchiveIntoTopic.ts`, `loadArchiveItems.ts`)
and `rag.ts` are untouched and simply unused for the archive path.

## 7. Milestones

1. **M1 — Read API.** `api/` package: core module, search index, four read
   endpoints, health. Runs against the real wiki checkout.
2. **M2 — Push-back.** `POST /v1/conversations` + the `inbox/` convention
   documented in the wiki's `AGENTS.md`.
3. **M3 — MCP.** MCP server wrapper over the same core; verified with MCP
   Inspector.
4. **M4 — Engine swap.** llm_engine tool internals + config; historian smoke
   test end-to-end in the Slack test channel.
5. **M5 — Feedback.** Slack-based feedback round on the historian interaction
   mode before summer ends (process, not code).

## 8. Phase-2 doors left open (explicitly out of scope now)

- **Sensitivity levels.** Reserve a `sensitivity:` frontmatter field on wiki
  pages/items; the API accepts (and for now ignores) a max-sensitivity filter
  param, so enforcement later is additive, not breaking.
- **NextSpace events.** `POST /v1/conversations` takes a `source` field
  (`slack` | `nextspace` | …); the API is adapter-agnostic by construction.
- **Wiki vs. RAG evaluation.** `/v1/search` is contract-stable across retrieval
  implementations — swapping lexical for vector (or a hybrid) changes nothing
  for clients.

## 9. Acceptance criteria / verification

- `npm run dev` in `api/`; each endpoint exercised with `curl` against the real
  wiki checkout (7,342 item stubs, 19 topic pages, 48 YouTube transcripts):
  search returns ranked results with snippets; list/read/get round-trip the
  same content the filesystem tools return today; POST writes a well-formed
  draft into `inbox/conversations/`.
- `npx @modelcontextprotocol/inspector` connected to `/mcp`; all five tools
  callable with correct schemas.
- llm_engine `.env` pointed at the local API (no `ARCHIVE_PATH`); a historian
  conversation in the Slack test channel demonstrates the list → read → get
  routing loop. Push-back is verified separately, by concluding a real event
  conversation and confirming `onConversationEvent` auto-files its summary
  (see §6 — push-back is not user-invokable from chat).
