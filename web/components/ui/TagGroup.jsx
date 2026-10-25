"use client";

// HeroUI's TagGroup and Tag: a tag's remove button names itself "Remove tag", so this one says
// "Hapus <tag>" when the caller passes the tag's text as `label` (05-ui-dashboard.md §3.7).
import { Tag as HeroTag, TagGroup as HeroTagGroup } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function RemoveButton({ label, ...props }) {
  return <HeroTag.RemoveButton aria-label={label ? `${ARIA.removeTag} ${label}` : ARIA.removeTag} {...props} />;
}

function Tag(props) {
  return <HeroTag {...props} />;
}

function TagGroup(props) {
  return <HeroTagGroup {...props} />;
}

export const TagItem = Object.assign(Tag, HeroTag, { RemoveButton });
export default Object.assign(TagGroup, HeroTagGroup);
