import assert from "node:assert/strict";
import test from "node:test";
import { importPdf, pdfCoreTesting, preloadPdfEngine } from "../app/lib/pdf-core";

function fontBlock(text, fontFamily = "EmbeddedFont") {
  return {
    text,
    style: {
      fontFamily,
      fontSize: 12,
      fontWeight: 400,
      fontStyle: "normal",
      color: "#000000",
      lineHeight: 1.2,
      letterSpacing: 0,
      align: "left",
    },
  };
}

test("the retained PDF bytes stay intact when PDF.js owns and transfers its copy", () => {
  const source = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer;
  const { bytes, pdfData } = pdfCoreTesting.createPdfByteCopies(source);

  pdfData[0] = 0;
  assert.deepEqual([...bytes], [0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.notEqual(bytes.buffer, pdfData.buffer);

  structuredClone(pdfData.buffer, { transfer: [pdfData.buffer] });
  assert.equal(pdfData.byteLength, 0);
  assert.equal(bytes.byteLength, 5);
});

test("PDF signature validation uses the already-read full file buffer", async () => {
  assert.equal(pdfCoreTesting.hasPdfSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), true);
  assert.equal(pdfCoreTesting.hasPdfSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46])), false);

  const phases = [];
  const invalidFile = {
    arrayBuffer: async () => new TextEncoder().encode("not a pdf").buffer,
  };
  await assert.rejects(
    importPdf(invalidFile, (progress) => phases.push(progress.phase)),
    /file signature is not a PDF/i,
  );
  assert.deepEqual(phases, ["reading"]);
});

test("worker preload consumes only a same-origin asset into browser cache", async () => {
  const requests = [];
  let bodyConsumed = false;
  const warmed = await pdfCoreTesting.warmSameOriginAsset(
    "/assets/pdf.worker.mjs",
    "https://editor.example/document",
    async (input, init) => {
      requests.push({ input, init });
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          bodyConsumed = true;
          return new ArrayBuffer(0);
        },
      };
    },
  );

  assert.equal(warmed, true);
  assert.equal(bodyConsumed, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "https://editor.example/assets/pdf.worker.mjs");
  assert.equal(requests[0].init.cache, "force-cache");
  assert.equal(requests[0].init.credentials, "same-origin");

  let crossOriginFetches = 0;
  const skipped = await pdfCoreTesting.warmSameOriginAsset(
    "https://cdn.example/pdf.worker.mjs",
    "https://editor.example/document",
    async () => {
      crossOriginFetches += 1;
      throw new Error("cross-origin preload should be skipped");
    },
  );
  assert.equal(skipped, false);
  assert.equal(crossOriginFetches, 0);
});

test("PDF engine preload is best-effort and coalesces concurrent callers", async () => {
  const first = preloadPdfEngine();
  const second = preloadPdfEngine();
  assert.equal(first, second);
  await first;
});

test("render scale respects both the pixel and maximum-dimension budgets", () => {
  const scale = pdfCoreTesting.boundedRenderScale(595, 842, 3, 3_000_000, 8_192);
  assert.ok(scale < 3);
  assert.ok(595 * scale * 842 * scale <= 3_000_001);

  const dimensionLimited = pdfCoreTesting.boundedRenderScale(20_000, 500, 3, 100_000_000, 8_192);
  assert.ok(20_000 * dimensionLimited <= 8_192.001);
});

test("a stalled import stage rejects and runs its cancellation hook", async () => {
  let cancelled = false;
  const stalled = new Promise(() => undefined);

  await assert.rejects(
    pdfCoreTesting.withStageTimeout(
      stalled,
      10,
      "rendering the test page",
      () => { cancelled = true; },
    ),
    /rendering the test page/i,
  );
  assert.equal(cancelled, true);
});

test("embedded font loading is deduplicated and cannot hold import open", async () => {
  const blocks = [fontBlock("Invoice"), fontBlock("فاتورة"), fontBlock("Total", "AnotherFont")];
  const requests = pdfCoreTesting.nativeFontLoadRequests(blocks);
  assert.equal(requests.length, 2);
  assert.match(requests.find((request) => request.font.includes("EmbeddedFont"))?.text ?? "", /I/);
  assert.match(requests.find((request) => request.font.includes("EmbeddedFont"))?.text ?? "", /ف/);

  let calls = 0;
  const stalledFontSet = {
    load() {
      calls += 1;
      return new Promise(() => undefined);
    },
  };
  const startedAt = Date.now();
  await pdfCoreTesting.loadNativeTextFonts(blocks, stalledFontSet, 10);
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt < 250);
});
