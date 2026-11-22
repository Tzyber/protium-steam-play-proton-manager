// Lokalisiert die Backend-Konsequenzen für den destruktiven Bestätigungsdialog.
// Das Backend liefert in `DeleteConsequence` strukturierte Fakten (action,
// path, affectedAppIds); die Struktur wird hier vollständig auf i18n-Keys
// gemappt, ohne rohe Backend-Texte in die Oberfläche durchzureichen (A-09).
import type { PendingDeleteInfo } from "../core/ports";
import { pathBasename } from "./format";
import { t } from "./i18n";

export function localizeConsequences(
  pending: PendingDeleteInfo,
  targetName?: string | null,
): string[] {
  return pending.consequences.flatMap((c) => {
    switch (pending.targetType) {
      case "orphan": {
        const name =
          targetName ?? String(c.affectedAppIds?.[0] ?? pathBasename(pending.targetPath));
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
        const name = pathBasename(c.path);
        // impactUnknown: die tool-VDF war nicht lesbar, die liste ist also
        // belegbar unvollständig. "leer" darf hier nicht als "keine" gelten;
        // die aktionszeile bleibt sichtbar.
        const lines =
          c.impactUnknown === true
            ? [
                t("cleanup.consequenceCompatTool", { name }),
                t("cleanup.consequenceCompatToolAppsUnknown", { name }),
              ]
            : [
                affected.length > 0
                  ? t("cleanup.consequenceCompatToolMapped", { name, n: affected.length })
                  : t("cleanup.consequenceCompatTool", { name }),
              ];
        return c.affectsGlobalDefault === true
          ? [...lines, t("cleanup.consequenceCompatToolGlobalDefault")]
          : lines;
      }
      case "extractLeftover":
        return t("cleanup.consequenceExtractLeftover", { name: pathBasename(c.path) });
    }
    return t("cleanup.consequenceUnknownEntry", {
      name: pathBasename(c.path || pending.targetPath),
    });
  });
}
