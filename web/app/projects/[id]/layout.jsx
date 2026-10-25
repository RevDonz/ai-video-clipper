// One project's provider (rombak 07 §8.2): the core namespaces plus the project page's, the
// pipeline stage words and the layout names. The editor below it replaces this provider with its own.
import SegmentI18n from "../../../components/SegmentI18n.jsx";

export default function ProjectLayout({ children }) {
  return <SegmentI18n namespaces={["projects", "project", "stage", "reason", "layout"]}>{children}</SegmentI18n>;
}
