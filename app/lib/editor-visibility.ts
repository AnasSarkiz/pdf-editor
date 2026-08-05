import type { TextBlock } from "./document-model";

/**
 * Native PDF pages keep their source preview on a shared canvas. Native text
 * is only rendered in the DOM while an inline editor is active; committed
 * replacements are painted back onto that source canvas so their smoothing
 * matches the original PDF preview.
 */
export function shouldRenderTextContent(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  if (!pageHasBackground || isInlineEditing || object.source !== "native-pdf") return true;
  return false;
}

export function needsNativeCanvasReplacement(object: TextBlock): boolean {
  if (object.source !== "native-pdf") return false;
  if (object.originalText !== object.text) return true;
  const original = object.originalBbox;
  if (!original) return false;
  return original.x !== object.bbox.x || original.y !== object.bbox.y || original.width !== object.bbox.width || original.height !== object.bbox.height;
}

export function isTextReplacementPreview(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  return pageHasBackground && !isInlineEditing && needsNativeCanvasReplacement(object);
}
