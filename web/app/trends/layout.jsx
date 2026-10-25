import SegmentI18n from "../../components/SegmentI18n.jsx";
import { routeMetadata } from "../../lib/i18n/server.mjs";

export async function generateMetadata() {
  return routeMetadata("trends");
}

export default function TrendsLayout({ children }) {
  return <SegmentI18n namespaces={["trends"]}>{children}</SegmentI18n>;
}
