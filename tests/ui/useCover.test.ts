// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { Game } from "../../src/core/types";

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
}));

vi.mock("../../src/core/adapters/tauri", () => ({
  tauriPorts: { fs: { readFile: mockReadFile } },
}));

import { useCover } from "../../src/ui/useCover";

function game(appId: number, localHeader: string | null): Game {
  return {
    appId,
    name: `Game ${appId}`,
    library: "/library",
    sizeBytes: 0,
    compatTool: "default",
    compatToolSource: "default",
    protonDb: null,
    localHeader,
    headerImage: `https://cdn.example/${appId}.jpg`,
  };
}

describe("useCover", () => {
  it("lädt lokale cover-bytes als blob-url und fällt danach auf cdn zurück", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cover-1");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const current = ref<Game | null>(game(42, "/library/cache/library_header.jpg"));
    let exposed: ReturnType<typeof useCover> | undefined;
    const host = mount({
      setup() {
        exposed = useCover(() => current.value);
        return {};
      },
      template: "<div />",
    });
    if (!exposed) throw new Error("useCover not mounted");
    const cover = exposed;

    await nextTick();
    await vi.waitFor(() => expect(cover.src.value).toBe("blob:cover-1"));
    expect(mockReadFile).toHaveBeenCalledWith("/library/cache/library_header.jpg");

    cover.onError();
    expect(cover.src.value).toBe("https://cdn.example/42.jpg");
    expect(revoke).toHaveBeenCalledWith("blob:cover-1");

    host.unmount();
    create.mockRestore();
    revoke.mockRestore();
  });

  it("widerruft alte blob-url bei spielwechsel und verwirft verspätete antworten", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const deferred: { resolve: (bytes: Uint8Array) => void } = { resolve: () => {} };
    mockReadFile.mockImplementation(
      (path) =>
        new Promise<Uint8Array>((resolve) => {
          if (path.endsWith("one.jpg")) deferred.resolve = resolve;
          else resolve(new Uint8Array([9]));
        }),
    );
    const current = ref<Game | null>(game(1, "/library/one.jpg"));
    let exposed: ReturnType<typeof useCover> | undefined;
    const host = mount({
      setup() {
        exposed = useCover(() => current.value);
        return {};
      },
      template: "<div />",
    });
    if (!exposed) throw new Error("useCover not mounted");
    const cover = exposed;
    await nextTick();

    current.value = game(2, "/library/two.jpg");
    await nextTick();
    await vi.waitFor(() => expect(mockReadFile).toHaveBeenCalledWith("/library/two.jpg"));
    await vi.waitFor(() => expect(cover.src.value).toContain("blob:"));
    deferred.resolve(new Uint8Array([9]));
    await nextTick();

    expect(cover.src.value).not.toContain("one.jpg");
    expect(cover.src.value).toContain("blob:");

    host.unmount();
    revoke.mockRestore();
  });

  it("widerruft blob-url beim unmount", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cover-unmount");
    mockReadFile.mockResolvedValue(new Uint8Array([4]));
    const current = ref<Game | null>(game(7, "/library/seven.jpg"));
    let exposed: ReturnType<typeof useCover> | undefined;
    const host = mount({
      setup() {
        exposed = useCover(() => current.value);
        return {};
      },
      template: "<div />",
    });
    if (!exposed) throw new Error("useCover not mounted");
    const cover = exposed;

    await vi.waitFor(() => expect(cover.src.value).toBe("blob:cover-unmount"));
    host.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:cover-unmount");

    create.mockRestore();
    revoke.mockRestore();
  });
});
