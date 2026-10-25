"use client";

// Pengaturan → AI (05-ui-dashboard.md §6.10): Aktifkan AI, Hanya model gratis, and the provider
// order, tried from the top. A draft card of the one save bar. Each provider is a card with its
// key, [Uji], an Aktif switch and ⋯ (Naikkan, Turunkan, Hapus); the rest of its fields sit under
// "Lanjutan", whose title says what they are set to. Problems show as alerts; the always-on
// status card is gone.
import { Alert, Button, Card, Chip, ComboBox, Description, Disclosure, Dropdown, FieldError, Input, Label, ListBox, Select, Switch, TextField } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { apiErrorMessage } from "../../lib/api-error.mjs";
import { helpHref } from "../../lib/help-catalog.mjs";
import { LLM_PRESETS, MAX_DISPLAY_NAME_LENGTH, REASONING_EFFORTS, SERVER_TEMPLATES, isFreeModel } from "../../lib/llm-presets.mjs";
import {
  availableProviders,
  baseUrlHost,
  customServerDraft,
  draftFromSettings,
  draftSignature,
  draftToPayload,
  moveProvider,
  nextCustomProvider,
  providerDraft,
  providerLabel,
  providerSignatures,
  providerStatusLine,
  serverTemplateFor,
  subscriptionModels,
} from "../../lib/llm-settings-view.mjs";
import AddProviderModal from "./AddProviderModal.jsx";
import { CardLoadError, CardLoading, CardNotice } from "./CardState.jsx";
import { cardDomId, useSaveAll, useSettingsCard } from "./SettingsSave.jsx";
import { useViewText } from "./view-text.jsx";

const CARD = "llm";
// Draft fields whose edits clear the matching server/validation error.
const ERROR_FIELD = { keyValue: "apiKey", keyAction: "apiKey", fallbackText: "fallbackModels" };
// The fields under "Lanjutan": an error in one of them opens it.
const ADVANCED_FIELDS = ["model", "baseUrl", "fallbackModels", "reasoningEffort", "contextTokens", "maxOutputTokens", "timeout", "rpm", "maxRetries", "temperature", "jsonMode", "httpReferer", "appTitle"];

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { ok: response.ok, status: response.status, payload };
}

// The server's issues ("providers[0].baseUrl") and the draft's own, keyed by provider name.
function keyedErrors(providers, raw) {
  const out = {};
  for (const [field, message] of Object.entries(raw)) {
    const match = /^providers\[(\d+)\]\.(\w+)$/.exec(field);
    if (match && providers[Number(match[1])]) out[`${providers[Number(match[1])].provider}.${match[2]}`] = message;
    else out.general = [...(out.general ?? []), message];
  }
  return out;
}

const upFront = (preset) => Boolean(preset.custom || preset.local);

function FieldText({ item, field, label, errors, onChange, text, placeholder, description, type = "text", inputMode, maxLength, wide = false }) {
  const error = errors[`${item.provider}.${field === "fallbackText" ? "fallbackModels" : field}`];
  return (
    <TextField
      value={item[field]}
      onChange={(value) => onChange({ [field]: value })}
      isInvalid={Boolean(error)}
      type={type}
      maxLength={maxLength}
      className={wide ? "settingsTextField settingsWide" : "settingsTextField"}
    >
      <Label>{label}</Label>
      <Input placeholder={placeholder} inputMode={inputMode} spellCheck={false} autoCapitalize="off" autoComplete="off" />
      {description ? <Description>{description}</Description> : null}
      <FieldError>{text(error)}</FieldError>
    </TextField>
  );
}

