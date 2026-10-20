// A5: a clip saves as "NN-judul-klip.mp4" (its two-digit number and an ASCII slug of its title),
// both from "Unduh MP4" and inside the project's ZIP; the ZIP route's address and size text.
import assert from "node:assert/strict";
import test from "node:test";

import {
  clipDownloads,
  clipSaveName,
  formatSize,
  namedDownloadHref,
  slugify,
  zipHref,
  zipSaveName,
} from "../lib/clip-download.mjs";
import { isSaveName } from "../lib/final-files.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";

test("a title becomes lower-case ASCII words joined by '-', cut at a word end", () => {
  assert.equal(slugify("Kenapa 90% Orang Gagal Nabung?"), "kenapa-90-orang-gagal-nabung");
  assert.equal(slugify("Ngopi di Café, Jakarta Selatan"), "ngopi-di-cafe-jakarta-selatan");
  assert.equal(slugify("Gak'nya Ketemu…  Lagi!!"), "gaknya-ketemu-lagi");
  assert.equal(slugify("“Jangan Menyerah” 🔥🔥 sekarang"), "jangan-menyerah-sekarang");
  assert.equal(slugify("  --  "), "");
  assert.equal(slugify("🔥🔥"), "");
  assert.equal(slugify(null), "");
  assert.equal(slugify(42), "");
  // Cut after the last whole word that fits; one word longer than the limit is cut inside it.
  assert.equal(slugify("satu dua tiga empat", 13), "satu-dua-tiga");
  assert.equal(slugify("satu dua tiga empat", 12), "satu-dua");
  assert.equal(slugify("supercalifragilistik", 5), "super");
});

test("a clip saves as NN-judul: its number in two digits and its title, 64 characters at most", () => {
  assert.equal(clipSaveName({ index: 3, title: "Rahasia Hook di 3 Detik Pertama" }), "03-rahasia-hook-di-3-detik-pertama");
  assert.equal(clipSaveName({ index: 12, title: "Jangan menyerah" }), "12-jangan-menyerah");
  assert.equal(clipSaveName({ index: 100, title: "Klip ke seratus" }), "100-klip-ke-seratus");
  // No title, or a title with no letter or digit: the clip number alone.
  assert.equal(clipSaveName({ index: 4 }), "04-klip");
  assert.equal(clipSaveName({ index: 4, title: "🔥 !!! 🔥" }), "04-klip");
  const long = clipSaveName({ index: 7, title: "kata ".repeat(40) });
  assert.ok(long.length <= 51, long);
  assert.match(long, /^07-kata(-kata)+$/);
  for (const clip of [null, {}, { index: 0, title: "x" }, { index: -1 }, { index: 1.5 }, { index: "3" }, { index: 10_000 }]) {
    assert.equal(clipSaveName(clip), null, JSON.stringify(clip));
  }
});

test("every save name passes the files route's own name check, so the browser gets that name", () => {
  const titles = [
    "Kenapa 90% Orang Gagal Nabung?", "Ngopi di Café", "", "🔥", "a".repeat(200), "KAPITAL SEMUA", "x-y_z.mp4",
    "Ünïcödé Çhàrs ÀÉÎÕÜ", "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25", "../../etc/passwd",
    "a\"b\r\nContent-Type: text/html", "%0d%0a", "<img src=x onerror=alert(1)>",
  ];
  for (const [position, title] of titles.entries()) {
    for (const index of [1, 9, 10, 99, 100, 9999]) {
      const name = clipSaveName({ index, title });
      assert.ok(isSaveName(name), `${index} ${JSON.stringify(title)} -> ${name} (${position})`);
    }
  }
});

test("Unduh MP4 and Subtitle SRT ask the files route for the clip's save name", () => {
  const base = `/api/jobs/${JOB_ID}/files/output/clip-03`;
  const clip = { index: 3, title: "Rahasia Hook", downloadUrl: `${base}.mp4?download=1`, subtitleUrl: `${base}.srt?download=1` };
  assert.deepEqual(clipDownloads(clip), {
    name: "03-rahasia-hook",
    mp4: `${base}.mp4?download=1&name=03-rahasia-hook`,
    mp4File: "03-rahasia-hook.mp4",
    srt: `${base}.srt?download=1&name=03-rahasia-hook`,
    srtFile: "03-rahasia-hook.srt",
  });
  // A clip without a subtitle link keeps none; one without a usable number keeps its own links.
  assert.equal(clipDownloads({ ...clip, subtitleUrl: undefined }).srt, null);
  assert.deepEqual(clipDownloads({ index: null, downloadUrl: "/d", subtitleUrl: "/s" }), {
    name: null, mp4: "/d", mp4File: null, srt: "/s", srtFile: null,
  });
  assert.equal(namedDownloadHref(`${base}.mp4`, "03-x"), `${base}.mp4?download=1&name=03-x`);
  assert.equal(namedDownloadHref(`${base}.mp4?download=1&name=lama`, "03-x"), `${base}.mp4?download=1&name=03-x`);
  assert.equal(namedDownloadHref(null, "03-x"), null);
  assert.equal(namedDownloadHref("/d", null), "/d");
});

test("the ZIP route takes the picked clip numbers; without them it zips every clip", () => {
  assert.equal(zipHref(JOB_ID), `/api/jobs/${JOB_ID}/zip`);
  assert.equal(zipHref(JOB_ID, null, { check: true }), `/api/jobs/${JOB_ID}/zip?check=1`);
  assert.equal(zipHref(JOB_ID, [1, 3, 12]), `/api/jobs/${JOB_ID}/zip?clips=1%2C3%2C12`);
  assert.equal(zipHref(JOB_ID, [2], { check: true }), `/api/jobs/${JOB_ID}/zip?clips=2&check=1`);
  assert.equal(zipHref("a/b"), "/api/jobs/a%2Fb/zip");
});

test("the ZIP is named after the project", () => {
  assert.equal(zipSaveName({ id: JOB_ID, source: { type: "upload", name: "Podcast Episode 12.mp4" } }), "podcast-episode-12-klip.zip");
  assert.equal(zipSaveName({ id: JOB_ID, source: { type: "youtube", url: "https://www.youtube.com/watch?v=Ive926sC6mc" } }), "youtube-ive926sc6mc-klip.zip");
  assert.equal(zipSaveName({ id: JOB_ID, source: { type: "upload", name: "🔥.mov" } }), "proyek-123e4567-klip.zip");
  assert.equal(zipSaveName({ id: JOB_ID }), "proyek-123e4567-klip.zip");
  assert.ok(isSaveName(zipSaveName({ source: { name: "x".repeat(300) } }).replace(/\.zip$/, "")));
});

test("sizes read the Indonesian way", () => {
  assert.equal(formatSize(2 * 1024 ** 3), "2 GB");
  assert.equal(formatSize(2.4 * 1024 ** 3), "2,4 GB");
  assert.equal(formatSize(18.4 * 1024 ** 2), "18 MB");
  assert.equal(formatSize(1500), "1 KB");
  assert.equal(formatSize(0), "0 KB");
  assert.equal(formatSize(-1), null);
  assert.equal(formatSize(Number.NaN), null);
});
