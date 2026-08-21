import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import type { EditableDocument, PageObject, TextBlock } from "./document-model";
import { hasUnsafeNativeSourceMutation, hasUnsafeOcrSourceMutation, needsSourceCanvasReplacement } from "./editor-visibility";

export type ExportStrategy = "patch" | "reconstruct" | "flatten" | "ocr-layer" | "optimize";

export interface ExportReadiness {
  canExport: boolean;
  /** Whether the visible-page flattened fallback can safely preserve this edit. */
  canFlatten: boolean;
  mode: ExportStrategy;
  messages: string[];
}

function isChangedSourceText(object: PageObject): object is TextBlock {
  return object.type === "text" && needsSourceCanvasReplacement(object);
}

function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text);
}

// pdf-lib's Standard 14 fonts encode text with WinAnsi. Keep this list in
// lockstep with that encoder so readiness can reject unsupported characters
// before PDF generation throws (or substitutes a different appearance).
const WIN_ANSI_EXTRA_CODE_POINTS = new Set([
  338, 339, 352, 353, 376, 381, 382, 402, 710, 732,
  8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224, 8225,
  8226, 8230, 8240, 8249, 8250, 8364, 8482,
]);

function isWinAnsiText(text: string): boolean {
  return Array.from(text).every((character) => {
    if (character === "\n") return true;
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (
      (codePoint >= 32 && codePoint <= 126)
      || (codePoint >= 160 && codePoint <= 255)
      || WIN_ANSI_EXTRA_CODE_POINTS.has(codePoint)
    );
  });
}

type DirectTextIssue = "font" | "spacing" | "alignment" | "direction";

function primaryFontFamily(fontFamily: string): string {
  return fontFamily
    .split(",", 1)[0]
    .trim()
    .replace(/^(?:"([^"]*)"|'([^']*)')$/, "$1$2")
    .toLowerCase();
}

function directTextIssue(object: TextBlock): DirectTextIssue | undefined {
  const usesSupportedHelvetica = primaryFontFamily(object.style.fontFamily) === "helvetica"
    && object.style.fontStyle === "normal"
    && (object.style.fontWeight === 400 || object.style.fontWeight === 700);
  if (!usesSupportedHelvetica) return "font";
  if (object.style.letterSpacing !== 0) return "spacing";
  if (object.style.align === "justify" || (object.style.align !== "left" && object.text.includes("\n"))) return "alignment";
  if (object.direction === "rtl") return "direction";
  return undefined;
}

function directExportText(document: EditableDocument, originalBytes?: Uint8Array): TextBlock[] {
  return document.pages.flatMap((page) => page.objects).filter(
    (object): object is TextBlock => object.type === "text" && (!originalBytes || object.source === "user"),
  );
}

function incompatibleDirectExportMessage(issue: DirectTextIssue): string {
  if (issue === "font") {
    return "Text uses a font family, weight, or italic style that direct PDF export cannot preserve exactly. Export PDF will download a flattened edited copy instead.";
  }
  if (issue === "spacing") {
    return "Text uses custom letter spacing that direct PDF export cannot preserve exactly. Export PDF will download a flattened edited copy instead.";
  }
  if (issue === "alignment") {
    return "Multiline text uses per-line alignment that direct PDF export cannot preserve exactly. Export PDF will download a flattened edited copy instead.";
  }
  return "Text uses a writing direction that direct PDF export cannot preserve exactly. Export PDF will download a flattened edited copy instead.";
}

