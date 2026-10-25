"use client";

// HeroUI's Table with the selection checkboxes and the "load more" row named in Indonesian
// (05-ui-dashboard.md §3.7). Parts: Table.ScrollContainer > Table.Content > Table.Header/Column,
// Table.Body/Row/Cell, Table.LoadMore.
import { Checkbox, Table as HeroTable } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";

function SelectionBox({ label }) {
  return (
    <Checkbox aria-label={label} slot="selection">
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
}

/** The header's "select all" box, for Table.Content selectionMode="multiple". */
export function SelectAll() {
  return <SelectionBox label={ARIA.selectAll} />;
}

/** A row's box; `label` is the row's name, so the box reads "Pilih baris <name>". */
export function SelectRow({ label }) {
  return <SelectionBox label={label ? `${ARIA.selectRow} ${label}` : ARIA.selectRow} />;
}

function LoadMore(props) {
  return <HeroTable.LoadMore aria-label={ARIA.loadingMore} {...props} />;
}

function Table(props) {
  return <HeroTable {...props} />;
}

export default Object.assign(Table, HeroTable, { LoadMore });
