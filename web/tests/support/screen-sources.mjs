// The source files of one screen, read together. Buat klip and the project page were split into
// components in Dashboard F2/F3 (05-ui-dashboard.md §6.3, §6.4); a source test that once read one
// page file reads the screen's files instead, in this order.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../..", import.meta.url));

export const DASHBOARD_FILES = Object.freeze([
  "app/dashboard/page.jsx",
  "app/dashboard/FocusField.jsx",
  "app/dashboard/RecentProjects.jsx",
  "components/ChoiceChip.jsx",
]);

export const PROJECT_FILES = Object.freeze([
  "app/projects/[id]/page.jsx",
  "components/ProjectProgress.jsx",
  "app/projects/[id]/ClipsSection.jsx",
  "components/ClipViewer.jsx",
  "app/projects/[id]/DeleteProject.jsx",
]);

async function joined(files) {
  const parts = await Promise.all(files.map((file) => readFile(path.join(WEB, file), "utf8")));
  return parts.join("\n");
}

export const dashboardSource = () => joined(DASHBOARD_FILES);
export const projectSource = () => joined(PROJECT_FILES);
export const readWeb = (relative) => readFile(path.join(WEB, relative), "utf8");
