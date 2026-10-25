// One project's provider (rombak 07 §8.2): the core namespaces plus the project page's, the
// pipeline stage words, the layout names, the failure texts and hints, and the trend kind names
// of the clip chips. The editor below it replaces this provider with its own.
import SegmentI18n from "../../../components/SegmentI18n.jsx";

export default function ProjectLayout({ children }) {
  return <SegmentI18n namespaces={["projects", "project", "stage", "reason", "layout", "errors.storage", "errors.download", "errors.llm", "hints", "trends.kind"]}>{children}</SegmentI18n>;
}
