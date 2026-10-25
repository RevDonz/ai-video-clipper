import SegmentI18n from "../../components/SegmentI18n.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";

export async function generateMetadata() {
  return routeMetadata("settings");
}

export default function SettingsLayout({ children }) {
  return <SegmentI18n namespaces={["settings"]}>{children}</SegmentI18n>;
}
