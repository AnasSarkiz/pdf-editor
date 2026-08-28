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

function mediaRuleBody(css, query) {
  const start = css.indexOf(query);
  assert.notEqual(start, -1, `missing ${query}`);
  const openingBrace = css.indexOf("{", start);
  assert.notEqual(openingBrace, -1, `missing opening brace for ${query}`);
  let depth = 1;
  for (let index = openingBrace + 1; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(openingBrace + 1, index);
  }
  assert.fail(`missing closing brace for ${query}`);
}

function selectorDeclarations(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  assert.ok(match, `missing ${selector} declarations`);
  return match[1];
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

test("phone layout clears desktop width floors and keeps primary actions reachable", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const phone = mediaRuleBody(css, "@media (max-width: 600px)");
  const workspace = selectorDeclarations(phone, ".workspace");
  const paperWrap = selectorDeclarations(phone, ".paper-wrap");
  const sidebar = selectorDeclarations(phone, ".page-sidebar");
  const shell = selectorDeclarations(phone, ".studio-shell");
  const primaryActions = selectorDeclarations(phone, ".open-button, .export-button");

  assert.doesNotMatch(phone, /minmax\(\s*390px\b/i);
  assert.doesNotMatch(phone, /min-width\s*:\s*560px\b/i);
  assert.match(workspace, /grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/i);
  assert.match(workspace, /grid-template-rows\s*:\s*64px\s+minmax\(\s*0\s*,\s*1fr\s*\)/i);
  assert.match(paperWrap, /width\s*:\s*100%\s*!important/i);
  assert.match(paperWrap, /min-width\s*:\s*0\b/i);
  assert.match(paperWrap, /max-width\s*:\s*100%/i);
  assert.match(sidebar, /flex-direction\s*:\s*row/i);
  assert.match(shell, /height\s*:\s*100dvh/i);
  assert.match(shell, /safe-area-inset-top/i);
  assert.match(primaryActions, /min-height\s*:\s*42px/i);

  const response = await render();
  const html = await response.text();
  assert.match(html, /class="open-button"[^>]*>Open PDF<\/button>/);
  assert.match(html, /class="export-button"[^>]*>Export PDF/);
  assert.match(html, /class="page-sidebar" aria-label="Pages"/);
  assert.match(html, /class="canvas-zone[^"]*" aria-label="Editable PDF canvas"/);
});

test("pan and touch interactions protect document objects", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /className=\{`canvas-zone \$\{activeTool === "hand" \? "is-pan-mode"/);
  assert.match(page, /scrollLeft = pan\.scrollLeft -/);
  assert.match(page, /Math\.hypot\([\s\S]*?\) < 6/);
  assert.match(page, /event\.key === "Enter"/);
  assert.match(css, /\.canvas-zone\.is-pan-mode\s*\{[^}]*touch-action:\s*none/s);
  assert.match(css, /\.canvas-zone\.is-pan-mode \.semantic-object\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.text-object\s*\{[^}]*touch-action:\s*pan-x pan-y/s);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.text-resize-handle\s*\{[^}]*width:\s*28px/s);
});
