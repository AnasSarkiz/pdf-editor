export type ObjectType =
  | "text"
  | "annotation"
  | "table"
  | "image"
  | "vector"
  | "form-field"
  | "group";

export type ObjectSource = "native-pdf" | "ocr" | "user" | "inferred";
export type TextDirection = "ltr" | "rtl" | "auto";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  color: string;
  lineHeight: number;
  letterSpacing: number;
  align: "left" | "center" | "right" | "justify";
}

export interface SemanticObjectBase {
  id: string;
  type: ObjectType;
  pageId: string;
  bbox: Rect;
  rotation: number;
  transform: Matrix;
  confidence: number;
  source: ObjectSource;
  zIndex: number;
  language: "ar" | "en" | "mixed" | "und";
  direction: TextDirection;
  relationships: string[];
  locked?: boolean;
}

export interface TextBlock extends SemanticObjectBase {
  type: "text";
  text: string;
  /** Immutable source placement used to remove moved native text from the page preview. */
  originalBbox?: Rect;
  /** Immutable source formatting used to detect native text changes safely. */
  originalStyle?: TextStyle;
  /** Source rotation in screen-space degrees for reconstruction decisions. */
  originalRotation?: number;
  style: TextStyle;
  originalText?: string;
  overflow: "shrink" | "expand" | "reflow" | "allow" | "warn";
  editable: boolean;
}

export type AnnotationKind = "highlight" | "comment" | "redaction";

/**
 * Review markup is kept independently from source text so it can be moved,
 * resized, and flattened safely when the edited document is exported.
 */
export interface AnnotationObject extends SemanticObjectBase {
  type: "annotation";
  annotationKind: AnnotationKind;
  color: string;
  opacity: number;
  text?: string;
}

export interface TableCell {
  id: string;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
  direction: TextDirection;
  confidence: number;
}

export interface TableObject extends SemanticObjectBase {
  type: "table";
  rows: number;
  columns: number;
  cells: TableCell[];
  borderColor: string;
  borderWidth: number;
}

export interface ImageObject extends SemanticObjectBase {
  type: "image";
  imageKind: "photo" | "logo" | "signature" | "stamp" | "barcode" | "unknown";
  originalAssetAvailable: boolean;
  opacity: number;
}

export interface VectorObject extends SemanticObjectBase {
  type: "vector";
  pathCount: number;
}

export interface FormFieldObject extends SemanticObjectBase {
  type: "form-field";
  fieldType: "text" | "checkbox" | "radio" | "dropdown" | "signature";
  name: string;
  value: string;
}

export type PageObject =
  | TextBlock
  | AnnotationObject
  | TableObject
  | ImageObject
  | VectorObject
  | FormFieldObject;

export interface DocumentPage {
  id: string;
  number: number;
  width: number;
  height: number;
  rotation: number;
  background?: string;
  sourceKind: "native" | "scan" | "hybrid";
  objects: PageObject[];
  nativeTextCount: number;
  imageCount: number;
  analysisStatus: "queued" | "ready" | "needs-review";
}

export interface DocumentMetadata {
  filename: string;
  title?: string;
  author?: string;
  pageCount: number;
  createdAt: string;
  processingMode: "browser" | "hybrid" | "server";
}

export interface EditOperation {
  id: string;
  type: "create" | "update" | "delete" | "move" | "resize" | "reorder";
  targetId: string;
  pageId: string;
  at: string;
  before?: Partial<PageObject>;
  after?: Partial<PageObject>;
  /** A complete page snapshot enables undoable duplicate, insert, and delete actions. */
  pageSnapshot?: DocumentPage;
  /** Page indices are stored directly for undoable reordering. */
  pageBeforeIndex?: number;
  pageAfterIndex?: number;
  label: string;
}

export interface EditableDocument {
  id: string;
  metadata: DocumentMetadata;
  pages: DocumentPage[];
  operations: EditOperation[];
}

export interface HistoryState {
  entries: EditOperation[];
  cursor: number;
}

export const identityMatrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const defaultTextStyle: TextStyle = {
  fontFamily: "Inter, Arial, sans-serif",
  fontSize: 15,
  fontWeight: 400,
  fontStyle: "normal",
  color: "#182128",
  lineHeight: 1.35,
  letterSpacing: 0,
  align: "left",
};

