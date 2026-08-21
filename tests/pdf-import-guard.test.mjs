import assert from "node:assert/strict";
import test from "node:test";
import { pdfCoreTesting } from "../app/lib/pdf-core";

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
