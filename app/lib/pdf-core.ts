import type { EditableDocument, DocumentPage, FormFieldObject, ImageObject, Matrix, TextBlock } from "./document-model";
import { defaultTextStyle, detectTextMeta, identityMatrix, stableId } from "./document-model";
import { createHighResolutionOcrSession, type LocalOcrSession } from "./local-ocr";
import { detectScannedPage, inferReadingOrder, textFromOcrToken } from "./recognition";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

type RenderablePdfPage = {
  getViewport: (value: { scale: number }) => { width: number; height: number };
  render: (input: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
};

const PREVIEW_RENDER_SCALE = 2;
const OCR_RENDER_SCALE = 300 / 72;

interface NativeTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

interface NativeAnnotation {
  id: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: string;
  rect: [number, number, number, number];
}

async function getPdfJs(): Promise<PdfJsModule> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
      import.meta.url,
    ).toString();
  }
  return pdfjs;
}

function matrixFrom(transform: number[]): Matrix {
  return {
    a: transform[0] ?? 1,
    b: transform[1] ?? 0,
    c: transform[2] ?? 0,
    d: transform[3] ?? 1,
    e: transform[4] ?? 0,
    f: transform[5] ?? 0,
  };
}

function nativeTextToBlock(pageId: string, item: NativeTextItem, pageHeight: number, zIndex: number): TextBlock {
  const fontSize = Math.max(7, Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height || 12);
  const value = item.str.trim();
  const bbox = {
    x: item.transform[4] ?? 0,
    y: Math.max(0, pageHeight - (item.transform[5] ?? 0) - fontSize),
    width: Math.max(2, item.width || value.length * fontSize * 0.5),
    height: fontSize * 1.16,
  };
  return {
    id: stableId("native-text"),
    type: "text",
    pageId,
    bbox,
    originalBbox: { ...bbox },
    rotation: Math.atan2(item.transform[1] ?? 0, item.transform[0] ?? 1) * (180 / Math.PI),
    transform: matrixFrom(item.transform),
    confidence: 1,
    source: "native-pdf",
    zIndex,
    relationships: [],
    ...detectTextMeta(value),
    text: value,
    originalText: value,
    style: {
      ...defaultTextStyle,
      fontFamily: item.fontName || defaultTextStyle.fontFamily,
      fontSize,
      lineHeight: 1,
    },
    overflow: "warn",
    editable: true,
  };
}

function annotationToField(pageId: string, annotation: NativeAnnotation, pageHeight: number, zIndex: number): FormFieldObject | null {
  if (!annotation.fieldType) return null;
  const [left, bottom, right, top] = annotation.rect;
  const fieldType = annotation.fieldType === "Btn" ? "checkbox" : annotation.fieldType === "Ch" ? "dropdown" : "text";
  return {
    id: `field-${annotation.id}`,
    type: "form-field",
    pageId,
    bbox: { x: left, y: pageHeight - top, width: right - left, height: top - bottom },
    rotation: 0,
    transform: identityMatrix,
    confidence: 1,
    source: "native-pdf",
    zIndex,
    language: "und",
    direction: "auto",
    relationships: [],
    fieldType,
    name: annotation.fieldName ?? annotation.id,
    value: annotation.fieldValue ?? "",
  };
}

async function renderPageCanvas(page: RenderablePdfPage, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
}

async function renderPage(page: RenderablePdfPage): Promise<string> {
  const canvas = await renderPageCanvas(page, PREVIEW_RENDER_SCALE);
  // Keep the original page and committed canvas text at the same quality.
  // JPEG artifacts made replacement text look different from the source page.
  return canvas.toDataURL("image/png");
}

export interface PdfLoadProgress {
  phase: "opening" | "extracting" | "recognizing" | "rendering" | "ready";
  completed: number;
  total: number;
}

