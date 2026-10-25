# Browser functional E2E

The Playwright suite is read-only by default and can target local, staging, or production deployments. An invoked suite fails during configuration when credentials are missing, so a successful run cannot mean that every authenticated test silently skipped.

Playwright bookkeeping is written under the system temporary directory by default, not inside the repository. Override it only with `E2E_OUTPUT_DIR` when an isolated writable path is required.

## Configuration

```bash
E2E_BASE_URL=https://example.invalid \
E2E_USERNAME=... E2E_PASSWORD=... \
npm run test:e2e:read-only
```

- `E2E_BASE_URL` defaults to `http://127.0.0.1:3000`. A local target starts `npm run dev`; set `E2E_NO_WEB_SERVER=1` when it is already managed externally.
- `E2E_JOB_ID` optionally pins a project. Without it, the read-only tests open the newest completed project with clips, and fail on authentication, transport, missing-project, and server errors.
- Remote targets default to one worker, and CI is always fixed at one worker. Local runs follow Playwright's local default unless `E2E_WORKERS=N` is set; `N` must be a strict positive integer no greater than 16. Setting `E2E_WORKERS` above 1 for a remote target is an explicit concurrency-stress opt-in; production-safe coverage should retain the default single worker.
- Credentials are read only from environment variables and no storage state is written. Do not put credentials in command-line arguments or checked-in environment files.

Install a matching browser once with `npx playwright install chromium`.

`npm run test:e2e:list` explicitly enables local `E2E_ALLOW_SKIP=1` safety mode and only validates discovery. `npm run test:e2e:safe-skip` proves the no-credential skip path without starting a server. This opt-out is rejected in CI; CI and normal functional runs require both credentials.

Desktop runs all specs. Mobile Chromium runs the smoke, read-only, app-shell and aria-names suites: a project deep link through login, every clip of a project opened from its poster in the detail panel (video, caption, a download saved as `NN-judul`), advancing playback of the first clip, an old candidate-editor link landing on the project page, and 404 from the retired candidate-editor API routes, its source preview included. All retries are disabled.

