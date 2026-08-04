import type { DocumentPage, PageObject, Rect, TableObject, TextBlock } from "./document-model";
import { detectTextMeta, identityMatrix, stableId } from "./document-model";

export interface OcrToken {
  text: string;
  polygon: Array<{ x: number; y: number }>;
  confidence: number;
  language: "ar" | "en" | "mixed" | "und";
  direction: "ltr" | "rtl" | "auto";
}

export interface OcrProvider {
  readonly id: string;
  recognize(input: { image: Blob; languages: Array<"ar" | "en">; signal?: AbortSignal }): Promise<OcrToken[]>;
}

export interface LayoutAnalysisProvider {
  readonly id: string;
  analyze(input: { width: number; height: number; tokens: OcrToken[] }): Promise<PageObject[]>;
}

export interface TableRecognitionProvider {
  readonly id: string;
  recognize(input: { page: DocumentPage; textBlocks: TextBlock[] }): Promise<TableObject[]>;
}

/** A deliberate boundary: browser-only builds never silently upload a document. */
export class UnconfiguredOcrProvider implements OcrProvider {
  readonly id = "unconfigured";

  async recognize(): Promise<OcrToken[]> {
    throw new Error("OCR is not configured. Choose a local or server-assisted provider before sending page imagery.");
  }
}

export function inferReadingOrder(textBlocks: TextBlock[]): TextBlock[] {
  return [...textBlocks].sort((left, right) => {
    const vertical = left.bbox.y - right.bbox.y;
    if (Math.abs(vertical) > Math.max(left.bbox.height, right.bbox.height) * 0.65) return vertical;
    return left.direction === "rtl" ? right.bbox.x - left.bbox.x : left.bbox.x - right.bbox.x;
  });
}

export function detectScannedPage(nativeTextCount: number, imageCount: number): DocumentPage["sourceKind"] {
  if (nativeTextCount === 0 && imageCount > 0) return "scan";
  if (nativeTextCount > 0 && imageCount > 0) return "hybrid";
  return "native";
}

export function textFromOcrToken(pageId: string, token: OcrToken): TextBlock {
  const xs = token.polygon.map((point) => point.x);
  const ys = token.polygon.map((point) => point.y);
  const bbox: Rect = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  return {
    id: stableId("ocr-text"),
    type: "text",
    pageId,
    bbox,
    rotation: 0,
    transform: identityMatrix,
    confidence: token.confidence,
    source: "ocr",
    zIndex: 1,
    relationships: [],
    ...detectTextMeta(token.text),
    text: token.text,
    originalText: token.text,
    editable: true,
    overflow: "warn",
    style: {
      fontFamily: "Noto Naskh Arabic, Arial, sans-serif",
      fontSize: Math.max(9, bbox.height * 0.82),
      fontWeight: 400,
      fontStyle: "normal",
      color: "#172026",
      lineHeight: 1.35,
      letterSpacing: 0,
      align: token.direction === "rtl" ? "right" : "left",
    },
  };
}
