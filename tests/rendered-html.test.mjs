import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the PDF Editor workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>PDF Editor — Arabic \+ English editing<\/title>/);
  assert.match(html, /aria-label="Editable PDF canvas"/);
  assert.match(html, /Open PDF/);
  assert.match(html, /Export PDF/);
  assert.match(html, /Select/);
  assert.match(html, /Text/);
  assert.match(html, />search<\/button>/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|react-loading-skeleton|codex-preview/i);
});

test("keeps starter preview assets out of the finished product", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /type Tool = "select" \| "text" \| "table"/);
  assert.match(page, /function SearchPanel/);
  assert.match(css, /\.studio-shell/);
  assert.match(css, /\.text-resize-handle/);
  assert.match(layout, /title: "PDF Editor — Arabic \+ English editing"/);
  assert.match(layout, /openGraph/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page, /codex-preview|_sites-preview|SkeletonPreview/);

});
