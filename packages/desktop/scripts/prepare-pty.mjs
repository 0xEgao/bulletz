import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Source launches skip electron-builder's afterPack hook.
if (process.platform === "darwin") {
  const root = dirname(fileURLToPath(import.meta.resolve("node-pty/package.json")));
  for (const dir of ["build/Release", "build/Debug", `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, dir, "spawn-helper");
    const stat = statSync(helper, { throwIfNoEntry: false });
    if (stat?.isFile() && !(stat.mode & 0o100)) {
      chmodSync(helper, stat.mode | 0o100);
    }
  }
}
