<script setup lang="ts">
defineProps<{
  title: string;
  intro?: string;
  items?: string[];
  /** Der Garantiesatz gehoert zum Geltungsbereich der Aktion, deshalb Pflicht. */
  guarantee: string;
  tone?: "blocked" | "info";
}>();
</script>

<template>
  <div class="blocked-explanation" :class="tone ?? 'blocked'" role="status">
    <div class="blocked-title">{{ title }}</div>
    <div v-if="intro" class="blocked-intro">{{ intro }}</div>
    <ul v-if="items && items.length" class="blocked-list">
      <li v-for="item in items" :key="item">{{ item }}</li>
    </ul>
    <div class="blocked-guarantee">{{ guarantee }}</div>
  </div>
</template>

<style scoped>
.blocked-explanation {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--tier-borked);
  border-radius: var(--r-md);
  padding: 12px 16px;
  margin-bottom: 16px;
}

.blocked-explanation.info {
  border-left-color: var(--signal-dim);
}

.blocked-title {
  font-weight: 600;
  color: var(--fg-0);
  margin-bottom: 4px;
}

.blocked-intro {
  font-size: 0.9em;
  color: var(--fg-1);
  margin-bottom: 8px;
}

.blocked-list {
  margin: 0 0 8px 16px;
  padding: 0;
  font-size: 0.9em;
  color: var(--fg-1);
}

.blocked-list li {
  margin-bottom: 2px;
}

.blocked-guarantee {
  font-size: 0.85em;
  color: var(--fg-2);
  font-style: italic;
}
</style>
