// The editor's own provider (rombak 07 §8.2): it replaces the projects segment's, with the core
// namespaces plus the editor's. The editor strings move into the catalog in i18n M8a.
// The editor's HeroUI/Tailwind entry and its kit provider load here only (06 §17 F0, X10).
import "../../../../../editor.css";
import KitProvider from "../../../../../../components/editor/ui/KitProvider.jsx";
import SegmentI18n from "../../../../../../components/SegmentI18n.jsx";

export default function EditorLayout({ children }) {
  return (
    <SegmentI18n namespaces={["editor"]}>
      <KitProvider>{children}</KitProvider>
    </SegmentI18n>
  );
}