Every project opens pages in Indonesian: `use.locale` is `id-ID` (the browser's `Accept-Language`) and the harness sets the `potongin_locale` cookie to the project's `uiLocale` (`id`). `E2E_EN_SMOKE=1` adds the `en-smoke` project (desktop, `en-US`, cookie `en`) for a server started with `POTONGIN_LOCALES=id,en`; it runs `smoke`, `read-only`, `app-shell`, `aria-names` and `i18n-locale`. It is opt-in because the post-deploy checks run every project and production stays Indonesian until English ships. `e2e/support/i18n.mjs` gives a spec the catalog text it expects in the project's language: `L(key, values?)` and `pageTitle(route)`; `LIn(locale, key, values?)` and `pageTitleIn(locale, route)` name the language for a request without the project's cookie. `tests/e2e-text-literal.test.mjs` keeps new text literals out of the specs (a per-file baseline): a new or rewritten check takes its text from `L()`.

`shell-screenshot.spec.mjs` writes the signed-in shell (the sidebar and its account menu at 1280 and 1024 px, the top bar, the open drawer and its account menu at 390 and 360 px) to `$EDITOR_GATES_OUT/shell-shots/`; run it on two refs through `editor-gates.yml -f suite=e2e` and compare the PNGs to show that a change left the shell as it was.

`e2e/app-shell.spec.mjs` covers the shared shell (`components/AppShell.jsx`) in the desktop and mobile projects and in `en-smoke`, with every name from the catalog (`L()`): the flat sidebar from 1024 px (the links in order, `aria-current` on the page, 44 px targets, no Menu button), the account menu (Escape gives focus back, Enter opens it from the keyboard), "Pintasan satu tombol" (`/` to the page's search and N to Buat klip while on; off in two clicks, kept in the `potongin_shortcuts` cookie across a reload, then both keys do nothing), Keluar through the hidden logout form, and below 1024 px the Menu drawer (focus inside, the page inert, Escape, Tutup and a tap beside it close it with focus back on Menu, the account menu inside it, closed when the window grows past 1024 px), plus the skip link. `e2e/aria-names.spec.mjs` reads the accessible names of the sidebar, the drawer and the account menu (and, in Indonesian, the whole help page and login: no "Close", "Next" … from HeroUI or React Aria, one `h1` and no skipped heading level); in `en-smoke` none of the shell's Indonesian words may name anything.

`e2e/i18n-locale.spec.mjs` checks that `<html lang>` and the page titles follow the project's language on `/login` and, signed in, on `/bantuan`, and that HTML responses carry `Cache-Control: private, no-store`. In `en-smoke` it also checks that a visitor without the cookie follows `Accept-Language` (`in` counts as Indonesian, `q=0` is dropped) and that the cookie wins over the header. In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/i18n-locale.spec.mjs [-f project=en-smoke]`; `project=en-smoke` starts the app with `POTONGIN_LOCALES=id,en`, and every e2e server runs with `POTONGIN_I18N_STRICT=1`, so a missing catalog key fails the page.

The candidate editor and its mutation spec were retired on 2026-09-30. `E2E_ALLOW_MUTATION=1` now only gates the live Konteks Tren block below.

Every page fixture records console errors, uncaught page errors, failed requests, and API responses with status 400 or higher. Only browser-cancelled `GET` media requests (`net::ERR_ABORTED`, as when a page with videos is left) are ignored; every other abort remains a failure. The retired-route check reads its expected 404s from a second tab the fixture does not watch. Collected diagnostics are printed on failures rather than attached to a report.

Tracing, screenshots, videos, and HTML reports are disabled, and Playwright output is never preserved. This avoids retaining browser views, typed credentials, or account-identifying UI by default and in CI. Terminal output can still contain application-generated error text and URLs, so handle CI logs according to the deployment's data policy. Generated result/report directories are ignored by git.

## Tren

`e2e/trends.spec.mjs` covers the `/trends` page and the "Nyambung tren" chips on V3 clips. By default it fakes the `/api/context/*` routes inside the browser (and the job API for the chip test), so it changes no server data and runs against any target. Selectors are roles with names from the catalog (`L(key)`): the table and its rows, the Jenis and Status `Select`s (button, then option), the Tambah tren / Ubah tren dialog, Hapus behind an `alertdialog`, the item and page switches, and the Agen tab (`?tab=agen`). It checks that hostile item text stays text, that mutations are same-origin with no browser dialogs, that a new token is shown once in a dialog and gone after Selesai and after a reload, keyboard reach (Escape closes the confirmation and the focus returns to ⋯), and no horizontal scroll at 390 px.

The live block talks to the real routes and runs only with `E2E_ALLOW_MUTATION=1` and `E2E_TRENDS_LIVE=1`. It creates and deletes one manual item, creates and revokes one token, asserts that the token list never contains the token value or a hash, and that the revoked token gets 401 on `GET /api/ingest/trends`.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
E2E_ALLOW_MUTATION=1 E2E_TRENDS_LIVE=1 \
npx playwright test --project=desktop-chromium e2e/trends.spec.mjs
```

Run it against a production build (`npm run build` then `next start`). Under `next dev`, React StrictMode mounts the project page twice and aborts its first job requests, which the harness counts as failed requests in the chip test.

## Fokus klip

`e2e/focus.spec.mjs` covers the focus chip input and note on the dashboard and the focus line and per-clip labels on the project page. It fakes `/api/jobs`, `/api/llm/status` and `/api/storage/status` inside the browser, so it creates no job and changes no server data; only the login is real. It checks that commas and Enter make chips, that a pasted list becomes one chip per line, that a term the transcript can never say literally gets a hint, that invalid text stays in the input with a message, that chips are removable by keyboard, that the job POST carries `focusTerms`/`focusNote` only when a focus is set and never names a selection mode, that the focus help follows the AI status, that hostile term text stays text, and that nothing scrolls sideways at 390 px.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/focus.spec.mjs
```

Run it against a production build (`npm run build` then `next start`), like the Konteks Tren spec. Because the job API is faked, it does not prove that the real route stores the focus; `web/tests/focus.test.mjs` does that with a real `POST /api/jobs` into a temp `JOBS_ROOT`. The focus field sits in the dashboard's "Arahkan pilihan momen" fold, so the spec opens it first.

## Dashboard form

`e2e/dashboard.spec.mjs` covers the "Buat klip" form: the link (or the chosen file) and Buat klip in one row, Jumlah klip, Rasio, Durasi and Layout always shown, the other options in three folds that each show a one-line summary, the duration presets and "Atur sendiri", "Bahasa video", and the last choices kept in `localStorage` (`potongin-dashboard-choices`). It fakes the same three APIs as the focus spec. It checks that the choices reach the job POST and come back after a reload while the link does not, that a problem inside a fold opens that fold and focuses the field, that the page runs on the defaults when the stored choices cannot be read or written, that a video dropped on the page becomes the source (another file is refused), that the 9:16 preview under "Tampilan klip" follows the layout, the subtitle style and the hook switch (both style thumbnails load) and its note names Edit klip only when the jobs list says the editor is on, and that at 360 px nothing scrolls sideways and the form's controls are 44 px targets.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/dashboard.spec.mjs
```

## Batalkan

`e2e/cancel-job.spec.mjs` covers "Batalkan" on a running job, on the dashboard and in the project page's progress panel. It fakes the job API and `POST /api/jobs/<id>/cancel` inside the browser, so it changes no server data; only the login is real. It checks that the confirmation opens inside the page (a browser dialog fails the test) with the focus on "Lanjutkan proses", that Escape closes it and returns the focus to "Batalkan", that "Ya, batalkan" sends one same-origin POST, that the dashboard then reads "Dibatalkan" without a percentage and the project page shows "Proses dibatalkan" with the focus on it, and that at 360 px the confirmation fits with 44 px buttons and no horizontal scroll. The real route and the runner (processes that must die, partial files removed) are covered by `web/tests/job-cancel.test.mjs` and `web/tests/job-cancel-runner.test.mjs`.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/cancel-job.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/cancel-job.spec.mjs`.

## Badge job di header

`e2e/header-badge.spec.mjs` covers the job badge beside the brand in the shared header (`docs/operations/PROGRES_JOB.md` "Di header"). It fakes `GET /api/jobs` and `GET /api/jobs/<id>` inside the browser on `/bantuan`, so it changes no server data; only the login is real. It checks "1 berjalan · 42%" as a link to the project, the next read going to that job alone, a moving percentage leaving the `aria-live` region empty, "Terakhir: 3 klip" with "Proyek selesai: 3 klip" announced when the job finishes, an immediate refresh on the `potongin:jobs-changed` event, "Terakhir: gagal" and "Terakhir: dibatalkan", no badge without jobs, no request while the tab is hidden and one at once when it shows again, the badge right after the brand in the tab order, and at 360 px the short form on the brand row as a 44 px target with no horizontal scroll (the full text at 390 px). The view model, the announcements and the polling schedule are covered by `web/tests/job-badge.test.mjs`. The hidden-tab test waits 7 s on purpose.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/header-badge.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/header-badge.spec.mjs`.

## Halaman proyek

`e2e/project-workspace.spec.mjs` covers the project page as a workspace: posters that open one detail panel, left/right between clips (the focus follows on the posters, one tab stop), the "Semua", "Skor 8+" and "Diedit" filters, the neutral score pill with its mark for 8 and up, "NN-judul" download links, "Pilih" mode by click and keyboard with "Unduh (n)", "Pilih semua", Escape and "Unduh semua", the size-limit refusal shown on the page, and at 390 px one column with posters two across, the panel under them, 44 px targets and no horizontal scroll. It fakes the job, its clips listing and the ZIP route inside the browser, so it changes no server data; the download tests run in a second tab because a started download and the faked 413 are the point there. With `AXE_CORE_PATH` it also runs axe on the clip section. The real ZIP route is covered by `web/tests/clips-zip.test.mjs` (Python's `zipfile` reads every archive).

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/project-workspace.spec.mjs
```

## Judul dan deskripsi

`e2e/clip-text.spec.mjs` covers "Ubah" and "Tulis ulang" in the project page's caption box. It fakes the job API, `PATCH /api/jobs/<id>/clip-text` and `POST /api/jobs/<id>/clip-text/rewrite` inside the browser, so it changes no server data and asks no LLM; only the login is real. It checks that "Ubah" opens Judul and Deskripsi with the focus on Judul and the character count, that an empty title is named and not sent, that "Simpan" sends one JSON PATCH and the heading, poster, "Unduh MP4" name and "Salin caption" follow with the focus back on "Ubah", that an unsaved draft waits while another clip is shown and "Batal" drops it, that "Tulis ulang" shows "Saran AI" where "Pakai" fills the form without saving and "Buang" returns the focus, that a failure links to `/bantuan#llm_<code>` and Pengaturan, and that at 390 px the form has 44 px targets and no horizontal scroll. With `AXE_CORE_PATH` it runs axe on the clip section with a suggestion open. The real routes and the CLI are covered by `web/tests/clip-text-api.test.mjs` and `tests/test_post_text.py`.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/clip-text.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/clip-text.spec.mjs`.

`e2e/clip-hook.spec.mjs` covers the "Hook di video" switch in the same caption box. It fakes the job API, the clips listing, `POST /api/jobs/<id>/clips/<clipId>/hook` and `POST …/renders` inside the browser, so it changes no server data; only the login is real. It checks that a click sends one JSON save from the listed revision and one export of the saved revision, that the status line and "Ekspor sedang diproses" follow, that Space and Enter switch it, that a clip without a hook has no switch, that a conflict says so and keeps the switch as it was, and that at 390 px the switch is a 44 px target with no horizontal scroll. With `AXE_CORE_PATH` it runs axe on the clip section. The real route and the CLI are covered by `web/tests/clip-hook-api.test.mjs` and `tests/test_edit_v2_hook_toggle.py`.

```bash
npx playwright test --project=desktop-chromium e2e/clip-hook.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/clip-hook.spec.mjs`.

## Bantuan

`e2e/bantuan.spec.mjs` covers the help page (`/bantuan`, `docs/operations/BANTUAN.md`). It needs no server data; the failed project it opens is faked inside the browser, so it changes nothing and runs against any target. Every name and text comes from the catalog (`L()`), so it runs in each UI language. It checks that a pasted yt-dlp line opens its entry (the address gets `#<code>`, the entry is the `:target` and takes the focus), that a text nothing fits says so and keeps the focus in the box, that the Indonesian message of a code is found in every UI language, that the guide topics are folded and the one the address names opens by itself (also on a later `#topic` link), that anchors, the guide and the search work with JavaScript off (the GET form is redirected to the entry, the topics read open), that the "Cara memperbaiki" link of a failed download leads to its entry, keyboard reach, and no horizontal scroll at 390 px.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/bantuan.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/bantuan.spec.mjs`.

## Proyek

`e2e/projects.spec.mjs` covers `/projects` with a faked job list and delete: the status filter with counts and the search kept in the URL (`?status=`, `?q=`), "Tidak ditemukan" and Tampilkan semua, ⋯ with Buka and Edit klip as links, a single delete behind an `alertdialog` (Batal keeps it), a batch delete where one request is refused (toast "1 dihapus, 1 gagal", the refused row stays selected), and at 360 px the card list, Buat klip in the head and no horizontal scroll.

## Proyek: Klip

`e2e/history-clips.spec.mjs` covers the "Proyek | Klip" tabs of Proyek (`?tab=klip`, remembered without it): the clip grid with the project page's posters (neutral score pill, its mark for 8 and up, the project name on each card), the "Hari ini" heading and the older page under "Lebih lama", the choice kept across a reload, "Muat lagi" appending the next page and moving the focus to its first card, the search and the "Skor 8+" and "Minggu ini" chips reaching the request, "Tampilkan semua klip" after an empty result, a card opening its clip on the project page (`?klip=N`, that poster focused), a refused listing with "Coba lagi" (in a second tab, as the refusal is the point), and at 390 px posters two across, 44 px targets and no horizontal scroll. It fakes `GET /api/clips` and the opened job inside the browser; the real listing is covered by `web/tests/clip-library.test.mjs`.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/history-clips.spec.mjs
```

## Pengaturan: Logo bawaan

`e2e/settings-logo.spec.mjs` covers the "Logo bawaan" card on Pengaturan (CONTRACTS §5.36). It fakes `/api/settings/logo` and the logo image inside the browser, so it changes no server data; only the login is real. It checks the empty state, an upload through the hidden file input (the POST carries the asset transport headers) that shows the logo with its name and size, "Hapus" by keyboard, a GIF refused before anything is sent, the copy for automatic clips on the editor's engine, the card with uploads off (replace disabled, remove still possible), "Coba lagi" after a failed load, and at 390 px 44 px buttons with no horizontal scroll. The real routes, the store and the job copy are covered by `web/tests/default-logo.test.mjs`.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/settings-logo.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/settings-logo.spec.mjs`.

## Pengaturan: Cookies YouTube

`e2e/settings-youtube-cookies.spec.mjs` covers the "Cookies YouTube" card on Pengaturan (`docs/operations/UNDUHAN_YOUTUBE.md`). It fakes `/api/settings/youtube-cookies` inside the browser, so it changes no server data; only the login is real. It checks the empty state with the separate-account advice, an upload through the hidden file input (the POST carries the file unchanged as `text/plain`) that shows the saved and dropped counts and the upload time, "Hapus" by keyboard, a file over 1 MB refused before anything is sent, the warning for cookies without a login cookie, the card without the sealing secret (upload off), stored cookies that no longer open (re-upload asked, removal still possible), a JSON export refused with its reason, "Coba lagi" after a failed load, and at 390 px 44 px buttons with no horizontal scroll. The real route, the check, the sealed store and the worker's copy are covered by `web/tests/youtube-cookies.test.mjs` and `web/tests/worker-download.test.mjs`.

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/settings-youtube-cookies.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/settings-youtube-cookies.spec.mjs`.

## Pengaturan: Teks watermark bawaan

`e2e/settings-watermark.spec.mjs` covers the "Teks watermark bawaan" card on Pengaturan (CONTRACTS §5.43). It fakes `/api/settings/watermark` inside the browser, so it changes no server data; only the login is real. It checks the empty form, an empty text refused before anything is sent, typing, the place list, the size and opacity sliders by keyboard, the PUT body (the text trimmed), "Hapus" by keyboard, a saved watermark filling the form, the copy for automatic clips on the editor's engine, "Coba lagi" after a failed load, and at 390 px 44 px controls with no horizontal scroll. The real route, the settings file and the job copy are covered by `web/tests/default-watermark.test.mjs`. The editor's own section is in `e2e/editor-logo.spec.mjs` (harness).

```bash
E2E_BASE_URL=http://127.0.0.1:3417 E2E_NO_WEB_SERVER=1 \
E2E_USERNAME=... E2E_PASSWORD=... \
npx playwright test --project=desktop-chromium e2e/settings-watermark.spec.mjs
```

In CI: `gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command=e2e/settings-watermark.spec.mjs`.
