// T-09/N-1: gemeinsame komponenten-stubs der game-detail-drawer-tests.
// preamble und integrationstest trugen je eigene stubs, inhaltlich divergent
// (SelectBox: klickliste mit modelValue gegen statisches <select>); ein umbau
// eines stubs ließ einen der beiden teststränge still scheitern. hier steht
// die eine quelle, beide dateien holen sie über die async-mock-fabriken.

export const playButtonStub = {
  template: '<button data-testid="play-button" />',
};

export const tierBadgeStub = {
  template: '<span data-testid="tier-badge" />',
};

/** liste mit klick-auswahl: auch tests ohne interaktion rendern sie, tests mit
 *  tool-wechsel klicken die option an (emittiert update:modelValue). */
export const selectBoxStub = {
  props: ["options", "modelValue"],
  emits: ["update:modelValue"],
  template:
    '<ul data-testid="select-box"><li v-for="option in options" :key="option.value" class="select-option" @click="$emit(\'update:modelValue\', option.value)">{{ option.label }}</li></ul>',
};

/** frischer mock je aufruf: geteilte fn-handles würden über tests akkumulieren. */
export function useCoverStub(): { src: null; onError: () => void } {
  return { src: null, onError: () => {} };
}
