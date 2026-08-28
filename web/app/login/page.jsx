export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const hasError = params?.error === "1";
  const next = typeof params?.next === "string" && params.next.startsWith("/") ? params.next : "/";
  return (
    <main className="loginPage">
      <section className="loginCard">
        <a className="brand loginBrand" href="/login"><span>P</span> Potongin AI</a>
        <div className="loginIntro">
          <small>SELF-HOSTED VIDEO WORKER</small>
          <h1>Selamat datang kembali.</h1>
          <p>Masuk untuk membuat, memantau, dan mengunduh klip video.</p>
        </div>
        <form className="loginForm" method="post" action="/api/auth/login">
          <input type="hidden" name="next" value={next} />
          <label><span>Username</span><input name="username" autoComplete="username" required autoFocus /></label>
          <label><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
          {hasError && <div className="loginError">Username atau password tidak sesuai.</div>}
          <button type="submit">Masuk ke dashboard <b>→</b></button>
        </form>
        <p className="loginNote">Sesi aman tersimpan selama 30 hari pada perangkat ini.</p>
      </section>
      <aside className="loginVisual">
        <div className="visualPhone"><div /><i /><b /></div>
        <h2>Video panjang menjadi klip yang layak ditonton.</h2>
        <p>Whisper · FFmpeg · Face Tracking · Berjalan di server sendiri</p>
      </aside>
    </main>
  );
}
