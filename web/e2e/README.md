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

Desktop runs all specs. Mobile Chromium runs the smoke and read-only suites: a project deep link through login, every clip card of a project (video, caption, download), advancing playback of the first clip, an old candidate-editor link landing on the project page, and 404 from the retired candidate-editor API routes, its source preview included. All retries are disabled.

The candidate editor and its mutation spec were retired on 2026-09-30. `E2E_ALLOW_MUTATION=1` now only gates the live Konteks Tren block below.

Every page fixture records console errors, uncaught page errors, failed requests, and API responses with status 400 or higher. Only browser-cancelled `GET` media requests (`net::ERR_ABORTED`, as when a page with videos is left) are ignored; every other abort remains a failure. The retired-route check reads its expected 404s from a second tab the fixture does not watch. Collected diagnostics are printed on failures rather than attached to a report.

Tracing, screenshots, videos, and HTML reports are disabled, and Playwright output is never preserved. This avoids retaining browser views, typed credentials, or account-identifying UI by default and in CI. Terminal output can still contain application-generated error text and URLs, so handle CI logs according to the deployment's data policy. Generated result/report directories are ignored by git.

## Konteks Tren

`e2e/trends.spec.mjs` covers the `/trends` page and the "Nyambung tren" chips on V3 clips. By default it fakes the `/api/context/*` routes inside the browser (and the job API for the chip test), so it changes no server data and runs against any target. It checks that hostile item text stays text, that mutations are same-origin with no browser dialogs, that a new token is shown once and gone after hiding and after a reload, keyboard reach, and no horizontal scroll at 390 px.

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

Run it against a production build (`npm run build` then `next start`), like the Konteks Tren spec. Because the job API is faked, it does not prove that the real route stores the focus; `web/tests/focus.test.mjs` does that with a real `POST /api/jobs` into a temp `JOBS_ROOT`.
