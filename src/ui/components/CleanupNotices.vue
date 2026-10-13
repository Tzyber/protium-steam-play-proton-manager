<script setup lang="ts">
import { computed } from "vue";
import { blockedReport } from "../../core/cleanupBlocked";
import { formatErrorKind } from "../formatError";
import { t } from "../i18n";
import { useCleanupStore } from "../stores/cleanupStore";
import { useScanStore } from "../stores/scanStore";
import BlockedExplanation from "./BlockedExplanation.vue";
import ExplainInfo from "./ExplainInfo.vue";

defineProps<{ shortcutHint: boolean }>();

const cleanup = useCleanupStore();
const scan = useScanStore();

const blockedItems = computed(() => {
  const items = blockedReport(scan.result).map((item) =>
    t("cleanup.blockedItem", { path: item.path, class: formatErrorKind(item.kind) }),
  );
  return items.length > 0 ? items : [t("cleanup.scanBlocked")];
});

const shortcutBlockedItems = computed(() =>
  cleanup.shortcutUnreadablePaths.map((path) =>
    t("cleanup.blockedItem", { path, class: formatErrorKind("unreadable") }),
  ),
);
</script>

<template>
  <BlockedExplanation
    v-if="cleanup.blockedBySkipped"
    :title="t('cleanup.blockedTitle')"
    :intro="t('common.couldNotVerify')"
    :items="blockedItems"
    :guarantee="t('cleanup.guaranteeScope')"
  />

  <div v-if="cleanup.pathMissingLibs.length" class="pathmissing">
    <p class="pm-title">{{ t("cleanup.pathMissingTitle") }}</p>
    <ul class="pm-list">
      <li v-for="p in cleanup.pathMissingLibs" :key="p">{{ p }}</li>
    </ul>
    <p class="pm-note">{{ t("cleanup.pathMissingNote") }}</p>
    <button class="pm-btn" type="button" @click="cleanup.dismissPathMissing()">
      {{ t("cleanup.pathMissingDismiss") }}
    </button>
  </div>

  <BlockedExplanation
    v-if="shortcutHint && cleanup.shortcutUnreadable"
    :title="t('cleanup.blockedPrefixesTitle')"
    :intro="t('common.couldNotVerify')"
    :items="shortcutBlockedItems"
    :guarantee="t('cleanup.guaranteeScope')"
    tone="info"
  />

  <div v-if="cleanup.incompleteDeletions.length" class="blocked">
    <strong>{{ t("cleanup.incompleteDeletionsTitle") }}</strong>
    <ExplainInfo
      class="explain-inline"
      :label="t('explain.topics.incompleteDeletion.title')"
      :topics="['incomplete-deletion']"
    />
    <p class="pm-note">{{ t("cleanup.incompleteDeletionsBody") }}</p>
    <p class="pm-note">{{ t("cleanup.incompleteDeletionsHint") }}</p>
    <ul class="pm-list">
      <li v-for="d in cleanup.incompleteDeletions" :key="d.path" class="mono">{{ d.path }}</li>
    </ul>
  </div>

  <div v-if="cleanup.incompleteDeletionsError" class="blocked" role="alert">
    {{ cleanup.incompleteDeletionsError }}
  </div>
</template>

<style scoped>
.blocked {
  background: color-mix(in srgb, var(--tier-borked) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--tier-borked) 40%, transparent);
  color: #ff9aa0;
  border-radius: var(--r-sm);
  padding: 12px 16px;
  font-family: var(--font-body);
  font-size: 0.875rem;
  margin-bottom: 16px;
}

.pathmissing {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 14px 16px;
  margin-bottom: 16px;
}
.pm-title { margin: 0 0 8px; color: var(--signal); font-size: 0.875rem; }
.pm-list { margin: 0 0 10px; padding-left: 18px; }
.pm-list li { color: var(--fg-1); font-family: var(--font-mono); font-size: 0.875rem; line-height: 1.6; }
.pm-note { margin: 0 0 12px; color: var(--fg-2); font-size: 0.875rem; line-height: 1.5; }
.pm-btn {
  background: var(--signal); border: none; color: var(--bg-0);
  border-radius: var(--r-sm); padding: 10px 15px;
  font-family: var(--font-body); font-weight: 600; font-size: 0.875rem; cursor: pointer;
}
.pm-btn:hover { background: var(--signal-bright); }
.pm-btn:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.explain-inline { margin-left: 7px; vertical-align: middle; }
</style>
