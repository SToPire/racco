import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderLogo } from "./ProviderLogo.js";

test("renders OpenAI and Claude Code vector marks with accessible brand names", () => {
  const openAI = renderToStaticMarkup(<ProviderLogo provider="codex" />);
  const claudeCode = renderToStaticMarkup(<ProviderLogo provider="claude" />);

  assert.match(openAI, /aria-label="OpenAI"/);
  assert.match(openAI, /viewBox="1.68 1.75 16.65 16.5"/);
  assert.match(claudeCode, /aria-label="Claude Code"/);
  assert.match(claudeCode, /viewBox="0 0 94 94"/);
});
