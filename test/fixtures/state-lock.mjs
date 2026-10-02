import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [directory, mode] = process.argv.slice(2);
if (mode === "pause-after-open") {
  const open = fs.openSync;
  fs.openSync = function (path, ...args) {
    const descriptor = open(path, ...args);
    if (path === join(directory, "racco.lock")) {
      // Pause in the original empty-file window. The parent explicitly releases
      // this barrier after a second process has acquired the state directory.
      process.send({ type: "opened-lock-file" });
      const waiting = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(join(directory, "resume"))) {
        Atomics.wait(waiting, 0, 0, 10);
      }
    }
    return descriptor;
  };
  syncBuiltinESMExports();
}

const { openRaccoStateDatabase } =
  await import("../../src/server/state/database.ts");
try {
  const state = openRaccoStateDatabase(directory);
  process.on("message", (message) => {
    if (message !== "close") throw new Error("Unexpected fixture command");
    state.close();
    process.disconnect();
  });
  process.send({ type: "opened-database" });
} catch (error) {
  process.send({ type: "rejected", message: error.message });
  process.disconnect();
}
