// Darstellung der ProtonDB-Stufe an einer Stelle: Farbe, Kurzname und der
// englische Klarname für den Support-Text. Vorher pflegten TierBadge,
// FilterBar, GameDetailDrawer und supportText je eine eigene Liste; eine neue
// Stufe musste überall nachgezogen werden.

import type { Tier } from "../core/types";
import { t } from "./i18n";

const TONE: Record<Tier, string> = {
  platinum: "var(--tier-platinum)",
  gold: "var(--tier-gold)",
  silver: "var(--tier-silver)",
  bronze: "var(--tier-bronze)",
  borked: "var(--tier-borked)",
  unknown: "var(--tier-unknown)",
};

const NAME: Record<Tier, string> = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  borked: "Borked",
  unknown: "unknown",
};

/** CSS-Farbwert der Stufe (`var(--tier-…)`). */
export function tierTone(tier: Tier): string {
  return TONE[tier];
}

/** englischer Klarname (Markenbegriff), wie ihn der Support-Text braucht. */
export function tierText(tier: Tier): string {
  return tier === "unknown" ? t("support.unknown") : NAME[tier];
}

/** lokalisierter Kurzname für sichtbare Labels. */
export function tierName(tier: Tier): string {
  return t(`tierName.${tier}`);
}
