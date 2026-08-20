# Test suite guide

Guidance for writing and running tests in this folder. The single most important
thing to internalize: **this project runs Jest in native ESM mode** (`ts-jest` with
`useESM: true`). ESM changes how mocking works, and most historical test pain comes
from using CommonJS-era Jest patterns that silently do nothing under ESM. Read the
Mocking section before adding any mock.

## The two test suites

There are two Jest configs with **non-overlapping** `testMatch` globs:

| Command | Config | Runs | Excludes |
| --- | --- | --- | --- |
| `npm test` | `jest.config.ts` | everything under `tests/**` | `tests/agents/**`, `tests/**/development/**` |
| `npm run test:agents` | `jest.agent.config.ts` | only `tests/agents/**` | `tests/agents/development/**` |

- The **main** suite (`npm test`) is the default. It covers unit tests, service/model
  tests, HTTP integration tests, handlers, jobs, adapters. Agent behavior is stubbed,
  not run against a real LLM.
- The **agent** suite (`npm run test:agents`) runs live end-to-end/eval tests that call
  a real LLM and real Chroma. It has a `globalSetup` that pings the vLLM and embeddings
  endpoints first. Only put a test here if it genuinely needs a live model.

Both run with `-i` (`--runInBand`, serial). This is deliberate: tests share one real
MongoDB and wipe collections between runs, so they cannot run in parallel. Do not add
`--maxWorkers` or write tests that assume isolation from a fresh DB per worker.

### Running a single file or test

```bash
# one file (main suite)
npm test -- tests/services/user.service.test.ts
# one file (agent suite) — must pass the agent config
npm test -- --config jest.agent.config.ts tests/agents/<file>.test.ts
# filter by test name
npm test -- tests/services/user.service.test.ts -t "should return 200"
```

## Prerequisites (tests are integration-first)

Most tests are **not** hermetic — they need real services running:

- **MongoDB is required for almost everything.** `setupIntTest()` connects to
  `config.mongoose.url` (`MONGODB_URL`, e.g. `mongodb://127.0.0.1:27017/llm_engine`).
  There is **no** `mongodb-memory-server`. Start a local Mongo before running tests.
- **Agent suite** additionally needs a reachable LLM (`TEST_LLM_PLATFORM`,
  `TEST_LLM_MODEL`, vLLM vars) and Chroma. See `.env.example`. If agent-suite tests fail
  with connection errors, check Chroma is up first: `docker ps --filter "ancestor=chromadb/chroma"`.
  If nothing is listed, start it with `yarn chroma:up` (runs on port 8000).
- `NODE_ENV=test` is set by the npm scripts; env comes from `.env`.

## ESM conventions (get these right or nothing loads)

- **Import paths use the `.js` extension even for `.ts` files**:
  `import setupIntTest from '../utils/setupIntTest.js'`. The config's `moduleNameMapper`
  rewrites `.js` → source. Omitting the extension breaks resolution.
- **`jest` is available as a global** (wired up in `tests/setup.ts`). You only need
  `import { jest } from '@jest/globals'` in files that touch `jest` at module top level —
  in practice, any file doing `jest.unstable_mockModule(...)`. When in doubt, add the
  import; it's harmless.

## Mocking — what works, what silently doesn't

### ✅ Preferred: dependency injection over module mocking

When the code exposes a setter/registry, inject test doubles instead of mocking a
module. Agent behavior is the main example — use `setAgentTypes()` to register fake
agent types whose `respond`/`evaluate`/`start`/`stop` are `jest.fn()`s:

```ts
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
const mockRespond = jest.fn()
const mockEvaluate = jest.fn()
setAgentTypes({ myTestAgent: { respond: mockRespond, evaluate: mockEvaluate, /* ... */ } })
```

This is how `agent.model.test.ts` and `conversation.service.test.ts` keep the LLM out
of the main suite. Reach for this first — it sidesteps ESM mocking entirely.

**If the flow under test actually starts the conversation** (not just creates a draft),
stub adapter types too, the same way, with `setAdapterTypes()`:

```ts
import { setAdapterTypes } from '../../src/models/adapter.model.js'
const mockAdapterStart = jest.fn()
setAdapterTypes({ zoom: { start: mockAdapterStart, stop: jest.fn(), getUniqueKeys: jest.fn() } })
```

Starting a conversation calls the real adapter type's `start()`, which for `zoom` makes
a live network call to Recall.ai to deploy the meeting bot. `emailSetup.service.test.ts`'s
on-demand flow does this; its invite-flow tests don't need it because that flow only ever
creates a draft.