function KeyField({ item, preset, errors, onChange, text }) {
  const t = useTranslations("settings");
  const id = `${item.provider}-apiKey`;
  const error = errors[`${item.provider}.apiKey`];
  const editing = item.keyAction === "replace" || (!item.apiKeySet && item.keyAction !== "clear");
  const label = preset.requiresKey ? t("ai.apiKey") : t("ai.apiKeyOptional");
  if (!editing) {
    const tone = item.keyAction === "clear" ? "warning" : item.apiKeyUnreadable ? "error" : "ok";
    const state = item.keyAction === "clear"
      ? t("common.keyRemovedOnSave")
      : item.apiKeyUnreadable ? t("common.keyUnreadable") : item.keySource === "env" ? t("ai.keyFromEnv") : t("ai.keySaved");
    return (
      <div className="settingsField">
        <span id={`${id}-label`} className="settingsLabel">{label}</span>
        <div className="settingsKeyState" data-tone={tone} role="group" aria-labelledby={`${id}-label`}>
          <span>{state}</span>
          {item.keyAction === "clear" ? (
            <Button variant="secondary" onPress={() => onChange({ keyAction: "keep", keyValue: "" })}>{t("common.cancel")}</Button>
          ) : (
            <>
              <Button variant="secondary" onPress={() => onChange({ keyAction: "replace", keyValue: "" })}>
                {item.apiKeyUnreadable ? t("common.refill") : t("common.replace")}
              </Button>
              <Button variant="danger" onPress={() => onChange({ keyAction: "clear", keyValue: "" })}>{t("common.remove")}</Button>
            </>
          )}
        </div>
        {error ? <p className="settingsFieldError" role="alert">{text(error)}</p> : null}
      </div>
    );
  }
  return (
    <TextField
      type="password"
      value={item.keyValue}
      onChange={(value) => onChange({ keyValue: value, keyAction: value || item.apiKeySet ? "replace" : "keep" })}
      isInvalid={Boolean(error)}
      className="settingsTextField"
    >
      <Label>{label}</Label>
      <div className="settingsRow">
        <Input placeholder={item.apiKeySet ? t("common.pasteNewKey") : t("common.pasteKey")} autoComplete="new-password" spellCheck={false} autoCapitalize="off" />
        {item.apiKeySet && <Button variant="secondary" onPress={() => onChange({ keyAction: "keep", keyValue: "" })}>{t("common.cancel")}</Button>}
      </div>
      <Description>
        {t("ai.keyHelp")}
        {preset.keyUrl ? <>{" "}<a className="settingsLink" href={preset.keyUrl} target="_blank" rel="noopener noreferrer">{t("common.getKey")}</a></> : null}
      </Description>
      <FieldError>{text(error)}</FieldError>
    </TextField>
  );
}

function ModelField({ item, preset, errors, onChange, text, models, onFetchModels, freeOnly, locked }) {
  const t = useTranslations("settings");
  const error = errors[`${item.provider}.model`];
  const listing = models[item.provider];
  const filterFree = freeOnly && item.provider === "openrouter";
  const shown = listing?.state === "done" ? listing.list.filter((model) => !filterFree || isFreeModel("openrouter", model)) : [];
  const placeholder = preset.defaultModel ? t("ai.placeholderDefault", { value: preset.defaultModel }) : t("ai.modelPlaceholder");
  return (
    <div className="settingsField settingsWide">
      <div className="settingsRow settingsRowEnd">
        <ComboBox
          allowsCustomValue
          inputValue={item.model}
          onInputChange={(value) => onChange({ model: value })}
          onChange={(key) => key !== null && key !== undefined && onChange({ model: String(key) })}
          isInvalid={Boolean(error)}
          menuTrigger="input"
          className="settingsTextField settingsGrow"
        >
          <Label>{preset.custom ? t("ai.modelRequired") : t("ai.model")}</Label>
          <ComboBox.InputGroup>
            <Input placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoComplete="off" />
            <ComboBox.Trigger />
          </ComboBox.InputGroup>
          <FieldError>{text(error)}</FieldError>
          <ComboBox.Popover>
            <ListBox>
              {shown.map((model) => <ListBox.Item key={model} id={model} textValue={model}>{model}</ListBox.Item>)}
            </ListBox>
          </ComboBox.Popover>
        </ComboBox>
        <Button variant="secondary" onPress={onFetchModels} isDisabled={listing?.state === "loading" || locked}>
          {listing?.state === "loading" ? t("ai.fetchingModels") : t("ai.fetchModels")}
        </Button>
      </div>
      {listing?.state === "done" && shown.length === 0 && (
        <p className="settingsMuted">{filterFree ? t("ai.noFreeModels") : t("ai.noModels")}</p>
      )}
      {listing?.state === "done" && shown.length > 0 && (
        <p className="settingsMuted">{t("ai.modelCount", { count: shown.length })}</p>
      )}
      {listing?.state === "error" && <p className="settingsFieldError" role="alert">{listing.message}</p>}
    </div>
  );
}