export async function importPdf(file: File, onProgress?: (progress: PdfLoadProgress) => void): Promise<{ document: EditableDocument; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await getPdfJs();
  onProgress?.({ phase: "opening", completed: 0, total: 1 });
  const loadingTask = pdfjs.getDocument({ data: bytes, disableAutoFetch: true, useWorkerFetch: false, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const metadata = await pdf.getMetadata().catch(() => null);
  const pages: DocumentPage[] = [];
  let localOcr: LocalOcrSession | null = null;

  try {
  for (let index = 1; index <= pdf.numPages; index += 1) {
    onProgress?.({ phase: "extracting", completed: index - 1, total: pdf.numPages });
    const sourcePage = await pdf.getPage(index);
    const viewport = sourcePage.getViewport({ scale: 1 });
    const pageId = stableId("page");
    const textContent = await sourcePage.getTextContent({ includeMarkedContent: true });
    const textItems = textContent.items
      .filter((item): item is NativeTextItem => "str" in item && typeof item.str === "string" && item.str.trim().length > 0)
      .map((item, itemIndex) => nativeTextToBlock(pageId, item, viewport.height, itemIndex + 1));
    const operatorList = await sourcePage.getOperatorList().catch(() => null);
    // PDF.js exposes its paint operations as `fnArray`. Keeping a guarded
    // compatibility fallback makes this boundary resilient across PDF.js
    // builds without treating a missing operator list as a parsing failure.
    const operators = operatorList?.fnArray ?? operatorList?.fn ?? [];
    const imageCount = operators.filter(
      (operation) => operation === pdfjs.OPS.paintImageXObject || operation === pdfjs.OPS.paintJpegXObject,
    ).length;
    const annotations = (await sourcePage.getAnnotations().catch(() => [])) as unknown as NativeAnnotation[];
    const fields = annotations
      .map((annotation, fieldIndex) => annotationToField(pageId, annotation, viewport.height, textItems.length + fieldIndex + 1))
      .filter((field): field is FormFieldObject => field !== null);
    const sourceKind = detectScannedPage(textItems.length, imageCount);
    let ocrBlocks: TextBlock[] = [];
    if (sourceKind === "scan") {
      onProgress?.({ phase: "recognizing", completed: index - 1, total: pdf.numPages });
      try {
        localOcr ??= await createHighResolutionOcrSession();
        const ocrCanvas = await renderPageCanvas(sourcePage, OCR_RENDER_SCALE);
        const tokens = await localOcr.recognize(ocrCanvas, viewport);
        ocrBlocks = tokens.map((token) => textFromOcrToken(pageId, token));
      } catch {
        // A local model failure must not prevent a document from opening. The
        // empty scan remains explicitly marked for manual OCR review.
        ocrBlocks = [];
      }
      onProgress?.({ phase: "recognizing", completed: index, total: pdf.numPages });
    }
    const objects = inferReadingOrder([...textItems, ...ocrBlocks]);

    onProgress?.({ phase: "rendering", completed: index - 1, total: pdf.numPages });
    const background = await renderPage(sourcePage);
    pages.push({
      id: pageId,
      number: index,
      width: viewport.width,
      height: viewport.height,
      rotation: sourcePage.rotate,
      background,
      sourceKind,
      objects: [...objects, ...fields],
      nativeTextCount: textItems.length,
      imageCount,
      analysisStatus: textItems.length || ocrBlocks.length ? "ready" : "needs-review",
    });
    onProgress?.({ phase: "rendering", completed: index, total: pdf.numPages });
  }

  const info = metadata?.info as { Title?: string; Author?: string } | undefined;
  onProgress?.({ phase: "ready", completed: pdf.numPages, total: pdf.numPages });
  return {
    bytes,
    document: {
      id: stableId("document"),
      metadata: {
        filename: file.name,
        title: info?.Title,
        author: info?.Author,
        pageCount: pdf.numPages,
        createdAt: new Date().toISOString(),
        processingMode: "browser",
      },
      pages,
      operations: [],
    },
  };
  } finally {
    await localOcr?.terminate();
  }
}

/** Native image objects stay opaque until an extraction provider resolves their original stream. */
export function createImageObject(pageId: string, bbox: { x: number; y: number; width: number; height: number }): ImageObject {
  return {
    id: stableId("image"),
    type: "image",
    pageId,
    bbox,
    rotation: 0,
    transform: identityMatrix,
    confidence: 0.5,
    source: "inferred",
    zIndex: 1,
    language: "und",
    direction: "auto",
    relationships: [],
    imageKind: "unknown",
    originalAssetAvailable: false,
    opacity: 1,
  };
}
