"use client";

// HeroUI's Tabs without Tabs.ListContainer: the container adds scroll buttons named in English
// ("Scroll tabs left"), and the app's tab rows are short enough to wrap instead
// (05-ui-dashboard.md §3.7). Parts: Tabs.List > Tabs.Tab, Tabs.Panel (shouldForceMount keeps a
// hidden panel mounted; React Aria's TabPanel prop, passed through by HeroUI 3.2.6).
import { Tabs as HeroTabs } from "@heroui/react";

function Tabs(props) {
  return <HeroTabs {...props} />;
}

export default Object.assign(Tabs, HeroTabs, { ListContainer: undefined });
