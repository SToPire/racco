import { createServer } from "vite";
import { startPreview, stopPreview } from "./preview.mjs";
import { cancellationSignals } from "./lib/signals.mjs";
const cancellation = cancellationSignals();
let preview;
let vite;
try {
  preview = await startPreview({ signal: cancellation.signal });
  cancellation.signal.throwIfAborted();
  vite = await createServer({
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: preview.url, ws: true } },
    },
  });
  cancellation.signal.throwIfAborted();
  await vite.listen();
  cancellation.signal.throwIfAborted();
  console.log(
    JSON.stringify({
      mode: "development",
      web: vite.resolvedUrls?.local,
      backend: preview.url,
      unit: preview.unit,
    }),
  );
  await new Promise((done) =>
    cancellation.signal.addEventListener("abort", done, { once: true }),
  );
} catch (error) {
  if (!cancellation.signal.aborted) throw error;
} finally {
  try {
    await vite?.close();
  } finally {
    try {
      if (preview) await stopPreview({ token: preview.token });
    } finally {
      cancellation.dispose();
    }
  }
}
