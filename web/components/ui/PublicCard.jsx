// The frame of a page without the app shell (/login now; the invite and password-reset pages
// later): it brings ui.css and the providers, so such a page imports this, never ui.css itself
// (05-ui-dashboard.md §3.3).
import "../../app/ui.css";

import Providers from "./Providers.jsx";

export default function PublicCard({ children }) {
  return <Providers>{children}</Providers>;
}
