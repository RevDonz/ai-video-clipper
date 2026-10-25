"use client";

// The Agen tab of Tren (admin; 05-ui-dashboard.md §6.9): the ingest endpoint of this deployment
// with Salin, a new token (its value shown once in TokenModal, never kept beyond it), the token
// list and Cabut behind an AlertDialog. Potongin does not scrape social media itself; an agent the
// owner runs posts trends to the endpoint with its token (docs/integrations/hermes-trends).
import { Button, Chip, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import { msg } from "../../lib/i18n/descriptor.mjs";
import {
  GUIDE_URL,
  INGEST_PATH,
  TREND_LIMITS,
  activeTokenCount,
  ingestEndpoint,
  relativeTime,
  tokenView,
  validateTokenLabel,
} from "../../lib/trend-view.mjs";
import AlertDialog from "../ui/AlertDialog.jsx";
import Table from "../ui/Table.jsx";
import { toast } from "../ui/Toast.jsx";
import CopyButton from "./CopyButton.jsx";
import TokenModal from "./TokenModal.jsx";

function RevokeDialog({ token, busy, onConfirm, onClose }) {
  const t = useTranslations("trends.agent");
  return (
    <AlertDialog isOpen={Boolean(token)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      {/* HeroUI's AlertDialog ignores Escape by default; here Escape closes it unless it is busy. */}
      <AlertDialog.Backdrop isKeyboardDismissDisabled={busy}>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Heading>{token ? t("revokeConfirm", { label: token.label }) : ""}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body><p>{t("revokeBody")}</p></AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={onClose}>{t("cancel")}</Button>
              <Button variant="danger" isPending={busy} onPress={onConfirm}>{busy ? t("revoking") : t("revoke")}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

export default function TrendAgentPanel({ origin, tokensState, now, locale, lastIngestAt, onCreateToken, onRevokeToken, onReloadTokens }) {
  const t = useTranslations("trends.agent");
  const tAll = useTranslations();
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null); // { token, label }: only until the dialog closes
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);

  const endpoint = ingestEndpoint(origin) || INGEST_PATH;
  const tokens = tokensState.tokens || [];
  const active = activeTokenCount(tokens);
  const full = active >= TREND_LIMITS.maxActiveTokens;
  const lastIngest = relativeTime(lastIngestAt, now, locale);

  async function create(event) {
    event.preventDefault();
    const checked = validateTokenLabel(label);
    if (checked.error) {
      setLabelError(checked.error);
      return;
    }
    setCreating(true);
    const result = await onCreateToken(checked.label);
    setCreating(false);
    if (result.ok) {
      setCreated({ token: result.data.token, label: result.data.record?.label || checked.label });
      setLabel("");
      setLabelError(null);
    } else if (result.field === "label") {
      setLabelError(result.error);
    } else {
      toast(msg(tAll, result.error), { variant: "danger" });
    }
  }

  async function revoke() {
    const token = revoking;
    setBusy(true);
    const result = await onRevokeToken(token.id);
    setBusy(false);
    setRevoking(null);
    if (result.ok) toast(tAll("trends.toast.revoked", { label: token.label }), { variant: "success" });
    else toast(msg(tAll, result.error), { variant: "danger" });
  }

  return (
    <div className="trAgent">
      <div className="trEndpoint">
        <TextField className="trField" isReadOnly value={endpoint}>
          <Label>{t("endpoint")}</Label>
          <div className="trInlineRow">
            <Input spellCheck={false} onFocus={(event) => event.target.select()} />
            <CopyButton text={endpoint} label={t("copy")} />
          </div>
        </TextField>
        <div className="trAgentLinks">
          <span className="trMuted">{lastIngest ? t("lastIngest", { when: lastIngest }) : t("noIngest")}</span>
          <a className="trGuideLink" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">{t("guide")} ↗</a>
        </div>
      </div>

      <Form className="trTokenForm" onSubmit={create} validationBehavior="aria">
        <TextField className="trField" isInvalid={Boolean(labelError)} value={label} onChange={(value) => { setLabel(value); setLabelError(null); }}>
          <Label>{t("newLabel")}</Label>
          <div className="trInlineRow">
            <Input placeholder={t("newLabelHint")} maxLength={TREND_LIMITS.tokenLabel + 10} autoComplete="off" />
            <Button variant="secondary" type="submit" isPending={creating} isDisabled={full || tokensState.state !== "ready"}>
              {creating ? t("creating") : t("newToken")}
            </Button>
          </div>
          <FieldError>{labelError ? msg(tAll, labelError) : ""}</FieldError>
        </TextField>
        {full && <span className="trMuted">{t("full", { max: TREND_LIMITS.maxActiveTokens })}</span>}
      </Form>

      <section className="trTokens" aria-labelledby="trend-tokens-title">
        <div className="trTokensHead">
          <h2 id="trend-tokens-title">{t("tokens")}</h2>
          <span className="trMuted">{t("activeCount", { count: active, max: TREND_LIMITS.maxActiveTokens })}</span>
        </div>
        {tokensState.state === "loading" && <span className="trMuted" role="status">{tAll("trends.loading")}</span>}
        {tokensState.state === "error" && (
          <div className="trAlert" role="alert">
            <span>{msg(tAll, tokensState.error)}</span>
            <Button variant="secondary" onPress={onReloadTokens}>{tAll("common.retry")}</Button>
          </div>
        )}
        {tokensState.state === "ready" && tokens.length === 0 && <span className="trMuted">{t("noTokens")}</span>}
        {tokensState.state === "ready" && tokens.length > 0 && (
          <Table className="trTable">
            <Table.ScrollContainer>
              <Table.Content aria-labelledby="trend-tokens-title">
                <Table.Header>
                  <Table.Column isRowHeader>{t("col.label")}</Table.Column>
                  <Table.Column>{t("col.prefix")}</Table.Column>
                  <Table.Column>{t("col.status")}</Table.Column>
                  <Table.Column>{t("col.created")}</Table.Column>
                  <Table.Column>{t("col.lastUsed")}</Table.Column>
                  <Table.Column><span className="visuallyHidden">{t("col.actions")}</span></Table.Column>
                </Table.Header>
                <Table.Body items={tokens}>
                  {(token) => {
                    const view = tokenView(token, now, locale);
                    return (
                      <Table.Row id={token.id} textValue={token.label}>
                        <Table.Cell><strong>{token.label}</strong></Table.Cell>
                        <Table.Cell><code>{view.prefixText}</code></Table.Cell>
                        <Table.Cell>
                          <Chip size="sm" variant="soft" color={view.status === "active" ? "success" : "default"}>
                            <Chip.Label>{msg(tAll, view.statusLabel)}</Chip.Label>
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>{msg(tAll, view.createdText)}</Table.Cell>
                        <Table.Cell><span title={view.lastUsedAbsolute || undefined}>{msg(tAll, view.lastUsedText)}</span></Table.Cell>
                        <Table.Cell>
                          {view.status === "active" ? (
                            <Button variant="danger" aria-label={t("revokeLabel", { label: token.label })} onPress={() => setRevoking(token)}>{t("revoke")}</Button>
                          ) : null}
                        </Table.Cell>
                      </Table.Row>
                    );
                  }}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </section>

      <TokenModal created={created} origin={origin} onClose={() => setCreated(null)} />
      <RevokeDialog token={revoking} busy={busy} onConfirm={revoke} onClose={() => setRevoking(null)} />
    </div>
  );
}
