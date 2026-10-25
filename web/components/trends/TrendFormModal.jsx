"use client";

// Tambah tren and Ubah tren (05-ui-dashboard.md §6.9): one Modal with a Form. Adding asks for the
// kind, platforms and score too; editing sends only the fields that changed (spec §3.2 PATCH)
// and carries the item's on/off switch. Client validation first, then the server's answer,
// which may mark one field. `onSubmit(payload)` resolves to the API client's result.
import { Button, Checkbox, CheckboxGroup, Description, FieldError, Form, Input, Label, ListBox, Select, Switch, TextArea, TextField } from "@heroui/react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { msg } from "../../lib/i18n/descriptor.mjs";
import {
  TREND_KINDS,
  TREND_KIND_NAMES,
  TREND_LIMITS,
  TREND_PLATFORMS,
  TREND_PLATFORM_LABELS,
  TREND_SENSITIVITY_LABELS,
  draftFromTrendItem,
  emptyTrendDraft,
  expiryDateBounds,
  trendCreatePayload,
  trendPatchPayload,
} from "../../lib/trend-view.mjs";
import Modal from "../ui/Modal.jsx";

// Draft field → the error key used by validation and by the server.
const ERROR_KEY = Object.freeze({ keywordsText: "keywords", hashtagsText: "hashtags", expiresDate: "expiresAt" });

function Field({ label, help, error, value, onChange, type = "text", placeholder, autoFocus = false, wide = false, ...input }) {
  return (
    <TextField className={wide ? "trField wide" : "trField"} isInvalid={Boolean(error)} value={value} onChange={onChange} type={type}>
      <Label>{label}</Label>
      <Input placeholder={placeholder} autoFocus={autoFocus} {...input} />
      {help ? <Description>{help}</Description> : null}
      <FieldError>{error}</FieldError>
    </TextField>
  );
}

function Choice({ label, help, value, onChange, options, error }) {
  return (
    <Select className="trField" selectedKey={value} onSelectionChange={(key) => { if (key !== null) onChange(key); }} isInvalid={Boolean(error)}>
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
      {help ? <Description>{help}</Description> : null}
      <FieldError>{error}</FieldError>
    </Select>
  );
}

