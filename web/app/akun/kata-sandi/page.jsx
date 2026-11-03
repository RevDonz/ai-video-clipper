// Ganti kata sandi (rombak 02 §6.5). In this phase it is the one page of the account area, there so
// that `admin-reset.mjs --admin` (must change at login) never ends on a missing page. Same card as
// /login, without the app shell; the rest of /akun arrives with Fase 6.
import Brand from "../../../components/Brand.jsx";
import SegmentI18n from "../../../components/SegmentI18n.jsx";
import PublicCard from "../../../components/ui/PublicCard.jsx";
import { getLocale, getT, routeMetadata } from "../../../lib/i18n/server.mjs";
import styles from "../../login/login.module.css";
import PasswordForm from "./PasswordForm.jsx";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return routeMetadata("password", { robots: { index: false, follow: false } });
}

export default async function PasswordPage() {
  const t = await getT(await getLocale(), "auth");
  return (
    <SegmentI18n namespaces={["auth", "errors.account"]}>
      <PublicCard>
        <main className={styles.page}>
          <section className={styles.card} aria-labelledby="password-title">
            <Brand />
            <h1 id="password-title">{t("password.title")}</h1>
            <PasswordForm className={styles.form} errorClassName={styles.error} submitClassName={styles.submit} />
          </section>
        </main>
      </PublicCard>
    </SegmentI18n>
  );
}
