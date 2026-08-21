import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { exportPdf, getExportReadiness } from "../app/lib/export-engine";
import { createDemoDocument, detectTextMeta, type EditableDocument, type TextBlock } from "../app/lib/document-model";
import {
  canSafelyMutateText,
  canSafelyPlaceText,
  hasUnsafeOcrSourceMutation,
  isTextReplacementPreview,
  isUnsafeOcrSourceCleanup,
  needsNativeCanvasReplacement,
  needsSourceCanvasReplacement,
  shouldRenderTextContent,
} from "../app/lib/editor-visibility";
import { tokensFromTesseractBlocks } from "../app/lib/local-ocr";
import { pdfCoreTesting } from "../app/lib/pdf-core";
import { detectScannedPage, inferReadingOrder, textFromOcrToken } from "../app/lib/recognition";
import { getNativeTextRestorationPlan } from "../app/lib/text-compositor";

function appendDirectExportText(
  document: EditableDocument,
  text: string,
  style: Partial<TextBlock["style"]> = {},
): TextBlock {
  const template = document.pages[0].objects.find((object): object is TextBlock => object.type === "text");
  assert.ok(template);
  const block: TextBlock = {
    ...template,
    id: `user-text-${document.pages[0].objects.length}`,
    source: "user",
    sourceBbox: undefined,
    originalBbox: undefined,
    originalStyle: undefined,
    originalRotation: undefined,
    originalDirection: undefined,
    originalText: undefined,
    text,
    direction: "ltr",
    language: "en",
    style: {
      ...template.style,
      fontFamily: "Helvetica, Arial, sans-serif",
      fontWeight: 400,
      fontStyle: "normal",
      letterSpacing: 0,
      align: "left",
      ...style,
    },
  };
  document.pages[0].objects.push(block);
  return block;
}

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

test("patch export keeps a narrowly verified Helvetica and WinAnsi text subset", () => {
  const document = createDemoDocument();
  appendDirectExportText(document, "Résumé — €100", { fontWeight: 700, align: "right" });
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, true);
  assert.equal(readiness.canFlatten, true);
  assert.equal(readiness.mode, "patch");
});

test("Times italic text uses the flattened fallback instead of Helvetica substitution", () => {
  const document = createDemoDocument();
  appendDirectExportText(document, "Italic contract note", {
    fontFamily: '"Times New Roman", Times, serif',
    fontStyle: "italic",
  });
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.canFlatten, true);
  assert.equal(readiness.mode, "reconstruct");
  assert.match(readiness.messages.join(" "), /font family.*italic/i);
});

test("reconstructed documents also flatten unsupported direct-export typography", () => {
  const document = createDemoDocument();
  const text = appendDirectExportText(document, "Reconstructed italic note", {
    fontFamily: '"Times New Roman", Times, serif',
    fontStyle: "italic",
  });
  document.pages[0].objects = [text];
  const readiness = getExportReadiness(document);
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.canFlatten, true);
  assert.equal(readiness.mode, "reconstruct");
  assert.match(readiness.messages.join(" "), /direct PDF export/i);
});

test("custom letter spacing uses the flattened fallback", () => {
  const document = createDemoDocument();
  appendDirectExportText(document, "Tracked heading", { letterSpacing: 1.25 });
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.canFlatten, true);
  assert.equal(readiness.mode, "reconstruct");
  assert.match(readiness.messages.join(" "), /letter spacing/i);
});

test("centered and right-aligned multiline text use the flattened fallback", () => {
  for (const align of ["center", "right"] as const) {
    const document = createDemoDocument();
    appendDirectExportText(document, "A longer first line\nshort", { align });
    const readiness = getExportReadiness(document, new Uint8Array([1]));
    assert.equal(readiness.canExport, false);
    assert.equal(readiness.canFlatten, true);
    assert.equal(readiness.mode, "reconstruct");
    assert.match(readiness.messages.join(" "), /multiline.*per-line alignment/i);
  }
});

