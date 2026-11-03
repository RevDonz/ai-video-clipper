import SegmentI18n from "../../components/SegmentI18n.jsx";
import ShellData from "../../components/ShellData.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";
import { sessionShellData } from "../../lib/shell-session.mjs";

export async function generateMetadata() {
  return routeMetadata("projects");
}

export default async function ProjectsLayout({ children }) {
  const shell = await sessionShellData();
  return <SegmentI18n namespaces={["projects", "errors.storage", "errors.download", "hints"]}><ShellData {...shell}>{children}</ShellData></SegmentI18n>;
}
