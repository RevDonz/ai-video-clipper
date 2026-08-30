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
- `E2E_JOB_ID` optionally pins a job. Without it, read-only tests inspect completed jobs newest-first, explicitly ignore only the documented invalid legacy candidate artifact response, and fail on authentication, transport, missing-job, and server errors.
- `E2E_CANDIDATE_ID` or comma-separated `E2E_CANDIDATE_IDS` pins mutation targets only. Read-only project/editor assertions always cover every available candidate.
- `E2E_RENDER_TIMEOUT_MS` must be a positive finite integer no greater than 24 hours and defaults to 10 minutes.
- Credentials are read only from environment variables and no storage state is written. Do not put credentials in command-line arguments or checked-in environment files.

Install a matching browser once with `npx playwright install chromium`.

`npm run test:e2e:list` explicitly enables local `E2E_ALLOW_SKIP=1` safety mode and only validates discovery. `npm run test:e2e:safe-skip` proves the no-credential skip path without starting a server. This opt-out is rejected in CI; CI and normal functional runs require both credentials.

Desktop runs all specs. Mobile Chromium runs the smoke and read-only suites, including nested editor deep-link authentication, all-candidate editor/control loading, weak ETag behavior, and advancing preview playback. Mutation specs are desktop-only and all retries are disabled.

## Production mutation gate

Mutation and render tests skip unless **both** conditions hold:

1. `E2E_ALLOW_MUTATION=1`
2. explicit `E2E_JOB_ID` and `E2E_CANDIDATE_ID(S)`

```bash
E2E_BASE_URL=https://example.invalid \
E2E_USERNAME=... E2E_PASSWORD=... \
E2E_ALLOW_MUTATION=1 E2E_JOB_ID=... E2E_CANDIDATE_ID=... \
npm run test:e2e -- --project=desktop-chromium e2e/mutation.spec.mjs
```

The edit test toggles only `audio.normalize`, verifies the new revision after reload, and restores the original value in a second revision. The render test is intentionally not reversible: it creates or reuses a final-render request, fails immediately on terminal failure/conflict/error, and otherwise waits up to the configured timeout.

Every page fixture records console errors, uncaught page errors, failed requests, and API responses with status 400 or higher. Only non-API document/media `net::ERR_ABORTED` lifecycle events are suppressed; API aborts remain failures. Collected diagnostics are printed on failures rather than attached to a report.

Tracing, screenshots, videos, and HTML reports are disabled, and Playwright output is never preserved. This avoids retaining browser views, typed credentials, or account-identifying UI by default and in CI. Terminal output can still contain application-generated error text and URLs, so handle CI logs according to the deployment's data policy. Generated result/report directories are ignored by git.