test("Cyrillic text uses the flattened fallback before WinAnsi encoding", () => {
  const document = createDemoDocument();
  appendDirectExportText(document, "Привет, мир");
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.canFlatten, true);
  assert.equal(readiness.mode, "reconstruct");
  assert.match(readiness.messages.join(" "), /characters.*encoder/i);
});

test("an edited native text block returns to the shared page canvas after inline editing ends", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.text = "Updated semantic text";
  assert.equal(shouldRenderTextContent(text, true, false), false);
  assert.equal(isTextReplacementPreview(text, true, false), true);
});

test("unchanged native text stays hidden over an untouched source preview", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  assert.equal(shouldRenderTextContent(text, true, false), false);
  assert.equal(isTextReplacementPreview(text, true, false), false);
});

test("moving native text redraws it at the new location on the page canvas", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.bbox = { ...text.bbox, x: text.bbox.x + 24, y: text.bbox.y + 12 };
  assert.equal(needsNativeCanvasReplacement(text), true);
  assert.equal(isTextReplacementPreview(text, true, false), true);
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.mode, "reconstruct");
});

test("resizing native text requires flattened reconstruction readiness", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.bbox = { ...text.bbox, width: text.bbox.width + 18, height: text.bbox.height + 6 };
  assert.equal(needsNativeCanvasReplacement(text), true);
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.mode, "reconstruct");
});

test("changing native paragraph direction requires flattened reconstruction readiness", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.direction = text.direction === "rtl" ? "ltr" : "rtl";
  assert.equal(needsNativeCanvasReplacement(text), true);
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.mode, "reconstruct");
});

test("deleting native text retains a tombstone and forces flattened reconstruction readiness", () => {
  const document = createDemoDocument();
  const page = document.pages[0];
  const text = page.objects.find((object) => object.type === "text" && object.source === "native-pdf");
  assert.ok(text && text.type === "text");
  page.objects = page.objects.filter((object) => object.id !== text.id);
  page.deletedSourceText = [text];
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.mode, "reconstruct");
  assert.match(readiness.messages.join(" "), /deleted/);
});

test("unchanged OCR text stays in the source raster instead of being double-painted", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.source = "ocr";
  assert.equal(needsSourceCanvasReplacement(text), false);
  assert.equal(shouldRenderTextContent(text, true, false), false);
  assert.equal(shouldRenderTextContent(text, true, true), true);
});

test("OCR source blocks stay locked until glyph-accurate cleanup metadata exists", () => {
  const text = textFromOcrToken("page", {
    text: "WHITE HEADER",
    polygon: [
      { x: 20, y: 16 },
      { x: 180, y: 16 },
      { x: 180, y: 48 },
      { x: 20, y: 48 },
    ],
    confidence: 0.98,
    language: "en",
    direction: "ltr",
  });

  assert.equal(text.editable, false);
  assert.equal(text.locked, true);
  assert.equal(isUnsafeOcrSourceCleanup(text), true);
  assert.equal(canSafelyMutateText(text), false);
  assert.equal(hasUnsafeOcrSourceMutation(text), false);

  text.text = "Changed header";
  assert.equal(hasUnsafeOcrSourceMutation(text), true);
});

test("OCR content, position, and formatting edits hard-block unsafe export", () => {
  const mutations: Array<(text: TextBlock) => void> = [
    (text) => { text.text = "Changed OCR text"; },
    (text) => { text.bbox = { ...text.bbox, x: text.bbox.x + 12 }; },
    (text) => { text.style = { ...text.style, fontWeight: text.style.fontWeight === 400 ? 700 : 400 }; },
  ];
  for (const mutate of mutations) {
    const document = createDemoDocument();
    const text = document.pages[0].objects.find((object) => object.type === "text");
    assert.ok(text && text.type === "text");
    text.source = "ocr";
    mutate(text);
    assert.equal(needsSourceCanvasReplacement(text), true);
    assert.equal(isTextReplacementPreview(text, true, false), true);
    const readiness = getExportReadiness(document, new Uint8Array([1]));
    assert.equal(readiness.canExport, false);
    assert.equal(readiness.canFlatten, false);
    assert.equal(readiness.mode, "ocr-layer");
    assert.match(readiness.messages.join(" "), /cannot be removed safely/i);
  }
});

