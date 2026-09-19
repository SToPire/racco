export function cancellationSignals() {
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort(new Error("Interrupted"));
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort(new Error("Terminated"));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return {
    signal: controller.signal,
    dispose() {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    },
  };
}
