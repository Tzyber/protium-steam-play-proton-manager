// Lokalisiert die Backend-Konsequenzen für den destruktiven Bestätigungsdialog.
// Das Backend liefert in `DeleteConsequence` strukturierte Fakten (action,
// path, affectedAppIds) plus einen rohen description-String; die Struktur
// wird hier auf i18n-Keys gemappt. Der Backend-String bleibt als Fallback —
// das Backend ist die Autorität für WAS passiert, das Frontend lokalisiert
// nur die Darstellung.
import type { PendingDeleteInfo } from "../core/ports.js";
import { pathBasename } from "./format.js";
import { t } from "./i18n/index.js";

export function localizeConsequences(
  pending: PendingDeleteInfo,
  targetName?: string | null,
): string[] {
  return pending.consequences.map((c) => {
    switch (pending.targetType) {
      case "orphan": {
        const name = targetName ?? String(c.affectedAppIds?.[0] ?? pending.targetPath);
        if (c.action === "trash") return t("cleanup.consequenceMoveToTrash", { name });
        if (c.action === "permanentDelete") {
          return t("cleanup.consequencePermanentShadercache", { name });
        }
        break;
      }
      case "trash":
        return t("cleanup.consequenceTrashEntry", { name: pathBasename(c.path) });
      case "compatTool": {
        const affected = c.affectedAppIds ?? [];
        if (affected.length > 0) {
          return t("cleanup.consequenceCompatToolMapped", {
            name: pathBasename(c.path),
            n: affected.length,
          });
        }
        return t("cleanup.consequenceCompatTool", { name: pathBasename(c.path) });
      }
    }
    return c.description;
  });
}
