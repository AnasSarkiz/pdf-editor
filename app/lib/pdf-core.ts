import type { EditableDocument, DocumentPage, FormFieldObject, ImageObject, Matrix, Rect, SourceForegroundOcclusion, TextBlock } from "./document-model";
import { defaultTextStyle, detectTextMeta, identityMatrix, stableId } from "./document-model";
import { createHighResolutionOcrSession, type LocalOcrSession } from "./local-ocr";
import { detectScannedPage, inferReadingOrder, textFromOcrToken } from "./recognition";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfPageProxy = import("pdfjs-dist/types/src/display/api").PDFPageProxy;

// 216 dpi source pages keep the browser view and flattened fallback export
// sharp enough for business documents without rendering at full print size.
const PREVIEW_RENDER_SCALE = 3;
const OCR_RENDER_SCALE = 300 / 72;

interface NativeTextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

interface NativeTextStyle {
  ascent: number;
  descent: number;
  vertical: boolean;
  fontFamily: string;
}

interface NativeFont {
  loadedName?: string;
  name?: string;
  fallbackName?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  ascent?: number;
  descent?: number;
}

interface RecordedOperationBounds {
  isEmpty: (index: number) => boolean;
  minX: (index: number) => number;
  minY: (index: number) => number;
  maxX: (index: number) => number;
  maxY: (index: number) => number;
}

interface TextPaintAppearance {
  operatorIndex: number;
  text: string;
  color?: string;
  fontName?: string;
}

interface MatchedTextPaintAppearance extends TextPaintAppearance {
  sourceBbox: Rect;
  operatorIndices: number[];
  mappingMethod: NonNullable<TextBlock["sourceMappingMethod"]>;
}

interface TextAppearanceTarget {
  text: string;
  fontName: string;
  bbox: Rect;
  fontSize: number;
}

interface PaintExtractionState {
  transform: number[];
  transformReliable: boolean;
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  miterLimit: number;
  fillVisible: boolean;
  strokeVisible: boolean;
  fillAlpha: number;
  strokeAlpha: number;
  fillSolidColor: boolean;
  strokeSolidColor: boolean;
  dashSolid: boolean;
  clipGeometrySafe: boolean;
  clipBounds?: Rect;
  pendingClip: boolean;
  blendModeSafe: boolean;
  softMaskSafe: boolean;
}

interface ForegroundPaintCandidate {
  operatorIndex: number;
  /** Exact opaque rectangles that the compositor can safely clip. */
  opaqueRects: Rect[];
  /** Conservative paint bounds used to block unsafe replacement overlap. */
  guardRects: Rect[];
  /** False when any visible part of this paint cannot be represented above. */
  fullyRepresented: boolean;
}

interface SourceForegroundAnalysis {
  occlusions: SourceForegroundOcclusion[];
  unsafeBounds: Rect[];
  hasUnboundedRisk: boolean;
}

interface NativeAnnotation {
  id: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: string;
  rect: [number, number, number, number];
}

async function getPdfJs(): Promise<PdfJsModule> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
      import.meta.url,
    ).toString();
  }
  return pdfjs;
}

function matrixFrom(transform: number[]): Matrix {
  return {
    a: transform[0] ?? 1,
    b: transform[1] ?? 0,
    c: transform[2] ?? 0,
    d: transform[3] ?? 1,
    e: transform[4] ?? 0,
    f: transform[5] ?? 0,
  };
}

