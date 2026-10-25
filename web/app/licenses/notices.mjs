// Third-party notices shown on /licenses (plan §11.4 T4.4, R3). Every licence text is a file in
// public/licenses/; web/tests/licenses.test.mjs ties the versions to the pins in package.json and
// package-lock.json and the copies to the installed packages and resources/fonts.

const JASSUB_REPO = "https://github.com/ThaUnknown/jassub";
const JASSUB_COMMIT = "656371af1c904be59a1008dcdb93f18dfe5e23d0";
const at = (repository, ref) => `${repository}/tree/${ref}`;

export const JASSUB = Object.freeze({
  name: "JASSUB",
  version: "2.5.16",
  integrity: "sha512-n4vjXfraf3o8k3/5TK6DhCYVcbQ/VqhVOgwqLd3l0xfMtsN4fpE/hPq2hPaGagBTOtJS9yHwRoRp3mmchQ9XVg==",
  use: "Menggambar teks caption dan hook di pratinjau editor (libass yang dikompilasi ke WebAssembly).",
  // What the app serves (lib/clip-media.mjs JASSUB_FILES), byte for byte from the npm package.
  files: ["jassub-worker.js", "jassub-worker.wasm"],
  license: "LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0",
  repository: JASSUB_REPO,
  commit: JASSUB_COMMIT,
  source: at(JASSUB_REPO, JASSUB_COMMIT),
  // The repository has no git tag for the 2.5.x releases.
  sourceNote: "Repositori JASSUB tidak memberi tag untuk rilis 2.5.x. Commit ini adalah commit terakhir sebelum paket npm 2.5.16 terbit (5 September 2026).",
  buildScripts: [
    { label: "Makefile", href: `${JASSUB_REPO}/blob/${JASSUB_COMMIT}/Makefile` },
    { label: "Dockerfile (emscripten/emsdk:6.0.4)", href: `${JASSUB_REPO}/blob/${JASSUB_COMMIT}/Dockerfile` },
    { label: "run-docker-build.sh", href: `${JASSUB_REPO}/blob/${JASSUB_COMMIT}/run-docker-build.sh` },
  ],
  components: [
    { name: "JASSUB", license: "MIT", source: at(JASSUB_REPO, JASSUB_COMMIT), texts: ["/licenses/jassub/LICENSE.txt"] },
    { name: "libass", license: "ISC", source: at("https://github.com/libass/libass", "266b9831d7a7f513db48a02ade91c1f3e2fcd7a3"), texts: ["/licenses/jassub/libass-COPYING.txt"] },
    { name: "FriBidi", license: "LGPL-2.1-or-later", source: at("https://github.com/fribidi/fribidi", "247fddc3599e3fe7b1b5cc21020c9eb51e662637"), texts: ["/licenses/jassub/fribidi-COPYING.txt"] },
    {
      name: "FreeType 2.11.0",
      license: "FTL (dipilih dari FTL atau GPL-2.0-or-later)",
      source: "https://gitlab.freedesktop.org/freetype/freetype/-/tree/801cd842e27c85cb1d5000f6397f382ffe295daa",
      texts: ["/licenses/jassub/freetype-FTL.txt", "/licenses/jassub/freetype-LICENSE.txt"],
    },
    { name: "HarfBuzz", license: "MIT-Modern-Variant", source: at("https://github.com/harfbuzz/harfbuzz", "afcae83a064843d71d47624bc162e121cc56c08b"), texts: ["/licenses/jassub/harfbuzz-COPYING.txt"] },
    { name: "Brotli", license: "MIT", source: at("https://github.com/google/brotli", "e61745a6b7add50d380cfd7d3883dd6c62fc2c71"), texts: ["/licenses/jassub/brotli-LICENSE.txt"] },
    {
      name: "Emscripten 6.0.4 (runtime, musl libc, mimalloc)",
      license: "MIT atau NCSA; musl dan mimalloc MIT",
      source: at("https://github.com/emscripten-core/emscripten", "6.0.4"),
      texts: ["/licenses/jassub/emscripten-LICENSE.txt", "/licenses/jassub/musl-COPYRIGHT.txt", "/licenses/jassub/mimalloc-LICENSE.txt"],
    },
  ],
  fullNotice: "/licenses/jassub/license_fullnotice.txt",
});

