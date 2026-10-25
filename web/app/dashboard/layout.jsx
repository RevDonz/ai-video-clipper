import SegmentI18n from "../../components/SegmentI18n.jsx";
import ShellData from "../../components/ShellData.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";
import { shellData } from "../../lib/shell-data.mjs";

export async function generateMetadata() {
  return routeMetadata("dashboard");
}

export default function DashboardLayout({ children }) {
  return <SegmentI18n namespaces={["dashboard"]}><ShellData {...shellData()}>{children}</ShellData></SegmentI18n>;
}
