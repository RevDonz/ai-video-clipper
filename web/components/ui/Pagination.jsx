"use client";

// HeroUI's Pagination: its <nav> is named "pagination" and the arrows carry no name of their own,
// so the wrapper names all three in Indonesian (05-ui-dashboard.md §3.7).
import { Pagination as HeroPagination } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function Pagination(props) {
  return <HeroPagination aria-label={ARIA.pagination} {...props} />;
}

function Previous(props) {
  return <HeroPagination.Previous aria-label={ARIA.prev} {...props} />;
}

function Next(props) {
  return <HeroPagination.Next aria-label={ARIA.next} {...props} />;
}

export default Object.assign(Pagination, HeroPagination, { Previous, Next });