export function stableId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function detectTextMeta(text: string): Pick<TextBlock, "language" | "direction"> {
  const arabicCharacters = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) ?? []).length;
  const latinCharacters = (text.match(/[A-Za-z]/g) ?? []).length;
  const language =
    arabicCharacters > 0 && latinCharacters > 0
      ? "mixed"
      : arabicCharacters > 0
        ? "ar"
        : latinCharacters > 0
          ? "en"
          : "und";
  // The paragraph base direction follows its first strong character. Character
  // counts are useful for language reporting but are not a substitute for the
  // Unicode bidirectional algorithm on mixed lines.
  const firstStrong = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]|[A-Za-z]/)?.[0];
  return {
    language,
    direction: firstStrong && /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(firstStrong) ? "rtl" : "ltr",
  };
}

export function createDemoDocument(): EditableDocument {
  const pageId = stableId("page");
  const english = "Reference 4821 · North Africa Operations";
  const arabic = "اتفاقية خدمات — Service Agreement";
  const table: TableObject = {
    id: stableId("table"),
    type: "table",
    pageId,
    bbox: { x: 54, y: 292, width: 468, height: 130 },
    rotation: 0,
    transform: identityMatrix,
    confidence: 0.94,
    source: "inferred",
    zIndex: 1,
    language: "mixed",
    direction: "auto",
    relationships: [],
    rows: 3,
    columns: 3,
    borderColor: "#a5ada9",
    borderWidth: 1,
    cells: [
      ["Description / الوصف", "Currency", "Amount"],
      ["Advisory services", "USD", "12,500"],
      ["خدمات استشارية", "د.ل", "8,000"],
    ].flatMap((row, r) =>
      row.map((text, c) => ({
        id: stableId("cell"),
        row: r,
        column: c,
        rowSpan: 1,
        columnSpan: 1,
        text,
        direction: detectTextMeta(text).direction,
        confidence: r === 2 ? 0.86 : 0.98,
      })),
    ),
  };
  const text = (value: string, bbox: Rect, style: Partial<TextStyle> = {}, source: ObjectSource = "native-pdf"): TextBlock => {
    const resolvedStyle = { ...defaultTextStyle, ...style };
    return {
    id: stableId("text"),
    type: "text",
    pageId,
    bbox,
    originalBbox: { ...bbox },
    rotation: 0,
    originalRotation: 0,
    transform: identityMatrix,
    confidence: 0.99,
    source,
    zIndex: 2,
    relationships: [],
    ...detectTextMeta(value),
    text: value,
    originalText: value,
    style: resolvedStyle,
    originalStyle: { ...resolvedStyle },
    overflow: "warn",
    editable: true,
    };
  };

  return {
    id: stableId("document"),
    metadata: {
      filename: "mixed-language-proof-of-concept.pdf",
      title: "PDF Editor — mixed-language proof of concept",
      pageCount: 1,
      createdAt: new Date().toISOString(),
      processingMode: "browser",
    },
    operations: [],
    pages: [
      {
        id: pageId,
        number: 1,
        width: 576,
        height: 720,
        rotation: 0,
        sourceKind: "native",
        nativeTextCount: 5,
        imageCount: 1,
        analysisStatus: "needs-review",
        objects: [
          text("PDF EDITOR", { x: 54, y: 50, width: 220, height: 26 }, { fontSize: 24, fontWeight: 700, color: "#1a756e", letterSpacing: 1.8 }),
          text(arabic, { x: 54, y: 108, width: 468, height: 36 }, { fontFamily: "Noto Naskh Arabic, Arial, sans-serif", fontSize: 25, fontWeight: 600 }, "inferred"),
          text(english, { x: 54, y: 161, width: 430, height: 22 }, { fontSize: 14, color: "#67716e" }),
          text("This semantic sample proves mixed-direction selection and operation-based editing. It is not a raster page.", { x: 54, y: 216, width: 432, height: 42 }, { fontSize: 14, lineHeight: 1.5 }),
          table,
          text("Review note: one Arabic cell boundary requires confirmation.", { x: 54, y: 470, width: 420, height: 24 }, { fontSize: 13, color: "#967139" }, "ocr"),
        ],
      },
    ],
  };
}