Don't stub `getUniqueKeys` to return `[]` by reflex: `adapter.service.ts` uses it to
reject a second adapter starting on an already-active meeting, and `[]` silently defeats
that check. Return the real key list (for zoom, `['type', 'config.meetingUrl']`) if the
test depends on that uniqueness behavior, as `emailSetup.service.test.ts`'s "never hands
another organizer the links to someone else's active meeting" test does.

### ✅ Module mocking: `jest.unstable_mockModule` + `await import` (in this order)

This is the **only** reliable way to mock an ES module. The mock declaration must come
first, and the module under test must be imported *dynamically after it*:

```ts
import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetch = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('../src/services/analyticsSources/matomo.js', () => ({
  default: mockFetch,
  fetchMatomoSnapshot: mockFetch
}))

// dynamic import AFTER the mock, so it picks up the mocked module
const { fetchAndStoreSnapshot } = await import('../../src/services/analyticsSources/index.js')
```

Notes:

- Provide every export the consumer uses (`default` and named).
- Type the fns as `jest.fn<(...args: any[]) => Promise<any>>()` — the codebase does this
  and eslint-disables `no-explicit-any` on the line.
- `mockReset()` in `beforeEach` since the module instance is shared across tests.
- See `tests/unit/agents/vibesAnalyst/*.test.ts` and
  `tests/unit/services/analyticsSources/index.test.ts` for full examples.

### ✅ Spying on object methods

`jest.spyOn(obj, 'method')` works normally for objects/instances you already hold a
reference to (used in ~38 files). This does not fight ESM.

### ❌ Does NOT work under ESM — do not use

- **`jest.mock('module', factory)`** — not hoisted under ESM (no babel-plugin-jest-hoist),
  so by the time it runs the real module has already been statically imported. The mock
  never takes effect.
- **`jest.mock()` inside `beforeEach`/`beforeAll`** — same problem, guaranteed no-op.
  The static `import` at the top of the test file resolved the real module long before
  any lifecycle hook runs. There is an explicit write-up of this trap in
  `tests/models/agent.model.test.ts` (search for "never actually take effect").
- If you see `jest.mock('agenda')` lingering at the top of some integration files, treat
  it as legacy/questionable, not a pattern to copy. Prefer injection or
  `unstable_mockModule`.

## Integration test pattern (services, models, HTTP routes)

```ts
import request from 'supertest'
import app from '../../src/app.js'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { registeredUserAccessToken } from '../fixtures/token.fixture.js'

setupIntTest() // connects Mongo (beforeAll), wipes all collections (beforeEach), disconnects (afterAll)

test('GET returns the user', async () => {
  await insertUsers([registeredUser])
  const res = await request(app)
    .get(`/v1/users/user/${registeredUser._id}`)
    .set('Authorization', `Bearer ${registeredUserAccessToken}`)
    .expect(200)
  expect(res.body.username).toEqual(registeredUser.username)
})
```

- **`setupIntTest()`** (from `tests/utils/setupIntTest.js`) handles the Mongo lifecycle
  and clears every collection before each test — so tests start from an empty DB and must
  seed their own data.
- **HTTP** tests import the real `app` from `src/app.js` and drive it with `supertest`.
- **Auth**: use pre-built tokens from `tests/fixtures/token.fixture.js` with a matching
  seeded user from `user.fixture.js`.

## Agent / eval test pattern (`tests/agents/**`, live LLM)

```ts
import setupAgentTest from '../utils/setupAgentTest.js'
const testConfig = setupAgentTest('eventAssistant') // returns { llmPlatform, llmModel, embeddingsModel }
```

- **`setupAgentTest()`** calls `setupIntTest()` internally, then isolates a per-worker
  Chroma collection prefix and initializes evaluators. Use its returned `testConfig` to
  build agents/conversations at the model the suite is targeting.
- These tests are slow and nondeterministic (real model). Bump the timeout:
  `jest.setTimeout(120000)`.
- `tests/utils/agentTestHelpers.ts` has factories for the common setups:
  `createEventAssistantConversation`, `createBackChannelConversation`,
  `loadTestTranscript` / `load*Transcript`, `createUser`, `createMessage`, etc. Build
  scenarios from these rather than hand-assembling Mongo documents.

## Global-state hygiene (the #1 cause of cross-test thrashing)

Several "mocks" here mutate **module-level global registries**, not local objects. If you
set them and don't restore them, the fake leaks into every later test file in the serial
run and causes failures that look unrelated to your change. Always restore in `afterAll`:

