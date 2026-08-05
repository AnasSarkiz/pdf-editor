import type { OcrToken } from "./recognition";
import { detectTextMeta } from "./document-model";

export interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TesseractLine {
  text: string;
  confidence: number;
  bbox: TesseractBox;
}

export interface TesseractParagraph {
  is_ltr: boolean;
  lines: TesseractLine[];
}

export interface TesseractBlock {
  paragraphs: TesseractParagraph[];
}

export interface LocalOcrSession {
  recognize(canvas: HTMLCanvasElement, page: { width: number; height: number }): Promise<OcrToken[]>;
  terminate(): Promise<void>;
}

/**
 * Starts a single browser-local Arabic + English OCR worker. The page image is
 * transferred only to this Web Worker; it is never posted to an OCR service.
 */
export async function createHighResolutionOcrSession(): Promise<LocalOcrSession> {
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("ara+eng", 1, {
    // The best trained data gives Arabic diacritics and mixed Latin values a
    // better chance than the smaller fast data, at the cost of one larger
    // first-run model download.
    langPath: "https://tessdata.projectnaptha.com/4.0.0_best",
  });
  await worker.setParameters({
    user_defined_dpi: "300",
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
  });

  return {
    async recognize(canvas, page) {
      const result = await worker.recognize(canvas, {}, { blocks: true });
      return tokensFromTesseractBlocks((result.data.blocks ?? []) as unknown as TesseractBlock[], canvas.width, canvas.height, page);
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

export function tokensFromTesseractBlocks(
  blocks: TesseractBlock[],
  imageWidth: number,
  imageHeight: number,
  page: { width: number; height: number },
): OcrToken[] {
  if (!imageWidth || !imageHeight) return [];
  const scaleX = page.width / imageWidth;
  const scaleY = page.height / imageHeight;
  return blocks.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => {
    const text = line.text.trim();
    if (!text) return [];
    const meta = detectTextMeta(text);
    const direction = meta.direction === "auto" ? (paragraph.is_ltr ? "ltr" : "rtl") : meta.direction;
    return [{
      text,
      polygon: [
        { x: line.bbox.x0 * scaleX, y: line.bbox.y0 * scaleY },
        { x: line.bbox.x1 * scaleX, y: line.bbox.y0 * scaleY },
        { x: line.bbox.x1 * scaleX, y: line.bbox.y1 * scaleY },
        { x: line.bbox.x0 * scaleX, y: line.bbox.y1 * scaleY },
      ],
      confidence: Math.max(0, Math.min(1, line.confidence / 100)),
      language: meta.language,
      direction,
    }];
  })));
}
