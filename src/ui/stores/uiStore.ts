import { defineStore } from "pinia";
import { useLibraryStore } from "./libraryStore";

export type ViewId = "library" | "proton" | "cleanup";

export const useUiStore = defineStore("ui", {
  state: () => ({
    activeView: "library" as ViewId,
    /** appId des spiels im offenen detail-drawer. bewusst KEINE Game-referenz:
     *  ein rescan ersetzt scan.result komplett, eine gehaltene referenz würde
     *  veralten, und applyGameConfig (schreibt ins neue array) käme im drawer
     *  nie an. die appId bleibt über rescans stabil, der drawer löst sie live
     *  gegen scan.result.games auf. */
    selectedAppId: null as number | null,
    /** modal/drawer offen → hauptinhalt + sidebar via inert stilllegen */
    inertMain: false,
    /** globale notification-toast. neueste überschreibt, 30s auto-dismiss. */
    notification: null as { message: string } | null,
    notificationTimer: null as ReturnType<typeof setTimeout> | null,
  }),
  actions: {
    go(view: ViewId) {
      this.activeView = view;
    },
    openGame(appId: number) {
      this.selectedAppId = appId;
    },
    closeGame() {
      this.selectedAppId = null;
    },
    // aus dem proton-manager in die nach compat-tool gefilterte library springen
    showLibraryForTool(internalName: string) {
      const lib = useLibraryStore();
      lib.reset();
      lib.compatTools = [internalName];
      this.activeView = "library";
    },
    /** fehler als kopierbare notification anzeigen. 30s auto-dismiss als fallback. */
    showNotification(message: string) {
      if (this.notificationTimer) clearTimeout(this.notificationTimer);
      this.notification = { message };
      this.notificationTimer = setTimeout(() => {
        this.dismissNotification();
      }, 30_000);
    },
    dismissNotification() {
      if (this.notificationTimer) {
        clearTimeout(this.notificationTimer);
        this.notificationTimer = null;
      }
      this.notification = null;
    },
  },
});