function ChoiceField({ label, value, options, onChange }) {
  return (
    <Select value={value === "" ? "default" : value} onChange={(key) => onChange(key === "default" ? "" : String(key))} className="settingsSelect">
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

function ProviderCard({ item, index, count, freeOnly, errors, text, statusLine, locked, test, models, expanded, onExpand, onChange, onMove, onRemove, onTest, onFetchModels }) {
  const t = useTranslations("settings");
  const tAria = useTranslations("aria");
  const format = useFormatter();
  const preset = LLM_PRESETS[item.provider];
  const label = providerLabel(item);
  const template = serverTemplateFor(item) ? SERVER_TEMPLATES[serverTemplateFor(item)] : null;
  const titleId = `provider-${item.provider}-title`;
  const host = baseUrlHost(item.baseUrl.trim());
  const baseUrlFirst = upFront(preset);
  const subscription = subscriptionModels(item);
  let result = null;
  if (test?.state === "running") result = { tone: "muted", text: t("ai.testing") };
  else if (test?.state === "done" && test.result.status === "ok") {
    result = { tone: "ok", text: t("ai.testOk", { ms: Math.round((test.result.latencyS ?? 0) * 1000) }) };
  } else if (test?.state === "done") result = { tone: "error", text: test.result.message, help: helpHref(test.result.code) };
  else if (test?.state === "error") result = { tone: "error", text: text(test.message) };
  else if (locked) result = { tone: "muted", text: t("ai.testLocked") };

  const badges = [];
  if (preset.local) badges.push({ text: t("ai.badge.local"), tone: "default" });
  else if (preset.custom) badges.push({ text: t("ai.badge.server"), tone: "default" });
  else if (preset.paidOnly) badges.push({ text: t("ai.badge.paid"), tone: freeOnly ? "warning" : "default" });
  else badges.push({ text: t("ai.badge.free"), tone: "default" });
  if (!preset.requiresKey) badges.push({ text: t("ai.badge.keyOptional"), tone: "default" });

  const summaryModel = item.model.trim() || preset.defaultModel || t("ai.modelDefault");
  const summarySeconds = item.timeout.trim() || String(preset.timeout);
  const numberField = (field, labelText, placeholder) => (
    <FieldText item={item} field={field} label={labelText} errors={errors} onChange={onChange} text={text}
      inputMode="decimal" placeholder={placeholder} />
  );
  const onMenu = (key) => {
    if (key === "up") onMove(-1);
    else if (key === "down") onMove(1);
    else if (key === "remove") onRemove();
  };

  return (
    <Card id={`provider-${item.provider}`} className="settingsProvider" data-off={item.enabled ? undefined : "true"} aria-labelledby={titleId} role="group">
      <Card.Header className="settingsProviderHead">
        <span className="settingsRank"><span className="visuallyHidden">{t("ai.rank")} </span>{index + 1}</span>
        <div className="settingsProviderName">
          <h3 id={titleId}>{label}</h3>
          <div className="settingsProviderMeta">
            {host && <span className="settingsMuted">{host}</span>}
            {badges.map((badge) => <Chip key={badge.text} size="sm" color={badge.tone}>{badge.text}</Chip>)}
            {statusLine && !locked && <Chip size="sm" color={statusLine.tone === "ok" ? "success" : statusLine.tone === "error" ? "danger" : "warning"}>{text(statusLine)}</Chip>}
          </div>
        </div>
        <div className="settingsProviderTools">
          <Button variant="secondary" onPress={onTest} isDisabled={test?.state === "running" || locked}>
            {test?.state === "running" ? t("ai.testing") : t("ai.test")}
          </Button>
          <Dropdown>
            <Dropdown.Trigger className="settingsMore" aria-label={tAria("moreActions", { name: label })}>
              <span aria-hidden="true">⋯</span>
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu aria-label={tAria("moreActions", { name: label })} onAction={onMenu}
                disabledKeys={[...(index === 0 ? ["up"] : []), ...(index === count - 1 ? ["down"] : [])]}>
                <Dropdown.Item id="up" textValue={t("ai.moveUp")}>{t("ai.moveUp")}</Dropdown.Item>
                <Dropdown.Item id="down" textValue={t("ai.moveDown")}>{t("ai.moveDown")}</Dropdown.Item>
                <Dropdown.Item id="remove" variant="danger" textValue={t("common.remove")}>{t("common.remove")}</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </Card.Header>

      <Card.Content className="settingsStack">
        <Switch isSelected={item.enabled} onChange={(value) => onChange({ enabled: value })} className="settingsSwitch">
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            {t("ai.providerOn")}
          </Switch.Content>
        </Switch>

        {template?.warning && (
          <p className="settingsMuted">
            {template.docsUrl
              ? <a className="settingsLink" href={template.docsUrl} target="_blank" rel="noopener noreferrer">{t("tos9router")}</a>
              : t("tos9router")}
          </p>
        )}
        {subscription.length > 0 && <CardNotice tone="error" title={t("ai.subscription")}>{subscription.join(", ")}</CardNotice>}
        {freeOnly && preset.paidOnly && item.enabled && <CardNotice tone="warning">{t("ai.paidSkipped")}</CardNotice>}

        <div className="settingsGrid">
          {preset.custom && (
            <FieldText item={item} field="name" label={t("ai.name")} errors={errors} onChange={onChange} text={text}
              placeholder={preset.label} maxLength={MAX_DISPLAY_NAME_LENGTH} wide />
          )}
          <KeyField item={item} preset={preset} errors={errors} onChange={onChange} text={text} />
          {baseUrlFirst && (
            <FieldText item={item} field="baseUrl" label={preset.custom ? t("ai.baseUrlRequired") : t("ai.baseUrl")} type="url" errors={errors} onChange={onChange} text={text}
              placeholder={preset.baseUrl ? t("ai.placeholderDefault", { value: preset.baseUrl }) : t("ai.baseUrlPlaceholder")} />
          )}
          {baseUrlFirst && (
            <ModelField item={item} preset={preset} errors={errors} onChange={onChange} text={text} models={models} onFetchModels={onFetchModels} freeOnly={freeOnly} locked={locked} />
          )}
        </div>

        <Disclosure isExpanded={expanded} onExpandedChange={onExpand} className="settingsAdvanced">
          <Disclosure.Heading>
            <Disclosure.Trigger className="settingsAdvancedTrigger">
              <span>{t("ai.advanced")}</span>
              <span className="settingsMuted">{t("ai.advancedSummary", { model: summaryModel, seconds: summarySeconds })}</span>
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="settingsGrid">
              {!baseUrlFirst && (
                <ModelField item={item} preset={preset} errors={errors} onChange={onChange} text={text} models={models} onFetchModels={onFetchModels} freeOnly={freeOnly} locked={locked} />
              )}
              {!baseUrlFirst && (
                <FieldText item={item} field="baseUrl" label={t("ai.baseUrl")} type="url" errors={errors} onChange={onChange} text={text}
                  placeholder={t("ai.placeholderDefault", { value: preset.baseUrl })} wide />
              )}
              <FieldText item={item} field="fallbackText" label={t("ai.fallback")} errors={errors} onChange={onChange} text={text} wide
                placeholder={preset.fallbackModels.length ? t("ai.placeholderDefault", { value: preset.fallbackModels.join(", ") }) : t("ai.fallbackNone")}
                description={t("ai.fallbackHelp")} />
              <ChoiceField
                label={t("ai.reasoning")}
                value={item.reasoningEffort}
                onChange={(value) => onChange({ reasoningEffort: value })}
                options={[{ id: "default", label: t("ai.reasoningDefault") }, ...REASONING_EFFORTS.map((effort) => ({ id: effort, label: effort }))]}
              />
              {numberField("timeout", t("ai.timeout"), t("ai.placeholderDefault", { value: preset.timeout }))}
              {numberField("contextTokens", t("ai.contextTokens"), t("ai.placeholderDefault", { value: preset.contextTokens }))}
              {numberField("maxOutputTokens", t("ai.maxOutputTokens"), t("ai.placeholderDefault", { value: preset.maxOutputTokens }))}
              {numberField("rpm", t("ai.rpm"), preset.rpm ? t("ai.placeholderDefault", { value: preset.rpm }) : t("ai.rpmNone"))}
              {numberField("maxRetries", t("ai.maxRetries"), t("ai.placeholderDefault", { value: 3 }))}
              {numberField("temperature", t("ai.temperature"), t("ai.placeholderDefault", { value: format.number(0.2) }))}
              <ChoiceField
                label={t("ai.jsonMode")}
                value={item.jsonMode}
                onChange={(value) => onChange({ jsonMode: value })}
                options={[{ id: "default", label: t("ai.jsonDefault") }, { id: "true", label: t("ai.jsonOn") }, { id: "false", label: t("ai.jsonOff") }]}
              />
              {item.provider === "openrouter" && (
                <>
                  <FieldText item={item} field="httpReferer" label={t("ai.httpReferer")} errors={errors} onChange={onChange} text={text} placeholder={t("ai.httpRefererPlaceholder")} />
                  <FieldText item={item} field="appTitle" label={t("ai.appTitle")} errors={errors} onChange={onChange} text={text} placeholder={t("ai.placeholderDefault", { value: "Potongin" })} />
                </>
              )}
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>

        {result && (
          <p className="settingsStatus" data-tone={result.tone} role="status" aria-live="polite">
            {result.text}
            {result?.help && <>{" "}<a className="settingsLink" href={result.help}>{t("ai.testHelp")}</a></>}
          </p>
        )}
      </Card.Content>
    </Card>
  );
}

export default function AiSettings() {
  const t = useTranslations("settings");
  const tRoot = useTranslations();
  const locale = useLocale();
  const failure = (payload, status, fallback) => apiErrorMessage(tRoot, payload, status, { locale, fallback, domain: "llm" });
  const text = useViewText();
  const saveAll = useSaveAll();
  const [loadState, setLoadState] = useState("loading");
  const [loaded, setLoaded] = useState(null);
  const [draft, setDraft] = useState(() => draftFromSettings(null));
  const [baseline, setBaseline] = useState(() => draftSignature(draftFromSettings(null)));
  const [savedProviders, setSavedProviders] = useState({});
  const [errors, setErrors] = useState({});
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tests, setTests] = useState({});
  const [models, setModels] = useState({});
  const [expanded, setExpanded] = useState({});
  const mounted = useRef(true);

  const dirty = loadState === "ready" && draftSignature(draft) !== baseline;
  const settings = loaded?.settings || null;
  const source = settings?.source || null;

  function applyLoaded(payload) {
    const next = draftFromSettings(payload.settings);
    setLoaded(payload);
    setDraft(next);
    setBaseline(draftSignature(next));
    setSavedProviders(providerSignatures(next));
    setErrors({});
  }

  async function load() {
    setLoadState("loading");
    setNotice(null);
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm");
      if (!mounted.current) return;
      if (!ok || !payload) {
        setLoadState("error");
        setNotice({ tone: "error", text: status === 401 ? t("common.error.session") : failure(payload, status, t("ai.loadFailed")) });
        return;
      }
      applyLoaded(payload);
      setTests({});
      setModels({});
      setLoadState("ready");
    } catch {
      if (!mounted.current) return;
      setLoadState("error");
      setNotice({ tone: "error", text: t("ai.serverDown") });
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, []);

  function clearErrors(name, patch) {
    setErrors((current) => {
      const next = { ...current };
      for (const field of Object.keys(patch)) delete next[`${name}.${ERROR_FIELD[field] || field}`];
      return next;
    });
  }

  function updateProvider(name, patch) {
    setDraft((current) => ({ ...current, providers: current.providers.map((item) => (item.provider === name ? { ...item, ...patch } : item)) }));
    clearErrors(name, patch);
    if (notice?.tone === "ok") setNotice(null);
  }

  function updateGeneral(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    if (notice?.tone === "ok") setNotice(null);
  }

  function move(index, delta) {
    setDraft((current) => ({ ...current, providers: moveProvider(current.providers, index, delta) }));
  }

  // Test results, model lists and the open "Lanjutan" belong to one entry: a server removed and
  // added again under the same id starts clean.
  function forget(name) {
    const drop = (current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    };
    setTests(drop);
    setModels(drop);
    setExpanded(drop);
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !field.startsWith(`${name}.`))));
  }

  // Removing is a draft change like any other: the key goes only when Simpan runs, and the bar's
  // Batalkan brings the provider back.
  function remove(item) {
    setDraft((current) => ({ ...current, providers: current.providers.filter((entry) => entry.provider !== item.provider) }));
    forget(item.provider);
  }

  function append(entry) {
    forget(entry.provider);
    setDraft((current) => ({ ...current, providers: [...current.providers, entry] }));
    requestAnimationFrame(() => {
      const card = document.getElementById(`provider-${entry.provider}`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.querySelector("input")?.focus({ preventScroll: true });
    });
  }

  function addServer(templateId) {
    const entry = customServerDraft(draft, templateId);
    if (entry) append(entry);
  }

  async function save() {
    const { payload, errors: found } = draftToPayload(draft, source === "ui" ? settings.updatedAt : null);
    const keyed = keyedErrors(draft.providers, found);
    setErrors(keyed);
    const count = Object.keys(keyed).length;
    if (count) {
      setNotice({ tone: "error", text: t("ai.invalid", { count }) });
      openFailed(keyed);
      return { ok: false };
    }
    setNotice(null);
    try {
      const { ok, status, payload: body } = await requestJson("/api/settings/llm", { method: "PUT", body: payload });
      if (!mounted.current) return { ok: false };
      if (ok) {
        applyLoaded({ ...loaded, settings: body.settings, status: body.status, envImportAvailable: false, envWarnings: [], envError: null, fileError: null });
        setTests({});
        return { ok: true };
      }
      if (status === 422 && Array.isArray(body?.issues)) {
        const issues = keyedErrors(draft.providers, Object.fromEntries(body.issues.map((issue) => [issue.field, issue.message])));
        setErrors(issues);
        openFailed(issues);
        setNotice({ tone: "error", text: failure(body, status, t("ai.notValid")) });
      } else if (status === 409) {
        setNotice({ tone: "error", text: failure(body, status, t("ai.conflict")), reload: true });
      } else {
        setNotice({ tone: "error", text: status === 401 ? t("common.error.session") : failure(body, status, t("ai.saveFailed")) });
      }
    } catch {
      if (mounted.current) setNotice({ tone: "error", text: t("ai.saveOffline") });
    }
    return { ok: false };
  }

  // Opens "Lanjutan" on each provider with an error in it, then focuses the first marked field.
  function openFailed(keyed) {
    const open = {};
    for (const field of Object.keys(keyed)) {
      const [name, part] = field.split(".");
      if (part && ADVANCED_FIELDS.includes(part) && !upFront(LLM_PRESETS[name] ?? {})) open[name] = true;
    }
    setExpanded((current) => ({ ...current, ...open }));
    requestAnimationFrame(() => document.querySelector(`#${cardDomId(CARD)} [aria-invalid=true], #${cardDomId(CARD)} [data-invalid=true] input`)?.focus());
  }

  useSettingsCard(CARD, "ai", {
    dirty,
    save,
    discard: () => {
      if (loaded) applyLoaded(loaded);
      setNotice(null);
    },
  });

  async function importEnv() {
    if (dirty && !window.confirm(t("ai.importConfirm"))) return;
    setImporting(true);
    setNotice(null);
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm/import-env", { method: "POST", body: {} });
      if (!mounted.current) return;
      if (ok) {
        applyLoaded({ ...loaded, settings: payload.settings, status: payload.status, envImportAvailable: false, envWarnings: payload.warnings || [], envError: null, fileError: null });
        setTests({});
        setNotice({ tone: "ok", text: t("ai.imported", { count: payload.settings.providers.length }) });
      } else {
        setNotice({ tone: "error", text: status === 401 ? t("common.error.session") : failure(payload, status, t("ai.importFailed")) });
      }
    } catch {
      if (mounted.current) setNotice({ tone: "error", text: t("ai.importOffline") });
    } finally {
      if (mounted.current) setImporting(false);
    }
  }

  async function runTest(name) {
    setTests((current) => ({ ...current, [name]: { state: "running" } }));
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm/test", { method: "POST", body: { provider: name } });
      if (!mounted.current) return;
      setTests((current) => ({
        ...current,
        [name]: ok && payload?.result
          ? { state: "done", result: payload.result }
          : { state: "error", message: status === 401 ? { key: "common.error.session" } : { text: failure(payload, status, t("ai.testError")) } },
      }));
    } catch {
      if (mounted.current) setTests((current) => ({ ...current, [name]: { state: "error", message: { key: "common.error.offline" } } }));
    }
  }

  async function fetchModels(name) {
    setModels((current) => ({ ...current, [name]: { state: "loading" } }));
    try {
      const { ok, status, payload } = await requestJson("/api/settings/llm/models", { method: "POST", body: { provider: name } });
      if (!mounted.current) return;
      setModels((current) => ({
        ...current,
        [name]: ok && Array.isArray(payload?.models)
          ? { state: "done", list: payload.models, truncated: payload.truncated === true }
          : { state: "error", message: status === 401 ? t("common.error.session") : failure(payload, status, t("ai.modelsError")) },
      }));
    } catch {
      if (mounted.current) setModels((current) => ({ ...current, [name]: { state: "error", message: t("common.error.offline") } }));
    }
  }

  const statusByName = Object.fromEntries((loaded?.status?.providers || []).map((item) => [item.name, item]));
  const onSubmit = (event) => {
    event.preventDefault();
    if (dirty) void saveAll();
  };

  return (
    <section id={cardDomId(CARD)} tabIndex={-1} className="settingsCard settingsAi" aria-label={t("tab.ai")} aria-busy={loadState === "loading"}>
      {loadState === "loading" && <CardLoading label={t("common.loading")} lines={4} />}
      {loadState === "error" && <CardLoadError message={notice?.text || t("ai.loadFailed")} onRetry={load} />}

      {loadState === "ready" && (
        <form className="settingsStack" onSubmit={onSubmit} noValidate>
          {!loaded.secretConfigured && <CardNotice tone="error" title={t("ai.secretMissingTitle")}>{t("ai.secretMissing")}</CardNotice>}
          {loaded.fileError && <CardNotice tone="error" title={t("ai.fileError")}>{loaded.fileError}</CardNotice>}
          {loaded.envError && <CardNotice tone="warning" title={t("ai.envError")}>{loaded.envError}</CardNotice>}
          {(loaded.envWarnings || []).map((warning) => <CardNotice key={warning} tone="warning">{warning}</CardNotice>)}
          {source === "env" && loaded.envImportAvailable && (
            <Alert status="default" className="settingsNotice settingsImport">
              <Alert.Content>
                <Alert.Title>{t("ai.envSource")}</Alert.Title>
              </Alert.Content>
              <Button variant="secondary" onPress={importEnv} isDisabled={importing}>
                {importing ? t("ai.importing") : t("ai.importEnv")}
              </Button>
            </Alert>
          )}
          {notice && (notice.tone === "error" ? (
            <Alert status="danger" className="settingsNotice" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{notice.text}</Alert.Description>
              </Alert.Content>
              {notice.reload && <Button variant="secondary" onPress={load}>{t("ai.reload")}</Button>}
            </Alert>
          ) : <p className="settingsStatus" data-tone="ok" role="status">{notice.text}</p>)}

          <div className="settingsSwitches">
            <Switch isSelected={draft.enabled} onChange={(value) => updateGeneral({ enabled: value })} className="settingsSwitch">
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                {t("ai.enable")}
              </Switch.Content>
            </Switch>
            <Switch isSelected={draft.freeOnly} onChange={(value) => updateGeneral({ freeOnly: value })} className="settingsSwitch">
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                {t("ai.freeOnly")}
              </Switch.Content>
            </Switch>
          </div>

          <div className="settingsSectionHead">
            <h2 className="settingsCardTitle">{t("ai.providers")}</h2>
            <AddProviderModal
              available={availableProviders(draft)}
              serverSlot={nextCustomProvider(draft) !== null}
              freeOnly={draft.freeOnly}
              onAdd={(name) => append(providerDraft(name))}
              onAddServer={addServer}
            />
          </div>
          {!draft.enabled && <p className="settingsMuted">{t("ai.off")}</p>}
          {(errors.general ?? []).map((message, index) => <CardNotice key={index} tone="error">{text(message)}</CardNotice>)}
          {draft.providers.length === 0 ? (
            <p className="settingsEmpty">{t("ai.empty")}</p>
          ) : (
            <ol className="settingsProviders">
              {draft.providers.map((item, index) => (
                <li key={item.provider}>
                  <ProviderCard
                    item={item}
                    index={index}
                    count={draft.providers.length}
                    freeOnly={draft.freeOnly}
                    errors={errors}
                    text={text}
                    statusLine={providerStatusLine(statusByName[item.provider])}
                    locked={savedProviders[item.provider] !== JSON.stringify(item)}
                    test={tests[item.provider]}
                    models={models}
                    expanded={expanded[item.provider] === true}
                    onExpand={(open) => setExpanded((current) => ({ ...current, [item.provider]: open }))}
                    onChange={(patch) => updateProvider(item.provider, patch)}
                    onMove={(delta) => move(index, delta)}
                    onRemove={() => remove(item)}
                    onTest={() => runTest(item.provider)}
                    onFetchModels={() => fetchModels(item.provider)}
                  />
                </li>
              ))}
            </ol>
          )}
        </form>
      )}
    </section>
  );
}
