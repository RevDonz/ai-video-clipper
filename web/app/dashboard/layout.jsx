import SegmentI18n from "../../components/SegmentI18n.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";

export async function generateMetadata() {
  return routeMetadata("dashboard");
}

export default function DashboardLayout({ children }) {
  return <SegmentI18n namespaces={["dashboard"]}>{children}</SegmentI18n>;
}
