import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

let result;
try {
  result = spawnSync("stryker", ["run"], { stdio: "inherit" });
} finally {
  rmSync(".stryker-tmp", { recursive: true, force: true });
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
