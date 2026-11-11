/** FR-5 (P1/P2): regeln statt dateiweiter Matches pinnen.
 *
 *  `flattenCss` schneidet zuerst die `<style>`-Blöcke heraus, damit die erste
 *  Regel eines SFC-Styleblocks ein Regelanfang ist und Template-Braces keine
 *  falschen Regelanfänge erzeugen. Danach Kommentare raus, Komma-Abstand
 *  normalisieren und erst dann Whitespace bündeln; die Reihenfolge macht den
 *  Lauf idempotent und lässt ein- wie mehrzeilige Schreibweise gleich treffen. */

export function flattenCss(source: string): string {
  const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
    (match) => match[1] ?? "",
  );
  const css = styleBlocks.length > 0 ? styleBlocks.join("\n") : source;
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ");
}

function rulePrefix(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:^|[{};]) ?${escaped} \\{`;
}

/** Zählt Regeln, deren Selektor exakt `selector` ist (keine präfix-treffer). */
export function ruleCount(source: string, selector: string): number {
  const pattern = new RegExp(rulePrefix(flattenCss(selector)), "g");
  return [...flattenCss(source).matchAll(pattern)].length;
}

/** Erster exakter Regelblock; wirft, wenn der Selektor fehlt. */
export function ruleBlock(source: string, selector: string): string {
  const match = new RegExp(`${rulePrefix(flattenCss(selector))}([^}]*)`).exec(flattenCss(source));
  if (!match) throw new Error(`Regel nicht gefunden: ${selector}`);
  return match[1] ?? "";
}

/** Letzter Wert einer Eigenschaft im Regelblock; eine spätere Deklaration gewinnt. */
export function declarationValue(block: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...block.matchAll(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "g"))];
  return matches[matches.length - 1]?.[1]?.trim();
}