export default function TrendFormModal({ mode, item = null, now, isOpen, onClose, onSubmit }) {
  const t = useTranslations("trends.form");
  const tAll = useTranslations();
  const editing = mode === "edit" && item;
  const [draft, setDraft] = useState(() => (editing ? draftFromTrendItem(item) : emptyTrendDraft()));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);
  const formId = `trend-form${useId()}`;

  // Each opening starts from the item (or an empty draft), never from a half-typed old one.
  useEffect(() => {
    if (!isOpen) return;
    setDraft(editing ? draftFromTrendItem(item) : emptyTrendDraft());
    setErrors({});
    setBusy(false);
  }, [isOpen, editing, item]);

  const text = (value) => (value ? msg(tAll, value) : "");
  const error = (field) => text(errors[ERROR_KEY[field] ?? field]);

  function change(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[ERROR_KEY[key] ?? key];
      delete next.general;
      return next;
    });
  }

  function focusFirstError() {
    requestAnimationFrame(() => formRef.current?.querySelector("[aria-invalid=true]")?.focus());
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const checked = editing ? trendPatchPayload(item, draft, Date.now()) : trendCreatePayload(draft, Date.now());
    if (Object.keys(checked.errors).length) {
      setErrors(checked.errors);
      focusFirstError();
      return;
    }
    if (editing && !checked.changed) {
      onClose();
      return;
    }
    setBusy(true);
    const result = await onSubmit(checked.payload);
    setBusy(false);
    if (result?.ok) return;
    setErrors(result?.field ? { [result.field]: result.error } : { general: result?.error });
    if (result?.field) focusFirstError();
  }

  const bounds = expiryDateBounds(now);
  const kinds = TREND_KINDS.map((kind) => ({ id: kind, label: text(TREND_KIND_NAMES[kind]) }));
  const sensitivities = ["normal", "sensitive"].map((id) => ({ id, label: text(TREND_SENSITIVITY_LABELS[id]) }));
  const heading = editing ? t("edit") : t("add");

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Backdrop isDismissable={!busy}>
        <Modal.Container size="md" scroll="inside">
          <Modal.Dialog className="trDialog">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{heading}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <Form id={formId} ref={formRef} className="trForm" onSubmit={submit} validationBehavior="aria">
                {!editing && <Choice label={t("kind")} value={draft.kind} onChange={(kind) => change({ kind })} options={kinds} error={error("kind")} />}
                <Field wide label={t("title")} value={draft.title} onChange={(title) => change({ title })} error={error("title")}
                  placeholder={t("titleHint")} autoComplete="off" maxLength={TREND_LIMITS.title + 20} autoFocus />
                <Field wide label={t("keywords")} help={t("keywordsHelp")} value={draft.keywordsText} onChange={(keywordsText) => change({ keywordsText })}
                  error={error("keywordsText")} placeholder={t("keywordsHint")} autoComplete="off" spellCheck={false} />
                <Field label={t("hashtags")} help={t("hashtagsHelp")} value={draft.hashtagsText} onChange={(hashtagsText) => change({ hashtagsText })}
                  error={error("hashtagsText")} placeholder={t("hashtagsHint")} autoComplete="off" autoCapitalize="off" spellCheck={false} />
                <Choice label={t("sensitivity")} help={t("sensitivityHelp")} value={draft.sensitivity} onChange={(sensitivity) => change({ sensitivity })} options={sensitivities} />
                <TextField className="trField wide" isInvalid={Boolean(error("summary"))} value={draft.summary} onChange={(summary) => change({ summary })}>
                  <Label>{t("summary")}</Label>
                  <TextArea rows={3} />
                  <FieldError>{error("summary")}</FieldError>
                </TextField>
                <Field label={t("expiry")} type="date" min={bounds.min} max={bounds.max} value={draft.expiresDate}
                  onChange={(expiresDate) => change({ expiresDate })} error={error("expiresDate")}
                  help={editing ? t("expiryMax", { max: TREND_LIMITS.maxExpiryDays }) : t("expiryNew", { days: TREND_LIMITS.defaultExpiryDays })} />
                {!editing && (
                  <Field label={t("score")} help={t("scoreHelp")} value={draft.score} onChange={(score) => change({ score })}
                    error={error("score")} inputMode="numeric" placeholder="50" />
                )}
                {!editing && (
                  <CheckboxGroup className="trPlatforms wide" value={draft.platforms} onChange={(platforms) => change({ platforms })} isInvalid={Boolean(error("platforms"))}>
                    <Label>{t("platforms")}</Label>
                    <div className="trPlatformList">
                      {TREND_PLATFORMS.map((platform) => (
                        <Checkbox key={platform} value={platform}>
                          <Checkbox.Content>
                            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                            {text(TREND_PLATFORM_LABELS[platform])}
                          </Checkbox.Content>
                        </Checkbox>
                      ))}
                    </div>
                    <FieldError>{error("platforms")}</FieldError>
                  </CheckboxGroup>
                )}
                {editing && (
                  <Switch className="wide" isSelected={draft.enabled} onChange={(enabled) => change({ enabled })}>
                    <Switch.Content>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                      {t("enabled")}
                    </Switch.Content>
                  </Switch>
                )}
                {editing && item.source !== "manual" && <p className="trNote wide">{t("agentNote")}</p>}
                {errors.general ? <p className="trFormError wide" role="alert">{text(errors.general)}</p> : null}
                {Object.keys(errors).length > 0 && !errors.general ? <p className="trFormError wide" role="alert">{t("check")}</p> : null}
              </Form>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t("cancel")}</Button>
              <Button variant="primary" type="submit" form={formId} isPending={busy}>
                {busy ? t("saving") : editing ? t("submitEdit") : t("submitAdd")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
