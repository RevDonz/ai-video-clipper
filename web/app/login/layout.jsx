// The login segment's use-intl provider: the core namespaces plus auth, for the client parts of
// the page (the language picker).
import SegmentI18n from "../../components/SegmentI18n.jsx";

export default function LoginLayout({ children }) {
  return <SegmentI18n namespaces={["auth"]}>{children}</SegmentI18n>;
}
