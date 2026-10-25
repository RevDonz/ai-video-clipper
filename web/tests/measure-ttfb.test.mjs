// scripts/measure-ttfb.mjs, the TTFB record of 08 Fase 1, on a fake fetch: it signs in through
// the login form, sends the session only as a cookie, and reports nearest-rank statistics.
import assert from "node:assert/strict";
import test from "node:test";

import { PATHS, measure, percentile, signIn, summarize } from "../scripts/measure-ttfb.mjs";

test("the statistics are nearest-rank, rounded to 0.1 ms", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.deepEqual(summarize([10.04, 30, 20]), { samples: 3, medianMs: 20, p90Ms: 30, minMs: 10, maxMs: 30 });
});

test("it measures /, /dashboard and /login with the session cookie, after two warm-ups", async () => {
  assert.deepEqual(PATHS, ["/", "/dashboard", "/login"]);
  const seen = [];
  let clock = 0;
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.Cookie, init.redirect]);
    clock += 7;
    return new Response("ok", { status: 200 });
  };
  const result = await measure("http://127.0.0.1:3217/ignored", { samples: 3, cookie: "potongin_session=abc", fetchImpl, now: () => clock });
  assert.equal(seen.length, 3 * (2 + 3));
  assert.ok(seen.every(([, cookie, redirect]) => cookie === "potongin_session=abc" && redirect === "manual"));
  assert.deepEqual(seen.map(([url]) => url).filter((url, index, all) => all.indexOf(url) === index),
    ["http://127.0.0.1:3217/", "http://127.0.0.1:3217/dashboard", "http://127.0.0.1:3217/login"]);
  for (const path of PATHS) assert.deepEqual(result[path], { status: 200, samples: 3, medianMs: 7, p90Ms: 7, minMs: 7, maxMs: 7 });
});

test("signing in posts the login form from the same origin and keeps only the session cookie", async () => {
  assert.equal(await signIn("http://local", {}), null, "no credentials: unsigned measurement");
  let request;
  const ok = async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 303, headers: { "Set-Cookie": "potongin_session=tok.sig; Path=/; HttpOnly; Secure", Location: "/dashboard" } });
  };
  assert.equal(await signIn("http://local:3217/x", { username: "u", password: "p", fetchImpl: ok }), "potongin_session=tok.sig");
  assert.equal(request.url, "http://local:3217/api/auth/login");
  assert.equal(request.init.headers.Origin, "http://local:3217");
  assert.equal(request.init.body, "username=u&password=p&next=%2Fdashboard");
  const refused = async () => new Response(null, { status: 303, headers: { Location: "/login?error=1" } });
  await assert.rejects(signIn("http://local", { username: "u", password: "p", fetchImpl: refused }), /Sign-in failed \(status 303\)/);
});

test("editor-gates.yml records the TTFB on request, on the e2e app before any spec runs", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/editor-gates.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n {6}ttfb:\n {8}description: [^\n]+\n {8}required: false\n {8}default: false\n {8}type: boolean\n/);
  const step = /- name: Record the TTFB of \/, \/dashboard and \/login\n([\s\S]*?)\n\n/.exec(workflow)?.[1] ?? "";
  assert.match(step, /if: inputs\.suite == 'e2e' && inputs\.ttfb/);
  // The workflow's own copy of the script, so a ref without it (main before Fase 1) runs it too.
  assert.match(step, /git show "FETCH_HEAD:web\/scripts\/measure-ttfb\.mjs" > "\$RUNNER_TEMP\/measure-ttfb\.mjs"/);
  assert.match(step, /node "\$RUNNER_TEMP\/measure-ttfb\.mjs" http:\/\/127\.0\.0\.1:3217 30 > "\$GITHUB_WORKSPACE\/gate-output\/ttfb\.json"/);
  assert.ok(workflow.indexOf("Record the TTFB") > workflow.indexOf("Start the web app on the editor fakes"));
  assert.ok(workflow.indexOf("Record the TTFB") < workflow.indexOf("Browser specs on the editor fakes"));
});
