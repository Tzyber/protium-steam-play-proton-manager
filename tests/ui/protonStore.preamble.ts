import { vi } from "vitest";
import type { GeRelease } from "../../src/core/geproton";
import type { ScanResult } from "../../src/core/types";

export type ProgressHandler = (event: DownloadProgressEvent) => void;
export type PhaseHandler = (event: InstallPhaseEvent) => void;
type InstallCall = { downloadId: string };

const {
  mockGeTargetArch,
  mockInstallGeProton,
  mockHttpGet,
  mockOnDownloadProgress,
  mockOnInstallPhase,
  mockCancelDownload,
} = vi.hoisted(() => ({
  mockGeTargetArch: vi.fn<() => Promise<"x86_64" | "aarch64">>(async () => "x86_64"),
  mockInstallGeProton: vi.fn<(params: InstallCall) => Promise<"verified" | "unverified">>(
    async () => "verified",
  ),
  mockCancelDownload: vi.fn(async () => {}),
  mockHttpGet: vi.fn(async () => ({
    status: 200,
    ok: true,
    text: `${"a".repeat(128)}  x.tar.gz`,
    headers: {},
  })),
  mockOnDownloadProgress: vi.fn<(handler: ProgressHandler) => Promise<() => void>>(
    async () => () => {},
  ),
  mockOnInstallPhase: vi.fn<(handler: PhaseHandler) => Promise<() => void>>(async () => () => {}),
}));

vi.mock("../../src/core/adapters/tauri", async () => {
  return {
    tauriPorts: {
      fs: {},
      http: {
        get: mockHttpGet,
      },
      system: {
        geTargetArch: mockGeTargetArch,
        installGeProton: mockInstallGeProton,
        prepareDelete: vi.fn(async (req) => ({
          token: "tok-ge",
          expiresAt: Date.now() + 60000,
          targetType: req.targetType,
          targetPath: req.path,
          consequences: [],
        })),
        executeDelete: vi.fn(async () => ({ deletedPath: "/path" })),
        cancelDownload: mockCancelDownload,
        onDownloadProgress: mockOnDownloadProgress,
        onInstallPhase: mockOnInstallPhase,
      },
      cache: {},
    },
  };
});

import type { DownloadProgressEvent, InstallPhaseEvent } from "../../src/core/ports";
import { scanResult } from "../support/factories";

export const release: GeRelease = {
  tag: "GE-Proton9-27",
  name: "GE-Proton9-27",
  publishedAt: "",
  notes: "",
  installName: "GE-Proton9-27",
  tarball: {
    name: "GE-Proton9-27.tar.gz",
    url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.tar.gz",
    size: 400,
  },
  sha512Url:
    "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton9-27/GE-Proton9-27.sha512sum",
};

export function fakeScanResult(): ScanResult {
  return scanResult({ steamRoot: "/root", libraries: [] });
}

/** registrierungen gesamt: jeder init-Versuch startet beide Abos. */
export function listenerCalls(): number {
  return mockOnDownloadProgress.mock.calls.length + mockOnInstallPhase.mock.calls.length;
}

export type HttpReply = {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
};

/** Frische GitHub-Antwort mit genau einem modernen x86_64-asset. */
export function releasesReply(tag: string): HttpReply {
  const assetName = `${tag}-x86_64.tar.gz`;
  return {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify([
      {
        tag_name: tag,
        name: tag,
        published_at: "",
        body: "",
        assets: [
          {
            name: assetName,
            browser_download_url: `https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${tag}/${assetName}`,
            size: 400,
          },
        ],
      },
    ]),
  };
}

export {
  mockCancelDownload,
  mockGeTargetArch,
  mockHttpGet,
  mockInstallGeProton,
  mockOnDownloadProgress,
  mockOnInstallPhase,
};
