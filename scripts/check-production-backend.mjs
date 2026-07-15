import assert from "node:assert/strict";

const url = "https://crystal-clear-prompt.replit.app/api/healthz";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);

try {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: controller.signal,
  });

  assert.ok(response.ok, `Backend returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  assert.ok(
    contentType.includes("application/json") ||
      contentType.includes("text/plain"),
    `Unexpected content type: ${contentType}`,
  );

  console.log(`Backend health check passed: ${response.status} ${url}`);
} finally {
  clearTimeout(timer);
}
