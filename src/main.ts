import { createPinia } from "pinia";
import { createApp } from "vue";
import { appVersion, openLogsFolder } from "./core/adapters/tauri";
import App from "./ui/App.vue";
import "./ui/fonts.css";
import "./ui/tokens.css";
import { logError, logEvent } from "./ui/diagnostics";
import { formatError } from "./ui/formatError";
import { getLocale, t } from "./ui/i18n";
import { useUiStore } from "./ui/stores/uiStore";

document.documentElement.lang = getLocale();

const pinia = createPinia();
const app = createApp(App).use(pinia);

/** Kontrollierte Fehleransicht: ersetzt eine leere Seite, wenn die Oberflaeche
 *  nicht mehr rendern kann. Texte uebersetzt, Rohtext nur ins Log. */
function showFatalError(): void {
  const host = document.querySelector("#app");
  if (host === null) return;
  host.textContent = "";
  const panel = document.createElement("div");
  panel.className = "fatal-error";
  const title = document.createElement("h1");
  title.textContent = t("app.fatalTitle");
  const hint = document.createElement("p");
  hint.textContent = t("app.fatalHint");
  const openLogs = document.createElement("button");
  openLogs.type = "button";
  openLogs.textContent = t("app.openLogs");
  openLogs.addEventListener("click", () => {
    void openLogsFolder().catch(() => {});
  });
  panel.append(title, hint, openLogs);
  host.append(panel);
}

app.config.errorHandler = (err, _instance, info) => {
  console.error("[Protium UI Error]", err, info);
  logError(`UI-Fehler (info: ${info})`, err);
  try {
    useUiStore(pinia).showNotification(formatError(err));
  } catch {
    showFatalError();
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    logError("Unhandled Rejection", event.reason);
  });
}

void appVersion()
  .then((version) => logEvent("info", `Protium ${version} gestartet (Sprache ${getLocale()})`))
  .catch(() => logEvent("info", "Protium gestartet"));

try {
  app.mount("#app");
} catch {
  showFatalError();
}
