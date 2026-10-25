// Entry of the logo e2e harness page (bundled by transcript/__dev__/bundle.mjs; never imported
// by the app): the whole editor shell, EditorApp, on the harness runtime of ./logo-harness.mjs.
// The Logo panel mounts from the panel registry and the logo gizmo in the Stage's gizmo slot, as
// in the app. Config: window.__HARNESS_CONFIG__ (see logo-harness.mjs), plus `panel`. The editor
// reads its words from the Indonesian catalog, as the editor's layout provides it in the app.
import { createRoot } from "react-dom/client";

import I18n from "../../../../lib/i18n/client.jsx";
import aria from "../../../../messages/id/aria.json";
import common from "../../../../messages/id/common.json";
import editor from "../../../../messages/id/editor.json";
import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../../__dev__/fakes.mjs";
import EditorApp from "../../EditorApp.jsx";
import { createLogoHarness } from "./logo-harness.mjs";

const config = window.__HARNESS_CONFIG__ ?? {};
const harness = createLogoHarness(config);
window.__harness = harness;
createRoot(document.getElementById("root")).render(
  <I18n locale="id" messages={{ aria, common, editor }} timeZone="Asia/Jakarta">
    <EditorApp jobId={FAKE_JOB_ID} clipId={FAKE_CLIP_ID} runtime={harness.runtime} initialPanel={config.panel ?? "logo"} />
  </I18n>,
);
harness.store.ready.then(() => { harness.ready = true; });
