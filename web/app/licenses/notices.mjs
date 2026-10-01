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
]);

/** Every licence file the page links to (the test checks each one exists). */
export function licenceFiles() {
  return [
    ...JASSUB.components.flatMap((component) => component.texts),
    JASSUB.fullNotice,
    ...MEDIABUNNY.texts,
    ...FONTS.flatMap((font) => font.texts),
    ...WEB.flatMap((item) => item.texts),
  ];
}
