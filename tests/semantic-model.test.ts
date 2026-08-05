import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { exportPdf, getExportReadiness } from "../app/lib/export-engine";
import { createDemoDocument, detectTextMeta } from "../app/lib/document-model";
import { isTextReplacementPreview, shouldRenderTextContent } from "../app/lib/editor-visibility";
import { detectScannedPage, inferReadingOrder } from "../app/lib/recognition";

test("mixed Arabic and English metadata never reverses the source string", () => {
  const source = "اسم العميل North Africa 2026";
  const meta = detectTextMeta(source);
  assert.equal(meta.language, "mixed");
  assert.equal(meta.direction, "rtl");
  assert.equal(source, "اسم العميل North Africa 2026");
});

test("scan classification distinguishes native, hybrid, and image-only pages", () => {
  assert.equal(detectScannedPage(4, 0), "native");
  assert.equal(detectScannedPage(4, 1), "hybrid");
  assert.equal(detectScannedPage(0, 1), "scan");
});

test("reading order keeps right-to-left spans in visual order within a line", () => {
  const document = createDemoDocument();
  const blocks = document.pages[0].objects.filter((object) => object.type === "text");
  const ordered = inferReadingOrder(blocks);
  assert.equal(ordered.length, blocks.length);
  assert.equal(ordered[0].bbox.y <= ordered[1].bbox.y, true);
});

test("export is explicitly held when a reconstruction needs Arabic shaping", () => {
  const document = createDemoDocument();
  const readiness = getExportReadiness(document);
  assert.equal(readiness.canExport, false);
  assert.match(readiness.messages.join(" "), /Arabic/);
});

test("an edited native text block remains visible after inline editing ends", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.text = "Updated semantic text";
  assert.equal(shouldRenderTextContent(text, true, false), true);
  assert.equal(isTextReplacementPreview(text, true, false), true);
});

test("unchanged native text stays hidden over an untouched source preview", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  assert.equal(shouldRenderTextContent(text, true, false), false);
  assert.equal(isTextReplacementPreview(text, true, false), false);
});

test("the reconstruction proof of concept emits a valid PDF for an English semantic page", async () => {
  const document = createDemoDocument();
  document.pages[0].objects = document.pages[0].objects.filter(
    (object) => object.type === "text" && !/[\u0600-\u06FF]/.test(object.text),
  );
  const bytes = await exportPdf(document);
  const parsed = await PDFDocument.load(bytes);
  assert.equal(parsed.getPageCount(), 1);
  assert.equal(bytes.slice(0, 5).toString(), "37,80,68,70,45");
});
