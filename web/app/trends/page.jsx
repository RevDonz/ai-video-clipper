"use client";

// Tren (05-ui-dashboard.md §6.9): the switch that lets the next jobs use trends, the trend list
// with search and the Jenis and Status filters, Tambah tren and Ubah in a Modal, Hapus behind an
// AlertDialog, and for the admin the Agen tab (endpoint and tokens). Trends only shape a clip's
// packaging when its transcript names them (docs/plans/2026-09-25-konteks-tren.md).
import { Button, Label, ListBox, Select, Skeleton, Switch } from "@heroui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";

import AppShell from "../../components/AppShell.jsx";
import { useShellData } from "../../components/ShellData.jsx";
import TrendAgentPanel from "../../components/trends/TrendAgentPanel.jsx";
import TrendFormModal from "../../components/trends/TrendFormModal.jsx";
import TrendList from "../../components/trends/TrendList.jsx";
import { createTrendApi } from "../../components/trends/trend-api.mjs";
import AlertDialog from "../../components/ui/AlertDialog.jsx";
import PageHead from "../../components/ui/PageHead.jsx";
import SearchField from "../../components/ui/SearchField.jsx";
import Tabs from "../../components/ui/Tabs.jsx";
import { toast } from "../../components/ui/Toast.jsx";
import { msg } from "../../lib/i18n/descriptor.mjs";
import { localeOfIntl } from "../../lib/i18n/locales.mjs";
import {
  TREND_KINDS,
  TREND_KIND_NAMES,
  TREND_STATUS_FILTERS,
  filterTrendItems,
  groupTrendItems,
  normalizeTrendItem,
  trendCounts,
} from "../../lib/trend-view.mjs";
import "./trends.css";

const CLOCK_MS = 60_000;
// ?tab= words, the same in every UI language (07 §5).
const TAB_PARAM = Object.freeze({ list: "daftar", agent: "agen" });

