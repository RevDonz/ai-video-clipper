import SegmentI18n from "../../components/SegmentI18n.jsx";
import ShellData from "../../components/ShellData.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";
import { sessionShellData } from "../../lib/shell-session.mjs";

export async function generateMetadata() {
  return routeMetadata("trends");
}

export default async function TrendsLayout({ children }) {
  const shell = await sessionShellData();
  return <SegmentI18n namespaces={["trends"]}><ShellData {...shell}>{children}</ShellData></SegmentI18n>;
}
