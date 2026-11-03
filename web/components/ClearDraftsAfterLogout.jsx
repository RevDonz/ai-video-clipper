"use client";

// After a logout (/login?keluar=1) this device keeps no editor draft (rombak 02 §6.2).
import { useEffect } from "react";

import { clearAllDrafts } from "../lib/editor/draft-store.mjs";

export default function ClearDraftsAfterLogout() {
  useEffect(() => {
    clearAllDrafts();
  }, []);
  return null;
}
