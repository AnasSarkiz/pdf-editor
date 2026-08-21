import type { Rect, TextBlock, TextStyle } from "./document-model";

type CanvasWithTextSpacing = CanvasRenderingContext2D & {
  letterSpacing?: string;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sourceBounds(block: TextBlock): Rect {
  return block.sourceBbox ?? block.originalBbox ?? block.bbox;
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

export function textSourcePaintBounds(block: TextBlock): Rect {
  const bounds = sourceBounds(block);
  return block.sourceBbox
    ? bounds
    : rotatedBounds(bounds, block.originalRotation ?? block.rotation);
}

export function textCurrentPaintBounds(block: TextBlock): Rect {
  return rotatedBounds(block.bbox, block.rotation);
}

function inflatedBounds(bounds: Rect, amount = 1.5): Rect {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

function boundsOverlap(left: Rect, right: Rect): boolean {
  return left.x <= right.x + right.width
    && right.x <= left.x + left.width
    && left.y <= right.y + right.height
    && right.y <= left.y + left.height;
}

function intersectBounds(left: Rect, right: Rect): Rect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge > x && bottomEdge > y
    ? { x, y, width: rightEdge - x, height: bottomEdge - y }
    : null;
}

/** Converts overlapping rectangles into an exact, non-overlapping union. */
function disjointOcclusionBounds(bounds: Rect[]): Rect[] {
  const valid = bounds.filter((candidate) =>
    [candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)
    && candidate.width > 0
    && candidate.height > 0,
  );
  const xEdges = [...new Set(valid.flatMap((bounds) => [bounds.x, bounds.x + bounds.width]))].sort((left, right) => left - right);
  const output: Rect[] = [];
  for (let edgeIndex = 0; edgeIndex < xEdges.length - 1; edgeIndex += 1) {
    const left = xEdges[edgeIndex];
    const right = xEdges[edgeIndex + 1];
    if (right <= left) continue;
    const intervals = valid
      .filter((bounds) => bounds.x < right && bounds.x + bounds.width > left)
      .map((bounds) => [bounds.y, bounds.y + bounds.height] as const)
      .sort((first, second) => first[0] - second[0]);
    let active: [number, number] | null = null;
    for (const interval of intervals) {
      if (!active) active = [interval[0], interval[1]];
      else if (interval[0] <= active[1]) active[1] = Math.max(active[1], interval[1]);
      else {
        output.push({ x: left, y: active[0], width: right - left, height: active[1] - active[0] });
        active = [interval[0], interval[1]];
      }
    }
    if (active) output.push({ x: left, y: active[0], width: right - left, height: active[1] - active[0] });
  }
  return output;
}

/**
 * Reconstructed native text must keep its original position in the PDF paint
 * order. Clip it behind non-text operations that originally followed it.
 */
function clipSourceForeground(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  scaleX: number,
  scaleY: number,
): void {
  if (block.source !== "native-pdf" || !block.sourceForegroundOcclusions?.length) return;
  const currentBounds = inflatedBounds(textCurrentPaintBounds(block), 1);
  const occlusions = disjointOcclusionBounds(
    block.sourceForegroundOcclusions
      .map((occlusion) => occlusion.bbox)
      .flatMap((bounds) => {
        const intersection = intersectBounds(currentBounds, bounds);
        return intersection ? [intersection] : [];
      }),
  );
  if (!occlusions.length) return;
  context.beginPath();
  context.rect(0, 0, context.canvas.width, context.canvas.height);
  for (const bounds of occlusions) {
    const left = clamp(bounds.x * scaleX, 0, context.canvas.width);
    const top = clamp(bounds.y * scaleY, 0, context.canvas.height);
    const right = clamp((bounds.x + bounds.width) * scaleX, left, context.canvas.width);
    const bottom = clamp((bounds.y + bounds.height) * scaleY, top, context.canvas.height);
    if (right > left && bottom > top) context.rect(left, top, right - left, bottom - top);
  }
  context.clip("evenodd");
}

export interface NativeTextRestorationPlan {
  /** Source regions that must be copied from the text-free page render. */
  restore: TextBlock[];
  /** Surviving native runs erased by those regions and therefore repainted. */
  repaint: TextBlock[];
}

/**
 * A text-free source patch also erases any other native run crossing it. Walk
 * the complete overlap-connected component so every erased survivor is
 * restored and then repainted in source z order by the caller.
 */
export function getNativeTextRestorationPlan(
  survivingBlocks: TextBlock[],
  targetBlocks: TextBlock[],
): NativeTextRestorationPlan {
  const surviving = survivingBlocks.filter((block) => block.source === "native-pdf");
  const targets = [...new Map(
    targetBlocks
      .filter((block) => block.source === "native-pdf")
      .map((block) => [block.id, block]),
  ).values()];
  if (!targets.length) return { restore: [], repaint: [] };

  const connected = new Map(targets.map((block) => [block.id, block]));
  let foundNeighbor = true;
  while (foundNeighbor) {
    foundNeighbor = false;
    const connectedBounds = [...connected.values()].flatMap((block) => [
      inflatedBounds(textSourcePaintBounds(block)),
      inflatedBounds(textCurrentPaintBounds(block)),
    ]);
    for (const candidate of surviving) {
      if (connected.has(candidate.id)) continue;
      const candidateBounds = [
        inflatedBounds(textSourcePaintBounds(candidate)),
        inflatedBounds(textCurrentPaintBounds(candidate)),
      ];
      if (!connectedBounds.some((bounds) => candidateBounds.some((candidateBound) => boundsOverlap(bounds, candidateBound)))) continue;
      connected.set(candidate.id, candidate);
      foundNeighbor = true;
    }
  }

  const survivingById = new Map(surviving.map((block) => [block.id, block]));
  const repaint = [...connected.keys()]
    .map((id) => survivingById.get(id))
    .filter((block): block is TextBlock => block !== undefined);
  return { restore: [...connected.values()], repaint };
}

function pixelBounds(context: CanvasRenderingContext2D, block: TextBlock, scaleX: number, scaleY: number, padding: number): Rect {
  const bounds = textSourcePaintBounds(block);
  const left = clamp(Math.floor(bounds.x * scaleX) - padding, 0, context.canvas.width);
  const top = clamp(Math.floor(bounds.y * scaleY) - padding, 0, context.canvas.height);
  const right = clamp(Math.ceil((bounds.x + bounds.width) * scaleX) + padding, left, context.canvas.width);
  const bottom = clamp(Math.ceil((bounds.y + bounds.height) * scaleY) + padding, top, context.canvas.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Restores native PDF text from an exact text-free render when available. */
export function restoreTextSource(
  context: CanvasRenderingContext2D,
  cleanContext: CanvasRenderingContext2D | null,
  block: TextBlock,
  scaleX: number,
  scaleY: number,
): void {
  if (block.source !== "native-pdf" || !cleanContext) return;
  const padding = block.sourceBbox ? 1 : Math.max(2, Math.ceil(Math.max(scaleX, scaleY)));
  const bounds = pixelBounds(context, block, scaleX, scaleY, padding);
  if (bounds.width < 1 || bounds.height < 1) return;
  context.drawImage(
    cleanContext.canvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
  );
}

export function canvasFont(block: TextBlock, pixelScale: number): string {
  return `${block.style.fontStyle} ${block.style.fontWeight} ${block.style.fontSize * pixelScale}px ${block.style.fontFamily}`;
}

export async function loadTextFonts(blocks: TextBlock[], pixelScale: number): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all(blocks.map(async (block) => {
    await document.fonts.load(canvasFont(block, pixelScale), block.text);
  }));
}

function measureLine(context: CanvasRenderingContext2D, line: string, letterSpacing: number): number {
  const spacedContext = context as CanvasWithTextSpacing;
  const previousSpacing = spacedContext.letterSpacing;
  if ("letterSpacing" in spacedContext) spacedContext.letterSpacing = `${letterSpacing}px`;
  const width = context.measureText(line).width;
  if ("letterSpacing" in spacedContext) spacedContext.letterSpacing = previousSpacing ?? "0px";
  return width;
}

function drawLine(context: CanvasRenderingContext2D, line: string, x: number, y: number, letterSpacing: number): void {
  const spacedContext = context as CanvasWithTextSpacing;
  const previousSpacing = spacedContext.letterSpacing;
  if ("letterSpacing" in spacedContext) {
    spacedContext.letterSpacing = `${letterSpacing}px`;
    context.fillText(line, x, y);
    spacedContext.letterSpacing = previousSpacing ?? "0px";
    return;
  }
  // Drawing Arabic or combining text one code point at a time breaks shaping.
  // On older canvases, preserve the shaped run and omit custom spacing.
  context.fillText(line, x, y);
}

export function drawCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
  lineHeight: number,
  availableWidth: number,
  align: TextStyle["align"],
): void {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    const measuredWidth = measureLine(context, line, letterSpacing);
    const x = align === "right"
      ? availableWidth - measuredWidth
      : align === "center"
        ? (availableWidth - measuredWidth) / 2
        : 0;
    drawLine(context, line, x, lineIndex * lineHeight, letterSpacing);
  });
}

