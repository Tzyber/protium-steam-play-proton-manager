import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./ui/App.vue";
import "./ui/fonts.css";
import "./ui/tokens.css";
import { getLocale } from "./ui/i18n";

document.documentElement.lang = getLocale();
createApp(App).use(createPinia()).mount("#app");