function multiplyTransforms(left: number[], right: number[]): number[] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function cssFontFamily(value: string): string {
  if (!value || /[,"']/.test(value) || !/\s/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function normalizedText(value: string): string {
  // Compatibility normalization can make visibly distinct source glyphs look
  // equivalent (for example full-width Latin characters). NFC is deliberately
  // conservative because a false match can erase unrelated PDF content.
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function glyphText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(glyphText).join("");
  if (!value || typeof value !== "object") return "";
  const candidate = value as { unicode?: unknown; fontChar?: unknown };
  return typeof candidate.unicode === "string"
    ? candidate.unicode
    : typeof candidate.fontChar === "string"
      ? candidate.fontChar
      : "";
}

function colorFromArgs(args: unknown[] | null | undefined, mode: "rgb" | "gray" | "cmyk"): string | undefined {
  const cssValue = args?.find((value): value is string => typeof value === "string" && /^#[\da-f]{6}$/i.test(value));
  if (cssValue) return cssValue.toLowerCase();
  const values = (args ?? []).flatMap((value) => typeof value === "number" ? [value] : Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : []);
  if (!values.length) return undefined;
  const normalized = values.map((value) => value <= 1 ? value : value / 255);
  let red: number;
  let green: number;
  let blue: number;
  if (mode === "gray") {
    red = green = blue = normalized[0];
  } else if (mode === "cmyk") {
    const [cyan = 0, magenta = 0, yellow = 0, black = 0] = normalized;
    red = 1 - Math.min(1, cyan + black);
    green = 1 - Math.min(1, magenta + black);
    blue = 1 - Math.min(1, yellow + black);
  } else {
    [red = 0, green = 0, blue = 0] = normalized;
  }
  return `#${[red, green, blue].map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function textPaintOperationSet(pdfjs: PdfJsModule): Set<number> {
  return new Set([
    pdfjs.OPS.showText,
    pdfjs.OPS.showSpacedText,
    pdfjs.OPS.nextLineShowText,
    pdfjs.OPS.nextLineSetSpacingShowText,
  ]);
}

function graphicsStatePairs(args: unknown[] | null | undefined): unknown[][] {
  const entries = args?.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (!Array.isArray(entries)) return [];
  const pairs = entries[0] === "Font" ? [entries] : entries;
  return pairs.filter((entry): entry is unknown[] => Array.isArray(entry));
}

function fontNameFromGraphicsState(args: unknown[] | null | undefined): string | undefined {
  for (const entry of graphicsStatePairs(args)) {
    if (!Array.isArray(entry) || entry[0] !== "Font" || !Array.isArray(entry[1])) continue;
    const fontName = entry[1][0];
    if (typeof fontName === "string") return fontName;
  }
  return undefined;
}

// Keep run metadata internal so the public appearance objects (and existing
// diagnostics) retain their small, serializable shape.
const textAppearanceRunId = Symbol("pdf-text-appearance-run");
type InternalTextPaintAppearance = TextPaintAppearance & { [textAppearanceRunId]?: number };

function extractTextPaintAppearances(pdfjs: PdfJsModule, fnArray: number[], argsArray: unknown[][]): TextPaintAppearance[] {
  const appearances: TextPaintAppearance[] = [];
  const stateStack: Array<{ fillColor?: string; fontName?: string }> = [];
  let state: { fillColor?: string; fontName?: string } = { fillColor: "#000000" };
  let nextRunId = 0;
  let currentRunId = -1;
  let canContinueRun = false;
  const breakRun = () => { canContinueRun = false; };
  for (let index = 0; index < fnArray.length; index += 1) {
    const operation = fnArray[index];
    const args = argsArray[index];
    if (operation === pdfjs.OPS.save) {
      stateStack.push({ ...state });
      breakRun();
    } else if (operation === pdfjs.OPS.restore) {
      state = stateStack.pop() ?? state;
      breakRun();
    }
    else if (operation === pdfjs.OPS.setFont) {
      const fontName = args?.[0];
      if (typeof fontName === "string") state = { ...state, fontName };
      breakRun();
    } else if (operation === pdfjs.OPS.setGState) {
      const fontName = fontNameFromGraphicsState(args);
      if (fontName) state = { ...state, fontName };
      breakRun();
    } else if (operation === pdfjs.OPS.setFillRGBColor) {
      state = { ...state, fillColor: colorFromArgs(args, "rgb") ?? state.fillColor };
      breakRun();
    } else if (operation === pdfjs.OPS.setFillGray) {
      state = { ...state, fillColor: colorFromArgs(args, "gray") ?? state.fillColor };
      breakRun();
    } else if (operation === pdfjs.OPS.setFillCMYKColor) {
      state = { ...state, fillColor: colorFromArgs(args, "cmyk") ?? state.fillColor };
      breakRun();
    } else if (operation === pdfjs.OPS.moveText) {
      // Some generators emit one showText per glyph and advance horizontally
      // between them. This is the only inter-glyph operation we join: vertical
      // movement, text-state changes, and arbitrary operators start a new run.
      const verticalAdvance = args?.[1];
      if (!canContinueRun || typeof verticalAdvance !== "number" || Math.abs(verticalAdvance) > 1e-6) breakRun();
    } else if (textPaintOperationSet(pdfjs).has(operation)) {
      const continuesHorizontally = operation === pdfjs.OPS.showText || operation === pdfjs.OPS.showSpacedText;
      if (!canContinueRun || !continuesHorizontally) currentRunId = nextRunId++;
      const payload = operation === pdfjs.OPS.nextLineSetSpacingShowText ? args?.[2] : args?.[0];
      const appearance: InternalTextPaintAppearance = {
        operatorIndex: index,
        text: glyphText(payload),
        color: state.fillColor,
        fontName: state.fontName,
      };
      Object.defineProperty(appearance, textAppearanceRunId, { value: currentRunId });
      appearances.push(appearance);
      canContinueRun = continuesHorizontally;
    } else breakRun();
  }
  return appearances;
}

function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

function intersectionArea(left: Rect, right: Rect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function clonePaintExtractionState(state: PaintExtractionState): PaintExtractionState {
  return {
    ...state,
    transform: [...state.transform],
    ...(state.clipBounds ? { clipBounds: { ...state.clipBounds } } : {}),
  };
}

function numericArray(value: unknown): number[] | undefined {
  let values: unknown[];
  if (Array.isArray(value)) values = value;
  else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) values = Array.from(value as unknown as ArrayLike<unknown>);
  else return undefined;
  return values.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)) ? values : undefined;
}

function transformedPoint(transform: number[], x: number, y: number): { x: number; y: number } {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  };
}

function rectFromPoints(points: Array<{ x: number; y: number }>): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function unionRects(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const GEOMETRY_EPSILON = 1e-6;

function constructPathData(args: unknown[] | null | undefined): number[] | undefined {
  const container = args?.[1];
  const rawPath = Array.isArray(container) && container.length === 1 ? container[0] : container;
  return numericArray(rawPath);
}

function parsePathGuardRect(args: unknown[] | null | undefined, state: PaintExtractionState): Rect | undefined {
  if (!state.transformReliable) return undefined;
  const data = constructPathData(args);
  if (!data) return undefined;
  const points: Array<{ x: number; y: number }> = [];
  let cursor = 0;
  const readPoints = (count: number): boolean => {
    if (cursor + count * 2 > data.length) return false;
    for (let index = 0; index < count; index += 1) {
      points.push(transformedPoint(state.transform, data[cursor], data[cursor + 1]));
      cursor += 2;
    }
    return true;
  };
  while (cursor < data.length) {
    const operation = data[cursor];
    cursor += 1;
    if (operation === 0 || operation === 1) {
      if (!readPoints(1)) return undefined;
    } else if (operation === 2) {
      // A cubic Bezier is contained by the hull of its endpoints and controls.
      if (!readPoints(3)) return undefined;
    } else if (operation === 3) {
      if (!readPoints(2)) return undefined;
    } else if (operation !== 4) return undefined;
  }
  if (!points.length) return undefined;
  const rect = rectFromPoints(points);
  return rect.width > GEOMETRY_EPSILON || rect.height > GEOMETRY_EPSILON ? rect : undefined;
}

function expandedStrokeGuard(rect: Rect, state: PaintExtractionState): Rect {
  const halfWidth = state.lineWidth > 0 ? state.lineWidth / 2 : 0.5;
  const joinFactor = state.lineJoin === 0 ? Math.max(1, state.miterLimit) : 1;
  const paddingX = halfWidth * Math.hypot(state.transform[0], state.transform[2]) * joinFactor;
  const paddingY = halfWidth * Math.hypot(state.transform[1], state.transform[3]) * joinFactor;
  return {
    x: rect.x - paddingX,
    y: rect.y - paddingY,
    width: rect.width + paddingX * 2,
    height: rect.height + paddingY * 2,
  };
}

function transformedUnitSquare(state: PaintExtractionState): Rect | undefined {
  if (!state.transformReliable) return undefined;
  const rect = rectFromPoints([
    transformedPoint(state.transform, 0, 0),
    transformedPoint(state.transform, 1, 0),
    transformedPoint(state.transform, 0, 1),
    transformedPoint(state.transform, 1, 1),
  ]);
  return rect.width > GEOMETRY_EPSILON && rect.height > GEOMETRY_EPSILON ? rect : undefined;
}

function isAxisVector(x: number, y: number): boolean {
  return Math.abs(x) <= GEOMETRY_EPSILON || Math.abs(y) <= GEOMETRY_EPSILON;
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return Math.abs(left.x - right.x) <= GEOMETRY_EPSILON && Math.abs(left.y - right.y) <= GEOMETRY_EPSILON;
}

/**
 * Return exact rectangular coverage only for independent, solid, butt-capped
 * axis-aligned line segments. Curves, diagonals, joins, dashes, and hairlines
 * are intentionally left as unsafe paint instead of over-clipping their bbox.
 */
function parseOpaqueStrokeRects(args: unknown[] | null | undefined, state: PaintExtractionState): Rect[] | undefined {
  if (!state.transformReliable || state.lineWidth <= 0 || state.lineCap !== 0 || state.lineJoin !== 0 || !state.dashSolid) return undefined;
  const data = constructPathData(args);
  if (!data) return undefined;

  const segments: Rect[] = [];
  let cursor = 0;
  let current: { x: number; y: number } | undefined;
  let subpathStart: { x: number; y: number } | undefined;
  let subpathSegments = 0;
  const readPoint = (): { x: number; y: number } | undefined => {
    if (cursor + 1 >= data.length) return undefined;
    const point = { x: data[cursor], y: data[cursor + 1] };
    cursor += 2;
    return point;
  };
  const appendSegment = (start: { x: number; y: number }, end: { x: number; y: number }): boolean => {
    if (samePoint(start, end)) return true;
    if (subpathSegments > 0) return false;
    const transformedStart = transformedPoint(state.transform, start.x, start.y);
    const transformedEnd = transformedPoint(state.transform, end.x, end.y);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const horizontal = Math.abs(deltaY) <= GEOMETRY_EPSILON;
    const vertical = Math.abs(deltaX) <= GEOMETRY_EPSILON;
    if ((!horizontal && !vertical) || !isAxisVector(transformedEnd.x - transformedStart.x, transformedEnd.y - transformedStart.y)) return false;
    const halfWidth = state.lineWidth / 2;
    const normal = horizontal
      ? { x: state.transform[2] * halfWidth, y: state.transform[3] * halfWidth }
      : { x: state.transform[0] * halfWidth, y: state.transform[1] * halfWidth };
    if (!isAxisVector(normal.x, normal.y)) return false;
    const rect = rectFromPoints([
      { x: transformedStart.x - normal.x, y: transformedStart.y - normal.y },
      { x: transformedStart.x + normal.x, y: transformedStart.y + normal.y },
      { x: transformedEnd.x - normal.x, y: transformedEnd.y - normal.y },
      { x: transformedEnd.x + normal.x, y: transformedEnd.y + normal.y },
    ]);
    if (rect.width <= GEOMETRY_EPSILON || rect.height <= GEOMETRY_EPSILON) return false;
    segments.push(rect);
    return true;
  };

  while (cursor < data.length) {
    const operation = data[cursor];
    cursor += 1;
    if (operation === 0) {
      const point = readPoint();
      if (!point) return undefined;
      current = subpathStart = point;
      subpathSegments = 0;
    } else if (operation === 1) {
      const end = readPoint();
      if (!current || !end) return undefined;
      if (!appendSegment(current, end)) return undefined;
      current = end;
      subpathSegments += 1;
    } else if (operation === 4) {
      if (!current || !subpathStart) return undefined;
      if (!samePoint(current, subpathStart)) return undefined;
      current = subpathStart;
    } else return undefined;
  }
  return segments.length ? segments : undefined;
}

/** Accept exactly one transformed axis-aligned rectangular fill subpath. */
function parseOpaqueFillRect(args: unknown[] | null | undefined, state: PaintExtractionState): Rect | undefined {
  if (!state.transformReliable) return undefined;
  const data = constructPathData(args);
  if (!data) return undefined;
  const points: Array<{ x: number; y: number }> = [];
  let cursor = 0;
  let closed = false;
  const readPoint = (): { x: number; y: number } | undefined => {
    if (cursor + 1 >= data.length) return undefined;
    const point = { x: data[cursor], y: data[cursor + 1] };
    cursor += 2;
    return point;
  };
  while (cursor < data.length) {
    const operation = data[cursor];
    cursor += 1;
    if (operation === 0) {
      if (points.length) return undefined;
      const point = readPoint();
      if (!point) return undefined;
      points.push(point);
    } else if (operation === 1) {
      const point = readPoint();
      if (!points.length || !point || closed) return undefined;
      points.push(point);
    } else if (operation === 4) {
      if (!points.length || closed) return undefined;
      closed = true;
    } else return undefined;
  }
  if (points.length > 1 && samePoint(points[0], points.at(-1)!)) points.pop();
  if (points.length !== 4) return undefined;
  const transformed = points.map((point) => transformedPoint(state.transform, point.x, point.y));
  for (let index = 0; index < transformed.length; index += 1) {
    const next = transformed[(index + 1) % transformed.length];
    if (!isAxisVector(next.x - transformed[index].x, next.y - transformed[index].y)) return undefined;
  }
  const rect = rectFromPoints(transformed);
  if (rect.width <= GEOMETRY_EPSILON || rect.height <= GEOMETRY_EPSILON) return undefined;
  const corners = new Set(transformed.map((point) => {
    const horizontal = Math.abs(point.x - rect.x) <= GEOMETRY_EPSILON ? 0 : Math.abs(point.x - rect.x - rect.width) <= GEOMETRY_EPSILON ? 1 : -1;
    const vertical = Math.abs(point.y - rect.y) <= GEOMETRY_EPSILON ? 0 : Math.abs(point.y - rect.y - rect.height) <= GEOMETRY_EPSILON ? 1 : -1;
    return `${horizontal}:${vertical}`;
  }));
  return corners.size === 4 && ![...corners].some((corner) => corner.includes("-1")) ? rect : undefined;
}

function intersectRects(left: Rect, right: Rect): Rect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return undefined;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function applyPendingClip(args: unknown[] | null | undefined, state: PaintExtractionState): void {
  if (!state.pendingClip) return;
  state.pendingClip = false;
  const clipRect = parseOpaqueFillRect(args, state);
  if (!clipRect || !state.clipGeometrySafe) {
    state.clipGeometrySafe = false;
    delete state.clipBounds;
    return;
  }
  state.clipBounds = state.clipBounds ? intersectRects(state.clipBounds, clipRect) : clipRect;
}

function applySafeClip(rects: Rect[], state: PaintExtractionState): Rect[] {
  if (!state.clipGeometrySafe || !state.clipBounds) return rects;
  return rects.flatMap((rect) => {
    const clipped = intersectRects(rect, state.clipBounds!);
    return clipped ? [clipped] : [];
  });
}

function pathPaintComponents(pdfjs: PdfJsModule, operation: number): { fills: boolean; strokes: boolean } {
  const strokes = operation === pdfjs.OPS.stroke
    || operation === pdfjs.OPS.closeStroke
    || operation === pdfjs.OPS.fillStroke
    || operation === pdfjs.OPS.eoFillStroke
    || operation === pdfjs.OPS.closeFillStroke
    || operation === pdfjs.OPS.closeEOFillStroke;
  const fills = operation === pdfjs.OPS.fill
    || operation === pdfjs.OPS.eoFill
    || operation === pdfjs.OPS.fillStroke
    || operation === pdfjs.OPS.eoFillStroke
    || operation === pdfjs.OPS.closeFillStroke
    || operation === pdfjs.OPS.closeEOFillStroke;
  return { fills, strokes };
}

function isFillColorOperation(pdfjs: PdfJsModule, operation: number): boolean {
  return operation === pdfjs.OPS.setFillColor
    || operation === pdfjs.OPS.setFillColorN
    || operation === pdfjs.OPS.setFillGray
    || operation === pdfjs.OPS.setFillRGBColor
    || operation === pdfjs.OPS.setFillCMYKColor;
}

function isStrokeColorOperation(pdfjs: PdfJsModule, operation: number): boolean {
  return operation === pdfjs.OPS.setStrokeColor
    || operation === pdfjs.OPS.setStrokeColorN
    || operation === pdfjs.OPS.setStrokeGray
    || operation === pdfjs.OPS.setStrokeRGBColor
    || operation === pdfjs.OPS.setStrokeCMYKColor;
}

function isSolidFillColorOperation(pdfjs: PdfJsModule, operation: number): boolean {
  return operation === pdfjs.OPS.setFillGray
    || operation === pdfjs.OPS.setFillRGBColor
    || operation === pdfjs.OPS.setFillCMYKColor;
}

function isSolidStrokeColorOperation(pdfjs: PdfJsModule, operation: number): boolean {
  return operation === pdfjs.OPS.setStrokeGray
    || operation === pdfjs.OPS.setStrokeRGBColor
    || operation === pdfjs.OPS.setStrokeCMYKColor;
}

function isFullyOpaque(value: number): boolean {
  return value >= 1 - Number.EPSILON;
}

function dashPatternIsSolid(value: unknown): boolean {
  const pair = Array.isArray(value) ? value : undefined;
  const pattern = pair && pair.length === 2 ? numericArray(pair[0]) : numericArray(value);
  return Boolean(pattern && pattern.length === 0);
}

function blendModeIsSafe(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(blendModeIsSafe);
  return value === "Normal" || value === "Compatible" || value === "source-over";
}

function softMaskIsSafe(value: unknown): boolean {
  return value === false || value === null || value === "None";
}

function isImagePaintOperation(pdfjs: PdfJsModule, operation: number): boolean {
  return operation === pdfjs.OPS.paintImageMaskXObject
    || operation === pdfjs.OPS.paintImageMaskXObjectGroup
    || operation === pdfjs.OPS.paintImageXObject
    || operation === pdfjs.OPS.paintInlineImageXObject
    || operation === pdfjs.OPS.paintInlineImageXObjectGroup
    || operation === pdfjs.OPS.paintImageXObjectRepeat
    || operation === pdfjs.OPS.paintImageMaskXObjectRepeat
    || operation === pdfjs.OPS.paintSolidColorImageMask;
}

function isSingleImagePaintOperation(pdfjs: PdfJsModule, operation: number): boolean {
  return operation === pdfjs.OPS.paintImageMaskXObject
    || operation === pdfjs.OPS.paintImageXObject
    || operation === pdfjs.OPS.paintInlineImageXObject
    || operation === pdfjs.OPS.paintSolidColorImageMask;
}

function extractForegroundPaintCandidates(
  pdfjs: PdfJsModule,
  fnArray: number[],
  argsArray: unknown[][],
  viewportTransform: number[],
): ForegroundPaintCandidate[] {
  let state: PaintExtractionState = {
    transform: [...viewportTransform],
    transformReliable: viewportTransform.length >= 6 && viewportTransform.slice(0, 6).every(Number.isFinite),
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    fillVisible: true,
    strokeVisible: true,
    fillAlpha: 1,
    strokeAlpha: 1,
    fillSolidColor: true,
    strokeSolidColor: true,
    dashSolid: true,
    clipGeometrySafe: true,
    pendingClip: false,
    blendModeSafe: true,
    softMaskSafe: true,
  };
  const stack: PaintExtractionState[] = [];
  const pushState = () => stack.push(clonePaintExtractionState(state));
  const popState = () => { state = stack.pop() ?? state; };
  const candidates: ForegroundPaintCandidate[] = [];

  for (let index = 0; index < fnArray.length; index += 1) {
    const operation = fnArray[index];
    const args = argsArray[index];
    if (operation === pdfjs.OPS.save) pushState();
    else if (operation === pdfjs.OPS.restore) popState();
    else if (operation === pdfjs.OPS.paintFormXObjectBegin) {
      pushState();
      const matrix = numericArray(args?.[0]);
      if (matrix?.length === 6 && state.transformReliable) state.transform = multiplyTransforms(state.transform, matrix);
      else if (args?.[0] != null) state.transformReliable = false;
      // Form BBoxes are clipping paths. Without the exact clip geometry, a
      // child paint bbox is only suitable as a guard, never an opaque clip.
      if (args?.[1] != null) state.clipGeometrySafe = false;
    } else if (operation === pdfjs.OPS.paintFormXObjectEnd) popState();
    else if (operation === pdfjs.OPS.beginGroup || operation === pdfjs.OPS.beginAnnotation) {
      pushState();
      // Isolated groups and annotation canvases change their effective base
      // transform in ways not represented by a simple stream CTM. Their paint
      // still uses recorded bounds, but stroke segmentation falls back safely.
      state.transformReliable = false;
      state.clipGeometrySafe = false;
    } else if (operation === pdfjs.OPS.endGroup || operation === pdfjs.OPS.endAnnotation) popState();
    else if (operation === pdfjs.OPS.transform) {
      const matrix = numericArray(args);
      if (matrix?.length === 6 && state.transformReliable) state.transform = multiplyTransforms(state.transform, matrix);
      else state.transformReliable = false;
    } else if (operation === pdfjs.OPS.clip || operation === pdfjs.OPS.eoClip) state.pendingClip = true;
    else if (operation === pdfjs.OPS.setLineWidth && typeof args?.[0] === "number") state.lineWidth = Math.max(0, args[0]);
    else if (operation === pdfjs.OPS.setLineCap && typeof args?.[0] === "number") state.lineCap = args[0];
    else if (operation === pdfjs.OPS.setLineJoin && typeof args?.[0] === "number") state.lineJoin = args[0];
    else if (operation === pdfjs.OPS.setMiterLimit && typeof args?.[0] === "number") state.miterLimit = Math.max(1, args[0]);
    else if (operation === pdfjs.OPS.setDash) state.dashSolid = dashPatternIsSolid(args);
    else if (operation === pdfjs.OPS.setGState) {
      for (const [name, value] of graphicsStatePairs(args)) {
        if (name === "LW" && typeof value === "number") state.lineWidth = Math.max(0, value);
        else if (name === "LC" && typeof value === "number") state.lineCap = value;
        else if (name === "LJ" && typeof value === "number") state.lineJoin = value;
        else if (name === "ML" && typeof value === "number") state.miterLimit = Math.max(1, value);
        else if (name === "D") state.dashSolid = dashPatternIsSolid(value);
        else if (name === "ca" && typeof value === "number") state.fillAlpha = Math.max(0, Math.min(1, value));
        else if (name === "CA" && typeof value === "number") state.strokeAlpha = Math.max(0, Math.min(1, value));
        else if (name === "BM") state.blendModeSafe = blendModeIsSafe(value);
        else if (name === "SMask") state.softMaskSafe = softMaskIsSafe(value);
      }
    } else if (operation === pdfjs.OPS.setFillTransparent) {
      state.fillVisible = false;
      state.fillSolidColor = false;
    } else if (operation === pdfjs.OPS.setStrokeTransparent) {
      state.strokeVisible = false;
      state.strokeSolidColor = false;
    } else if (isFillColorOperation(pdfjs, operation)) {
      state.fillVisible = true;
      state.fillSolidColor = isSolidFillColorOperation(pdfjs, operation);
    } else if (isStrokeColorOperation(pdfjs, operation)) {
      state.strokeVisible = true;
      state.strokeSolidColor = isSolidStrokeColorOperation(pdfjs, operation);
    }
    else if (operation === pdfjs.OPS.constructPath) {
      const paintOperation = args?.[0];
      if (typeof paintOperation !== "number") continue;
      const components = pathPaintComponents(pdfjs, paintOperation);
      const visibleFill = components.fills && state.fillVisible && state.fillAlpha > 0;
      const visibleStroke = components.strokes && state.strokeVisible && state.strokeAlpha > 0;
      if (!visibleFill && !visibleStroke) {
        applyPendingClip(args, state);
        continue;
      }
      const opaqueRects: Rect[] = [];
      let fullyRepresented = true;
      if (visibleFill) {
        const fillRect = state.clipGeometrySafe
          && state.blendModeSafe
          && state.softMaskSafe
          && state.fillSolidColor
          && isFullyOpaque(state.fillAlpha)
          ? parseOpaqueFillRect(args, state)
          : undefined;
        if (fillRect) opaqueRects.push(fillRect);
        else fullyRepresented = false;
      }
      if (visibleStroke) {
        const strokeRects = state.clipGeometrySafe
          && state.blendModeSafe
          && state.softMaskSafe
          && state.strokeSolidColor
          && isFullyOpaque(state.strokeAlpha)
          ? parseOpaqueStrokeRects(args, state)
          : undefined;
        if (strokeRects) opaqueRects.push(...strokeRects);
        else fullyRepresented = false;
      }
      const pathGuard = parsePathGuardRect(args, state);
      const guardRects = pathGuard
        ? applySafeClip([visibleStroke ? expandedStrokeGuard(pathGuard, state) : pathGuard], state)
        : [];
      candidates.push({
        operatorIndex: index,
        opaqueRects: uniqueRects(applySafeClip(opaqueRects, state)),
        guardRects,
        fullyRepresented,
      });
      applyPendingClip(args, state);
    } else {
      const components = pathPaintComponents(pdfjs, operation);
      const visiblePath = (components.fills && state.fillVisible && state.fillAlpha > 0)
        || (components.strokes && state.strokeVisible && state.strokeAlpha > 0);
      const visibleRawFill = operation === pdfjs.OPS.rawFillPath && state.fillVisible && state.fillAlpha > 0;
      const visibleShading = operation === pdfjs.OPS.shadingFill && state.fillVisible && state.fillAlpha > 0;
      const visibleImage = isImagePaintOperation(pdfjs, operation) && (state.fillAlpha > 0 || state.strokeAlpha > 0);
      // Standalone paths no longer expose their numeric geometry after PDF.js
      // builds Path2D; shadings and images may have transparency or padding.
      // Retain them as bounded risks, never as opaque rectangular clips.
      if (visiblePath || visibleRawFill || visibleShading || visibleImage) {
        const imageGuard = visibleImage && isSingleImagePaintOperation(pdfjs, operation)
          ? transformedUnitSquare(state)
          : undefined;
        candidates.push({
          operatorIndex: index,
          opaqueRects: [],
          guardRects: imageGuard ? applySafeClip([imageGuard], state) : [],
          fullyRepresented: false,
        });
      }
    }
  }
  return candidates;
}

function uniqueRects(rects: Rect[]): Rect[] {
  const seen = new Set<string>();
  return rects.filter((rect) => {
    const key = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10_000)).join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceForegroundAnalysis(
  sourceOperatorIndex: number,
  candidates: ForegroundPaintCandidate[],
  sourceBounds: (operatorIndex: number) => Rect | undefined,
  pageWidth?: number,
  pageHeight?: number,
): SourceForegroundAnalysis {
  const occlusions: SourceForegroundOcclusion[] = [];
  const unsafeBounds: Rect[] = [];
  let hasUnboundedRisk = false;
  for (const candidate of candidates) {
    if (candidate.operatorIndex <= sourceOperatorIndex) continue;
    const geometries = uniqueRects(candidate.opaqueRects);
    for (const bbox of geometries) occlusions.push({ operatorIndex: candidate.operatorIndex, bbox });
    if (candidate.fullyRepresented && geometries.length) continue;
    if (candidate.guardRects.length) {
      unsafeBounds.push(...candidate.guardRects);
      continue;
    }
    const recordedBbox = sourceBounds(candidate.operatorIndex);
    const dependencyPropagated = Boolean(
      recordedBbox
      && pageWidth
      && pageHeight
      && recordedBbox.width >= pageWidth * 0.9
      && recordedBbox.height >= pageHeight * 0.5,
    );
    if (recordedBbox && !dependencyPropagated) unsafeBounds.push(recordedBbox);
    else hasUnboundedRisk = true;
  }
  return { occlusions, unsafeBounds: uniqueRects(unsafeBounds), hasUnboundedRisk };
}

function sourceForegroundOcclusions(
  sourceOperatorIndex: number,
  candidates: ForegroundPaintCandidate[],
  sourceBounds: (operatorIndex: number) => Rect | undefined,
): SourceForegroundOcclusion[] {
  return sourceForegroundAnalysis(sourceOperatorIndex, candidates, sourceBounds).occlusions;
}

function nativeSourceSafety(mappingVerified: boolean, foreground?: SourceForegroundAnalysis): {
  sourceMappingVerified: boolean;
  sourceEditSafety: NonNullable<TextBlock["sourceEditSafety"]>;
  editable: boolean;
  confidence: number;
} {
  if (!mappingVerified) {
    return { sourceMappingVerified: false, sourceEditSafety: "unmapped", editable: false, confidence: 0.86 };
  }
  if (foreground?.hasUnboundedRisk) {
    return { sourceMappingVerified: true, sourceEditSafety: "unbounded-risk", editable: false, confidence: 1 };
  }
  if (foreground?.unsafeBounds.length) {
    return { sourceMappingVerified: true, sourceEditSafety: "bounded-risk", editable: true, confidence: 1 };
  }
  return { sourceMappingVerified: true, sourceEditSafety: "safe", editable: true, confidence: 1 };
}

function sourceBoundsAreCompatible(target: TextAppearanceTarget, sourceBbox: Rect, pageWidth: number, pageHeight: number): boolean {
  const values = [
    target.bbox.x,
    target.bbox.y,
    target.bbox.width,
    target.bbox.height,
    sourceBbox.x,
    sourceBbox.y,
    sourceBbox.width,
    sourceBbox.height,
    pageWidth,
    pageHeight,
  ];
  if (!values.every(Number.isFinite) || target.bbox.width <= 0 || target.bbox.height <= 0 || sourceBbox.width <= 0 || sourceBbox.height <= 0 || pageWidth <= 0 || pageHeight <= 0) return false;

  const pageTolerance = Math.max(2, target.fontSize);
  if (
    sourceBbox.x < -pageTolerance
    || sourceBbox.y < -pageTolerance
    || sourceBbox.x + sourceBbox.width > pageWidth + pageTolerance
    || sourceBbox.y + sourceBbox.height > pageHeight + pageTolerance
  ) return false;

  const widthRatio = sourceBbox.width / target.bbox.width;
  const heightRatio = sourceBbox.height / target.bbox.height;
  if (widthRatio < 0.2 || widthRatio > 5 || heightRatio < 0.2 || heightRatio > 5) return false;

  const overlap = intersectionArea(target.bbox, sourceBbox);
  const smallerArea = Math.min(rectArea(target.bbox), rectArea(sourceBbox));
  if (smallerArea <= 0 || overlap / smallerArea < 0.2) return false;

  const targetCenterX = target.bbox.x + target.bbox.width / 2;
  const targetCenterY = target.bbox.y + target.bbox.height / 2;
  const sourceCenterX = sourceBbox.x + sourceBbox.width / 2;
  const sourceCenterY = sourceBbox.y + sourceBbox.height / 2;
  const horizontalTolerance = Math.max(target.fontSize, Math.max(target.bbox.width, sourceBbox.width) * 0.25);
  const verticalTolerance = Math.max(target.fontSize, Math.max(target.bbox.height, sourceBbox.height) * 0.75);
  return Math.abs(targetCenterX - sourceCenterX) <= horizontalTolerance
    && Math.abs(targetCenterY - sourceCenterY) <= verticalTolerance;
}

function sourceBoundsAreDependencyPropagated(target: TextAppearanceTarget, sourceBbox: Rect, pageWidth: number, pageHeight: number): boolean {
  if (pageWidth <= 0 || pageHeight <= 0) return false;
  // PDF.js deliberately propagates a full-page fallback bbox when it cannot
  // trust a font's glyph bounds. Treat only that unmistakable case as unusable;
  // an ordinary wrong-location bbox must never gain a semantic fallback.
  return sourceBbox.width >= pageWidth * 0.9
    && sourceBbox.height >= pageHeight * 0.5
    && rectArea(sourceBbox) >= rectArea(target.bbox) * 25;
}

function matchTextAppearances(
  targets: TextAppearanceTarget[],
  appearances: TextPaintAppearance[],
  sourceBounds: (operatorIndex: number) => Rect | undefined,
  pageWidth: number,
  pageHeight: number,
): Array<MatchedTextPaintAppearance | undefined> {
  let lastOperatorIndex = -1;
  return targets.map((target) => {
    const wanted = normalizedText(target.text);
    if (!wanted || !target.fontName) return undefined;
    const exactCandidates: MatchedTextPaintAppearance[] = [];
    const normalizedCandidates: MatchedTextPaintAppearance[] = [];
    for (let start = 0; start < appearances.length; start += 1) {
      const first = appearances[start] as InternalTextPaintAppearance;
      if (first.operatorIndex <= lastOperatorIndex || first.fontName !== target.fontName) continue;
      const runId = first[textAppearanceRunId];
      const operatorIndices: number[] = [];
      const bounds: Rect[] = [];
      let text = "";
      for (let end = start; end < appearances.length; end += 1) {
        const appearance = appearances[end] as InternalTextPaintAppearance;
        if (
          appearance.operatorIndex <= lastOperatorIndex
          || appearance.fontName !== target.fontName
          || (end > start && (runId === undefined || appearance[textAppearanceRunId] !== runId))
          || (operatorIndices.length > 0 && appearance.operatorIndex <= operatorIndices.at(-1)!)
        ) break;
        text += appearance.text;
        operatorIndices.push(appearance.operatorIndex);
        const sourceBbox = sourceBounds(appearance.operatorIndex);
        if (sourceBbox) bounds.push(sourceBbox);
        else if (normalizedText(appearance.text)) break;
        if (normalizedText(text) !== wanted) continue;
        const combinedBounds = unionRects(bounds);
        const exactText = text.normalize("NFC") === target.text.normalize("NFC");
        const recordedBoundsMatch = Boolean(combinedBounds && sourceBoundsAreCompatible(target, combinedBounds, pageWidth, pageHeight));
        const exactGlyphRunFallback = exactText
          && runId !== undefined
          && operatorIndices.length > 1
          && Boolean(combinedBounds && sourceBoundsAreDependencyPropagated(target, combinedBounds, pageWidth, pageHeight));
        if (!recordedBoundsMatch && !exactGlyphRunFallback) continue;
        const candidate: MatchedTextPaintAppearance = {
          ...first,
          operatorIndex: appearance.operatorIndex,
          operatorIndices: [...operatorIndices],
          text,
          sourceBbox: recordedBoundsMatch ? combinedBounds! : { ...target.bbox },
          mappingMethod: recordedBoundsMatch ? "recorded-bounds" : "exact-glyph-run",
        };
        if (exactText) exactCandidates.push(candidate);
        else normalizedCandidates.push(candidate);
      }
    }
    const candidates = exactCandidates.length ? exactCandidates : normalizedCandidates;
    // Repeated identical paint operations can overlap (shadow/faux-bold text).
    // Unless geometry makes one candidate unique, assigning either operation
    // would make source removal unsafe.
    if (candidates.length !== 1) return undefined;
    lastOperatorIndex = candidates[0].operatorIndex;
    return candidates[0];
  });
}

function inferNativeTextAlignment(bbox: Rect, pageWidth: number, rotation: number, fontSize: number): TextBlock["style"]["align"] {
  const normalizedRotation = Math.abs(((rotation % 180) + 180) % 180);
  const horizontalRotation = Math.min(normalizedRotation, 180 - normalizedRotation);
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || horizontalRotation > 1.5 || bbox.width <= 0 || bbox.width >= pageWidth * 0.95) return "left";
  const centerOffset = Math.abs(bbox.x + bbox.width / 2 - pageWidth / 2);
  const tolerance = Math.max(1, Math.min(4, fontSize * 0.25));
  return centerOffset <= tolerance ? "center" : "left";
}

function humanReadableSourceFontName(font: NativeFont | undefined): string | undefined {
  for (const candidate of [font?.name, font?.loadedName, font?.fallbackName]) {
    if (!candidate) continue;
    const withoutSubset = candidate.trim().replace(/^[A-Z]{6}\+/u, "");
    if (!withoutSubset || /^(?:g_d\d+_f\d+|font\d+|f\d+|sans-serif|serif|monospace)$/iu.test(withoutSubset)) continue;
    const readable = withoutSubset
      .replace(/(?:PS)?MT$/iu, "")
      .replace(/[-_]+/gu, " ")
      .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
      .replace(/\s+/gu, " ")
      .trim();
    if (readable) return readable;
  }
  return undefined;
}

function sourceFontWeight(font: NativeFont | undefined): number {
  const name = [font?.name, font?.loadedName, font?.fallbackName].filter(Boolean).join(" ");
  if (font?.black || /black|heavy/iu.test(name)) return 900;
  if (/extra[-_ ]?bold|ultra[-_ ]?bold/iu.test(name)) return 800;
  if (/semi[-_ ]?bold|demi/iu.test(name)) return 600;
  if (font?.bold || /bold/iu.test(name)) return 700;
  if (/medium/iu.test(name)) return 500;
  if (/light/iu.test(name)) return 300;
  if (/thin|hairline/iu.test(name)) return 100;
  return 400;
}

/** Pure matching helpers exposed for focused regression tests. */
export const pdfCoreTesting = {
  extractTextPaintAppearances,
  matchTextAppearances,
  inferNativeTextAlignment,
  humanReadableSourceFontName,
  sourceFontWeight,
  extractForegroundPaintCandidates,
  sourceForegroundAnalysis,
  sourceForegroundOcclusions,
  nativeSourceSafety,
  renderedTextColor,
};

function nativeTextToBlock(
  pageId: string,
  item: NativeTextItem,
  sourceStyle: NativeTextStyle | undefined,
  viewportTransform: number[],
  pageWidth: number,
  zIndex: number,
): TextBlock {
  const transformed = multiplyTransforms(viewportTransform, item.transform);
  let rotation = Math.atan2(transformed[1] ?? 0, transformed[0] ?? 1);
  if (sourceStyle?.vertical) rotation += Math.PI / 2;
  const fontSize = Math.max(0.1, Math.hypot(transformed[2] ?? 0, transformed[3] ?? 0) || item.height || 12);
  const ascent = Number.isFinite(sourceStyle?.ascent) ? sourceStyle!.ascent : 0.8;
  const descent = Number.isFinite(sourceStyle?.descent) ? sourceStyle!.descent : -0.2;
  const fontAscent = fontSize * ascent;
  const left = rotation === 0 ? transformed[4] : transformed[4] + fontAscent * Math.sin(rotation);
  const top = rotation === 0 ? transformed[5] - fontAscent : transformed[5] - fontAscent * Math.cos(rotation);
  const value = item.str;
  const bbox = {
    x: left,
    y: top,
    width: Math.max(2, item.width || value.length * fontSize * 0.5),
    height: Math.max(0.5, fontSize * Math.max(0.1, ascent - descent)),
  };
  const style = {
    ...defaultTextStyle,
    fontFamily: cssFontFamily(sourceStyle?.fontFamily || item.fontName || defaultTextStyle.fontFamily),
    fontSize,
    lineHeight: 1,
    color: "#000000",
    align: inferNativeTextAlignment(bbox, pageWidth, rotation * (180 / Math.PI), fontSize),
  };
  const textMeta = detectTextMeta(value);
  const direction = item.dir === "rtl" || item.dir === "ltr" ? item.dir : textMeta.direction;
  return {
    id: stableId("native-text"),
    type: "text",
    pageId,
    bbox,
    originalBbox: { ...bbox },
    rotation: rotation * (180 / Math.PI),
    originalRotation: rotation * (180 / Math.PI),
    transform: matrixFrom(transformed),
    confidence: 1,
    source: "native-pdf",
    zIndex,
    relationships: [],
    language: textMeta.language,
    direction,
    originalDirection: direction,
    fontAscent: ascent,
    fontDescent: descent,
    text: value,
    originalText: value,
    sourceMappingVerified: false,
    sourceEditSafety: "unmapped",
    style,
    originalStyle: { ...style },
    overflow: "warn",
    editable: false,
  };
}

function annotationToField(pageId: string, annotation: NativeAnnotation, pageHeight: number, zIndex: number): FormFieldObject | null {
  if (!annotation.fieldType) return null;
  const [left, bottom, right, top] = annotation.rect;
  const fieldType = annotation.fieldType === "Btn" ? "checkbox" : annotation.fieldType === "Ch" ? "dropdown" : "text";
  return {
    id: `field-${annotation.id}`,
    type: "form-field",
    pageId,
    bbox: { x: left, y: pageHeight - top, width: right - left, height: top - bottom },
    rotation: 0,
    transform: identityMatrix,
    confidence: 1,
    source: "native-pdf",
    zIndex,
    language: "und",
    direction: "auto",
    relationships: [],
    fieldType,
    name: annotation.fieldName ?? annotation.id,
    value: annotation.fieldValue ?? "",
  };
}

async function renderPageCanvas(page: PdfPageProxy, scale: number, options: { recordOperations?: boolean; operationsFilter?: (index: number) => boolean } = {}): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
  await page.render({ canvas, canvasContext: context, viewport, ...options }).promise;
  return canvas;
}

function canvasPng(canvas: HTMLCanvasElement): string {
  // Keep the original page and committed canvas text at the same quality.
  // JPEG artifacts made replacement text look different from the source page.
  return canvas.toDataURL("image/png");
}

function rotatedRectBounds(bounds: Rect, rotation: number): Rect {
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

/**
 * PDF.js text items do not expose fill color. When an operator cannot be
 * matched safely, compare the normal and text-free renders and recover the
 * dominant visible ink color from their highest-contrast pixels.
 */
function renderedTextColor(
  previewCanvas: HTMLCanvasElement,
  cleanCanvas: HTMLCanvasElement,
  block: TextBlock,
  pageWidth: number,
  pageHeight: number,
): string | undefined {
  const preview = previewCanvas.getContext("2d");
  const clean = cleanCanvas.getContext("2d");
  if (!preview || !clean || pageWidth <= 0 || pageHeight <= 0) return undefined;
  const scaleX = previewCanvas.width / pageWidth;
  const scaleY = previewCanvas.height / pageHeight;
  const bounds = rotatedRectBounds(block.originalBbox ?? block.bbox, block.originalRotation ?? block.rotation);
  const left = Math.max(0, Math.floor(bounds.x * scaleX) - 1);
  const top = Math.max(0, Math.floor(bounds.y * scaleY) - 1);
  const right = Math.min(previewCanvas.width, Math.ceil((bounds.x + bounds.width) * scaleX) + 1);
  const bottom = Math.min(previewCanvas.height, Math.ceil((bounds.y + bounds.height) * scaleY) + 1);
  if (right <= left || bottom <= top) return undefined;

  let source: ImageData;
  let background: ImageData;
  try {
    source = preview.getImageData(left, top, right - left, bottom - top);
    background = clean.getImageData(left, top, right - left, bottom - top);
  } catch {
    return undefined;
  }
  const clusters = new Map<string, { score: number; red: number; green: number; blue: number; count: number }>();
  for (let index = 0; index < source.data.length; index += 4) {
    const red = source.data[index];
    const green = source.data[index + 1];
    const blue = source.data[index + 2];
    const redDelta = red - background.data[index];
    const greenDelta = green - background.data[index + 1];
    const blueDelta = blue - background.data[index + 2];
    const contrast = redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
    if (contrast < 18 * 18) continue;
    const key = `${Math.floor(red / 32)}:${Math.floor(green / 32)}:${Math.floor(blue / 32)}`;
    const cluster = clusters.get(key) ?? { score: 0, red: 0, green: 0, blue: 0, count: 0 };
    cluster.score += contrast;
    cluster.red += red * contrast;
    cluster.green += green * contrast;
    cluster.blue += blue * contrast;
    cluster.count += 1;
    clusters.set(key, cluster);
  }
  const strongest = [...clusters.values()].filter((cluster) => cluster.count >= 2).sort((left, right) => right.score - left.score)[0];
  if (!strongest || strongest.score <= 0) return undefined;
  return `#${[strongest.red, strongest.green, strongest.blue]
    .map((total) => Math.round(total / strongest.score).toString(16).padStart(2, "0"))
    .join("")}`;
}

function recordedSourceBounds(page: PdfPageProxy, operatorIndex: number | undefined, pageWidth: number, pageHeight: number): TextBlock["sourceBbox"] {
  if (operatorIndex === undefined) return undefined;
  const recorded = (page as PdfPageProxy & { recordedBBoxes?: RecordedOperationBounds }).recordedBBoxes;
  if (!recorded || recorded.isEmpty(operatorIndex)) return undefined;
  // PDF.js records operation bounds as normalized page fractions, independent
  // of the preview raster scale.
  const left = recorded.minX(operatorIndex) * pageWidth;
  const top = recorded.minY(operatorIndex) * pageHeight;
  const right = recorded.maxX(operatorIndex) * pageWidth;
  const bottom = recorded.maxY(operatorIndex) * pageHeight;
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function refineNativeTextBlocks(
  page: PdfPageProxy,
  canvas: HTMLCanvasElement,
  pageHeight: number,
  items: NativeTextItem[],
  blocks: TextBlock[],
  appearances: TextPaintAppearance[],
  foregroundPaintCandidates: ForegroundPaintCandidate[],
): Promise<void> {
  const context = canvas.getContext("2d");
  const pixelScale = canvas.height / pageHeight;
  const pageWidth = canvas.width / pixelScale;
  const matches = matchTextAppearances(
    blocks.map((block, index) => ({
      text: block.text,
      fontName: items[index].fontName,
      bbox: block.bbox,
      fontSize: block.style.fontSize,
    })),
    appearances,
    (operatorIndex) => recordedSourceBounds(page, operatorIndex, pageWidth, pageHeight),
    pageWidth,
    pageHeight,
  );
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const item = items[index];
    const appearance = matches[index];
    const font = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) as NativeFont : undefined;
    const family = font?.loadedName || font?.fallbackName;
    const weight = sourceFontWeight(font);
    const fontStyle = font?.italic || /italic|oblique/i.test(font?.name ?? "") ? "italic" as const : "normal" as const;
    block.fontAscent = Number.isFinite(font?.ascent) ? font!.ascent : block.fontAscent;
    block.fontDescent = Number.isFinite(font?.descent) ? font!.descent : block.fontDescent;
    block.sourceFontName = humanReadableSourceFontName(font);
    block.style = {
      ...block.style,
      ...(family ? { fontFamily: cssFontFamily(family) } : {}),
      fontWeight: weight,
      fontStyle,
      ...(appearance?.color ? { color: appearance.color } : {}),
    };
    if (typeof document !== "undefined" && document.fonts) {
      await document.fonts.load(`${block.style.fontStyle} ${block.style.fontWeight} ${block.style.fontSize}px ${block.style.fontFamily}`, block.text).catch(() => []);
    }
    if (context && Array.from(block.text).length > 1) {
      context.font = `${block.style.fontStyle} ${block.style.fontWeight} ${block.style.fontSize * pixelScale}px ${block.style.fontFamily}`;
      const verticalScale = Math.max(0.001, Math.hypot(block.transform.c, block.transform.d));
      const horizontalScale = Math.max(0.001, Math.hypot(block.transform.a, block.transform.b));
      const ratio = horizontalScale / verticalScale;
      const measuredWidth = context.measureText(block.text).width / pixelScale * ratio;
      const inferredSpacing = (item.width - measuredWidth) / (Array.from(block.text).length - 1) / ratio;
      if (Number.isFinite(inferredSpacing)) block.style.letterSpacing = Math.max(-block.style.fontSize / 2, Math.min(block.style.fontSize * 2, Math.abs(inferredSpacing) < 0.01 ? 0 : inferredSpacing));
    }
    delete block.sourceBbox;
    delete block.sourceOperatorIndex;
    delete block.sourceOperatorIndices;
    delete block.sourceMappingMethod;
    delete block.sourceForegroundOcclusions;
    delete block.sourceUnsafeForegroundBounds;
    let foreground: SourceForegroundAnalysis | undefined;
    if (appearance) {
      block.sourceBbox = appearance.sourceBbox;
      block.sourceOperatorIndex = appearance.operatorIndex;
      block.sourceOperatorIndices = [...appearance.operatorIndices];
      block.sourceMappingMethod = appearance.mappingMethod;
      foreground = sourceForegroundAnalysis(
        appearance.operatorIndex,
        foregroundPaintCandidates,
        (operatorIndex) => recordedSourceBounds(page, operatorIndex, pageWidth, pageHeight),
        pageWidth,
        pageHeight,
      );
      if (foreground.occlusions.length) block.sourceForegroundOcclusions = foreground.occlusions;
      if (foreground.unsafeBounds.length) {
        block.sourceUnsafeForegroundBounds = foreground.unsafeBounds;
      }
    }
    Object.assign(block, nativeSourceSafety(Boolean(appearance), foreground));
    block.originalStyle = { ...block.style };
  }
}

export interface PdfLoadProgress {
  phase: "opening" | "extracting" | "recognizing" | "rendering" | "ready";
  completed: number;
  total: number;
}

export async function importPdf(file: File, onProgress?: (progress: PdfLoadProgress) => void): Promise<{ document: EditableDocument; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await getPdfJs();
  onProgress?.({ phase: "opening", completed: 0, total: 1 });
  const loadingTask = pdfjs.getDocument({ data: bytes, disableAutoFetch: true, useWorkerFetch: false });
  const pdf = await loadingTask.promise;
  const metadata = await pdf.getMetadata().catch(() => null);
  const pages: DocumentPage[] = [];
  let localOcr: LocalOcrSession | null = null;

  try {
  for (let index = 1; index <= pdf.numPages; index += 1) {
    onProgress?.({ phase: "extracting", completed: index - 1, total: pdf.numPages });
    const sourcePage = await pdf.getPage(index);
    const viewport = sourcePage.getViewport({ scale: 1 });
    const pageId = stableId("page");
    const textContent = await sourcePage.getTextContent({ includeMarkedContent: true });
    const nativeItems = textContent.items.filter(
      (item): item is NativeTextItem => "str" in item && typeof item.str === "string" && item.str.trim().length > 0,
    );
    const operatorList = await sourcePage.getOperatorList().catch(() => null);
    const operators = operatorList?.fnArray ?? [];
    const operatorArgs = (operatorList?.argsArray ?? []) as unknown as unknown[][];
    const appearances = extractTextPaintAppearances(pdfjs, operators, operatorArgs);
    // Path data is replaced with Path2D objects during rendering, so capture
    // stroke segments and their CTM before requesting recorded operation bounds.
    const foregroundPaintCandidates = extractForegroundPaintCandidates(pdfjs, operators, operatorArgs, viewport.transform);
    const nativeBlocks = nativeItems.map((item, itemIndex) => nativeTextToBlock(
      pageId,
      item,
      textContent.styles[item.fontName] as NativeTextStyle | undefined,
      viewport.transform,
      viewport.width,
      itemIndex + 1,
    ));
    const imageCount = operators.filter(
      (operation) => operation === pdfjs.OPS.paintImageXObject
        || operation === pdfjs.OPS.paintInlineImageXObject
        || operation === pdfjs.OPS.paintInlineImageXObjectGroup
        || operation === pdfjs.OPS.paintImageXObjectRepeat,
    ).length;
    const annotations = (await sourcePage.getAnnotations().catch(() => [])) as unknown as NativeAnnotation[];
    const fields = annotations
      .map((annotation, fieldIndex) => annotationToField(pageId, annotation, viewport.height, nativeBlocks.length + fieldIndex + 1))
      .filter((field): field is FormFieldObject => field !== null);
    const sourceKind = detectScannedPage(nativeBlocks.length, imageCount);
    let ocrBlocks: TextBlock[] = [];
    if (sourceKind === "scan") {
      onProgress?.({ phase: "recognizing", completed: index - 1, total: pdf.numPages });
      try {
        localOcr ??= await createHighResolutionOcrSession();
        const ocrCanvas = await renderPageCanvas(sourcePage, OCR_RENDER_SCALE);
        const tokens = await localOcr.recognize(ocrCanvas, viewport);
        ocrBlocks = tokens.map((token) => textFromOcrToken(pageId, token));
      } catch {
        // A local model failure must not prevent a document from opening. The
        // empty scan remains explicitly marked for manual OCR review.
        ocrBlocks = [];
      }
      onProgress?.({ phase: "recognizing", completed: index, total: pdf.numPages });
    }
    onProgress?.({ phase: "rendering", completed: index - 1, total: pdf.numPages });
    const previewCanvas = await renderPageCanvas(sourcePage, PREVIEW_RENDER_SCALE, { recordOperations: true });
    await refineNativeTextBlocks(sourcePage, previewCanvas, viewport.height, nativeItems, nativeBlocks, appearances, foregroundPaintCandidates);
    const textOperations = textPaintOperationSet(pdfjs);
    const cleanCanvas = nativeBlocks.length
      ? await renderPageCanvas(sourcePage, PREVIEW_RENDER_SCALE, { operationsFilter: (operatorIndex) => !textOperations.has(operators[operatorIndex]) })
      : null;
    if (cleanCanvas) {
      for (const block of nativeBlocks) {
        if (block.sourceOperatorIndex !== undefined) continue;
        const color = renderedTextColor(previewCanvas, cleanCanvas, block, viewport.width, viewport.height);
        if (!color) continue;
        block.style = { ...block.style, color };
        block.originalStyle = { ...block.style };
      }
    }
    const objects = inferReadingOrder([...nativeBlocks, ...ocrBlocks]);
    const hasUncertainNativeText = nativeBlocks.some((block) => !block.sourceMappingVerified);
    pages.push({
      id: pageId,
      number: index,
      width: viewport.width,
      height: viewport.height,
      rotation: sourcePage.rotate,
      background: canvasPng(previewCanvas),
      ...(cleanCanvas ? { cleanBackground: canvasPng(cleanCanvas) } : {}),
      sourceKind,
      objects: [...objects, ...fields],
      nativeTextCount: nativeBlocks.length,
      imageCount,
      analysisStatus: hasUncertainNativeText || (!nativeBlocks.length && !ocrBlocks.length) ? "needs-review" : "ready",
    });
    onProgress?.({ phase: "rendering", completed: index, total: pdf.numPages });
  }

  const info = metadata?.info as { Title?: string; Author?: string } | undefined;
  onProgress?.({ phase: "ready", completed: pdf.numPages, total: pdf.numPages });
  return {
    bytes,
    document: {
      id: stableId("document"),
      metadata: {
        filename: file.name,
        title: info?.Title,
        author: info?.Author,
        pageCount: pdf.numPages,
        createdAt: new Date().toISOString(),
        processingMode: "browser",
      },
      pages,
      operations: [],
    },
  };
  } finally {
    await localOcr?.terminate();
  }
}

/** Native image objects stay opaque until an extraction provider resolves their original stream. */
export function createImageObject(pageId: string, bbox: { x: number; y: number; width: number; height: number }): ImageObject {
  return {
    id: stableId("image"),
    type: "image",
    pageId,
    bbox,
    rotation: 0,
    transform: identityMatrix,
    confidence: 0.5,
    source: "inferred",
    zIndex: 1,
    language: "und",
    direction: "auto",
    relationships: [],
    imageKind: "unknown",
    originalAssetAvailable: false,
    opacity: 1,
  };
}
