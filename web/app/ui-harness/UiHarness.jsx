"use client";

// The test page's body: one of each control the app pages will use, in the states the e2e spec
// measures. The modal's content is HarnessModal.jsx (one primary action per overlay file).
import { Button, Switch } from "@heroui/react";
import dynamic from "next/dynamic";
import { useState } from "react";

import PageHead from "../../components/ui/PageHead.jsx";
import Table, { SelectAll, SelectRow } from "../../components/ui/Table.jsx";
import Tabs from "../../components/ui/Tabs.jsx";
import { toast } from "../../components/ui/Toast.jsx";
import HarnessModal from "./HarnessModal.jsx";
import styles from "./ui-harness.module.css";

const DatePicker = dynamic(() => import("../../components/ui/DatePicker.jsx"), { ssr: false });

const ROWS = [
  { id: "a", name: "Podcast Senin", clips: 8, status: "Selesai" },
  { id: "b", name: "Wawancara pasar", clips: 5, status: "Diproses" },
  { id: "c", name: "Kajian subuh", clips: 3, status: "Antre" },
];

export default function UiHarness() {
  const [shortcuts, setShortcuts] = useState(true);
  return (
    <div className={`shell ${styles.page}`}>
      <PageHead title="Uji komponen" id="ui-harness-title">
        <Button variant="primary" onPress={() => toast("Tersimpan")}>Simpan</Button>
      </PageHead>

      <section className={styles.block} aria-labelledby="ui-buttons">
        <h2 id="ui-buttons">Tombol</h2>
        <div className={styles.row}>
          <Button variant="secondary">Sekunder</Button>
          <Button variant="tertiary">Tersier</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Hapus</Button>
          <Button variant="secondary" isDisabled>Nonaktif</Button>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="ui-switch">
        <h2 id="ui-switch">Saklar</h2>
        <Switch isSelected={shortcuts} onChange={setShortcuts}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            Pintasan satu tombol
          </Switch.Content>
        </Switch>
      </section>

      <section className={styles.block} aria-labelledby="ui-tabs">
        <h2 id="ui-tabs">Tab</h2>
        <Tabs>
          <Tabs.List aria-label="Bagian">
            <Tabs.Tab id="ai">AI</Tabs.Tab>
            <Tabs.Tab id="tampilan">Tampilan</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel id="ai" shouldForceMount>
            <label className={styles.field}>
              <span>Catatan AI</span>
              <input name="catatan" defaultValue="" />
            </label>
          </Tabs.Panel>
          <Tabs.Panel id="tampilan" shouldForceMount>
            <p>Gelap</p>
          </Tabs.Panel>
        </Tabs>
      </section>

      <section className={styles.block} aria-labelledby="ui-table">
        <h2 id="ui-table">Tabel</h2>
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-labelledby="ui-table" selectionMode="multiple">
              <Table.Header>
                <Table.Column><SelectAll /></Table.Column>
                <Table.Column isRowHeader>Proyek</Table.Column>
                <Table.Column>Klip</Table.Column>
                <Table.Column>Status</Table.Column>
              </Table.Header>
              <Table.Body items={ROWS}>
                {(row) => (
                  <Table.Row id={row.id}>
                    <Table.Cell><SelectRow label={row.name} /></Table.Cell>
                    <Table.Cell>{row.name}</Table.Cell>
                    <Table.Cell>{row.clips}</Table.Cell>
                    <Table.Cell>{row.status}</Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </section>

      <section className={styles.block} aria-labelledby="ui-overlay">
        <h2 id="ui-overlay">Dialog dan tanggal</h2>
        <div className={styles.row}>
          <HarnessModal />
        </div>
        <div className={styles.date}>
          <DatePicker label="Tanggal terbit" name="tanggal" />
        </div>
      </section>
    </div>
  );
}
