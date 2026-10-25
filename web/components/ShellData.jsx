"use client";

// The shell's server data (lib/shell-data.mjs: the user, the features and the enabled languages)
// for client pages: their segment layout (a server component) wraps them in
// <ShellData {...shellData()}> and AppShell reads it here when the page passes no props of its own.
import { createContext, useContext } from "react";

const ShellDataContext = createContext(null);

export default function ShellData({ user, features, locales, children }) {
  return <ShellDataContext value={{ user, features, locales }}>{children}</ShellDataContext>;
}

export function useShellData() {
  return useContext(ShellDataContext);
}
