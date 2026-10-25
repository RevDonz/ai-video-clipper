import SegmentI18n from "../../components/SegmentI18n.jsx";
import ShellData from "../../components/ShellData.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";
import { shellData } from "../../lib/shell-data.mjs";

export async function generateMetadata() {
  return routeMetadata("projects");
}

export default function ProjectsLayout({ children }) {
  return <SegmentI18n namespaces={["projects"]}><ShellData {...shellData()}>{children}</ShellData></SegmentI18n>;
}