test("deleting OCR text retains a source tombstone and hard-blocks unsafe export", () => {
  const document = createDemoDocument();
  const page = document.pages[0];
  const text = page.objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  text.source = "ocr";
  page.objects = page.objects.filter((object) => object.id !== text.id);
  page.deletedSourceText = [text];
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.canFlatten, false);
  assert.equal(readiness.mode, "ocr-layer");
  assert.match(readiness.messages.join(" "), /cannot be removed safely/i);
});

test("native restoration repaints the full overlap-connected survivor set", () => {
  const document = createDemoDocument();
  const native = document.pages[0].objects.filter(
    (object): object is TextBlock => object.type === "text" && object.source === "native-pdf",
  ).slice(0, 3);
  assert.equal(native.length, 3);
  native[0].sourceBbox = { x: 10, y: 10, width: 30, height: 12 };
  native[1].sourceBbox = { x: 35, y: 10, width: 30, height: 12 };
  native[2].sourceBbox = { x: 60, y: 10, width: 30, height: 12 };
  const plan = getNativeTextRestorationPlan(native, [native[0]]);
  assert.deepEqual(new Set(plan.restore.map((block) => block.id)), new Set(native.map((block) => block.id)));
  assert.deepEqual(new Set(plan.repaint.map((block) => block.id)), new Set(native.map((block) => block.id)));

  const deletionPlan = getNativeTextRestorationPlan(native.slice(1), [native[0]]);
  assert.deepEqual(new Set(deletionPlan.restore.map((block) => block.id)), new Set(native.map((block) => block.id)));
  assert.deepEqual(new Set(deletionPlan.repaint.map((block) => block.id)), new Set(native.slice(1).map((block) => block.id)));
});

test("moving native text recomposes a survivor at its destination", () => {
  const document = createDemoDocument();
  const native = document.pages[0].objects.filter(
    (object): object is TextBlock => object.type === "text" && object.source === "native-pdf",
  ).slice(0, 2);
  assert.equal(native.length, 2);
  native[0].sourceBbox = { x: 10, y: 10, width: 30, height: 12 };
  native[0].bbox = { x: 80, y: 10, width: 30, height: 12 };
  native[1].sourceBbox = { x: 90, y: 10, width: 30, height: 12 };
  native[1].bbox = { ...native[1].sourceBbox };
  const plan = getNativeTextRestorationPlan(native, [native[0]]);
  assert.deepEqual(new Set(plan.repaint.map((block) => block.id)), new Set(native.map((block) => block.id)));
});

test("changing native text formatting requires a canvas replacement", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find((object) => object.type === "text");
  assert.ok(text && text.type === "text");
  const native = {
    ...text,
    source: "native-pdf" as const,
    originalText: text.text,
    originalStyle: { ...text.style },
    originalRotation: text.rotation,
    style: { ...text.style, letterSpacing: 1.5 },
  };
  assert.equal(needsNativeCanvasReplacement(native), true);
});

test("bounded native edits reject only placements that cross unsafe later paint", () => {
  const document = createDemoDocument();
  const text = document.pages[0].objects.find(
    (object): object is TextBlock => object.type === "text" && object.source === "native-pdf",
  );
  assert.ok(text);
  const bounded: TextBlock = {
    ...text,
    editable: true,
    locked: false,
    sourceMappingVerified: true,
    sourceEditSafety: "bounded-risk",
    sourceUnsafeForegroundBounds: [{ x: 300, y: 200, width: 80, height: 40 }],
  };
  assert.equal(canSafelyMutateText(bounded), true);
  assert.equal(canSafelyPlaceText(bounded, { x: 40, y: 40, width: 100, height: 20 }), true);
  assert.equal(canSafelyPlaceText(bounded, { x: 320, y: 210, width: 30, height: 10 }), false);
  assert.equal(canSafelyMutateText({ ...bounded, sourceEditSafety: "unmapped" }), false);
  assert.equal(canSafelyMutateText({ ...bounded, sourceEditSafety: "unbounded-risk" }), false);
});

