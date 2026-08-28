// Lokalisiert die Backend-Konsequenzen für den destruktiven Bestätigungsdialog.
// Das Backend liefert in `DeleteConsequence` strukturierte Fakten (action,
// path, affectedAppIds) plus einen rohen description-String; die Struktur
// wird hier auf i18n-Keys gemappt. Der Backend-String bleibt als Fallback —
// das Backend ist die Autorität für WAS passiert, das Frontend lokalisiert
// nur die Darstellung.
import type { PendingDeleteInfo } from "../core/ports.js";
import { t } from "./i18n/index.js";

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function localizeConsequences(pending: PendingDeleteInfo): string[] {
  return pending.consequences.map((c) => {
    switch (pending.targetType) {
      case "orphan": {
        const appId = c.affectedAppIds?.[0] ?? pending.targetPath;
        if (c.action === "trash") return t("cleanup.consequenceMoveToTrash", { appId });
        if (c.action === "permanentDelete") {
          return t("cleanup.consequencePermanentShadercache", { appId });
        }
        break;
      }
      case "trash":
        return t("cleanup.consequenceTrashEntry", { name: baseName(c.path) });
      case "compatTool":
        return t("cleanup.consequenceCompatTool", { name: baseName(c.path) });
    }
    return c.description;
  });
}
