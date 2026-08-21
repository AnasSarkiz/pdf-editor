import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("production PDF assets are compact and cacheable on mobile", async () => {
  const sourceHeaders = await readFile(new URL("public/_headers", projectRoot), "utf8");
  const builtHeaders = await readFile(new URL("dist/client/_headers", projectRoot), "utf8");
  const expectedCacheRule = /\/assets\/\*[\s\S]*Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/i;

  assert.match(sourceHeaders, expectedCacheRule);
  assert.match(builtHeaders, expectedCacheRule);

  const assetsUrl = new URL("dist/client/assets/", projectRoot);
  const workerFiles = (await readdir(assetsUrl)).filter((name) => /^pdf\.worker\.min-.*\.mjs$/u.test(name));
  assert.equal(workerFiles.length, 1, "the build should emit one minified PDF worker");

  const worker = await stat(new URL(workerFiles[0], assetsUrl));
  assert.ok(worker.size < 1_500_000, `minified PDF worker is unexpectedly large: ${worker.size} bytes`);
});