function FilterSelect({ label, value, onChange, options }) {
  return (
    <Select className="trFilter" selectedKey={value} onSelectionChange={(key) => { if (key !== null) onChange(key); }}>
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function DeleteDialog({ item, busy, onConfirm, onClose }) {
  const t = useTranslations("trends");
  return (
    <AlertDialog isOpen={Boolean(item)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      {/* HeroUI's AlertDialog ignores Escape by default; here Escape closes it unless it is busy. */}
      <AlertDialog.Backdrop isKeyboardDismissDisabled={busy}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{item ? t("delete.confirm", { title: item.title }) : ""}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{item && item.source !== "manual" ? t("delete.agentBody") : t("delete.body")}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t("delete.cancel")}</Button>
              <Button variant="danger" isPending={busy} onPress={onConfirm}>{busy ? t("delete.busy") : t("delete.submit")}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

export default function TrendsPage() {
  const t = useTranslations("trends");
  const tAll = useTranslations();
  const locale = localeOfIntl(useLocale());
  const shell = useShellData();
  const isAdmin = (shell?.user?.role ?? "admin") === "admin";
  const api = useMemo(() => createTrendApi(), []);
  const [loadState, setLoadState] = useState("loading");
  const [loadError, setLoadError] = useState(null);
  const [items, setItems] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [lastIngestAt, setLastIngestAt] = useState(null);
  const [pendingEnabled, setPendingEnabled] = useState(null); // optimistic while the PUT is in flight
  const [pending, setPending] = useState(() => new Map()); // item id → optimistic switch state
  const [tokensState, setTokensState] = useState({ state: "loading", tokens: [], error: null });
  const [origin, setOrigin] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState("list");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [form, setForm] = useState(null); // { mode: "add" } | { mode: "edit", item }
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const mounted = useRef(true);

  async function loadTrends({ quiet = false } = {}) {
    if (!quiet) setLoadState("loading");
    const result = await api.loadTrends();
    if (!mounted.current) return;
    if (!result.ok) {
      if (quiet) toast(msg(tAll, result.error), { variant: "danger" });
      else {
        setLoadError(result.status === 404 ? null : result.error);
        setLoadState(result.status === 404 ? "unavailable" : "error");
      }
      return;
    }
    setItems(result.data.items);
    setEnabled(result.data.enabled);
    setLastIngestAt(result.data.lastIngestAt);
    setNow(Date.now());
    setLoadState("ready");
  }

  async function loadTokens({ quiet = false } = {}) {
    if (!isAdmin) return;
    if (!quiet) setTokensState((current) => ({ ...current, state: "loading", error: null }));
    const result = await api.loadTokens();
    if (!mounted.current) return;
    setTokensState(result.ok ? { state: "ready", tokens: result.data, error: null } : { state: "error", tokens: [], error: result.error });
  }

  useEffect(() => {
    mounted.current = true;
    setOrigin(window.location.origin);
    const asked = new URLSearchParams(window.location.search).get("tab");
    if (asked === TAB_PARAM.agent && isAdmin) setTab("agent");
    void loadTrends();
    void loadTokens();
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      mounted.current = false;
      clearInterval(clock);
    };
    // The page loads once; later reloads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function chooseTab(next) {
    if (next !== "list" && next !== "agent") return;
    setTab(next);
    const url = next === "agent" ? `/trends?tab=${TAB_PARAM.agent}` : "/trends";
    window.history.replaceState(window.history.state, "", url);
  }

  // Shows the new state at once and reverts on failure.
  async function toggleEnabled(next) {
    if (pendingEnabled !== null) return;
    setPendingEnabled(next);
    const result = await api.setEnabled(next);
    if (!mounted.current) return;
    setPendingEnabled(null);
    if (result.ok) {
      setEnabled(result.data.enabled);
      toast(result.data.enabled ? t("toast.on") : t("toast.off"), { variant: "success" });
    } else {
      toast(msg(tAll, result.error), { variant: "danger" });
    }
  }

  async function toggleItem(item, next) {
    if (pending.has(item.id)) return;
    setPending((current) => new Map(current).set(item.id, next));
    const result = await updateItem(item, { enabled: next });
    setPending((current) => {
      const copy = new Map(current);
      copy.delete(item.id);
      return copy;
    });
    if (result.ok) toast(next ? t("toast.itemOn", { title: item.title }) : t("toast.itemOff", { title: item.title }), { variant: "success" });
    else if (result.status !== 404) toast(msg(tAll, result.error), { variant: "danger" });
  }

  async function createItem(payload) {
    const result = await api.createTrend(payload);
    if (!mounted.current) return result;
    if (result.ok) {
      if (result.data) setItems((current) => [result.data, ...current.filter((entry) => entry.id !== result.data.id)]);
      else await loadTrends({ quiet: true });
      setNow(Date.now());
      setForm(null);
      toast(t("toast.added", { title: payload.title }), { variant: "success" });
    }
    return result;
  }

  async function updateItem(item, patch) {
    const result = await api.updateTrend(item.id, patch);
    if (!mounted.current) return result;
    if (result.ok) {
      const next = result.data || normalizeTrendItem({ ...item, ...patch });
      setItems((current) => current.map((entry) => (entry.id === item.id ? next : entry)));
      setNow(Date.now());
    } else if (result.status === 404) {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      toast(t("toast.gone", { title: item.title }), { variant: "danger" });
    }
    return result;
  }

  async function saveEdit(item, patch) {
    const result = await updateItem(item, patch);
    if (result.ok || result.status === 404) {
      setForm(null);
      if (result.ok) toast(t("toast.saved"), { variant: "success" });
      return { ...result, ok: true };
    }
    return result;
  }

  async function confirmRemove() {
    const item = removing;
    setRemoveBusy(true);
    const result = await api.deleteTrend(item.id);
    if (!mounted.current) return;
    setRemoveBusy(false);
    setRemoving(null);
    if (result.ok || result.status === 404) {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      toast(t("toast.deleted", { title: item.title }), { variant: "success" });
    } else {
      toast(msg(tAll, result.error), { variant: "danger" });
    }
  }

  async function createToken(label) {
    const result = await api.createToken(label);
    if (mounted.current && (result.ok || result.status === 409)) await loadTokens({ quiet: true });
    return result;
  }

  async function revokeToken(id) {
    const result = await api.revokeToken(id);
    if (mounted.current && (result.ok || result.status === 404)) await loadTokens({ quiet: true });
    return result;
  }

  const switchOn = pendingEnabled ?? enabled;
  const counts = trendCounts(items, now);
  const visible = groupTrendItems(filterTrendItems(items, { query, kind, status }, now), now).flatMap((group) => group.items);
  const filtered = query.trim() !== "" || kind !== "all" || status !== "all";
  const kindOptions = [
    { id: "all", label: `${t("filter.allKinds")} (${counts.all})` },
    ...TREND_KINDS.map((entry) => ({ id: entry, label: `${msg(tAll, TREND_KIND_NAMES[entry])} (${counts.byKind[entry] || 0})` })),
    ...(counts.byKind.other > 0 ? [{ id: "other", label: `${msg(tAll, TREND_KIND_NAMES.other)} (${counts.byKind.other})` }] : []),
  ];
  const statusOptions = TREND_STATUS_FILTERS.map((entry) => ({ id: entry.id, label: `${msg(tAll, entry.label)} (${entry.id === "all" ? counts.all : counts[entry.id]})` }));
  const resetFilters = () => { setQuery(""); setKind("all"); setStatus("all"); };

  const list = (
    <>
      <div className="trTools" role="search">
        <SearchField className="trSearch" value={query} onChange={setQuery} aria-label={t("search")}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("searchHint")} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <FilterSelect label={t("filter.kind")} value={kind} onChange={setKind} options={kindOptions} />
        <FilterSelect label={t("filter.status")} value={status} onChange={setStatus} options={statusOptions} />
      </div>
      <p className="visuallyHidden" role="status" aria-live="polite">{filtered ? t("found", { count: visible.length }) : ""}</p>
      {items.length === 0 ? (
        <div className="trEmpty">
          <h2>{t("empty")}</h2>
          {isAdmin && <Button variant="secondary" onPress={() => setForm({ mode: "add" })}>{t("add")}</Button>}
        </div>
      ) : visible.length === 0 ? (
        <div className="trEmpty">
          <h2>{t("notFound")}</h2>
          <Button variant="secondary" onPress={resetFilters}>{t("reset")}</Button>
        </div>
      ) : (
        <TrendList items={visible} now={now} locale={locale} isAdmin={isAdmin} pending={pending}
          onToggle={toggleItem} onEdit={(item) => setForm({ mode: "edit", item })} onDelete={setRemoving} />
      )}
    </>
  );

  return (
    <AppShell current="/trends" className="trendsPage">
      <div className="shell trPage">
        <PageHead title={t("title")}>
          <Switch isSelected={switchOn} onChange={toggleEnabled} isDisabled={loadState !== "ready"}>
            <Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
              {t("use")}
            </Switch.Content>
          </Switch>
          {isAdmin && loadState === "ready" && <Button variant="primary" onPress={() => setForm({ mode: "add" })}>{t("add")}</Button>}
        </PageHead>

        {loadState === "ready" && (
          <p className="trSummaryLine">{t("summary", { active: counts.active, inactive: counts.disabled, expired: counts.expired })}</p>
        )}

        {loadState === "loading" && (
          <div className="trSkeleton" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="trSkeletonRow" />)}
          </div>
        )}
        {loadState === "loading" && <span className="visuallyHidden" role="status">{t("loading")}</span>}
        {loadState === "unavailable" && <div className="trEmpty" role="status"><h2>{t("unavailable")}</h2></div>}
        {loadState === "error" && (
          <div className="trAlert" role="alert">
            <strong>{t("loadFailed")}</strong>
            {loadError ? <span>{msg(tAll, loadError)}</span> : null}
            <Button variant="secondary" onPress={() => loadTrends()}>{tAll("common.retry")}</Button>
          </div>
        )}

        {loadState === "ready" && (isAdmin ? (
          <Tabs selectedKey={tab} onSelectionChange={chooseTab} className="trTabs">
            <Tabs.List aria-label={t("tab.label")}>
              <Tabs.Tab id="list">{t("tab.list")}</Tabs.Tab>
              <Tabs.Tab id="agent">{t("tab.agent")}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel id="list">{list}</Tabs.Panel>
            <Tabs.Panel id="agent">
              <TrendAgentPanel origin={origin} tokensState={tokensState} now={now} locale={locale} lastIngestAt={lastIngestAt}
                onCreateToken={createToken} onRevokeToken={revokeToken} onReloadTokens={() => loadTokens()} />
            </Tabs.Panel>
          </Tabs>
        ) : list)}
      </div>

      <TrendFormModal
        mode={form?.mode ?? "add"}
        item={form?.mode === "edit" ? form.item : null}
        now={now}
        isOpen={Boolean(form)}
        onClose={() => setForm(null)}
        onSubmit={(payload) => (form?.mode === "edit" ? saveEdit(form.item, payload) : createItem(payload))}
      />
      <DeleteDialog item={removing} busy={removeBusy} onConfirm={confirmRemove} onClose={() => setRemoving(null)} />
    </AppShell>
  );
}
