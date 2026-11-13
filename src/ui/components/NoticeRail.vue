<script setup lang="ts">
import NotificationToast from "./NotificationToast.vue";
import UpdateNotice from "./UpdateNotice.vue";
</script>

<template>
  <div class="notice-rail">
    <UpdateNotice />
    <NotificationToast />
  </div>
</template>

<style scoped>
.notice-rail {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}
</style>
