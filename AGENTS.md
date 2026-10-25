# Potongin: rules for every agent

This file is the single source of project rules for every coding agent (Claude Code imports it
from `CLAUDE.md`; Codex, Cursor, Gemini CLI and others read it directly). The rules come from the
owner; when one is in doubt, ask before acting against it.

**Current work and how to resume it: `docs/HANDOFF.md`. Read it first.** The overhaul plan
("rombak") is `docs/plans/2026-10-24-rombak/` (entry `00-README.md`; phase order in
`08-fase-test-deploy.md`); until PR #31 is merged it lives on branch `docs/rombak-spec`.

## Owner rules

- **Latest only.** The product shows only the newest method and UI. No version labels on screen
  (V1/V2/V3, "Selection V3", "Editor V3", prompt or engine versions, "mesin lama/baru") and no
  legacy mode choices. When something better is proven, it replaces the old one. Technical
  provenance stays in artifacts and logs.
- **Design.** Read `DESIGN.md` before any UI change and follow it, together with the antislop
  skills below.
- **Free LLMs first.** Use the free providers in the saved Pengaturan chain; never switch to a
  paid model or provider without asking the owner.
- **UI copy** lives in `web/messages/id/*.json` (source) and is translated for every locale in
  `web/lib/i18n/locales.mjs`. Short labels in every language. Content language (captions, titles,
  hashtags, LLM output) follows the video's language, never the UI language. English copy is
  written from the Indonesian catalog and the glossary only (clean-room). Terms come from
  `docs/glosarium.md`; a new term is added there in the PR that introduces it. Until the catalog
  exists (overhaul Fase 1, i18n M0), copy stays in the component: Indonesian, short and to the
  point. Operational docs, deploy self-checks, CLI messages and logs stay Indonesian.

## Engineering rules

- Never print, log or commit secrets. LLM keys live only in the encrypted settings store. This
  repository is public: no server addresses, usernames or credentials in commits either.
- `main` is protected and deploys to production on every merge (a docs-only push skips the image
  build and the deploy, `scripts/ci/deploy_scope.py`): PRs are merged with rebase (no merge
  commits). CI's gitleaks scans every ref, so allow known non-secrets in `.gitleaks.toml` by
  content (path + exact line), never by SHA fingerprint.
- Python stays 3.11-compatible (CI and production); `src/ai_clipper/edit_v2` is stdlib only; no
  new runtime dependencies without a reason.
- `web/proxy.js` buffers request bodies up to 10 MB: every upload route is excluded from the
  proxy matcher and authenticates itself (see `web/tests/proxy-matcher.test.mjs`).
- On the owner's PC, the local apps run on ports 3000 and 3001 and use `artifacts/local`
  (read-only for agents). Stop only processes you started, by PID; never kill by name or port.
- Tests first for behaviour changes; never weaken a threshold or a test to make it pass.
- **Migrations are additive only:** new tables, nullable or defaulted columns, new optional JSON
  fields. A migration file never changes once it is on `main`. Removing anything ("contract")
  ships only in a separate release and is recorded in the rollback matrix. DB rules and lint:
  `docs/plans/2026-10-24-rombak/01-arsitektur-data.md` §3.
- **Auth guards stay synchronous:** `requireAuth`, `currentUser` and the `authorize(request)` step
  of `secureRoute` never become `async`, and nobody writes `await authorize(`. When the DB-backed
  session lands (overhaul Fase 4), `web/tests/authorize-sync-contract.test.mjs` locks this.
- **Do not load the owner's PC with heavy tests** (owner's request, 2026-10-01). Many agents in
  parallel are fine; what lagged the PC was heavy test work. Locally run only targeted tests for
  the files you change. Whole suites, Docker image builds,
  FFmpeg gate measurements and browser suites run on GitHub Actions: push the work branch, then
  `gh workflow run editor-gates.yml -f ref=<branch> -f suite=full|image|command|e2e|player
  [-f command='…']` (`command`: a shell command in the image; `e2e`: the spec files under `web/`;
  `player`: the Playwright arguments), follow it with `gh run watch`, read failures with
  `gh run view --log-failed`, fetch outputs with `gh run download`. Before every push, scan with
  main's gitleaks config and change any fake key-like test value that trips it (CI scans every
  ref).
- A toolchain change (base image, Debian snapshot, package pins, Node, JASSUB) needs fresh
  evidence: `gh workflow run ci-cd.yml --ref <branch> -f suite=toolchain`, then commit the stamped
  `docs/editor/evidence/toolchain/record.json` (`docs/editor/OPERASIONAL.md` §3).

## Clean-room (SupoClip)

SupoClip is AGPL-3.0. Potongin stays free of AGPL as long as none of its code comes in.
- Allowed: reading SupoClip's docs, code and screenshots, and trying it, to understand behaviour,
  flows and edge cases. Clone it outside this repository.
- Forbidden: copying or closely paraphrasing its code, markup, CSS, UI strings, module names or
  constants; using its screenshots as Potongin assets; having SupoClip files open beside Potongin
  files while writing.
- Practice: read, close, write a behaviour note in your own words in the PR ("Rujukan
  perilaku"), then implement from the spec and Potongin's code.
- The English catalog is translated from the Indonesian catalog and the glossary, never from
  anyone else's text.
- Every PR description carries the line `Rujukan: rencana 2026-10-24-rombak + kode Potongin`. A
  PR that touches `web/messages/en/` also carries `Sumber copy: messages/id + glosarium`.

<!-- antislop:start -->
## antislop

antislop v3.2.20 is vendored in `.claude/skills/` (MIT, github.com/miqdadbadjuber/anti-slop).
For UI, copy, people, mobile layout, or code comments work, read the core
`.claude/skills/antislop/SKILL.md` and then the skill for the task:
- UI / visual: `.claude/skills/antislop-ui/SKILL.md`
- Copy & text: `.claude/skills/antislop-copywriting/SKILL.md`
- People (contrast, keyboard, focus, states): `.claude/skills/antislop-human/SKILL.md`
- Mobile / responsive: `.claude/skills/antislop-layoutmobile/SKILL.md`
- Code comments: `.claude/skills/antislop-code/SKILL.md`

Usage mode for this project: **during**. This is the owner's explicit choice (2026-09-30) and
counts as the explicit session instruction: never ask the mode question. Before the first edit,
announce `antislop active: during (project setting).`

Design direction: `DESIGN.md` (owner's answers, 2026-09-30). Dial: ENERGY 1 / RHYTHM 1 / MOTION 2.

The skill folders are vendored copies. One local change: `antislop-human` pre-approves only its
own `contrast-check.py` instead of any `python` command. To update, replace the folders with a
newer release and keep that change.
<!-- antislop:end -->
