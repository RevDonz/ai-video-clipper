// Registry of the Stage gizmos (plan Appendix C.1; §11.2 T2.Z W3 scaffolding): interactive
// overlays drawn over the 9:16 stage in its gizmo slot (Stage.jsx `data-slot="gizmos"`), in stage
// pixels scaled from the output size. T3.2 owns gizmos/** and replaces LogoGizmo.jsx.
//
// Every gizmo receives the same props: `{ plan, state, dispatch, player, output, readOnly }`.
// `load` is a lazy import, so this file stays importable outside the bundler (node tests).
const entry = (fields) => Object.freeze(fields);

export const GIZMOS = Object.freeze([
  entry({
    id: "logo", wave: "W3", owner: "T3.2", component: "LogoGizmo",
    file: "gizmos/LogoGizmo.jsx", load: () => import("./LogoGizmo.jsx"),
  }),
]);

export function gizmoById(id) {
  return GIZMOS.find((gizmo) => gizmo.id === id) ?? null;
}
