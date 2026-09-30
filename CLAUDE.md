# Potongin

Rules every session and every agent follows. They come from the owner; when one is in doubt, ask
before acting against it.

## Owner rules

- **Latest only.** The product shows only the newest method and UI. No version labels on screen
  (V1/V2/V3, "Selection V3", "Editor V3", prompt or engine versions, "mesin lama/baru") and no
  legacy mode choices. When something better is proven, it replaces the old one. Technical
  provenance stays in artifacts and logs.
- **Design.** Every UI change follows DESIGN.md (imported below) and the antislop skills.
- **Free LLMs first.** Use the free providers in the saved Pengaturan chain; never switch to a
  paid model or provider without asking the owner.
- **UI copy** is Indonesian, short and to the point.

## Engineering rules

- Never print, log or commit secrets. LLM keys live only in the encrypted settings store.
- `main` is protected: PRs are merged with rebase (no merge commits). CI's gitleaks scans every
  ref, so allow known non-secrets in `.gitleaks.toml` by content, never by SHA fingerprint.
- Python stays 3.11-compatible (CI and production); `src/ai_clipper/edit_v2` is stdlib only; no
  new runtime dependencies without a reason.
- `web/proxy.js` buffers request bodies up to 10 MB: every upload route is excluded from the
  proxy matcher and authenticates itself (see `web/tests/proxy-matcher.test.mjs`).
- The owner's local apps run on ports 3000 and 3001 and use `artifacts/local` (read-only for
  agents). Stop only processes you started, by PID; never kill by name or port.
- Tests first for behaviour changes; never weaken a threshold or a test to make it pass.

## Design direction

@DESIGN.md

<!-- antislop:start -->
## antislop

antislop v3.2.20 is installed as project skills in `.claude/skills/` (MIT, github.com/miqdadbadjuber/anti-slop).
For UI, copy, people, mobile layout, or code comments work, load the core skill `antislop` and then the skill for the task:
- UI / visual: `antislop-ui`
- Copy & text: `antislop-copywriting`
- People (contrast, keyboard, focus, states): `antislop-human`
- Mobile / responsive: `antislop-layoutmobile`
- Code comments: `antislop-code`

Usage mode for this project: **during**. This is the owner's explicit choice (2026-09-30) and counts as the explicit session instruction: never ask the mode question. Before the first edit, announce `antislop active: during (project setting).`

Design direction: `DESIGN.md` (owner's answers, 2026-09-30). Dial: ENERGY 1 / RHYTHM 1 / MOTION 2.

The skill folders are vendored copies. One local change: `antislop-human` pre-approves only its own `contrast-check.py` instead of any `python` command. To update, replace the folders with a newer release and keep that change.
<!-- antislop:end -->
