import { Button, FieldError, Input, Label, TextField } from "@heroui/react";

import Brand from "../../components/Brand.jsx";
import LanguageSwitcher from "../../components/LanguageSwitcher.jsx";
import PublicCard from "../../components/ui/PublicCard.jsx";
import { localeOptions } from "../../lib/i18n/locales.mjs";
import { getLocale, getT, routeMetadata } from "../../lib/i18n/server.mjs";
import { loginErrorCode, loginLocaleNext, safeNextPath } from "../../lib/login-view.mjs";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return routeMetadata("login");
}

// A card without the app shell (05-ui-dashboard.md §6.2): the native login form, which works
// without JavaScript, and below it the language picker as a second native form.
export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = await getT(locale, "auth");
  const tErrors = await getT(locale, "errors");
  const code = loginErrorCode(params?.error);
  const error = code === "invalid" ? tErrors("web.login_invalid") : code === "limited" ? t("login.limited") : null;
  const languageFailed = params?.bahasa === "gagal";
  const next = safeNextPath(params?.next);
  const locales = localeOptions();
  return (
    <PublicCard>
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="login-title">
          <Brand />
          <h1 id="login-title">{t("login.title")}</h1>
          <form className={styles.form} method="post" action="/api/auth/login" autoComplete="on">
            <input type="hidden" name="next" value={next} />
            <TextField name="username" type="text" isRequired autoFocus>
              <Label>{t("login.username")}</Label>
              <Input autoComplete="username" autoCapitalize="none" spellCheck={false} aria-describedby={error ? "login-error" : undefined} />
              <FieldError />
            </TextField>
            <TextField name="password" type="password" isRequired>
              <Label>{t("login.password")}</Label>
              <Input autoComplete="current-password" />
              <FieldError />
            </TextField>
            {error && <p id="login-error" className={styles.error} role="alert">{error}</p>}
            <Button type="submit" variant="primary" className={styles.submit}>{t("login.submit")}</Button>
          </form>
          {languageFailed && <p className={styles.error} role="alert">{t("locale.failed")}</p>}
          <LanguageSwitcher variant="form" locales={locales} current={locale} next={loginLocaleNext(params)} className={styles.language} />
        </section>
      </main>
    </PublicCard>
  );
}