test("programmatic native edits that cross unsafe paint hard-block flattened export", () => {
  const document = createDemoDocument();
  const index = document.pages[0].objects.findIndex(
    (object) => object.type === "text" && object.source === "native-pdf",
  );
  assert.notEqual(index, -1);
  const text = document.pages[0].objects[index] as TextBlock;
  document.pages[0].objects[index] = {
    ...text,
    text: `${text.text} changed`,
    bbox: { x: 320, y: 210, width: 50, height: 16 },
    editable: true,
    locked: false,
    sourceMappingVerified: true,
    sourceEditSafety: "bounded-risk",
    sourceUnsafeForegroundBounds: [{ x: 300, y: 200, width: 80, height: 40 }],
  };
  const readiness = getExportReadiness(document, new Uint8Array([1]));
  assert.equal(readiness.canExport, false);
  assert.equal(readiness.canFlatten, false);
  assert.match(readiness.messages.join(" "), /paint order|transparency/iu);
});

test("high-resolution OCR maps line bounds into page coordinates and preserves Arabic direction", () => {
  const tokens = tokensFromTesseractBlocks([{
    paragraphs: [{
      is_ltr: false,
      lines: [{ text: "اسم العميل 2026", confidence: 92, bbox: { x0: 300, y0: 600, x1: 900, y1: 720 } }],
    }],
  }], 2400, 3200, { width: 600, height: 800 });
  assert.deepEqual(tokens, [{
    text: "اسم العميل 2026",
    polygon: [{ x: 75, y: 150 }, { x: 225, y: 150 }, { x: 225, y: 180 }, { x: 75, y: 180 }],
    confidence: 0.92,
    language: "ar",
    direction: "rtl",
  }]);
});

test("the reconstruction proof of concept emits a valid PDF for an English semantic page", async () => {
  const document = createDemoDocument();
  document.pages[0].objects = document.pages[0].objects.filter(
    (object) => object.type === "text" && !/[\u0600-\u06FF]/.test(object.text),
  );
  for (const object of document.pages[0].objects) {
    if (object.type !== "text") continue;
    const style: TextBlock["style"] = {
      ...object.style,
      fontFamily: "Helvetica, Arial, sans-serif",
      fontWeight: object.style.fontWeight >= 600 ? 700 : 400,
      fontStyle: "normal",
      letterSpacing: 0,
      align: "left",
    };
    object.style = style;
    object.originalStyle = { ...style };
  }
  const bytes = await exportPdf(document);
  const parsed = await PDFDocument.load(bytes);
  assert.equal(parsed.getPageCount(), 1);
  assert.equal(bytes.slice(0, 5).toString(), "37,80,68,70,45");
});

test("native PDF paint matching never falls back to an unrelated sequential operator", () => {
  const target = { text: "Invoice total", fontName: "g_d0_f1", bbox: { x: 80, y: 120, width: 72, height: 12 }, fontSize: 12 };
  const bounds = new Map([[7, { x: 80, y: 120, width: 72, height: 12 }]]);
  const [match] = pdfCoreTesting.matchTextAppearances(
    [target],
    [{ operatorIndex: 7, text: "Different text", fontName: "g_d0_f1", color: "#ff0000" }],
    (operatorIndex) => bounds.get(operatorIndex),
    612,
    792,
  );
  assert.equal(match, undefined);
});

