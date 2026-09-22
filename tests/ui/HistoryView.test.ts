// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../../src/ui/i18n";
import HistoryView from "../../src/ui/views/HistoryView.vue";

const listConfigBackups = vi.fn();
const openBackupsFolder = vi.fn();
const openLogsFolder = vi.fn();
const readLogTail = vi.fn();

vi.mock("../../src/core/adapters/tauri", () => ({
  listConfigBackups: (...args: unknown[]) => listConfigBackups(...args),
  openBackupsFolder: (...args: unknown[]) => openBackupsFolder(...args),
  openLogsFolder: (...args: unknown[]) => openLogsFolder(...args),
  readLogTail: (...args: unknown[]) => readLogTail(...args),
}));

describe("HistoryView", () => {
  beforeEach(() => {
    setLocale("de");
    setActivePinia(createPinia());
    listConfigBackups.mockReset();
    readLogTail.mockReset();
  });

  it("zeigt frühere Stände mit Art, Zeitpunkt und Größe, ohne Dateinamen", async () => {
    listConfigBackups.mockResolvedValue([
      {
        fileName: "localconfig-113451388-1789062744050.vdf",
        kind: "localconfig",
        targetId: "113451388",
        timestampMs: 1789062744050,
        sizeBytes: 174080,
      },
    ]);
    readLogTail.mockResolvedValue("");

    const wrapper = mount(HistoryView);
    await vi.waitFor(() => expect(listConfigBackups).toHaveBeenCalled());
    await vi.waitFor(() => expect(wrapper.text()).toContain("Startoptionen, Account 113451388"));

    expect(wrapper.find(".title .label").text()).toBe(t("history.label"));
    expect(wrapper.find(".title h1").text()).toBe(t("history.title"));
    expect(wrapper.text()).toContain(t("history.snapshotsTitle"));
    expect(wrapper.text()).not.toContain(".vdf");
  });

  it("zeigt den Schluss des Protokolls", async () => {
    listConfigBackups.mockResolvedValue([]);
    readLogTail.mockResolvedValue("[1] [ERROR] UI-Fehler: kaputt\n");

    const wrapper = mount(HistoryView);
    await vi.waitFor(() => expect(readLogTail).toHaveBeenCalled());
    await vi.waitFor(() => expect(wrapper.find(".log").text()).toContain("UI-Fehler: kaputt"));
  });

  it("meldet einen unlesbaren Stand als Zustand statt als leere Liste", async () => {
    listConfigBackups.mockRejectedValue("unreadable");
    readLogTail.mockResolvedValue("");

    const wrapper = mount(HistoryView);
    await vi.waitFor(() => expect(listConfigBackups).toHaveBeenCalled());
    await vi.waitFor(() => expect(wrapper.text()).toContain("unlesbar"));

    expect(wrapper.text()).not.toContain(t("history.snapshotsEmpty"));
  });
});
