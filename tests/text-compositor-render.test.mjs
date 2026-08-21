import assert from "node:assert/strict";
import { test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { isUnsafeOcrSourceCleanup } from "../app/lib/editor-visibility";
import { paintTextBlock, restoreTextSource } from "../app/lib/text-compositor";
import { pdfCoreTesting } from "../app/lib/pdf-core";

function countRedPixels(context, left, top, width, height) {
  const data = context.getImageData(left, top, width, height).data;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] > 160 && data[index + 1] < 100 && data[index + 2] < 100) count += 1;
  }
  return count;
}

function countPixels(context, left, top, width, height, predicate) {
  const data = context.getImageData(left, top, width, height).data;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (predicate(data[index], data[index + 1], data[index + 2])) count += 1;
  }
  return count;
}

function unsafeOcrBlock(bbox, text = "TEXT") {
  const style = {
    fontFamily: "Arial, sans-serif",
    fontSize: 24,
    fontWeight: 700,
    fontStyle: "normal",
    color: "#172026",
    lineHeight: 1,
    letterSpacing: 0,
    align: "left",
  };
  return {
    id: "unsafe-ocr",
    type: "text",
    pageId: "page",
    bbox: { ...bbox },
    sourceBbox: { ...bbox },
    originalBbox: { ...bbox },
    rotation: 0,
    originalRotation: 0,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    confidence: 1,
    source: "ocr",
    zIndex: 1,
    language: "en",
    direction: "ltr",
    originalDirection: "ltr",
    relationships: [],
    fontAscent: 0.82,
    fontDescent: -0.18,
    text,
    originalText: text,
    style,
    originalStyle: { ...style },
    overflow: "warn",
    editable: false,
    locked: true,
  };
}

test("OCR cleanup stays disabled when light glyphs cannot be removed from a dark scan", () => {
  const canvas = createCanvas(220, 70);
  const context = canvas.getContext("2d");
  context.fillStyle = "#202050";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "700 26px Arial";
  context.textBaseline = "top";
  context.fillStyle = "#ffffff";
  context.fillText("WHITE", 20, 18);
  const block = unsafeOcrBlock({ x: 18, y: 16, width: 100, height: 32 }, "WHITE");
  const lightPixels = () => countPixels(
    context,
    0,
    0,
    canvas.width,
    canvas.height,
    (red, green, blue) => red > 230 && green > 230 && blue > 230,
  );
  const before = lightPixels();

  restoreTextSource(context, null, block, 1, 1);

  assert.ok(before > 0);
  assert.equal(lightPixels(), before, "the hard-coded dark OCR ink cannot remove the white source glyphs");
  assert.equal(isUnsafeOcrSourceCleanup(block), true, "this source must remain locked instead of exposing unsafe cleanup");
});

test("OCR cleanup stays disabled when a same-coloured rule crosses the text bounds", () => {
  const canvas = createCanvas(220, 80);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#172026";
  context.font = "700 24px Arial";
  context.textBaseline = "top";
  context.fillText("TEXT", 30, 22);
  context.fillRect(0, 48, canvas.width, 2);
  const block = unsafeOcrBlock({ x: 25, y: 18, width: 120, height: 34 });
  const rulePixels = () => countPixels(
    context,
    25,
    48,
    120,
    2,
    (red, green, blue) => red < 50 && green < 50 && blue < 60,
  );
  const before = rulePixels();

  restoreTextSource(context, null, block, 1, 1);

  assert.equal(before, 240);
  assert.equal(rulePixels(), before, "locked OCR restoration must be a no-op so unrelated page geometry survives");
  assert.equal(isUnsafeOcrSourceCleanup(block), true, "this source must remain locked instead of exposing unsafe cleanup");
});

