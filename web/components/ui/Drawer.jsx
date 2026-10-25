"use client";

// HeroUI's Drawer with its close trigger named in Indonesian (05-ui-dashboard.md §3.7). The parts
// are HeroUI's: Drawer.Backdrop > Drawer.Content > Drawer.Dialog > Drawer.Header/Heading/Body/Footer.
import { Drawer as HeroDrawer } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function CloseTrigger(props) {
  return <HeroDrawer.CloseTrigger aria-label={ARIA.close} {...props} />;
}

function Drawer(props) {
  return <HeroDrawer {...props} />;
}

export default Object.assign(Drawer, HeroDrawer, { CloseTrigger });