// The FreeType Licence asks for this sentence, word for word, in the product's documentation.
export const FREETYPE_CREDIT = "Portions of this software are copyright © 2021 The FreeType Project (www.freetype.org). All rights reserved.";

export const MEDIABUNNY = Object.freeze({
  name: "Mediabunny",
  version: "1.59.1",
  integrity: "sha512-K6vFvOZ7x36fqP3MaFFWFLYEfGF192qY4LQ6QB+L5eB74SUJjEgq9ZRztYpk9RJOjSyxooPZBV4WE0k8PKcjaQ==",
  use: "Membaca video sumber di browser untuk pratinjau editor.",
  license: "MPL-2.0",
  source: at("https://github.com/Vanilagy/mediabunny", "v1.59.1"),
  tag: "v1.59.1",
  commit: "049a89347a34ffc43878bb95295c439d07e0f8be",
  texts: ["/licenses/mediabunny/LICENSE.txt"],
});

export const FONTS = Object.freeze([
  {
    name: "Montserrat ExtraBold",
    use: "Caption gaya Bold dan Box.",
    license: "SIL Open Font License 1.1",
    copyright: "Copyright 2011 The Montserrat Project Authors",
    source: at("https://github.com/JulietaUla/Montserrat", "v7.222"),
    texts: ["/licenses/fonts/Montserrat-OFL.txt"],
  },
  {
    name: "Anton",
    use: "Kata kunci di caption gaya Bold.",
    license: "SIL Open Font License 1.1",
    copyright: "Copyright 2020 The Anton Project Authors",
    source: at("https://github.com/google/fonts", "47d54ca1ebb14fd864695f1d39dc734f39017c33") + "/ofl/anton",
    texts: ["/licenses/fonts/Anton-OFL.txt"],
  },
  {
    name: "DM Serif Display Italic",
    use: "Kata kunci di caption gaya Sinar.",
    license: "SIL Open Font License 1.1",
    copyright: "Copyright 2014-2018 Adobe, with Reserved Font Name 'Source'; Copyright 2019 Google LLC",
    source: at("https://github.com/google/fonts", "47d54ca1ebb14fd864695f1d39dc734f39017c33") + "/ofl/dmserifdisplay",
    texts: ["/licenses/fonts/DMSerifDisplay-OFL.txt"],
  },
  {
    name: "DejaVu Sans dan DejaVu Sans Bold",
    use: "Caption gaya Karaoke dan Classic, dan huruf cadangan untuk karakter yang tidak ada di font lain.",
    license: "Lisensi Bitstream Vera dan Arev; perubahan DejaVu domain publik",
    copyright: "Copyright (c) 2003 by Bitstream, Inc.; Copyright (c) 2006 by Tavmjong Bah",
    source: "https://packages.debian.org/bookworm/fonts-dejavu-core",
    texts: ["/licenses/fonts/DejaVu-LICENSE.txt"],
  },
  {
    name: "DM Sans",
    use: "Huruf antarmuka Potongin.",
    license: "SIL Open Font License 1.1",
    copyright: "Copyright 2014 The DM Sans Project Authors",
    source: "https://github.com/googlefonts/dm-fonts",
    texts: ["/licenses/fonts/DMSans-OFL.txt"],
  },
]);

