import Brand from "../../components/Brand.jsx";
import PublicCard from "../../components/ui/PublicCard.jsx";
import { LANDING_MEDIA } from "../../lib/landing-media.mjs";
import { loginErrorMessage, safeNextPath } from "../../lib/login-view.mjs";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Masuk" };

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const error = loginErrorMessage(params?.error);
  const next = safeNextPath(params?.next);
  // The landing's real clip poster: one of the files the proxy serves without a session.
  const poster = LANDING_MEDIA.sesudah;
  return (
    <PublicCard>
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="login-title">
          <Brand />
          <div className={styles.intro}>
            <h1 id="login-title">Masuk</h1>
            <p>Buat, pantau, dan unduh klip dari video panjang.</p>
          </div>
          <form className={styles.form} method="post" action="/api/auth/login" autoComplete="on">
            <input type="hidden" name="next" value={next} />
            <label htmlFor="username"><span>Nama pengguna</span><input id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus aria-describedby={error ? "login-error" : undefined} /></label>
            <label htmlFor="password"><span>Kata sandi</span><input id="password" name="password" type="password" autoComplete="current-password" required /></label>
            {error && <p id="login-error" className={styles.error} role="alert">{error}</p>}
            <button type="submit" className={styles.submit}>Masuk</button>
          </form>
          <p className={styles.note}>Sesi tersimpan 30 hari di perangkat ini.</p>
        </section>
        <aside className={styles.visual} aria-hidden="true">
          <div className={styles.phone}>
            <img src={poster.poster} width={poster.width} height={poster.height} alt="" />
          </div>
          <p className={styles.visualTitle}>Video panjang jadi klip yang layak ditonton.</p>
          <p className={styles.visualNote}>Contoh klip dari film terbuka Elephants Dream. Diproses di server Anda sendiri.</p>
        </aside>
      </main>
    </PublicCard>
  );
}
