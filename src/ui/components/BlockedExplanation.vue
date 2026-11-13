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
  border-left: 3px solid var(--error-border);
  border-radius: var(--r-md);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
}

.blocked-explanation.info {
  border-left-color: var(--signal-dim);
}

.blocked-title {
  font-weight: 600;
  color: var(--fg-0);
  margin-bottom: var(--space-1);
}

.blocked-intro {
  font-size: var(--text-md);
  color: var(--fg-1);
  margin-bottom: var(--space-2);
}

.blocked-list {
  margin: 0 0 var(--space-2) var(--space-4);
  padding: 0;
  font-size: var(--text-md);
  color: var(--fg-1);
}

.blocked-list li {
  margin-bottom: var(--space-1);
}

.blocked-guarantee {
  font-size: var(--text-sm);
  color: var(--fg-2);
}
</style>
