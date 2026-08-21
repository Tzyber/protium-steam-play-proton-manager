import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
