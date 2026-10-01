# Potongin: rules for every agent

This file is the single source of project rules for every coding agent (Claude Code imports it
from `CLAUDE.md`; Codex, Cursor, Gemini CLI and others read it directly). The rules come from the
owner; when one is in doubt, ask before acting against it.

**Current work and how to resume it: `docs/HANDOFF.md`. Read it first.**

## Owner rules

- **Latest only.** The product shows only the newest method and UI. No version labels on screen
  (V1/V2/V3, "Selection V3", "Editor V3", prompt or engine versions, "mesin lama/baru") and no
  legacy mode choices. When something better is proven, it replaces the old one. Technical
  provenance stays in artifacts and logs.
- **Design.** Read `DESIGN.md` before any UI change and follow it, together with the antislop
  skills below.
- **Free LLMs first.** Use the free providers in the saved Pengaturan chain; never switch to a
  paid model or provider without asking the owner.
- **UI copy** is Indonesian, short and to the point.

## Engineering rules

- Never print, log or commit secrets. LLM keys live only in the encrypted settings store. This
  repository is public: no server addresses, usernames or credentials in commits either.
- `main` is protected and deploys to production on every merge: PRs are merged with rebase (no
  merge commits). CI's gitleaks scans every ref, so allow known non-secrets in `.gitleaks.toml`
  by content (path + exact line), never by SHA fingerprint.
- Python stays 3.11-compatible (CI and production); `src/ai_clipper/edit_v2` is stdlib only; no
  new runtime dependencies without a reason.
- `web/proxy.js` buffers request bodies up to 10 MB: every upload route is excluded from the
  proxy matcher and authenticates itself (see `web/tests/proxy-matcher.test.mjs`).
- On the owner's PC, the local apps run on ports 3000 and 3001 and use `artifacts/local`
  (read-only for agents). Stop only processes you started, by PID; never kill by name or port.
- Tests first for behaviour changes; never weaken a threshold or a test to make it pass.
- **Do not load the owner's PC** (owner's request, 2026-10-01). Locally run only targeted tests
  for the files you change; at most 3 agents in parallel. Whole suites, Docker image builds,
  FFmpeg gate measurements and browser suites run on GitHub Actions: push the work branch, then
  `gh workflow run editor-gates.yml -f ref=<branch> -f suite=full|image|command [-f command='…']`,
  follow it with `gh run watch`, read failures with `gh run view --log-failed`, fetch outputs with
  `gh run download`. Before every push, scan with main's gitleaks config and change any fake
  key-like test value that trips it (CI scans every ref).

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
