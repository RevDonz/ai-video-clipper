// The editor's own provider (rombak 07 §8.2): it replaces the projects segment's, with the core
// namespaces plus the editor's. The editor strings move into the catalog in i18n M8a.
import SegmentI18n from "../../../../../../components/SegmentI18n.jsx";

export default function EditorLayout({ children }) {
  return <SegmentI18n namespaces={["editor"]}>{children}</SegmentI18n>;
}
