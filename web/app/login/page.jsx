export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const hasError = params?.error === "1";
  const requestedNext = params?.next;
  const next = typeof requestedNext === "string"
    && requestedNext.startsWith("/")
    && !requestedNext.startsWith("//")
    && !requestedNext.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(requestedNext)
    ? requestedNext
    : "/dashboard";
  return (
    <main className="loginPage">
      <section className="loginCard">
        <a className="brand loginBrand" href="/login"><span>P</span> Potongin AI</a>
        <div className="loginIntro">
          <small>SELF-HOSTED VIDEO WORKER</small>
          <h1>Selamat datang kembali.</h1>
          <p>Masuk untuk membuat, memantau, dan mengunduh klip video.</p>
        </div>
        <form className="loginForm" method="post" action="/api/auth/login" autoComplete="on">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="username"><span>Username</span><input id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus /></label>
          <label htmlFor="password"><span>Password</span><input id="password" name="password" type="password" autoComplete="current-password" required /></label>
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
