"use client";

// Pengaturan → AI → [Tambah penyedia]: a Modal with one list of the presets not yet in the order
// and the self-hosted server templates (05-ui-dashboard.md §6.10), one label each. Picking one adds
// it at the end of the order and closes the dialog.
import { Button, Chip, Header, ListBox } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import Modal from "../../components/ui/Modal.jsx";
import { CUSTOM_PROVIDERS, LLM_PRESETS, SERVER_TEMPLATES } from "../../lib/llm-presets.mjs";

const SERVER_PREFIX = "server:";

export default function AddProviderModal({ available, serverSlot, freeOnly, onAdd, onAddServer }) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  if (!available.length && !serverSlot) return null;

  const badge = (name) => {
    const preset = LLM_PRESETS[name];
    if (preset.local) return { text: t("ai.badge.local"), tone: "default" };
    if (preset.paidOnly) return { text: t("ai.badge.paid"), tone: freeOnly ? "warning" : "default" };
    return { text: t("ai.badge.free"), tone: "default" };
  };
  const pick = (key) => {
    const id = String(key);
    if (id.startsWith(SERVER_PREFIX)) onAddServer(id.slice(SERVER_PREFIX.length));
    else onAdd(id);
    setOpen(false);
  };

  return (
    <Modal isOpen={open} onOpenChange={setOpen}>
      <Button variant="secondary">{t("ai.addProvider")}</Button>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t("ai.addProvider")}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <ListBox aria-label={t("ai.addProvider")} onAction={pick} className="settingsPresetList">
                {available.length > 0 && (
                  <ListBox.Section>
                    <Header className="settingsPresetHead">{t("ai.modal.presets")}</Header>
                    {available.map((name) => {
                      const tag = badge(name);
                      return (
                        <ListBox.Item key={name} id={name} textValue={LLM_PRESETS[name].label} className="settingsPresetItem">
                          <span>{LLM_PRESETS[name].label}</span>
                          <Chip size="sm" color={tag.tone}>{tag.text}</Chip>
                        </ListBox.Item>
                      );
                    })}
                  </ListBox.Section>
                )}
                <ListBox.Section>
                  <Header className="settingsPresetHead">
                    {serverSlot ? t("ai.modal.servers") : t("ai.modal.serverLimit", { max: CUSTOM_PROVIDERS.length })}
                  </Header>
                  {serverSlot && Object.entries(SERVER_TEMPLATES).map(([id, template]) => (
                    <ListBox.Item key={id} id={`${SERVER_PREFIX}${id}`} textValue={template.title} className="settingsPresetItem">
                      <span>{template.title}</span>
                      <Chip size="sm">{t("ai.badge.server")}</Chip>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              </ListBox>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
