<script lang="ts">
let selectBoxCount = 0;
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  options: { value: string; label: string }[];
  modelValue: string;
  id?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [v: string];
}>();

const open = ref(false);
const listRef = ref<HTMLUListElement | null>(null);
const btnRef = ref<HTMLButtonElement | null>(null);
const ho = ref(0);
const instanceId = ++selectBoxCount;
const triggerId = props.id ?? `select-box-trigger-${instanceId}`;
const listboxId = `select-box-listbox-${instanceId}`;

const selectedLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);

function select(value: string) {
  emit("update:modelValue", value);
  open.value = false;
  ho.value = 0;
  nextTick(() => btnRef.value?.focus());
}

function onBtnKeydown(e: KeyboardEvent) {
  if (e.key === "Tab") {
    open.value = false;
  } else if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
    e.preventDefault();
    open.value = true;
    ho.value = 0;
    nextTick(() => focusItem(0));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    open.value = true;
    ho.value = props.options.length - 1;
    nextTick(() => focusItem(props.options.length - 1));
  }
}

function focusItem(i: number) {
  const items = listRef.value?.querySelectorAll<HTMLElement>('[role="option"]');
  items?.[i]?.focus();
}

function onListKeydown(e: KeyboardEvent) {
  const n = props.options.length;
  if (e.key === "Tab") {
    open.value = false;
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    ho.value = (ho.value + 1) % n;
    nextTick(() => focusItem(ho.value));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    ho.value = (ho.value - 1 + n) % n;
    nextTick(() => focusItem(ho.value));
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const o = props.options[ho.value];
    if (o) select(o.value);
  } else if (e.key === "Escape") {
    // stopPropagation: sonst schließt das event auch den drawer-keydown
    // (ESC schließt den drawer), obwohl nur die listbox zu schließen war.
    e.preventDefault();
    e.stopPropagation();
    open.value = false;
    nextTick(() => btnRef.value?.focus());
  }
}

// click-outside: capture-phase, nur aktiv wenn geöffnet.
// blur-basierter ansatz hat race-condition mit options-klick unter webkitgtk.
function onClickOutside(e: MouseEvent) {
  if (!open.value) return;
  const target = e.target as Node;
  if (btnRef.value?.contains(target) || listRef.value?.contains(target)) return;
  open.value = false;
}

watch(open, (v) => {
  if (v) document.addEventListener("click", onClickOutside, true);
  else document.removeEventListener("click", onClickOutside, true);
});

onBeforeUnmount(() => {
  open.value = false;
  document.removeEventListener("click", onClickOutside, true);
});
</script>

<template>
	<div class="sb">
		<button
			ref="btnRef"
			:id="triggerId"
			type="button"
			class="sb-btn control mono"
			:aria-expanded="open"
			aria-haspopup="listbox"
			:aria-controls="open ? listboxId : undefined"
			@click="open = !open"
			@keydown="onBtnKeydown"
		>
			<span class="sb-label">{{ selectedLabel }}</span>
			<span class="sb-chevron" aria-hidden="true">▾</span>
		</button>
		<ul
			v-if="open"
			ref="listRef"
			:id="listboxId"
			role="listbox"
			:aria-labelledby="triggerId"
			class="sb-list mono"
			@keydown="onListKeydown"
		>
			<li
				v-for="(o, i) in options"
				:key="o.value"
				role="option"
				class="sb-opt"
				:class="{ on: o.value === modelValue, hl: i === ho }"
				:aria-selected="o.value === modelValue"
				tabindex="-1"
				@mouseenter="ho = i"
				@click="select(o.value)"
			>
				{{ o.label }}
			</li>
		</ul>
	</div>
</template>

<style scoped>
.sb { position: relative; flex: 1; min-width: 0; }
.sb-btn {
	width: 100%;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding-right: 10px; /* chevron hat eigenes padding */
}
.sb-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-chevron {
	flex-shrink: 0;
	font-size: 0.75rem;
	color: var(--fg-2);
	transition: transform 0.15s;
}
.sb-btn[aria-expanded="true"] .sb-chevron { transform: rotate(180deg); }

.sb-list {
	position: absolute;
	top: calc(100% + 4px);
	left: 0;
	right: 0;
	z-index: 50;
	max-height: 240px;
	overflow-y: auto;
	margin: 0;
	padding: 4px;
	list-style: none;
	background: var(--bg-2);
	border: 1px solid var(--line);
	border-radius: var(--r-sm);
	box-shadow: 0 12px 32px -10px rgba(0, 0, 0, 0.5);
}
.sb-opt {
	padding: 9px 11px;
	border-radius: 4px;
	font-size: 0.8125rem;
	color: var(--fg-1);
	cursor: pointer;
}
.sb-opt:hover,
.sb-opt:focus-visible,
.sb-opt.hl { background: var(--bg-3); color: var(--fg-0); outline: none; }
.sb-opt.on { color: var(--signal-bright); }
.sb-opt.on::before { content: "✓ "; font-size: 0.75rem; }
</style>
