# Potongin

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
