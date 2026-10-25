"use client";

// The trend list of Tren (05-ui-dashboard.md §6.9): a table from 768 px, cards below. Each item
// shows its title, summary, keywords, hashtags and example links (untrusted text, rendered as
// text; links only http(s), hardened), its kind, status, expiry and source, a switch that turns
// it on or off for the next jobs and, for the admin, ⋯ with Ubah and Hapus.
import { Chip, Dropdown, Switch, buttonVariants } from "@heroui/react";
import { useTranslations } from "use-intl";

import { msg } from "../../lib/i18n/descriptor.mjs";
import {
  TREND_SENSITIVITY_LABELS,
  TREND_STATUS_LABELS,
  expiryView,
  platformLabels,
  sourceLabel,
  trendItemStatus,
  trendKindLabel,
} from "../../lib/trend-view.mjs";
import Table from "../ui/Table.jsx";

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function StatusChips({ item, now }) {
  const tAll = useTranslations();
  const t = useTranslations("trends");
  const status = trendItemStatus(item, now);
  return (
    <span className="trChips">
      <Chip size="sm" variant="soft" color={status === "active" ? "success" : "default"}><Chip.Label>{msg(tAll, TREND_STATUS_LABELS[status])}</Chip.Label></Chip>
      {item.sensitivity === "sensitive" && <Chip size="sm" variant="soft" color="danger"><Chip.Label>{msg(tAll, TREND_SENSITIVITY_LABELS.sensitive)}</Chip.Label></Chip>}
      {item.score !== null && <span className="trScore">{t("item.score", { score: item.score })}</span>}
    </span>
  );
}

function Details({ item }) {
  const t = useTranslations("trends");
  return (
    <>
      {item.summary ? <span className="trSummary">{item.summary}</span> : null}
      {(item.keywords.length > 0 || item.hashtags.length > 0) && (
        <ul className="trTerms" aria-label={t("item.terms")}>
          {item.keywords.map((keyword) => <li key={`k-${keyword}`}>{keyword}</li>)}
          {item.hashtags.map((tag) => <li key={`h-${tag}`} className="tag">{tag}</li>)}
        </ul>
      )}
      {item.examples.length > 0 && (
        <ul className="trExamples" aria-label={t("item.examples")}>
          {item.examples.map((example) => (
            <li key={example.url}>
              <a href={example.url} target="_blank" rel="noopener noreferrer nofollow">{example.host} ↗</a>
              {example.note ? <span>{example.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function UseSwitch({ item, pending, onToggle }) {
  const t = useTranslations("trends");
  const on = pending.has(item.id) ? pending.get(item.id) : item.enabled;
  return (
    <Switch aria-label={t("item.use", { title: item.title })} isSelected={on} onChange={(next) => onToggle(item, next)}>
      <Switch.Content>
        <Switch.Control><Switch.Thumb /></Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

function Actions({ item, onEdit, onDelete }) {
  const t = useTranslations("trends");
  return (
    <Dropdown>
      <Dropdown.Trigger className={buttonVariants({ variant: "ghost", isIconOnly: true })} aria-label={t("item.more", { title: item.title })}>
        <MoreIcon />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={t("item.more", { title: item.title })} onAction={(key) => (key === "edit" ? onEdit(item) : onDelete(item))}>
          <Dropdown.Item id="edit" textValue={t("item.edit")}>{t("item.edit")}</Dropdown.Item>
          <Dropdown.Item id="delete" variant="danger" textValue={t("item.delete")}>{t("item.delete")}</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function Expiry({ item, now, locale }) {
  const tAll = useTranslations();
  const view = expiryView(item, now, locale);
  return <span className={`trExpiry ${view.tone}`} title={view.absolute || undefined}>{msg(tAll, view.label)}</span>;
}

function Meta({ item }) {
  const tAll = useTranslations();
  const platforms = platformLabels(item.platforms).map((label) => msg(tAll, label));
  return (
    <span className="trMeta">
      <span>{msg(tAll, sourceLabel(item.source))}</span>
      {platforms.length > 0 && <span>{platforms.join(", ")}</span>}
    </span>
  );
}

export default function TrendList({ items, now, locale, isAdmin, pending, onToggle, onEdit, onDelete }) {
  const t = useTranslations("trends");
  const tAll = useTranslations();
  return (
    <>
      <div className="trWide">
        <Table className="trTable">
          <Table.ScrollContainer>
            <Table.Content aria-label={t("list")}>
              <Table.Header>
                <Table.Column isRowHeader>{t("col.title")}</Table.Column>
                <Table.Column>{t("col.kind")}</Table.Column>
                <Table.Column>{t("col.status")}</Table.Column>
                <Table.Column>{t("col.expiry")}</Table.Column>
                <Table.Column>{t("col.use")}</Table.Column>
                <Table.Column><span className="visuallyHidden">{t("col.actions")}</span></Table.Column>
              </Table.Header>
              <Table.Body items={items}>
                {(item) => (
                  <Table.Row id={item.id} textValue={item.title}>
                    <Table.Cell>
                      <span className="trTitleCell">
                        <strong className="trTitle">{item.title}</strong>
                        <Details item={item} />
                        <Meta item={item} />
                      </span>
                    </Table.Cell>
                    <Table.Cell>{msg(tAll, trendKindLabel(item.kind))}</Table.Cell>
                    <Table.Cell><StatusChips item={item} now={now} /></Table.Cell>
                    <Table.Cell><Expiry item={item} now={now} locale={locale} /></Table.Cell>
                    <Table.Cell><UseSwitch item={item} pending={pending} onToggle={onToggle} /></Table.Cell>
                    <Table.Cell>{isAdmin ? <Actions item={item} onEdit={onEdit} onDelete={onDelete} /> : null}</Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </div>
      <ul className="trCards trNarrow" aria-label={t("list")}>
        {items.map((item) => (
          <li key={item.id}>
            <article className="trCard" aria-labelledby={`trend-${item.id}`}>
              <div className="trCardHead">
                <h3 id={`trend-${item.id}`}>{item.title}</h3>
                {isAdmin ? <Actions item={item} onEdit={onEdit} onDelete={onDelete} /> : null}
              </div>
              <span className="trCardLine">
                <span>{msg(tAll, trendKindLabel(item.kind))}</span>
                <StatusChips item={item} now={now} />
              </span>
              <Details item={item} />
              <span className="trCardLine">
                <Expiry item={item} now={now} locale={locale} />
                <Meta item={item} />
              </span>
              <UseSwitch item={item} pending={pending} onToggle={onToggle} />
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}
