"use client";

// A date field with a calendar popover (HeroUI DatePicker + DateField + Calendar), its calendar
// and month buttons named in Indonesian (05-ui-dashboard.md §3.7). Pages load it with
// next/dynamic, so its JS and date-picker.css reach only the screens that schedule something.
import { Calendar, DateField, DatePicker as HeroDatePicker, Label } from "@heroui/react";

import { ARIA } from "./aria-labels.mjs";
import "./date-picker.css";

export default function DatePicker({ label, ...props }) {
  return (
    <HeroDatePicker {...props}>
      <Label>{label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          <HeroDatePicker.Trigger aria-label={ARIA.calendar}>
            <HeroDatePicker.TriggerIndicator />
          </HeroDatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <HeroDatePicker.Popover>
        <Calendar aria-label={ARIA.calendar}>
          <Calendar.Header>
            <Calendar.Heading />
            <Calendar.NavButton slot="previous" aria-label={ARIA.prevMonth} />
            <Calendar.NavButton slot="next" aria-label={ARIA.nextMonth} />
          </Calendar.Header>
          <Calendar.Grid>
            <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
            <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
          </Calendar.Grid>
        </Calendar>
      </HeroDatePicker.Popover>
    </HeroDatePicker>
  );
}