export function getExportReadiness(document: EditableDocument, originalBytes?: Uint8Array): ExportReadiness {
  const changedSourceText = document.pages.flatMap((page) => page.objects.filter(isChangedSourceText));
  const changedNativeText = changedSourceText.filter((object) => object.source === "native-pdf");
  const changedOcrText = changedSourceText.filter((object) => object.source === "ocr");
  const deletedSourceText = document.pages.flatMap((page) => page.deletedSourceText ?? []);
  const exportedText = directExportText(document, originalBytes);
  if (changedOcrText.some(hasUnsafeOcrSourceMutation) || deletedSourceText.some((object) => object.source === "ocr")) {
    return {
      canExport: false,
      canFlatten: false,
      mode: "ocr-layer",
      messages: [
        "Recognized scan text was changed or deleted, but its source pixels cannot be removed safely. Undo that OCR edit before exporting.",
      ],
    };
  }
  if (changedNativeText.some(hasUnsafeNativeSourceMutation)) {
    return {
      canExport: false,
      canFlatten: false,
      mode: "reconstruct",
      messages: [
        "This native text edit crosses source graphics whose paint order or transparency cannot be reconstructed safely. Undo that edit or duplicate the text as a new editable object.",
      ],
    };
  }
  if (deletedSourceText.length > 0) {
    return {
      canExport: false,
      canFlatten: true,
      mode: "reconstruct",
      messages: [
        "Source text has been deleted. Export PDF will download a flattened edited copy so the removed source glyphs stay hidden.",
        "A reconstruction worker is still required for a lossless source-text PDF export.",
      ],
    };
  }
  if (originalBytes && changedNativeText.length > 0) {
    return {
      canExport: false,
      canFlatten: true,
      mode: "reconstruct",
      messages: [
        "Native text has been changed. Export PDF will download a flattened edited copy so no work is lost.",
        "A reconstruction worker is still required for a lossless source-text PDF export.",
      ],
    };
  }
  if (exportedText.some((object) => hasArabic(object.text))) {
    return {
      canExport: false,
      canFlatten: true,
      mode: "reconstruct",
      messages: [
        "Arabic user text will export as a flattened edited copy until HarfBuzz shaping and an embeddable font are configured.",
      ],
    };
  }
  if (exportedText.some((object) => !isWinAnsiText(object.text))) {
    return {
      canExport: false,
      canFlatten: true,
      mode: "reconstruct",
      messages: [
        "New text contains characters that the direct PDF text encoder cannot preserve. Export PDF will download a flattened edited copy instead.",
      ],
    };
  }
  const issue = exportedText.map(directTextIssue).find((candidate) => candidate !== undefined);
  if (issue) {
    return {
      canExport: false,
      canFlatten: true,
      mode: "reconstruct",
      messages: [incompatibleDirectExportMessage(issue)],
    };
  }
  return {
    canExport: true,
    canFlatten: true,
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

function textObjects(document: EditableDocument): Array<{ pageIndex: number; object: TextBlock }> {
  return document.pages.flatMap((page, pageIndex) =>
    page.objects.filter((object): object is TextBlock => object.type === "text").map((object) => ({ pageIndex, object })),
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

  for (const { pageIndex, object } of textObjects(document)) {
    if (originalBytes && object.source !== "user") continue;
    const page = pdf.getPages()[pageIndex];
    const color = hexToRgb(object.style.color);
    const drawFont = object.style.fontWeight >= 600 ? bold : font;
    const textWidth = Math.max(...object.text.split(/\r?\n/).map((line) => drawFont.widthOfTextAtSize(line, object.style.fontSize) + Math.max(0, line.length - 1) * object.style.letterSpacing));
    const x = object.style.align === "right"
      ? object.bbox.x + object.bbox.width - textWidth
      : object.style.align === "center"
        ? object.bbox.x + (object.bbox.width - textWidth) / 2
        : object.bbox.x;
    page.drawText(object.text, {
      x,
      y: document.pages[pageIndex].height - object.bbox.y - object.style.fontSize,
      size: object.style.fontSize,
      font: drawFont,
      color: rgb(color.red, color.green, color.blue),
      rotate: object.rotation ? degrees(-object.rotation) : undefined,
      lineHeight: object.style.fontSize * object.style.lineHeight,
    });
  }
  pdf.setTitle(document.metadata.title ?? document.metadata.filename);
  pdf.setProducer("PDF Editor browser proof of concept");
  return pdf.save();
}

export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.pdf$/i, "") + "-edited.pdf";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel or hide the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
