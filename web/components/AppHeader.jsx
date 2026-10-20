import Brand from "./Brand.jsx";
import { navItems } from "../lib/app-nav.mjs";

export default function AppHeader({ current }) {
  return (
    <header className="appHeader">
      <div className="appHeaderInner shell">
        <Brand />
        <nav className="appNav" aria-label="Menu utama">
          {navItems(current).map((item) => (
            <a key={item.href} href={item.href} aria-current={item.current ? "page" : undefined}>{item.label}</a>
          ))}
        </nav>
        <a className="btn ghost appHelp" href="/bantuan" aria-current={current === "/bantuan" ? "page" : undefined}>Bantuan</a>
        <form className="appLogout" method="post" action="/api/auth/logout">
          <button type="submit" className="btn ghost">Keluar</button>
        </form>
      </div>
    </header>
  );
}
