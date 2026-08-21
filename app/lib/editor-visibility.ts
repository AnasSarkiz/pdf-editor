import type { Rect, TextBlock } from "./document-model";

function textStyleChanged(object: TextBlock): boolean {
  const original = object.originalStyle;
  return Boolean(original && (
    original.fontFamily !== object.style.fontFamily
    || original.fontSize !== object.style.fontSize
    || original.fontWeight !== object.style.fontWeight
    || original.fontStyle !== object.style.fontStyle
    || original.color !== object.style.color
    || original.lineHeight !== object.style.lineHeight
    || original.letterSpacing !== object.style.letterSpacing
    || original.align !== object.style.align
  ));
}

function textBoundsChanged(object: TextBlock): boolean {
  const original = object.originalBbox ?? object.sourceBbox;
  return Boolean(original && (
    original.x !== object.bbox.x
    || original.y !== object.bbox.y
    || original.width !== object.bbox.width
    || original.height !== object.bbox.height
  ));
}

export function isCanvasBackedText(object: TextBlock): boolean {
  return object.source === "native-pdf" || object.source === "ocr";
}

/**
 * OCR blocks currently have only rectangular source bounds. Until recognition
 * persists a glyph-accurate cleanup mask, removing their source pixels is not
 * safe on arbitrary scans.
 */
export function isUnsafeOcrSourceCleanup(object: TextBlock): boolean {
  return object.source === "ocr";
}

/** Shared UI guard for content, geometry, style, direction, and delete tools. */
export function canSafelyMutateText(object: TextBlock): boolean {
  return object.editable !== false
    && !object.locked
    && object.sourceEditSafety !== "unmapped"
    && object.sourceEditSafety !== "unbounded-risk"
    && object.sourceMappingVerified !== false
    && !isUnsafeOcrSourceCleanup(object);
}

function rotatedBounds(bounds: Rect, rotation: number): Rect {
  if (!rotation) return bounds;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [0, 0],
    [bounds.width, 0],
    [0, bounds.height],
    [bounds.width, bounds.height],
  ].map(([x, y]) => ({
    x: bounds.x + x * cosine - y * sine,
    y: bounds.y + x * sine + y * cosine,
  }));
  const left = Math.min(...corners.map((corner) => corner.x));
  const top = Math.min(...corners.map((corner) => corner.y));
  const right = Math.max(...corners.map((corner) => corner.x));
  const bottom = Math.max(...corners.map((corner) => corner.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function overlaps(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

/** Rejects only placements that touch later paints whose shape/alpha is unsafe to reconstruct. */
export function canSafelyPlaceText(object: TextBlock, bounds: Rect = object.bbox): boolean {
  if (!canSafelyMutateText(object)) return false;
  if (object.source !== "native-pdf" || object.sourceEditSafety !== "bounded-risk") return true;
  const rotated = rotatedBounds(bounds, object.rotation);
  const paintBounds = { x: rotated.x - 1, y: rotated.y - 1, width: rotated.width + 2, height: rotated.height + 2 };
  return !(object.sourceUnsafeForegroundBounds ?? []).some((unsafeBounds) => overlaps(paintBounds, unsafeBounds));
}

/**
 * Native PDF and OCR text already exists in the source page raster. Keep it
 * out of the DOM except while editing so unchanged OCR is not double-painted.
 */
export function shouldRenderTextContent(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  if (!pageHasBackground || isInlineEditing || !isCanvasBackedText(object)) return true;
  return false;
}

export function needsSourceCanvasReplacement(object: TextBlock): boolean {
  if (!isCanvasBackedText(object)) return false;
  if (object.originalText !== object.text) return true;
  if (object.originalRotation !== undefined && object.originalRotation !== object.rotation) return true;
  if (object.originalDirection !== undefined && object.originalDirection !== object.direction) return true;
  return textStyleChanged(object) || textBoundsChanged(object);
}

/** Detects legacy or programmatic OCR changes that export must hard-block. */
export function hasUnsafeOcrSourceMutation(object: TextBlock): boolean {
  return isUnsafeOcrSourceCleanup(object) && needsSourceCanvasReplacement(object);
}

/** Active native edits must have a verified mapping and a safe destination. */
export function hasUnsafeNativeSourceMutation(object: TextBlock): boolean {
  return object.source === "native-pdf"
    && needsSourceCanvasReplacement(object)
    && !canSafelyPlaceText(object, object.bbox);
}

export function needsNativeCanvasReplacement(object: TextBlock): boolean {
  return object.source === "native-pdf" && needsSourceCanvasReplacement(object);
}

export function isTextReplacementPreview(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  return pageHasBackground && !isInlineEditing && needsSourceCanvasReplacement(object);
}
