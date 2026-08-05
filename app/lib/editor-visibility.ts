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

export function isTextReplacementPreview(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  return pageHasBackground && !isInlineEditing && object.source === "native-pdf" && object.originalText !== object.text;
}
