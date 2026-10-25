"use client";

// A new ingest token, shown once (05-ui-dashboard.md §6.9): the value with Salin token and a curl
// example that never contains it. Closing the dialog drops the value; the server keeps only its
// hash.
import { Button, Input, Label, TextField } from "@heroui/react";
import { useTranslations } from "use-intl";

import { TOKEN_ENV, curlExample } from "../../lib/trend-view.mjs";
import Modal from "../ui/Modal.jsx";
import CopyButton from "./CopyButton.jsx";

export default function TokenModal({ created, origin, onClose }) {
  const t = useTranslations("trends.agent");
  const open = Boolean(created);
  const curl = curlExample({ origin, title: t("sampleTitle"), summary: t("sampleSummary") });
  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container size="md" scroll="inside">
          <Modal.Dialog className="trDialog">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{created ? t("created", { label: created.label }) : ""}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="trOnce" role="note"><strong>{t("once")}</strong> · {t("secret", { env: TOKEN_ENV })}</p>
              <TextField className="trField" isReadOnly value={created?.token ?? ""}>
                <Label>{t("token")}</Label>
                <div className="trInlineRow">
                  <Input spellCheck={false} autoComplete="off" onFocus={(event) => event.target.select()} />
                  <CopyButton text={created?.token ?? ""} label={t("copyToken")} variant="primary" />
                </div>
              </TextField>
              <div className="trCurlHead">
                <span id="trend-curl-title">{t("curl")}</span>
                <CopyButton text={curl} label={t("copyCurl")} />
              </div>
              <pre className="trCurl" aria-labelledby="trend-curl-title" tabIndex={0}><code>{curl}</code></pre>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={onClose}>{t("done")}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