test("repainted native text remains behind later source graphics", () => {
  const canvas = createCanvas(180, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const block = {
    id: "occluded-run",
    type: "text",
    pageId: "page",
    bbox: { x: 10, y: 10, width: 150, height: 32 },
    sourceBbox: { x: 10, y: 10, width: 150, height: 32 },
    sourceOperatorIndex: 7,
    sourceForegroundOcclusions: [{ operatorIndex: 18, bbox: { x: 58, y: 0, width: 44, height: 64 } }],
    originalBbox: { x: 10, y: 10, width: 150, height: 32 },
    rotation: 0,
    originalRotation: 0,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 34 },
    confidence: 1,
    source: "native-pdf",
    zIndex: 1,
    language: "en",
    direction: "ltr",
    originalDirection: "ltr",
    relationships: [],
    fontAscent: 0.8,
    fontDescent: -0.2,
    text: "XXXXXXXXXX",
    originalText: "ORIGINAL",
    style: {
      fontFamily: "Arial, sans-serif",
      fontSize: 28,
      fontWeight: 700,
      fontStyle: "normal",
      color: "#d51f1f",
      lineHeight: 1,
      letterSpacing: 0,
      align: "left",
    },
    overflow: "warn",
    editable: true,
  };

  paintTextBlock(context, block, 1, 1);

  assert.ok(countRedPixels(context, 10, 0, 44, 64) > 50, "text should render before the foreground graphic");
  assert.equal(countRedPixels(context, 60, 0, 40, 64), 0, "foreground geometry must remain above reconstructed text");
  assert.ok(countRedPixels(context, 106, 0, 54, 64) > 50, "text should resume after the foreground graphic");
});

test("crossing stroke occlusions do not erase their whole bounding rectangle", () => {
  const canvas = createCanvas(180, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const block = {
    id: "grid-occlusion",
    type: "text",
    pageId: "page",
    bbox: { x: 10, y: 10, width: 150, height: 32 },
    sourceBbox: { x: 10, y: 10, width: 150, height: 32 },
    sourceOperatorIndex: 7,
    sourceForegroundOcclusions: [
      { operatorIndex: 18, bbox: { x: 58, y: 0, width: 8, height: 64 } },
      { operatorIndex: 18, bbox: { x: 40, y: 25, width: 90, height: 6 } },
    ],
    originalBbox: { x: 10, y: 10, width: 150, height: 32 },
    rotation: 0,
    originalRotation: 0,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 34 },
    confidence: 1,
    source: "native-pdf",
    zIndex: 1,
    language: "en",
    direction: "ltr",
    originalDirection: "ltr",
    relationships: [],
    fontAscent: 0.8,
    fontDescent: -0.2,
    text: "MMMMMMMM",
    originalText: "ORIGINAL",
    style: {
      fontFamily: "Arial, sans-serif",
      fontSize: 28,
      fontWeight: 700,
      fontStyle: "normal",
      color: "#d51f1f",
      lineHeight: 1,
      letterSpacing: 0,
      align: "left",
    },
    overflow: "warn",
    editable: true,
  };

  paintTextBlock(context, block, 1, 1);

  assert.equal(countRedPixels(context, 59, 0, 6, 64), 0, "the vertical foreground stroke must occlude text");
  assert.equal(countRedPixels(context, 40, 26, 90, 4), 0, "the horizontal foreground stroke must occlude text");
  assert.ok(countRedPixels(context, 72, 12, 42, 11) > 20, "text outside the crossing strokes must remain visible");
});

test("visible ink color is recovered when a PDF text operator is unsafe to match", () => {
  const clean = createCanvas(180, 60);
  const preview = createCanvas(180, 60);
  for (const canvas of [clean, preview]) {
    const context = canvas.getContext("2d");
    context.fillStyle = "#302b88";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const context = preview.getContext("2d");
  context.font = "700 22px Arial";
  context.fillStyle = "#ffffff";
  context.textBaseline = "top";
  context.fillText("WHITE HEADER", 12, 12);
  const block = {
    bbox: { x: 10, y: 10, width: 160, height: 30 },
    originalBbox: { x: 10, y: 10, width: 160, height: 30 },
    rotation: 0,
    originalRotation: 0,
  };

  const color = pdfCoreTesting.renderedTextColor(preview, clean, block, 180, 60);
  assert.match(color ?? "", /^#[\da-f]{6}$/i);
  assert.ok(Number.parseInt(color.slice(1, 3), 16) > 235);
  assert.ok(Number.parseInt(color.slice(3, 5), 16) > 235);
  assert.ok(Number.parseInt(color.slice(5, 7), 16) > 235);
});
