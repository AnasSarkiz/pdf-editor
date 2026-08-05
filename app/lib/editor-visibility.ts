import type { TextBlock } from "./document-model";

/**
 * Native PDF pages keep a rendered source preview underneath the semantic
 * objects. Unchanged native text can stay hidden over that preview, but an
 * edited block must remain rendered after its inline editor loses focus.
 */
export function shouldRenderTextContent(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  if (!pageHasBackground || isInlineEditing || object.source !== "native-pdf") return true;
  return object.originalText !== object.text;
}

export function isTextReplacementPreview(object: TextBlock, pageHasBackground: boolean, isInlineEditing: boolean): boolean {
  return pageHasBackground && !isInlineEditing && object.source === "native-pdf" && object.originalText !== object.text;
}
