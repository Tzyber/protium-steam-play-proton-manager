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

/** Erster exakter Regelblock innerhalb eines `@media (...)`-Blocks (klammer-balanciert). */
export function mediaRuleBlock(source: string, mediaCondition: string, selector: string): string {
  const flat = flattenCss(source);
  const condFlat = flattenCss(mediaCondition)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`@media\\s*${condFlat}\\s*\\{`, "g");
  const match = headerRe.exec(flat);
  if (!match) throw new Error(`Media-Block nicht gefunden: ${mediaCondition}`);
  let depth = 1;
  let cursor = match.index + match[0].length;
  const start = cursor;
  while (cursor < flat.length && depth > 0) {
    const ch = flat[cursor];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    cursor++;
  }
  if (depth !== 0) throw new Error(`Unbalancierter Media-Block: ${mediaCondition}`);
  const inner = flat.slice(start, cursor - 1).trim();
  return ruleBlock(inner, selector);
}

/** Letzter Wert einer Eigenschaft im Regelblock; eine spätere Deklaration gewinnt. */
export function declarationValue(block: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...block.matchAll(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "g"))];
  return matches[matches.length - 1]?.[1]?.trim();
}