test("PDF.js text paint parsing carries fill color and font state through save and restore", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const appearances = pdfCoreTesting.extractTextPaintAppearances(
    pdfjs,
    [
      pdfjs.OPS.save,
      pdfjs.OPS.setFillRGBColor,
      pdfjs.OPS.setFont,
      pdfjs.OPS.showText,
      pdfjs.OPS.restore,
      pdfjs.OPS.setGState,
      pdfjs.OPS.showText,
    ],
    [
      [],
      ["#336699"],
      ["g_d0_f1", 12],
      [[{ unicode: "Blue" }]],
      [],
      [["Font", ["g_d0_f2", 9]]],
      [[{ unicode: "Black" }]],
    ],
  );
  assert.deepEqual(appearances, [
    { operatorIndex: 3, text: "Blue", color: "#336699", fontName: "g_d0_f1" },
    { operatorIndex: 6, text: "Black", color: "#000000", fontName: "g_d0_f2" },
  ]);
});

test("native PDF paint matching requires text, font, order, and compatible geometry", () => {
  const targets = [
    { text: "First", fontName: "g_d0_f1", bbox: { x: 40, y: 80, width: 30, height: 10 }, fontSize: 10 },
    { text: "Second", fontName: "g_d0_f2", bbox: { x: 40, y: 110, width: 38, height: 10 }, fontSize: 10 },
  ];
  const bounds = new Map([
    [10, { x: 40, y: 80, width: 31, height: 11 }],
    [11, { x: 400, y: 500, width: 38, height: 10 }],
    [12, { x: 40, y: 110, width: 39, height: 11 }],
  ]);
  const matches = pdfCoreTesting.matchTextAppearances(
    targets,
    [
      { operatorIndex: 9, text: "First", fontName: "g_d0_wrong" },
      { operatorIndex: 10, text: "First", fontName: "g_d0_f1", color: "#336699" },
      { operatorIndex: 11, text: "Second", fontName: "g_d0_f2" },
      { operatorIndex: 12, text: "Second", fontName: "g_d0_f2", color: "#112233" },
    ],
    (operatorIndex) => bounds.get(operatorIndex),
    612,
    792,
  );
  assert.equal(matches[0]?.operatorIndex, 10);
  assert.deepEqual(matches[0]?.sourceBbox, bounds.get(10));
  assert.equal(matches[1]?.operatorIndex, 12);
});

test("ambiguous overlapping PDF paint operations remain unmapped", () => {
  const target = { text: "Shadow", fontName: "g_d0_f1", bbox: { x: 40, y: 80, width: 42, height: 10 }, fontSize: 10 };
  const bounds = new Map([
    [20, { x: 40, y: 80, width: 42, height: 10 }],
    [21, { x: 40.5, y: 80.5, width: 42, height: 10 }],
  ]);
  const [match] = pdfCoreTesting.matchTextAppearances(
    [target],
    [
      { operatorIndex: 20, text: "Shadow", fontName: "g_d0_f1" },
      { operatorIndex: 21, text: "Shadow", fontName: "g_d0_f1" },
    ],
    (operatorIndex) => bounds.get(operatorIndex),
    612,
    792,
  );
  assert.equal(match, undefined);
});

test("centered native text and source font metadata are exposed conservatively", () => {
  assert.equal(pdfCoreTesting.inferNativeTextAlignment({ x: 256, y: 40, width: 100, height: 12 }, 612, 0, 12), "center");
  assert.equal(pdfCoreTesting.inferNativeTextAlignment({ x: 40, y: 40, width: 100, height: 12 }, 612, 0, 12), "left");
  assert.equal(pdfCoreTesting.inferNativeTextAlignment({ x: 256, y: 40, width: 100, height: 12 }, 612, 15, 12), "left");
  assert.equal(pdfCoreTesting.humanReadableSourceFontName({ name: "ABCDEF+Helvetica-BoldOblique" }), "Helvetica Bold Oblique");
  assert.equal(pdfCoreTesting.humanReadableSourceFontName({ name: "g_d0_f1" }), undefined);
  assert.equal(pdfCoreTesting.sourceFontWeight({ name: "Roboto-Medium" }), 500);
  assert.equal(pdfCoreTesting.sourceFontWeight({ name: "Roboto-SemiBold" }), 600);
  assert.equal(pdfCoreTesting.sourceFontWeight({ name: "Helvetica-BoldOblique", bold: true }), 700);
});
