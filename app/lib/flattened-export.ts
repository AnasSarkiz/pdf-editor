import { PDFDocument } from "pdf-lib";
import type { DocumentPage, EditableDocument, TextBlock } from "./document-model";
import { hasUnsafeNativeSourceMutation, hasUnsafeOcrSourceMutation, needsSourceCanvasReplacement } from "./editor-visibility";
import { getNativeTextRestorationPlan, loadTextFonts, paintTextBlock, restoreTextSource } from "./text-compositor";

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The source page could not be rendered for export."));
    image.src = source;
  });
}

async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("The page could not be encoded for export.")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

function sourceNeedsReplacement(block: TextBlock): boolean {
  return needsSourceCanvasReplacement(block);
}

function shouldDrawText(page: DocumentPage, block: TextBlock): boolean {
  if (!page.background) return true;
  if (block.source === "user") return true;
  return sourceNeedsReplacement(block);
}

function imageCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
  context.drawImage(image, 0, 0);
  return canvas;
}

async function flattenPage(page: DocumentPage): Promise<HTMLCanvasElement> {
  const [image, cleanImage] = await Promise.all([
    page.background ? loadImage(page.background) : Promise.resolve(null),
    page.cleanBackground ? loadImage(page.cleanBackground) : Promise.resolve(null),
  ]);
  const scaleX = image ? image.naturalWidth / page.width : 3;
  const scaleY = image ? image.naturalHeight / page.height : 3;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(page.width * scaleX);
  canvas.height = Math.ceil(page.height * scaleY);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (image) context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const cleanContext = cleanImage ? imageCanvas(cleanImage).getContext("2d", { alpha: false }) : null;

  const textBlocks = page.objects.filter((object): object is TextBlock => object.type === "text" && shouldDrawText(page, object));
  const sourceReplacements = page.objects.filter(
    (object): object is TextBlock => object.type === "text" && sourceNeedsReplacement(object),
  );
  const deletedSourceText = page.deletedSourceText ?? [];
  const nativePlan = getNativeTextRestorationPlan(
    page.objects.filter((object): object is TextBlock => object.type === "text" && object.source === "native-pdf"),
    [...sourceReplacements, ...deletedSourceText],
  );
  const paintBlocks = [...new Map(
    [...textBlocks, ...nativePlan.repaint].map((block) => [block.id, block]),
  ).values()];
  await loadTextFonts(paintBlocks, scaleY);
  if (page.background) {
    for (const block of nativePlan.restore) restoreTextSource(context, cleanContext, block, scaleX, scaleY);
    for (const block of [...sourceReplacements, ...deletedSourceText]) {
      if (block.source === "ocr") restoreTextSource(context, cleanContext, block, scaleX, scaleY);
    }
  }
  for (const block of paintBlocks.sort((left, right) => left.zIndex - right.zIndex)) paintTextBlock(context, block, scaleX, scaleY);
  return canvas;
}

/**
 * Produces a valid visual PDF when a source PDF needs full reconstruction.
 * The result intentionally flattens each edited page, preserving the rendered
 * appearance and allowing the user to download their work without pretending
 * the original native content stream was losslessly rewritten.
 */
export async function exportFlattenedPdf(document: EditableDocument): Promise<Uint8Array> {
  const unsafeOcrEdit = document.pages.some((page) =>
    page.objects.some((object) => object.type === "text" && hasUnsafeOcrSourceMutation(object))
    || (page.deletedSourceText ?? []).some((object) => object.source === "ocr"),
  );
  if (unsafeOcrEdit) {
    throw new Error("Recognized scan text cannot be removed safely without a glyph-accurate cleanup mask. Undo that OCR edit before exporting.");
  }
  const unsafeNativeEdit = document.pages.some((page) => page.objects.some(
    (object) => object.type === "text" && hasUnsafeNativeSourceMutation(object),
  ));
  if (unsafeNativeEdit) {
    throw new Error("This native text edit crosses source graphics that cannot be reconstructed safely. Undo it or duplicate the text as a new editable object.");
  }
  const pdf = await PDFDocument.create();
  for (const modelPage of document.pages) {
    const canvas = await flattenPage(modelPage);
    const image = await pdf.embedPng(await canvasPngBytes(canvas));
    const page = pdf.addPage([modelPage.width, modelPage.height]);
    page.drawImage(image, { x: 0, y: 0, width: modelPage.width, height: modelPage.height });
  }
  pdf.setTitle(document.metadata.title ?? document.metadata.filename);
  pdf.setProducer("PDF Editor flattened visual export");
  return pdf.save();
}
