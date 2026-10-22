// The app sidebar's phone and tablet form (components/AppShell.jsx): below MENU_BREAKPOINT_PX the
// sidebar folds into a top bar with a "Menu" button that opens it as a drawer. The state is plain
// data so the rules are tested without a browser.

export const MENU_BREAKPOINT_PX = 1024;
export const MENU_QUERY = `(max-width: ${MENU_BREAKPOINT_PX - 1}px)`;

export const INITIAL_MENU = Object.freeze({ open: false, returnFocus: false });

const closed = (returnFocus) => ({ open: false, returnFocus });

/**
 * The next state after one event; the given state is never changed. `returnFocus` tells the
 * shell to put focus back on the Menu button: after Escape, the close button or a click on the
 * dimmed page, never after a link was followed or the window grew past the breakpoint (the
 * button is gone there).
 */
export function menuReducer(state = INITIAL_MENU, event) {
  switch (event?.type) {
    case "toggle": return state.open ? closed(true) : { open: true, returnFocus: false };
    case "close":
    case "escape": return state.open ? closed(true) : state;
    case "navigate":
    case "wide": return state.open ? closed(false) : state;
    default: return state;
  }
}

/** The Menu button's visible label and its state for assistive technology. */
export function menuButtonView(state) {
  return state?.open
    ? { label: "Tutup", icon: "close", expanded: true }
    : { label: "Menu", icon: "menu", expanded: false };
}
