import SegmentI18n from "../../components/SegmentI18n.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";

export async function generateMetadata() {
  return routeMetadata("projects");
}

export default function ProjectsLayout({ children }) {
  return <SegmentI18n namespaces={["projects"]}>{children}</SegmentI18n>;
}
