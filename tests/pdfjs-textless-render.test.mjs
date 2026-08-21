import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

test("PDF.js can render an exact page background without text paint operations", async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([240, 120]);
  const font = await source.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 0, y: 0, width: 240, height: 120, color: rgb(0.72, 0.84, 0.94) });
  page.drawLine({ start: { x: 10, y: 54 }, end: { x: 230, y: 54 }, thickness: 1, color: rgb(0.12, 0.34, 0.48) });
  page.drawText("REMOVABLE TEXT", { x: 30, y: 62, size: 14, font, color: rgb(0.2, 0.4, 0.6) });

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await source.save()), disableWorker: true }).promise;
  const sourcePage = await pdf.getPage(1);
  const viewport = sourcePage.getViewport({ scale: 2 });
  const operatorList = await sourcePage.getOperatorList();
  const textOperations = new Set([
    pdfjs.OPS.showText,
    pdfjs.OPS.showSpacedText,
    pdfjs.OPS.nextLineShowText,
    pdfjs.OPS.nextLineSetSpacingShowText,
  ]);
  const fullCanvas = createCanvas(viewport.width, viewport.height);
  const cleanCanvas = createCanvas(viewport.width, viewport.height);
  await sourcePage.render({ canvas: fullCanvas, canvasContext: fullCanvas.getContext("2d"), viewport, recordOperations: true }).promise;
  await sourcePage.render({
    canvas: cleanCanvas,
    canvasContext: cleanCanvas.getContext("2d"),
    viewport,
    operationsFilter: (index) => !textOperations.has(operatorList.fnArray[index]),
  }).promise;

  const full = fullCanvas.getContext("2d").getImageData(0, 0, fullCanvas.width, fullCanvas.height).data;
  const clean = cleanCanvas.getContext("2d").getImageData(0, 0, cleanCanvas.width, cleanCanvas.height).data;
  let changedPixels = 0;
  for (let index = 0; index < full.length; index += 4) {
    if (Math.abs(full[index] - clean[index]) + Math.abs(full[index + 1] - clean[index + 1]) + Math.abs(full[index + 2] - clean[index + 2]) > 3) changedPixels += 1;
  }
  assert.ok(changedPixels > 100, `expected text pixels to differ, found ${changedPixels}`);
  const showTextIndex = operatorList.fnArray.findIndex((operation) => textOperations.has(operation));
  assert.ok(showTextIndex >= 0);
  const recorded = sourcePage.recordedBBoxes;
  assert.ok(recorded.minX(showTextIndex) > 0 && recorded.maxX(showTextIndex) < 1, "recorded x bounds are normalized page fractions");
  assert.ok(recorded.minY(showTextIndex) > 0 && recorded.maxY(showTextIndex) < 1, "recorded y bounds are normalized page fractions");
});
