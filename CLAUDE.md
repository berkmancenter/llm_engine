# Project guide

`@berkmancenter/llm_engine` — Node 20/22, ESM, TypeScript. **Use `yarn`** (npm is
blocked). Always run `git` with `--no-pager`. Tests: see [tests/CLAUDE.md](tests/CLAUDE.md).

## Committing (non-interactive)

Commit with `-m` and a [Conventional Commit](https://www.conventionalcommits.org/)
message (`feat: ...`, `fix: ...`, `feat!: ...` for breaking). No `Co-authored-by` trailer.

```bash
git --no-pager commit -m "feat: subject"
```

commitlint (config-conventional) enforces: **every line ≤ 100 chars** (header
*and* each body line — hard-wrap the body), a lowercase `type:` prefix, and a
non-empty subject. For a multi-paragraph body, pass it via a file
(`git commit -F msg.txt`) so you control the wrapping.

Husky hooks run on every commit and **must not be bypassed** (`--no-verify`):

- [pre-commit](.husky/pre-commit): eslint (staged), prettier, `audit:critical`
- [commit-msg](.husky/commit-msg): commitlint validates the message format
- [prepare-commit-msg](.husky/prepare-commit-msg): interactive prompt that **auto-skips**
  with no TTY (CI/agents). Force it with `HUSKY_NONINTERACTIVE=1` if a stray TTY hangs it.

## Checks (run before pushing; none need a TTY)

```bash
yarn lint && yarn prettier && yarn build   # eslint / prettier --check / tsc typecheck
```

`yarn build` and tests are not enforced by any hook — run them yourself. Pushing runs
no hooks: `git --no-pager push`.
