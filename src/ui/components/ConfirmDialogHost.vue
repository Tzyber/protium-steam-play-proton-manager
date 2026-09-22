<script setup lang="ts">
import { t } from "../i18n";
import { useConfirmStore } from "../stores/confirmStore";
import ConfirmDialog from "./ConfirmDialog.vue";

// Der Bestätigungsdialog hing zuvor wortgleich in Bereinigung und
// Proton-Manager. Er gehört einmal hierher: die Anfrage selbst trägt Titel,
// Meldung und optionale Beschriftung, der Dialog zeigt sie nur an.
const confirm = useConfirmStore();
</script>

<template>
  <ConfirmDialog
    v-if="confirm.pending"
    :title="confirm.pending.title"
    :busy="confirm.busy"
    :confirm-label="confirm.pending.confirmLabel ?? t('common.delete')"
    @confirm="confirm.confirm()"
    @cancel="confirm.cancel()"
  >
    <p class="consequences">{{ confirm.pending.message }}</p>
  </ConfirmDialog>
</template>
