import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { EditableDocument, PageObject, TextBlock } from "./document-model";

export type ExportStrategy = "patch" | "reconstruct" | "flatten" | "ocr-layer" | "optimize";

export interface ExportReadiness {
  canExport: boolean;
  mode: ExportStrategy;
  messages: string[];
}

function isChangedNativeText(object: PageObject): object is TextBlock {
  return object.type === "text" && object.source === "native-pdf" && object.originalText !== object.text;
}

function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text);
}

export function getExportReadiness(document: EditableDocument, originalBytes?: Uint8Array): ExportReadiness {
  const changedNativeText = document.pages.flatMap((page) => page.objects.filter(isChangedNativeText));
  const arabicUserText = document.pages.flatMap((page) => page.objects).filter(
    (object) => object.type === "text" && object.source === "user" && hasArabic(object.text),
  );
  const arabicReconstructionText = !originalBytes
    ? document.pages.flatMap((page) => page.objects).filter((object) => object.type === "text" && hasArabic(object.text))
    : [];
  if (originalBytes && changedNativeText.length > 0) {
    return {
      canExport: false,
      mode: "reconstruct",
      messages: [
        "Native text has been changed. This browser-only build will not cover old glyphs or silently rasterize the page.",
        "Choose the reconstruction worker when it is configured; untouched pages remain lossless in patch export.",
      ],
    };
  }
  if (arabicUserText.length > 0 || arabicReconstructionText.length > 0) {
    return {
      canExport: false,
      mode: "reconstruct",
      messages: [
        "Arabic user text requires HarfBuzz shaping plus an embeddable Arabic font. Export is deliberately held until that worker is configured.",
      ],
    };
  }
  return {
    canExport: true,
    mode: originalBytes ? "patch" : "reconstruct",
    messages: originalBytes
      ? ["Patch export preserves every untouched PDF object. New Latin text is added as a real PDF text object."]
      : ["The proof-of-concept document will be rebuilt as vector text and table geometry."],
  };
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const normalized = hex.replace("#", "");
  const integer = Number.parseInt(normalized.length === 3 ? normalized.split("").map((value) => value + value).join("") : normalized, 16);
  return { red: ((integer >> 16) & 255) / 255, green: ((integer >> 8) & 255) / 255, blue: (integer & 255) / 255 };
}

function latinTextObjects(document: EditableDocument): Array<{ pageIndex: number; object: TextBlock }> {
  return document.pages.flatMap((page, pageIndex) =>
    page.objects.filter((object): object is TextBlock => object.type === "text" && !hasArabic(object.text)).map((object) => ({ pageIndex, object })),
  );
}

export async function exportPdf(document: EditableDocument, originalBytes?: Uint8Array): Promise<Uint8Array> {
  const readiness = getExportReadiness(document, originalBytes);
  if (!readiness.canExport) throw new Error(readiness.messages[0]);
  const pdf = originalBytes ? await PDFDocument.load(originalBytes, { ignoreEncryption: false, updateMetadata: false }) : await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const existingPages = pdf.getPages();

  document.pages.forEach((modelPage, pageIndex) => {
    const page = existingPages[pageIndex] ?? pdf.addPage([modelPage.width, modelPage.height]);
    if (!originalBytes) {
      page.drawRectangle({ x: 0, y: 0, width: modelPage.width, height: modelPage.height, color: rgb(0.976, 0.957, 0.91) });
      for (const object of modelPage.objects) {
        if (object.type === "table") {
          const { x, y, width, height } = object.bbox;
          const cellWidth = width / object.columns;
          const cellHeight = height / object.rows;
          for (let row = 0; row <= object.rows; row += 1) page.drawLine({ start: { x, y: modelPage.height - y - row * cellHeight }, end: { x: x + width, y: modelPage.height - y - row * cellHeight }, thickness: object.borderWidth, color: rgb(0.65, 0.68, 0.66) });
          for (let column = 0; column <= object.columns; column += 1) page.drawLine({ start: { x: x + column * cellWidth, y: modelPage.height - y }, end: { x: x + column * cellWidth, y: modelPage.height - y - height }, thickness: object.borderWidth, color: rgb(0.65, 0.68, 0.66) });
        }
      }
    }
  });

  for (const { pageIndex, object } of latinTextObjects(document)) {
    if (originalBytes && object.source !== "user") continue;
    const page = pdf.getPages()[pageIndex];
    const color = hexToRgb(object.style.color);
    page.drawText(object.text, {
      x: object.bbox.x,
      y: document.pages[pageIndex].height - object.bbox.y - object.style.fontSize,
      size: object.style.fontSize,
      font: object.style.fontWeight >= 600 ? bold : font,
      color: rgb(color.red, color.green, color.blue),
      rotate: object.rotation ? undefined : undefined,
      maxWidth: object.bbox.width,
      lineHeight: object.style.fontSize * object.style.lineHeight,
    });
  }
  pdf.setTitle(document.metadata.title ?? document.metadata.filename);
  pdf.setProducer("PDF Editor browser proof of concept");
  return pdf.save();
}

export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.pdf$/i, "") + "-edited.pdf";
  link.click();
  URL.revokeObjectURL(url);
}
