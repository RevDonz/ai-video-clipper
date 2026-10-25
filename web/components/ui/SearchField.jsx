"use client";

// HeroUI's SearchField with the clear button named in Indonesian (05-ui-dashboard.md §3.7).
import { SearchField as HeroSearchField } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function ClearButton(props) {
  return <HeroSearchField.ClearButton aria-label={ARIA.clearSearch} {...props} />;
}

function SearchField(props) {
  return <HeroSearchField {...props} />;
}

export default Object.assign(SearchField, HeroSearchField, { ClearButton });