/** Paints the same transformed text run in both the editor and flattened PDF. */
export function paintTextBlock(context: CanvasRenderingContext2D, block: TextBlock, scaleX: number, scaleY: number): void {
  const verticalScale = Math.max(0.001, Math.hypot(block.transform.c, block.transform.d));
  const horizontalScale = Math.max(0.001, Math.hypot(block.transform.a, block.transform.b));
  const sourceRatio = block.source === "native-pdf" ? horizontalScale / verticalScale : 1;
  const textScale = sourceRatio * (scaleX / scaleY);
  const radians = block.rotation * Math.PI / 180;
  const ascent = clamp(block.fontAscent ?? 1, 0.1, 2) * block.style.fontSize;
  const baselineX = block.bbox.x - ascent * Math.sin(radians);
  const baselineY = block.bbox.y + ascent * Math.cos(radians);

  context.save();
  clipSourceForeground(context, block, scaleX, scaleY);
  context.translate(baselineX * scaleX, baselineY * scaleY);
  if (block.rotation) context.rotate(radians);
  context.scale(textScale, 1);
  context.font = canvasFont(block, scaleY);
  context.fillStyle = block.style.color;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.direction = block.direction === "auto" ? "inherit" : block.direction;
  drawCanvasText(
    context,
    block.text,
    block.style.letterSpacing * scaleY,
    block.style.fontSize * block.style.lineHeight * scaleY,
    block.bbox.width * scaleX / textScale,
    block.style.align,
  );
  context.restore();
}
