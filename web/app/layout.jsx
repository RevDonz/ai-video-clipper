import { DM_Sans } from "next/font/google";

import "./globals.css";

// Downloaded at build time and served from this app; globals.css reads it through --font.
const dmSans = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

export const metadata = {
  title: {
    default: "Potongin AI · Video Panjang Jadi Konten Siap Publish",
    template: "%s · Potongin",
  },
  description: "Potong video panjang berbahasa Indonesia jadi klip 9:16 dengan subtitle, teks hook, dan caption. Diproses di server sendiri.",
};

export const viewport = {
  themeColor: "#080907",
  colorScheme: "dark",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id" className={dmSans.variable}>
      <body>{children}</body>
    </html>
  );
}