export const WEB = Object.freeze([
  { name: "Next.js", version: "16.3.6", license: "MIT", source: at("https://github.com/vercel/next.js", "v16.3.6"), texts: ["/licenses/web/next-LICENSE.txt"] },
  { name: "React dan React DOM", version: "19.3.0", license: "MIT", source: at("https://github.com/facebook/react", "v19.3.0"), texts: ["/licenses/web/react-LICENSE.txt"] },
  // The UI-language runtime and the parts of its dependencies that reach the bundles; lockPath is
  // the package's entry in package-lock.json (the test ties version, licence and text to it).
  { name: "use-intl", version: "4.14.9", license: "MIT", lockPath: "node_modules/use-intl", source: at("https://github.com/amannn/next-intl", "v4.14.9"), texts: ["/licenses/web/use-intl-LICENSE.txt"] },
  { name: "intl-messageformat", version: "11.2.15", license: "BSD-3-Clause", lockPath: "node_modules/intl-messageformat", source: at("https://github.com/formatjs/formatjs", "intl-messageformat@11.2.15"), texts: ["/licenses/web/intl-messageformat-LICENSE.txt"] },
  { name: "@formatjs/fast-memoize", version: "3.1.7", license: "MIT", lockPath: "node_modules/@formatjs/fast-memoize", source: at("https://github.com/formatjs/formatjs", "@formatjs/fast-memoize@3.1.7"), texts: ["/licenses/web/formatjs-fast-memoize-LICENSE.txt"] },
  { name: "@formatjs/icu-messageformat-parser", version: "3.5.18", license: "MIT", lockPath: "node_modules/intl-messageformat/node_modules/@formatjs/icu-messageformat-parser", source: at("https://github.com/formatjs/formatjs", "@formatjs/icu-messageformat-parser@3.5.18"), texts: ["/licenses/web/formatjs-icu-messageformat-parser-LICENSE.txt"] },
  { name: "@formatjs/icu-skeleton-parser", version: "2.1.11", license: "MIT", lockPath: "node_modules/intl-messageformat/node_modules/@formatjs/icu-skeleton-parser", source: at("https://github.com/formatjs/formatjs", "@formatjs/icu-skeleton-parser@2.1.11"), texts: ["/licenses/web/formatjs-icu-skeleton-parser-LICENSE.txt"] },
]);

// The UI kit of the app pages (docs/plans/2026-10-24-rombak/05-ui-dashboard.md §3.1). HeroUI's
// package.json says MIT while the LICENSE file in both of its packages holds the Apache License
// 2.0 text, so the notice gives both and links that file as shipped.
export const UI = Object.freeze([
  {
    name: "HeroUI",
    packages: [
      { name: "@heroui/react", version: "3.2.6", license: "MIT" },
      { name: "@heroui/styles", version: "3.2.6", license: "MIT" },
    ],
    use: "Komponen antarmuka halaman aplikasi.",
    licenseNote: "MIT menurut package.json; berkas LICENSE di paketnya berisi Apache License 2.0.",
    source: at("https://github.com/heroui-inc/heroui", "v3.2.6"),
    texts: ["/licenses/ui/heroui-LICENSE.txt"],
  },
  {
    name: "React Aria",
    packages: [
      { name: "react-aria", version: "3.52.1", license: "Apache-2.0" },
      { name: "react-aria-components", version: "1.21.1", license: "Apache-2.0" },
      { name: "@internationalized/date", version: "3.12.4", license: "Apache-2.0" },
    ],
    use: "Keyboard, fokus dan pembaca layar di bawah komponen HeroUI.",
    licenseNote: "Termasuk paket @react-aria/*, @react-stately/* dan @internationalized/* yang ditarik paket ini.",
    source: at("https://github.com/adobe/react-spectrum", "react-aria-components@1.21.1"),
    texts: ["/licenses/ui/react-aria-LICENSE.txt"],
  },
  {
    name: "Tailwind CSS",
    packages: [{ name: "tailwindcss", version: "4.3.3", license: "MIT" }],
    use: "Membangun CSS tema dan utilitas komponen saat build.",
    source: at("https://github.com/tailwindlabs/tailwindcss", "v4.3.3"),
    texts: ["/licenses/ui/tailwindcss-LICENSE.txt"],
  },
  {
    name: "tw-animate-css",
    packages: [{ name: "tw-animate-css", version: "1.4.0", license: "MIT" }],
    use: "Animasi buka dan tutup overlay.",
    source: at("https://github.com/Wombosvideo/tw-animate-css", "v1.4.0"),
    texts: ["/licenses/ui/tw-animate-css-LICENSE.txt"],
  },
  {
    name: "Tailwind Variants",
    packages: [{ name: "tailwind-variants", version: "3.3.1", license: "MIT" }],
    use: "Kelas varian komponen HeroUI.",
    source: at("https://github.com/heroui-inc/tailwind-variants", "v3.3.1"),
    texts: ["/licenses/ui/tailwind-variants-LICENSE.txt"],
  },
]);

/** Every licence file the page links to (the test checks each one exists). */
export function licenceFiles() {
  return [
    ...JASSUB.components.flatMap((component) => component.texts),
    JASSUB.fullNotice,
    ...MEDIABUNNY.texts,
    ...FONTS.flatMap((font) => font.texts),
    ...WEB.flatMap((item) => item.texts),
    ...UI.flatMap((item) => item.texts),
  ];
}
