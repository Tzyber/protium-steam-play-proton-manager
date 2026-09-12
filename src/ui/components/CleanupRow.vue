<script setup lang="ts">
// Eine Zeile der Cleanup-Listen (Shader, Prefixe, Papierkorb). Die drei
// Bereiche hatten dasselbe Markup mit unterschiedlichen Spalten drumherum;
// Name, Zusatzspalte und Auswahlzustand kommen als Props/Slots.
import { t } from "../i18n";

defineProps<{
  label: string;
  /** voller Pfad (title) */
  path: string;
  /** gekürzte Pfadanzeige */
  shortPath: string;
  sizeText: string;
  selected: boolean;
  /** Zusatzspalte rechts vor der Größe (Papierkorb: datum) */
  extra?: string;
  extraTitle?: string;
  /** Warnhinweis hinter dem Namen (möglicher Shortcut) */
  warning?: string;
  /** Papierkorb-Zeilen tragen eine zusätzliche Datumsspalte */
  withDate?: boolean;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="row"
    :class="{ on: selected, 'with-date': withDate }"
    :aria-pressed="selected"
    @click="$emit('toggle')"
  >
    <span class="box" aria-hidden="true" />
    <span class="rname mono">
      {{ label }}
      <span v-if="warning" class="sc-warn" :title="warning" aria-hidden="true">?</span>
      <span v-if="warning" class="sr-only">{{ warning }}</span>
    </span>
    <span class="rpath mono" :title="path">{{ shortPath }}<span class="sr-only">{{ path }}</span></span>
    <span v-if="extra !== undefined" class="rdate mono" :title="extraTitle">{{ extra }}</span>
    <span class="rsize mono">{{ sizeText }}</span>
  </button>
</template>

<style scoped>
/* ganze zeile ist die klickfläche (a11y: große trefferfläche statt mini-checkbox).
   grid statt flex: die pfad-spalte ist minmax(0, 1fr) und kann damit NICHT über
   den container hinauswachsen. vorher schob die zusätzliche datumsspalte im
   papierkorb die zeile aus dem viewport. beide listen nutzen dieselben
   spaltenbreiten, damit sie identisch aussehen. */
.row {
position: relative;
  display: grid;
  /* rem statt px: skaliert mit root-schriftgröße (text-only-zoom). ch wäre hier
     falsch, .row erbt Inter vom body, nicht Space Mono. ch in Inter (14px) ≈ 7px,
     damit wäre 9ch ≈ 63px statt 90px. 5.6rem / 4.6rem bei root 16px = 90px / 74px. */
  grid-template-columns: 20px 5.6rem minmax(0, 1fr) 5.6rem;
  align-items: center; gap: 14px;
  width: 100%; text-align: left;
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px 14px; cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  /* damit tastatur-fokus nicht unter der sticky leiste landet */
  scroll-margin-bottom: 80px;
}
/* papierkorb: datumsspalte zwischen pfad und größe, feste breite */
.row.with-date { grid-template-columns: 20px 5.6rem minmax(0, 1fr) 4.6rem 5.6rem; }
.row:hover { border-color: var(--signal-dim); background: var(--bg-3); }
.row:hover .rdate {
  color: var(--fg-1);
}
.row:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.row.on { border-color: var(--signal); background: color-mix(in srgb, var(--signal) 10%, var(--bg-2)); }

.box {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 5px;
  border: 2px solid var(--fg-2); background: transparent;
  display: grid; place-items: center; transition: all 0.12s;
}
.row.on .box { border-color: var(--signal); background: var(--signal); }
.row.on .box::after {
  content: ""; width: 5px; height: 9px; margin-top: -2px;
  border: solid var(--bg-0); border-width: 0 2px 2px 0; transform: rotate(45deg);
}

.rname { font-size: 0.9375rem; color: var(--fg-0); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-warn {
  display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
  border-radius: 50%; font-size: 0.8125rem; font-weight: 600; margin-left: 4px;
  background: color-mix(in srgb, var(--tier-gold) 20%, transparent);
  color: #f5d678; border: 1px solid color-mix(in srgb, var(--tier-gold) 40%, transparent);
}
.rpath {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--fg-1); font-size: 0.875rem;
}
.rsize { color: var(--fg-1); font-size: 0.875rem; white-space: nowrap; text-align: right; }
.rdate { color: var(--fg-2); font-size: 0.875rem; white-space: nowrap; text-align: right; }
</style>
