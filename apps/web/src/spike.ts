// Milestone-1 spike: prove that under COOP same-origin + COEP credentialless
// we can (a) boot a WebContainer and (b) reach api.anthropic.com directly.
import { WebContainer } from "@webcontainer/api";

const out = document.getElementById("out")!;
const results: Record<string, unknown> = {};

function report() {
  out.textContent = JSON.stringify(results, null, 2);
  // Marker for automated verification.
  (window as any).__spikeResults = results;
}

async function main() {
  results.crossOriginIsolated = self.crossOriginIsolated;
  report();

  // (b) Anthropic CORS check: a bogus key should yield a CORS-visible 401
  // JSON error. Any network/CORS failure throws instead.
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-spike-invalid",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    const body = await res.json();
    results.anthropicCors = { ok: true, status: res.status, errorType: body?.error?.type };
  } catch (err) {
    results.anthropicCors = { ok: false, error: String(err) };
  }
  report();

  // (a) WebContainer boot + run a real command.
  try {
    const wc = await WebContainer.boot();
    await wc.mount({
      "hello.js": { file: { contents: "console.log('vassal reporting for duty')" } },
    });
    const proc = await wc.spawn("node", ["hello.js"]);
    let stdout = "";
    proc.output.pipeTo(new WritableStream({ write(chunk) { stdout += chunk; } }));
    const exit = await proc.exit;
    results.webcontainer = { ok: exit === 0, exit, stdout: stdout.trim() };
  } catch (err) {
    results.webcontainer = { ok: false, error: String(err) };
  }
  results.done = true;
  report();
}

main();