```ts
import defaultAgentTypes from '../../src/agents/index.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import { setAdapterTypes, defaultAdapterTypes } from '.../adapter.model/index.js'

afterAll(() => {
  setAgentTypes(defaultAgentTypes)     // restore — REQUIRED if you called setAgentTypes()
  setAdapterTypes(defaultAdapterTypes) // same for adapter types
})
afterEach(async () => {
  jest.clearAllMocks()                 // reset jest.fn() call history between tests
})
```

- If you inject with `setAgentTypes(...)` / `setAdapterTypes(...)`, you **must** reset in
  `afterAll`. This is not optional — it is the most common source of "my test passes
  alone but breaks the suite" (and vice-versa).
- Reset `jest.fn()` call counts with `jest.clearAllMocks()` (`afterEach`) or `mockReset()`
  on the specific fn (common in `unstable_mockModule` unit tests, since the mocked module
  is shared across all tests in the file).

## Other gotchas

- **A real credential in your local `.env` can mask incomplete mocking.** If a service
  (Recall.ai, OpenAI, etc.) isn't stubbed, a live call to it will quietly succeed locally
  using your own `.env` secret and only fail in CI, where that secret isn't set. A test
  passing locally isn't proof it's fully mocked. If you're unsure, unset the credential
  (or point it at garbage) and rerun; it should still pass.
- **Mongoose indexes are NOT built automatically in tests.** If your test relies on a
  `unique`/compound index (e.g. asserting an upsert dedupes, or a duplicate insert
  rejects), call `await Model.syncIndexes()` in `beforeAll`. `setupIntTest()` clears
  documents with `deleteMany`, which does not build indexes. Without `syncIndexes()` the
  constraint silently won't fire and your assertion will be wrong.
- **`faker` is the legacy v5 package** (`"faker": "^5"`), **not** `@faker-js/faker`. The
  API differs. Use the v5 forms already in the fixtures: `faker.name.findName()`,
  `faker.internet.email()`, `faker.internet.userName()`, `faker.datatype.uuid()`,
  `faker.lorem.words()`. Don't copy `@faker-js` snippets from the web.
- **`tests/jest.setup.ts` is an orphan** — no config references it. Only `tests/setup.ts`
  is wired in (via `setupFilesAfterEnv`). Put global test setup in `tests/setup.ts`;
  editing `jest.setup.ts` does nothing.
- **The runner uses `--bail` and `--forceExit`.** `--bail` aborts the whole run on the
  first failing test, so a later failure can be hidden until you fix the earlier one — run
  a single file while iterating. `--forceExit` is there because Mongo/agenda handles don't
  always close cleanly; if you see the suite hang at the end, that's expected teardown
  behavior, not your test. Don't rely on process-exit side effects.
- **Memory**: the suite runs with `--max-old-space-size` bumped (8 GB main / 7 GB agent).
  It is genuinely memory-hungry because it loads the whole app; avoid adding tests that
  retain large objects across the file.
- **`development/` folders are excluded** from both suites (`tests/**/development/**`).
  Put throwaway/manual exploration tests there if you don't want them in CI; put anything
  that should actually run outside `development/`.

## Fixtures & helpers

- `tests/fixtures/*.fixture.ts` — canned domain objects (`user`, `topic`, `conversation`,
  `message`, `token`, `poll`, `follower`) plus `insert*` helpers that persist them. Seed
  with these; don't reinvent user/topic/token shapes.
- `tests/utils/` — shared setup and helpers (`setupIntTest`, `setupAgentTest`,
  `agentTestHelpers`, `transcriptUtils`, `waitFor`, `evaluators`).
- `tests/unit/**` — the genuinely isolated tests. They still often call `setupIntTest()`
  when they touch a model, but they mock collaborators with `unstable_mockModule`.

## Checklist for a new test

1. Does it need a live LLM? → `tests/agents/`, use `setupAgentTest()`, else main suite.
2. Import everything with `.js` extensions.
3. Need Mongo? Call `setupIntTest()` and seed via fixtures (DB is wiped each test).
4. Need to fake a collaborator? Prefer injection (`setAgentTypes`, constructor args);
   otherwise `jest.unstable_mockModule` **before** an `await import`. Never `jest.mock`.
5. Injected a global registry (`setAgentTypes`/`setAdapterTypes`)? Restore it in
   `afterAll`. Clear mocks in `afterEach`.
6. Asserting on a unique/compound index? `await Model.syncIndexes()` in `beforeAll`.
7. Using `faker`? It's v5 API, not `@faker-js/faker`.
8. Slow/live test? `jest.setTimeout(...)`.
9. Verify with `npm test -- <path>` (or `--config jest.agent.config.ts` for agent tests).
   Remember `--bail` hides later failures — iterate one file at a time.
