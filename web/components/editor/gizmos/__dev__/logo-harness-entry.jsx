// Entry of the logo e2e harness page (bundled by transcript/__dev__/bundle.mjs; never imported
// by the app): the whole editor shell, EditorApp, on the harness runtime of ./logo-harness.mjs.
// The Logo panel mounts from the panel registry and the logo gizmo in the Stage's gizmo slot, as
// in the app. Config: window.__HARNESS_CONFIG__ (see logo-harness.mjs), plus `panel`.
import { createRoot } from "react-dom/client";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../../__dev__/fakes.mjs";
import EditorApp from "../../EditorApp.jsx";
import { createLogoHarness } from "./logo-harness.mjs";

const config = window.__HARNESS_CONFIG__ ?? {};
const harness = createLogoHarness(config);
window.__harness = harness;
createRoot(document.getElementById("root")).render(
  <EditorApp jobId={FAKE_JOB_ID} clipId={FAKE_CLIP_ID} runtime={harness.runtime} initialPanel={config.panel ?? "logo"} />,
);
harness.store.ready.then(() => { harness.ready = true; });
