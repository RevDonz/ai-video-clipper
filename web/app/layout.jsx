export const metadata = {
  title: "Potongin AI",
  description: "Ubah video panjang menjadi klip vertikal siap publikasi.",
};

import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
