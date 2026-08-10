import { PDFDocument } from "pdf-lib";
import type { AnnotationObject, DocumentPage, EditableDocument, Rect, TextBlock } from "./document-model";
import { needsNativeCanvasReplacement } from "./editor-visibility";

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
  if (block.source === "native-pdf") return needsNativeCanvasReplacement(block);
  return block.originalText !== undefined && block.originalText !== block.text;
}

function shouldDrawText(page: DocumentPage, block: TextBlock): boolean {
  if (!page.background) return true;
  if (block.source === "user") return true;
  return sourceNeedsReplacement(block);
}

function concealSourceText(context: CanvasRenderingContext2D, source: Rect, scaleX: number, scaleY: number): void {
  const paddingX = Math.max(2, scaleX * 1.5);
  const paddingY = Math.max(2, scaleY * 1.5);
  const x = Math.max(0, source.x * scaleX - paddingX);
  const y = Math.max(0, source.y * scaleY - paddingY);
  const width = Math.min(context.canvas.width - x, source.width * scaleX + paddingX * 2);
  const height = Math.min(context.canvas.height - y, source.height * scaleY + paddingY * 2);
  if (width <= 0 || height <= 0) return;

  const samples = [
    [x, Math.max(0, y - paddingY * 2), width, paddingY],
    [x, Math.min(context.canvas.height - paddingY, y + height + paddingY), width, paddingY],
    [Math.max(0, x - paddingX * 2), y, paddingX, height],
    [Math.min(context.canvas.width - paddingX, x + width + paddingX), y, paddingX, height],
  ] as const;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (const [sampleX, sampleY, sampleWidth, sampleHeight] of samples) {
    const safeWidth = Math.max(1, Math.min(context.canvas.width - Math.floor(sampleX), Math.ceil(sampleWidth)));
    const safeHeight = Math.max(1, Math.min(context.canvas.height - Math.floor(sampleY), Math.ceil(sampleHeight)));
    const pixels = context.getImageData(Math.floor(sampleX), Math.floor(sampleY), safeWidth, safeHeight).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] < 150) continue;
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
      count += 1;
    }
  }
  if (!count) return;
  context.save();
  context.fillStyle = `rgb(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)})`;
  context.fillRect(x, y, width, height);
  context.restore();
}

function drawText(context: CanvasRenderingContext2D, block: TextBlock): void {
  context.save();
  context.translate(block.bbox.x, block.bbox.y + block.style.fontSize);
  if (block.rotation) context.rotate((block.rotation * Math.PI) / 180);
  context.font = `${block.style.fontStyle} ${block.style.fontWeight} ${block.style.fontSize}px ${block.style.fontFamily}`;
  context.fillStyle = block.style.color;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.direction = block.direction === "auto" ? "inherit" : block.direction;
  block.text.split(/\r?\n/).forEach((line, lineIndex) => {
    const letterSpacing = block.style.letterSpacing;
    const lineWidth = context.measureText(line).width + Math.max(0, line.length - 1) * letterSpacing;
    const x = block.style.align === "right" ? block.bbox.width - lineWidth : block.style.align === "center" ? (block.bbox.width - lineWidth) / 2 : 0;
    const y = lineIndex * block.style.fontSize * block.style.lineHeight;
    if (!letterSpacing) {
      context.fillText(line, x, y);
      return;
    }
    let advance = x;
    for (const glyph of Array.from(line)) {
      context.fillText(glyph, advance, y);
      advance += context.measureText(glyph).width + letterSpacing;
    }
  });
  context.restore();
}

function drawAnnotation(context: CanvasRenderingContext2D, annotation: AnnotationObject): void {
  const { bbox } = annotation;
  context.save();
  context.globalAlpha = annotation.opacity;
  if (annotation.annotationKind === "highlight") {
    context.fillStyle = annotation.color;
    context.fillRect(bbox.x, bbox.y, bbox.width, bbox.height);
  }
  if (annotation.annotationKind === "comment") {
    context.fillStyle = annotation.color;
    context.strokeStyle = "rgba(125, 91, 10, .6)";
    context.lineWidth = 1;
    context.fillRect(bbox.x, bbox.y, bbox.width, bbox.height);
    context.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
    context.globalAlpha = 1;
    context.fillStyle = "#5f4810";
    context.font = "600 12px Inter, Arial, sans-serif";
    context.textBaseline = "top";
    const words = (annotation.text || "Comment").split(/\s+/);
    let line = "";
    let y = bbox.y + 8;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > Math.max(20, bbox.width - 14) && line) {
        context.fillText(line, bbox.x + 7, y);
        y += 15;
        line = word;
      } else line = candidate;
    }
    if (line && y < bbox.y + bbox.height - 4) context.fillText(line, bbox.x + 7, y);
  }
  if (annotation.annotationKind === "redaction") {
    context.globalAlpha = 1;
    context.fillStyle = annotation.color;
    context.fillRect(bbox.x, bbox.y, bbox.width, bbox.height);
    context.fillStyle = "#ffffff";
    context.font = "700 9px Inter, Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(annotation.text || "REDACTED", bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, Math.max(0, bbox.width - 8));
  }
  context.restore();
}

async function flattenPage(page: DocumentPage): Promise<HTMLCanvasElement> {
  const image = page.background ? await loadImage(page.background) : null;
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

  const textBlocks = page.objects.filter((object): object is TextBlock => object.type === "text" && shouldDrawText(page, object));
  await Promise.all(textBlocks.map((block) => document.fonts.load(`${block.style.fontStyle} ${block.style.fontWeight} ${block.style.fontSize}px ${block.style.fontFamily}`, block.text).catch(() => [])));
  for (const block of textBlocks) {
    if (page.background && sourceNeedsReplacement(block)) concealSourceText(context, block.originalBbox ?? block.bbox, scaleX, scaleY);
    context.save();
    context.scale(scaleX, scaleY);
    drawText(context, block);
    context.restore();
  }
  const annotations = page.objects.filter((object): object is AnnotationObject => object.type === "annotation");
  for (const annotation of annotations) {
    context.save();
    context.scale(scaleX, scaleY);
    drawAnnotation(context, annotation);
    context.restore();
  }
  return canvas;
}

/**
 * Produces a valid visual PDF when a source PDF needs full reconstruction.
 * The result intentionally flattens each edited page, preserving the rendered
 * appearance and allowing the user to download their work without pretending
 * the original native content stream was losslessly rewritten.
 */
export async function exportFlattenedPdf(document: EditableDocument): Promise<Uint8Array> {
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
