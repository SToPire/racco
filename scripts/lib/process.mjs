import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("../../", import.meta.url));

/** Run one command in an owned process group and wait for termination on cancellation. */
export function run(command, args, options = {}) {
  const { signal, ...spawnOptions } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      ...spawnOptions,
      detached: true,
    });
    let cancelled;
    let killTimer;
    let settled = false;
    const kill = (name) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const cancel = (reason, name = "SIGTERM") => {
      if (cancelled || settled) return;
      cancelled = reason;
      kill(name);
      killTimer = setTimeout(() => kill("SIGKILL"), 5000);
      killTimer.unref();
    };
    const abort = () => cancel(signal.reason);
    const interrupt = () => {
      process.exitCode = 130;
      cancel(new Error("Command interrupted"), "SIGINT");
    };
    const terminate = () => {
      process.exitCode = 143;
      cancel(new Error("Command terminated"));
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code, exitSignal) => {
      if (cancelled) kill("SIGKILL");
      finish(
        cancelled ??
          (code === 0
            ? undefined
            : new Error(`${command} failed (${code ?? exitSignal})`)),
      );
    });
    signal?.addEventListener("abort", abort, { once: true });
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    if (signal?.aborted) abort();
  });
}
