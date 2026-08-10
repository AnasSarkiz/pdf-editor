"use client";

import { ChangeEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { downloadPdf, exportPdf, getExportReadiness } from "./lib/export-engine";
import { exportFlattenedPdf } from "./lib/flattened-export";
import type { DocumentPage, EditableDocument, EditOperation, PageObject, Rect, TextBlock, TextDirection, TextStyle } from "./lib/document-model";
import { createDemoDocument, defaultTextStyle, detectTextMeta, identityMatrix, stableId } from "./lib/document-model";
import { isTextReplacementPreview, needsNativeCanvasReplacement, shouldRenderTextContent } from "./lib/editor-visibility";
import { importPdf, type PdfLoadProgress } from "./lib/pdf-core";

type Tool = "select" | "text" | "table" | "image" | "shape" | "signature" | "form" | "hand";
type Panel = "properties" | "layers" | "review" | "search";

const tools: Array<{ id: Tool; mark: string; label: string }> = [
  { id: "select", mark: "↖", label: "Select" },
  { id: "text", mark: "T", label: "Text" },
  { id: "table", mark: "▦", label: "Table" },
  { id: "image", mark: "◫", label: "Image" },
  { id: "shape", mark: "◇", label: "Shape" },
  { id: "signature", mark: "✦", label: "Sign" },
  { id: "form", mark: "☑", label: "Form" },
  { id: "hand", mark: "✋", label: "Pan" },
];

function cloneDocument(document: EditableDocument): EditableDocument {
  return structuredClone(document);
}

function findObject(document: EditableDocument, objectId: string): { pageIndex: number; objectIndex: number; object: PageObject } | null {
  for (let pageIndex = 0; pageIndex < document.pages.length; pageIndex += 1) {
    const objectIndex = document.pages[pageIndex].objects.findIndex((object) => object.id === objectId);
    if (objectIndex >= 0) return { pageIndex, objectIndex, object: document.pages[pageIndex].objects[objectIndex] };
  }
  return null;
}

function applyOperation(document: EditableDocument, operation: EditOperation, phase: "before" | "after"): EditableDocument {
  const next = cloneDocument(document);
  const target = findObject(next, operation.targetId);
  if (operation.type === "create") {
    if (phase === "before") {
      if (target) next.pages[target.pageIndex].objects.splice(target.objectIndex, 1);
    } else {
      const page = next.pages.find((entry) => entry.id === operation.pageId);
      if (page && operation.after) page.objects.push(operation.after as PageObject);
    }
    return next;
  }
  if (operation.type === "delete") {
    if (phase === "after") {
      if (target) next.pages[target.pageIndex].objects.splice(target.objectIndex, 1);
    } else {
      const page = next.pages.find((entry) => entry.id === operation.pageId);
      if (page && operation.before) page.objects.push(operation.before as PageObject);
    }
    return next;
  }
  if (target) next.pages[target.pageIndex].objects[target.objectIndex] = { ...target.object, ...(operation[phase] ?? {}) } as PageObject;
  return next;
}

function objectLabel(object: PageObject): string {
  if (object.type === "text") return object.text.replace(/\s+/g, " ").slice(0, 32) || "Empty text";
  if (object.type === "table") return `${object.rows} × ${object.columns} table`;
  if (object.type === "form-field") return object.name || "Form field";
  return object.type;
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MIN_TEXT_BOX_WIDTH = 24;
const MIN_TEXT_BOX_HEIGHT = 20;

function fitTextBounds(text: string, bbox: Rect, pageWidth: number, pageHeight: number, style: TextStyle, minimum: Pick<Rect, "width" | "height"> = { width: 0, height: 0 }): Rect {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const lines = text.split(/\r?\n/);
  let widestLine = 0;
  if (context) {
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    widestLine = Math.max(...lines.map((line) => context.measureText(line || " ").width + Math.max(0, line.length - 1) * style.letterSpacing));
  } else {
    widestLine = Math.max(...lines.map((line) => Math.max(1, line.length) * style.fontSize * 0.58));
  }
  const availableWidth = Math.max(MIN_TEXT_BOX_WIDTH, pageWidth - bbox.x);
  const availableHeight = Math.max(MIN_TEXT_BOX_HEIGHT, pageHeight - bbox.y);
  return {
    ...bbox,
    width: clamp(Math.max(MIN_TEXT_BOX_WIDTH, minimum.width, widestLine + 4), MIN_TEXT_BOX_WIDTH, availableWidth),
    height: clamp(Math.max(MIN_TEXT_BOX_HEIGHT, minimum.height, lines.length * style.fontSize * style.lineHeight + 4), MIN_TEXT_BOX_HEIGHT, availableHeight),
  };
}

export default function Home() {
  const [documentModel, setDocumentModel] = useState<EditableDocument>(() => createDemoDocument());
  const [originalBytes, setOriginalBytes] = useState<Uint8Array>();
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [activePanel, setActivePanel] = useState<Panel>("properties");
  const [history, setHistory] = useState<{ entries: EditOperation[]; cursor: number }>({ entries: [], cursor: 0 });
  const [progress, setProgress] = useState<PdfLoadProgress | null>(null);
  const [notice, setNotice] = useState("Demo loaded — select any object to inspect the semantic model.");
  const [zoom, setZoom] = useState(100);
  const [search, setSearch] = useState("");
  const [inlineEditing, setInlineEditing] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const page = documentModel.pages[currentPageIndex] ?? documentModel.pages[0];
  const selected = useMemo(() => (selectedId ? findObject(documentModel, selectedId)?.object ?? null : null), [documentModel, selectedId]);
  const matchingIds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return new Set<string>();
    return new Set(
      documentModel.pages.flatMap((entry) =>
        entry.objects.filter((object) => object.type === "text" && object.text.toLocaleLowerCase().includes(query)).map((object) => object.id),
      ),
    );
  }, [documentModel, search]);
  const exportReadiness = useMemo(() => getExportReadiness(documentModel, originalBytes), [documentModel, originalBytes]);

  function commit(operation: EditOperation): void {
    setDocumentModel((current) => applyOperation(current, operation, "after"));
    setHistory((current) => ({ entries: [...current.entries.slice(0, current.cursor), operation], cursor: current.cursor + 1 }));
  }

  function updateSelected(changes: Partial<TextBlock>, label: string): void {
    if (!selected || selected.type !== "text") return;
    commit({
      id: stableId("op"),
      type: "update",
      targetId: selected.id,
      pageId: selected.pageId,
      at: new Date().toISOString(),
      before: selected,
      after: { ...selected, ...changes },
      label,
    });
  }

  function undo(): void {
    if (history.cursor === 0) return;
    const operation = history.entries[history.cursor - 1];
    setDocumentModel((current) => applyOperation(current, operation, "before"));
    setHistory((current) => ({ ...current, cursor: current.cursor - 1 }));
    setNotice(`Undid: ${operation.label}`);
  }

  function redo(): void {
    if (history.cursor >= history.entries.length) return;
    const operation = history.entries[history.cursor];
    setDocumentModel((current) => applyOperation(current, operation, "after"));
    setHistory((current) => ({ ...current, cursor: current.cursor + 1 }));
    setNotice(`Redid: ${operation.label}`);
  }

  function addText(): void {
    if (!page) return;
    const style = { ...defaultTextStyle, fontSize: 16, color: "#0f766e" };
    const anchor = { x: 72, y: Math.min(page.height - 90, 520), width: 0, height: 0 };
    const newObject: TextBlock = {
      id: stableId("user-text"),
      type: "text",
      pageId: page.id,
      bbox: fitTextBounds("New text", anchor, page.width, page.height, style),
      rotation: 0,
      transform: identityMatrix,
      confidence: 1,
      source: "user",
      zIndex: 99,
      relationships: [],
      ...detectTextMeta("New text"),
      text: "New text",
      originalText: "",
      style,
      overflow: "warn",
      editable: true,
    };
    commit({ id: stableId("op"), type: "create", targetId: newObject.id, pageId: page.id, at: new Date().toISOString(), after: newObject, label: "Added text" });
    setSelectedId(newObject.id);
    setInlineEditing(newObject.id);
    setActiveTool("text");
    setNotice("New text object added. Type directly on the page or use the inspector.");
  }

  function deleteSelected(): void {
    if (!selected) return;
    commit({ id: stableId("op"), type: "delete", targetId: selected.id, pageId: selected.pageId, at: new Date().toISOString(), before: selected, label: `Deleted ${objectLabel(selected)}` });
    setSelectedId(null);
    setNotice("Object deleted. Use Undo to restore it.");
  }

  function duplicateSelected(): void {
    if (!selected) return;
    const duplicate = { ...cloneDocument({ ...documentModel, pages: [{ ...page, objects: [selected] }] }).pages[0].objects[0], id: stableId(selected.type), bbox: { ...selected.bbox, x: selected.bbox.x + 18, y: selected.bbox.y + 18 }, source: "user" as const };
    commit({ id: stableId("op"), type: "create", targetId: duplicate.id, pageId: page.id, at: new Date().toISOString(), after: duplicate, label: `Duplicated ${objectLabel(selected)}` });
    setSelectedId(duplicate.id);
  }

  function moveObject(object: PageObject, bbox: Rect): void {
    if (object.bbox.x === bbox.x && object.bbox.y === bbox.y) return;
    commit({
      id: stableId("op"),
      type: "move",
      targetId: object.id,
      pageId: object.pageId,
      at: new Date().toISOString(),
      before: object,
      after: { ...object, bbox },
      label: `Moved ${objectLabel(object)}`,
    });
    setSelectedId(object.id);
    setActiveTool("select");
    setNotice("Object moved. Use Undo to restore its original position.");
  }

  function resizeObject(object: TextBlock, bbox: Rect): void {
    if (object.bbox.width === bbox.width && object.bbox.height === bbox.height) return;
    commit({
      id: stableId("op"),
      type: "resize",
      targetId: object.id,
      pageId: object.pageId,
      at: new Date().toISOString(),
      before: object,
      after: { ...object, bbox },
      label: `Resized ${objectLabel(object)}`,
    });
    setSelectedId(object.id);
    setActiveTool("select");
    setNotice("Text box resized. Use Undo to restore its previous size.");
  }

  function replaceAllMatches(replacement: string): void {
    const query = search.trim();
    if (!query) {
      setNotice("Enter text to find before replacing it.");
      return;
    }
    const operations: EditOperation[] = [];
    documentModel.pages.forEach((entry) => {
      entry.objects.forEach((object) => {
        if (object.type !== "text") return;
        const nextText = object.text.replace(new RegExp(escapeRegularExpression(query), "giu"), replacement);
        if (nextText === object.text) return;
        const nextObject: TextBlock = {
          ...object,
          text: nextText,
          ...detectTextMeta(nextText),
          ...(object.source === "user" ? { bbox: fitTextBounds(nextText, object.bbox, entry.width, entry.height, object.style, object.bbox) } : {}),
        };
        operations.push({
          id: stableId("op"),
          type: "update",
          targetId: object.id,
          pageId: entry.id,
          at: new Date().toISOString(),
          before: object,
          after: nextObject,
          label: `Replaced text in ${objectLabel(object)}`,
        });
      });
    });
    if (!operations.length) {
      setNotice(`No matches found for “${query}”.`);
      return;
    }
    setDocumentModel((current) => operations.reduce((next, operation) => applyOperation(next, operation, "after"), current));
    setHistory((current) => ({ entries: [...current.entries.slice(0, current.cursor), ...operations], cursor: current.cursor + operations.length }));
    setNotice(`Replaced ${operations.length} text block${operations.length === 1 ? "" : "s"}. Use Undo to step back through each change.`);
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      setNotice("This proof of concept limits local files to 100 MB.");
      return;
    }
    const signature = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
    if (signature !== "%PDF-") {
      setNotice("The file signature is not a PDF. Choose a valid PDF file.");
      return;
    }
    try {
      setIsImporting(true);
      setProgress({ phase: "opening", completed: 0, total: 1 });
      const imported = await importPdf(file, setProgress);
      setDocumentModel(imported.document);
      setOriginalBytes(imported.bytes);
      setHistory({ entries: [], cursor: 0 });
      setCurrentPageIndex(0);
      setSelectedId(null);
      const ocrTextCount = imported.document.pages.flatMap((entry) => entry.objects).filter((object) => object.type === "text" && object.source === "ocr").length;
      setNotice(ocrTextCount ? `${file.name} opened locally. ${ocrTextCount} Arabic + English OCR blocks were recognized at 300 dpi.` : `${file.name} opened locally. Native text is semantic; scanned regions are marked for OCR review.`);
    } catch (error) {
      setNotice(error instanceof Error ? `Unable to open PDF: ${error.message}` : "Unable to open this PDF.");
    } finally {
      setIsImporting(false);
      setProgress(null);
      event.target.value = "";
    }
  }

  async function handleExport(): Promise<void> {
    if (isExporting) return;
    try {
      setIsExporting(true);
      const flattened = !exportReadiness.canExport;
      const bytes = flattened ? await exportFlattenedPdf(documentModel) : await exportPdf(documentModel, originalBytes);
      downloadPdf(bytes, documentModel.metadata.filename);
      setNotice(flattened
        ? `Downloaded ${documentModel.metadata.filename.replace(/\.pdf$/i, "")}-edited.pdf. This edited fallback preserves the visible page appearance.`
        : `Exported ${documentModel.metadata.filename.replace(/\.pdf$/i, "")}-edited.pdf as a valid PDF.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  function resetDemo(): void {
    setDocumentModel(createDemoDocument());
    setOriginalBytes(undefined);
    setHistory({ entries: [], cursor: 0 });
    setCurrentPageIndex(0);
    setSelectedId(null);
    setNotice("Mixed Arabic and English proof-of-concept document loaded.");
  }

  function handlePageKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") setInlineEditing(null);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      }
      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
      if (event.key === "Delete" && selectedId && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) deleteSelected();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!page) return null;
  const ocrTextCount = page.objects.filter((object) => object.type === "text" && object.source === "ocr").length;

  return (
    <main className="studio-shell" onKeyDown={handlePageKeyDown}>
      <header className="topbar">
        <div className="brand-lockup" aria-label="PDF Editor">
          <span className="brand-mark">P</span>
          <span>PDF <em>Editor</em></span>
        </div>
        <div className="document-title">
          <span className="file-dot" />
          <strong>{documentModel.metadata.filename}</strong>
          <span className="saved-state">Local session</span>
        </div>
        <div className="topbar-actions">
          <button className="quiet-button" onClick={undo} disabled={history.cursor === 0} aria-label="Undo">↶</button>
          <button className="quiet-button" onClick={redo} disabled={history.cursor >= history.entries.length} aria-label="Redo">↷</button>
          <button className="open-button" onClick={() => inputRef.current?.click()}>{isImporting ? "Opening…" : "Open PDF"}</button>
          <button className="export-button" onClick={handleExport} disabled={isExporting}>{isExporting ? "Exporting…" : "Export PDF"} <span>↗</span></button>
          <input ref={inputRef} onChange={onFileChange} accept="application/pdf,.pdf" type="file" hidden />
        </div>
      </header>

      <section className="tool-row" aria-label="Document tools">
        <div className="tool-list">
          {tools.map((tool) => (
            <button key={tool.id} className={`tool-button ${activeTool === tool.id ? "is-active" : ""}`} onClick={() => tool.id === "text" ? addText() : setActiveTool(tool.id)} aria-pressed={activeTool === tool.id}>
              <span>{tool.mark}</span>{tool.label}
            </button>
          ))}
        </div>
        <div className="zoom-controls">
          <button onClick={() => setZoom((value) => Math.max(60, value - 10))}>−</button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((value) => Math.min(140, value + 10))}>+</button>
          <button className="fit-button" onClick={() => setZoom(100)}>Fit width</button>
        </div>
      </section>

      <section className="workspace">
        <aside className="page-sidebar" aria-label="Pages">
          <div className="side-title"><span>Pages</span><button onClick={resetDemo} title="Open mixed-language demo">↺</button></div>
          <div className="thumbnails">
            {documentModel.pages.map((entry, index) => (
              <button className={`thumbnail ${index === currentPageIndex ? "is-current" : ""}`} key={entry.id} onClick={() => { setCurrentPageIndex(index); setSelectedId(null); }}>
                <div
                  className={`thumbnail-paper ${entry.background ? "has-background" : ""}`}
                  style={{
                    aspectRatio: `${entry.width} / ${entry.height}`,
                    ...(entry.background ? { backgroundImage: `url(${entry.background})` } : {}),
                  }}
                >
                  {!entry.background && entry.objects.filter((object) => object.type === "text").slice(0, 4).map((object) => <i key={object.id} style={{ top: `${(object.bbox.y / entry.height) * 100}%`, width: `${Math.min(80, (object.bbox.width / entry.width) * 100)}%` }} />)}
                </div>
                <span>{entry.number}</span>
              </button>
            ))}
          </div>
          <button className="add-page" onClick={() => setNotice("Page creation is queued for the reconstruction worker; native page reordering remains non-destructive.")}>＋ Add page</button>
        </aside>

        <section className="canvas-zone" aria-label="Editable PDF canvas">
          <div className="canvas-toolbar">
            <div className="crumb">Page {page.number} <span>/</span> {documentModel.metadata.pageCount}</div>
            <div className={`analysis-chip ${page.analysisStatus === "needs-review" ? "needs-review" : ""}`}><span /> {page.sourceKind === "scan" ? ocrTextCount ? `Local OCR · 300 dpi · ${ocrTextCount} blocks` : "OCR review" : page.sourceKind === "hybrid" ? "Hybrid analysis" : "Native extraction"}</div>
          </div>
          <div className="paper-wrap" style={{ width: `${zoom}%` }}>
            <div
              className={`paper ${page.background ? "has-background" : ""}`}
              style={{
                aspectRatio: `${page.width} / ${page.height}`,
              } as CSSProperties}
            >
              <PageRenderSurface page={page} mutedTextId={inlineEditing} />
              {!page.background && <div className="demo-folio">PDF / 01</div>}
              {page.objects.map((object) => (
                <SemanticObject
                  key={object.id}
                  object={object}
                  pageWidth={page.width}
                  pageHeight={page.height}
                  showContent={object.type !== "text" || shouldRenderTextContent(object, Boolean(page.background), object.id === inlineEditing)}
                  replacementPreview={object.type === "text" && isTextReplacementPreview(object, Boolean(page.background), object.id === inlineEditing)}
                  selected={selectedId === object.id}
                  matched={matchingIds.has(object.id)}
                  onSelect={() => { setSelectedId(object.id); setActiveTool("select"); }}
                  onEdit={() => object.type === "text" && setInlineEditing(object.id)}
                  onTextCommit={(value, bbox) => object.type === "text" && updateSelected({ text: value, ...detectTextMeta(value), ...(bbox ? { bbox } : {}) }, "Edited text")}
                  onEditEnd={() => setInlineEditing(null)}
                  onMove={(bbox) => moveObject(object, bbox)}
                  onResize={(bbox) => object.type === "text" && resizeObject(object, bbox)}
                  editing={inlineEditing === object.id}
                />
              ))}
              {selected && selected.type !== "text" && <SelectionRuler object={selected} pageWidth={page.width} pageHeight={page.height} />}
            </div>
          </div>
        </section>

        <aside className="inspector" aria-label="Document inspector">
          <nav className="inspector-tabs" aria-label="Inspector sections">
            {(["properties", "layers", "review", "search"] as Panel[]).map((panel) => <button key={panel} className={activePanel === panel ? "is-active" : ""} onClick={() => setActivePanel(panel)}>{panel}</button>)}
          </nav>
          {activePanel === "properties" && <PropertiesPanel selected={selected} onTextChange={(text) => selected?.type === "text" && updateSelected({ text, ...detectTextMeta(text), ...(selected.source === "user" ? { bbox: fitTextBounds(text, selected.bbox, page.width, page.height, selected.style, selected.bbox) } : {}) }, "Edited text")} onStyleChange={(style) => selected?.type === "text" && updateSelected({ style: { ...selected.style, ...style } }, "Changed text style")} onRotationChange={(rotation) => selected?.type === "text" && updateSelected({ rotation: clamp(rotation, -180, 180) }, "Rotated text")} onDirectionChange={(direction) => selected?.type === "text" && updateSelected({ direction }, "Changed paragraph direction")} onDelete={deleteSelected} onDuplicate={duplicateSelected} />}
          {activePanel === "layers" && <LayersPanel page={page} selectedId={selectedId} onSelect={setSelectedId} />}
          {activePanel === "review" && <ReviewPanel page={page} readiness={exportReadiness} />}
          {activePanel === "search" && <SearchPanel search={search} setSearch={setSearch} document={documentModel} onReplaceAll={replaceAllMatches} onSelect={(id) => { setSelectedId(id); const located = findObject(documentModel, id); if (located) setCurrentPageIndex(located.pageIndex); }} />}
        </aside>
      </section>

      <footer className="statusbar">
        <span className="status-led" />
        <span>{notice}</span>
        {progress && <span className="progress-text">{progress.phase} · {progress.completed}/{progress.total}</span>}
        <span className="status-spacer" />
        <span>{documentModel.pages.reduce((total, entry) => total + entry.objects.length, 0)} semantic objects</span>
        <span>Browser-only</span>
      </footer>
    </main>
  );
}

function SemanticObject({ object, pageWidth, pageHeight, selected, matched, showContent, replacementPreview, editing, onSelect, onEdit, onTextCommit, onEditEnd, onMove, onResize }: { object: PageObject; pageWidth: number; pageHeight: number; selected: boolean; matched: boolean; showContent: boolean; replacementPreview: boolean; editing: boolean; onSelect: () => void; onEdit: () => void; onTextCommit: (value: string, bbox?: Rect) => void; onEditEnd: () => void; onMove: (bbox: Rect) => void; onResize: (bbox: Rect) => void }) {
  const [draftText, setDraftText] = useState(object.type === "text" ? object.text : "");
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [draftBbox, setDraftBbox] = useState<Rect | null>(null);
  const [resizeBbox, setResizeBbox] = useState<Rect | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startBbox: Rect; paper: DOMRect; offset: { x: number; y: number } } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startBbox: Rect; paper: DOMRect; bbox: Rect } | null>(null);
  const isDragging = dragOffset !== null;
  const displayBbox = resizeBbox ?? draftBbox ?? object.bbox;
  const style = {
    left: `${((displayBbox.x + (dragOffset?.x ?? 0)) / pageWidth) * 100}%`,
    top: `${((displayBbox.y + (dragOffset?.y ?? 0)) / pageHeight) * 100}%`,
    width: `${(displayBbox.width / pageWidth) * 100}%`,
    height: `${(displayBbox.height / pageHeight) * 100}%`,
    transform: object.type === "text" && object.rotation ? `rotate(${object.rotation}deg)` : undefined,
    transformOrigin: "top left",
  };
  if (object.type === "table") {
    return <button className={`semantic-object table-object ${selected ? "is-selected" : ""} ${matched ? "is-matched" : ""}`} style={style} onClick={onSelect} aria-label="Recognized table"><span className="table-object-label">{object.rows} × {object.columns} table · {formatConfidence(object.confidence)}</span></button>;
  }
  if (object.type === "form-field") return <button className={`semantic-object field-object ${selected ? "is-selected" : ""}`} style={style} onClick={onSelect} aria-label={`Form field ${object.name}`} />;
  if (object.type !== "text") return <button className={`semantic-object ${selected ? "is-selected" : ""}`} style={style} onClick={onSelect} aria-label={object.type} />;
  const finishEditing = () => {
    const fittedBbox = object.source === "user" ? fitTextBounds(draftText, object.bbox, pageWidth, pageHeight, object.style, object.bbox) : undefined;
    if (draftText !== object.text || (fittedBbox && (fittedBbox.width !== object.bbox.width || fittedBbox.height !== object.bbox.height))) onTextCommit(draftText, fittedBbox);
    setDraftBbox(null);
    onEditEnd();
  };
  const startEditing = () => {
    setDraftText(object.text);
    onEdit();
  };
  const startDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (editing || (event.pointerType === "mouse" && event.button !== 0)) return;
    const paper = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!paper) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startBbox: { ...object.bbox }, paper, offset: { x: 0, y: 0 } };
  };
  const updateDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextX = clamp(drag.startBbox.x + ((event.clientX - drag.startX) / drag.paper.width) * pageWidth, 0, Math.max(0, pageWidth - drag.startBbox.width));
    const nextY = clamp(drag.startBbox.y + ((event.clientY - drag.startY) / drag.paper.height) * pageHeight, 0, Math.max(0, pageHeight - drag.startBbox.height));
    drag.offset = { x: nextX - drag.startBbox.x, y: nextY - drag.startBbox.y };
    setDragOffset(drag.offset);
  };
  const finishDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const offset = drag.offset;
    setDragOffset(null);
    if (Math.abs(offset.x) < 0.5 && Math.abs(offset.y) < 0.5) return;
    event.preventDefault();
    event.stopPropagation();
    onMove({ ...drag.startBbox, x: drag.startBbox.x + offset.x, y: drag.startBbox.y + offset.y });
  };
  const cancelDragging = () => {
    dragRef.current = null;
    setDragOffset(null);
  };
  const startResizing = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (editing || (event.pointerType === "mouse" && event.button !== 0)) return;
    const paper = event.currentTarget.closest(".paper")?.getBoundingClientRect();
    if (!paper) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startBbox: { ...object.bbox }, paper, bbox: { ...object.bbox } };
  };
  const updateResizing = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = {
      ...resize.startBbox,
      width: clamp(resize.startBbox.width + ((event.clientX - resize.startX) / resize.paper.width) * pageWidth, MIN_TEXT_BOX_WIDTH, Math.max(MIN_TEXT_BOX_WIDTH, pageWidth - resize.startBbox.x)),
      height: clamp(resize.startBbox.height + ((event.clientY - resize.startY) / resize.paper.height) * pageHeight, MIN_TEXT_BOX_HEIGHT, Math.max(MIN_TEXT_BOX_HEIGHT, pageHeight - resize.startBbox.y)),
    };
    resize.bbox = next;
    setResizeBbox(next);
  };
  const finishResizing = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    setResizeBbox(null);
    onResize(resize.bbox);
  };
  const cancelResizing = () => {
    resizeRef.current = null;
    setResizeBbox(null);
  };
  const textStyle = {
    color: object.style.color,
    // PDF.js registers the embedded subset font under this exact family name
    // while it renders the source page. Reusing it is essential for matching
    // the original glyph metrics, weight, and antialiasing in edited spans.
    fontFamily: object.style.fontFamily,
    fontSize: `${(object.style.fontSize / pageWidth) * 100}cqw`,
    fontWeight: object.style.fontWeight,
    fontStyle: object.style.fontStyle,
    lineHeight: object.style.lineHeight,
    letterSpacing: `${object.style.letterSpacing / pageWidth * 100}cqw`,
    textAlign: object.style.align,
  };
  return <div className={`semantic-object text-object ${selected ? "is-selected" : ""} ${matched ? "is-matched" : ""} ${showContent || isDragging ? "show-content" : ""} ${replacementPreview ? "is-replacement-preview" : ""} ${isDragging ? "is-dragging" : ""}`} style={style} onClick={(event) => { event.stopPropagation(); onSelect(); }} onDoubleClick={startEditing} onPointerDown={startDragging} onPointerMove={updateDragging} onPointerUp={finishDragging} onPointerCancel={cancelDragging} role="button" tabIndex={0} aria-label={`Text: ${objectLabel(object)}${replacementPreview ? " (edited preview)" : ""}`}>
    {editing ? <textarea autoFocus wrap="off" value={draftText} dir={object.direction === "auto" ? undefined : object.direction} style={textStyle} onChange={(event) => { const value = event.target.value; setDraftText(value); if (object.source === "user") setDraftBbox(fitTextBounds(value, object.bbox, pageWidth, pageHeight, object.style, object.bbox)); }} onBlur={finishEditing} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setDraftText(object.text); setDraftBbox(null); onEditEnd(); } }} /> : <span dir={object.direction === "auto" ? undefined : object.direction} style={textStyle}>{showContent || isDragging ? object.text : ""}</span>}
    {selected && !editing && <button className="text-resize-handle" aria-label="Resize text box" title="Drag to resize text box" onClick={(event) => event.stopPropagation()} onPointerDown={startResizing} onPointerMove={updateResizing} onPointerUp={finishResizing} onPointerCancel={cancelResizing} />}
    {selected && !replacementPreview && <span className="object-source">{object.source === "native-pdf" ? "native" : object.source}</span>}
  </div>;
}

function PageRenderSurface({ page, mutedTextId }: { page: DocumentPage; mutedTextId: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const replacementSignature = page.objects
    .filter((object): object is TextBlock => object.type === "text" && object.source === "native-pdf" && (object.id === mutedTextId || needsNativeCanvasReplacement(object)))
    .map((object) => `${object.id}:${object.text}:${object.bbox.x}:${object.bbox.y}:${object.bbox.width}:${object.bbox.height}:${object.rotation}:${object.style.fontFamily}:${object.style.fontSize}:${object.style.fontWeight}:${object.style.fontStyle}:${object.style.color}:${object.style.lineHeight}:${object.style.letterSpacing}:${object.style.align}:${object.direction}`)
    .join("|");

  useEffect(() => {
    if (!page.background || !canvasRef.current) return;
    let disposed = false;
    const canvas = canvasRef.current;
    const image = new Image();
    image.onload = async () => {
      if (disposed) return;
      const replacements = page.objects.filter(
        (object): object is TextBlock => object.type === "text" && object.source === "native-pdf" && (object.id === mutedTextId || needsNativeCanvasReplacement(object)),
      );
      await Promise.all(replacements.map((object) => document.fonts.load(canvasFont(object, 1), object.text).catch(() => [])));
      if (disposed) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      context.drawImage(image, 0, 0);
      const scaleX = canvas.width / page.width;
      const scaleY = canvas.height / page.height;
      replacements.forEach((object) => {
        concealSourceText(context, object, scaleX, scaleY, object.originalBbox ?? object.bbox);
        if (object.id !== mutedTextId) paintNativeTextReplacement(context, object, scaleX, scaleY);
      });
    };
    image.src = page.background;
    return () => { disposed = true; };
  }, [page, mutedTextId, replacementSignature]);

  if (!page.background) return null;
  return <canvas ref={canvasRef} className="page-render-surface" aria-hidden="true" />;
}

function canvasFont(object: TextBlock, pixelScale: number): string {
  return `${object.style.fontStyle} ${object.style.fontWeight} ${object.style.fontSize * pixelScale}px ${object.style.fontFamily}`;
}

function paintNativeTextReplacement(context: CanvasRenderingContext2D, object: TextBlock, scaleX: number, scaleY: number): void {
  const verticalScale = Math.max(0.001, Math.hypot(object.transform.c, object.transform.d));
  const horizontalScale = Math.hypot(object.transform.a, object.transform.b);
  const textScale = (horizontalScale / verticalScale) * (scaleX / scaleY);
  context.save();
  context.translate(object.bbox.x * scaleX, (object.bbox.y + object.style.fontSize) * scaleY);
  if (object.rotation) context.rotate((object.rotation * Math.PI) / 180);
  context.scale(textScale, 1);
  context.font = canvasFont(object, scaleY);
  context.fillStyle = object.style.color;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.direction = object.direction === "auto" ? "inherit" : object.direction;
  drawCanvasText(context, object.text, object.style.letterSpacing * scaleY, object.style.fontSize * object.style.lineHeight * scaleY, (object.bbox.width * scaleX) / textScale, object.style.align);
  context.restore();
}

function drawCanvasText(context: CanvasRenderingContext2D, text: string, letterSpacing: number, lineHeight: number, availableWidth: number, align: TextStyle["align"]): void {
  text.split(/\r?\n/).forEach((line, lineIndex) => {
    const y = lineIndex * lineHeight;
    const measuredWidth = context.measureText(line).width + Math.max(0, line.length - 1) * letterSpacing;
    const x = align === "right" ? availableWidth - measuredWidth : align === "center" ? (availableWidth - measuredWidth) / 2 : 0;
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
}

function concealSourceText(context: CanvasRenderingContext2D, object: TextBlock, scaleX: number, scaleY: number, sourceBbox: Rect): void {
  const paddingX = Math.max(2, scaleX * 1.5);
  const paddingY = Math.max(2, scaleY * 1.5);
  const x = Math.max(0, sourceBbox.x * scaleX - paddingX);
  const y = Math.max(0, sourceBbox.y * scaleY - paddingY);
  const width = Math.min(context.canvas.width - x, sourceBbox.width * scaleX + paddingX * 2);
  const height = Math.min(context.canvas.height - y, sourceBbox.height * scaleY + paddingY * 2);
  if (width <= 0 || height <= 0) return;

  // Derive the repair colour from the pixels immediately around the original
  // glyphs. This keeps the page preview continuous without putting a CSS box
  // behind edited text.
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
      // Ignore dark neighbouring glyphs and favour the actual page surface.
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

function SelectionRuler({ object, pageWidth, pageHeight }: { object: PageObject; pageWidth: number; pageHeight: number }) {
  return <div className="selection-ruler" style={{ left: `${(object.bbox.x / pageWidth) * 100}%`, top: `${(object.bbox.y / pageHeight) * 100}%` }}><span>{Math.round(object.bbox.x)}, {Math.round(object.bbox.y)}</span></div>;
}

function PropertiesPanel({ selected, onTextChange, onStyleChange, onRotationChange, onDirectionChange, onDelete, onDuplicate }: { selected: PageObject | null; onTextChange: (value: string) => void; onStyleChange: (value: Partial<TextStyle>) => void; onRotationChange: (value: number) => void; onDirectionChange: (direction: TextDirection) => void; onDelete: () => void; onDuplicate: () => void }) {
  if (!selected) return <div className="empty-inspector"><span className="empty-glyph">⌁</span><strong>Select an object</strong><p>Text, tables, form fields, and recognized graphics keep their own semantic metadata.</p></div>;
  if (selected.type !== "text") return <div className="object-inspector"><span className="eyebrow">{selected.type.replace("-", " ")}</span><h2>{objectLabel(selected)}</h2><div className="confidence-card"><span>Recognition confidence</span><strong>{formatConfidence(selected.confidence)}</strong><i><b style={{ width: `${selected.confidence * 100}%` }} /></i></div><dl><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Bounds</dt><dd>{Math.round(selected.bbox.width)} × {Math.round(selected.bbox.height)} pt</dd></div><div><dt>Direction</dt><dd>{selected.direction}</dd></div></dl><div className="inspector-buttons"><button onClick={onDuplicate}>Duplicate</button><button className="danger" onClick={onDelete}>Delete</button></div></div>;
  return <div className="object-inspector">
    <div className="property-heading"><div><span className="eyebrow">Text block</span><h2>Content & type</h2></div><span className={`source-pill ${selected.source}`}>{selected.source}</span></div>
    <label className="field-label">Text <textarea value={selected.text} dir={selected.direction === "auto" ? undefined : selected.direction} onChange={(event) => onTextChange(event.target.value)} /></label>
    <div className="field-grid">
      <label className="field-label">Font <select value={selected.style.fontFamily.includes("Noto") ? "arabic" : selected.style.fontFamily.includes("Arial") ? "arial" : "inter"} onChange={(event) => onStyleChange({ fontFamily: event.target.value === "arabic" ? "Noto Naskh Arabic, Arial, sans-serif" : event.target.value === "arial" ? "Arial, sans-serif" : "Inter, Arial, sans-serif" })}><option value="inter">Inter</option><option value="arabic">Arabic</option><option value="arial">Arial</option></select></label>
      <label className="field-label">Size <input type="number" min="7" max="72" value={Math.round(selected.style.fontSize)} onChange={(event) => onStyleChange({ fontSize: Number(event.target.value) || 12 })} /></label>
    </div>
    <div className="format-strip"><button className={selected.style.fontWeight >= 600 ? "is-on" : ""} onClick={() => onStyleChange({ fontWeight: selected.style.fontWeight >= 600 ? 400 : 700 })}><b>B</b></button><button className={selected.style.fontStyle === "italic" ? "is-on" : ""} onClick={() => onStyleChange({ fontStyle: selected.style.fontStyle === "italic" ? "normal" : "italic" })}><i>I</i></button><input aria-label="Text color" type="color" value={selected.style.color} onChange={(event) => onStyleChange({ color: event.target.value })} /><span /></div>
    <div className="field-grid">
      <label className="field-label">Align <select value={selected.style.align} onChange={(event) => onStyleChange({ align: event.target.value as TextStyle["align"] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
      <label className="field-label">Rotation <input type="number" min="-180" max="180" value={Math.round(selected.rotation)} onChange={(event) => onRotationChange(Number(event.target.value) || 0)} /></label>
    </div>
    <div className="field-grid">
      <label className="field-label">Line height <input type="number" min="0.8" max="3" step="0.1" value={selected.style.lineHeight} onChange={(event) => onStyleChange({ lineHeight: clamp(Number(event.target.value) || 1, 0.8, 3) })} /></label>
      <label className="field-label">Spacing <input type="number" min="-2" max="12" step="0.1" value={selected.style.letterSpacing} onChange={(event) => onStyleChange({ letterSpacing: clamp(Number(event.target.value) || 0, -2, 12) })} /></label>
    </div>
    <div className="direction-control"><span>Paragraph direction</span><div><button className={selected.direction === "ltr" ? "is-on" : ""} onClick={() => onDirectionChange("ltr")}>LTR</button><button className={selected.direction === "rtl" ? "is-on" : ""} onClick={() => onDirectionChange("rtl")}>RTL</button><button className={selected.direction === "auto" ? "is-on" : ""} onClick={() => onDirectionChange("auto")}>Auto</button></div></div>
    <div className="confidence-card"><span>Extraction confidence</span><strong>{formatConfidence(selected.confidence)}</strong><i><b style={{ width: `${selected.confidence * 100}%` }} /></i></div>
    <div className="inspector-buttons"><button onClick={onDuplicate}>Duplicate</button><button className="danger" onClick={onDelete}>Delete</button></div>
  </div>;
}

function LayersPanel({ page, selectedId, onSelect }: { page: EditableDocument["pages"][number]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <div className="layers-panel"><div className="panel-heading"><span className="eyebrow">Page {page.number}</span><h2>Layer stack</h2></div>{[...page.objects].sort((left, right) => right.zIndex - left.zIndex).map((object) => <button key={object.id} className={`layer-row ${selectedId === object.id ? "is-selected" : ""}`} onClick={() => onSelect(object.id)}><span className={`layer-icon ${object.type}`}>{object.type === "text" ? "T" : object.type === "table" ? "▦" : "◇"}</span><span><strong>{objectLabel(object)}</strong><small>{object.source} · {formatConfidence(object.confidence)}</small></span><i>{object.locked ? "⌕" : ""}</i></button>)}</div>;
}

function ReviewPanel({ page, readiness }: { page: EditableDocument["pages"][number]; readiness: ReturnType<typeof getExportReadiness> }) {
  const uncertain = page.objects.filter((object) => object.confidence < 0.9);
  const ocrTextCount = page.objects.filter((object) => object.type === "text" && object.source === "ocr").length;
  return <div className="review-panel"><div className="panel-heading"><span className="eyebrow">Quality gate</span><h2>Recognition review</h2></div><div className="review-hero"><span>{page.sourceKind === "native" ? "Native source" : page.sourceKind === "hybrid" ? "Hybrid source" : "Scanned source"}</span><strong>{page.nativeTextCount + ocrTextCount} text objects</strong><small>{ocrTextCount ? `Local Arabic + English OCR · 300 dpi · ${ocrTextCount} blocks` : `${page.imageCount} image operations detected`}</small></div><div className="review-list">{uncertain.length ? uncertain.map((object) => <div key={object.id}><span className="warning-dot" /><p><strong>{objectLabel(object)}</strong><small>{formatConfidence(object.confidence)} confidence · {object.source}</small></p><button>Review</button></div>) : <div className="review-clear"><span>✓</span><p>All current objects meet the review threshold.</p></div>}</div><div className={`export-readiness ${readiness.canExport ? "ready" : "held"}`}><span>{readiness.canExport ? "Export ready" : "Export held"}</span>{readiness.messages.map((message) => <p key={message}>{message}</p>)}</div></div>;
}

function SearchPanel({ search, setSearch, document, onReplaceAll, onSelect }: { search: string; setSearch: (value: string) => void; document: EditableDocument; onReplaceAll: (replacement: string) => void; onSelect: (id: string) => void }) {
  const [replacement, setReplacement] = useState("");
  const results = search.trim() ? document.pages.flatMap((page) => page.objects.filter((object): object is TextBlock => object.type === "text" && object.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((object) => ({ page: page.number, object }))) : [];
  return <div className="search-panel">
    <div className="panel-heading"><span className="eyebrow">Semantic search</span><h2>Find & replace</h2></div>
    <label className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find Arabic or English text" autoFocus /></label>
    <label className="search-field replace-field"><span>↻</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Replace with" /></label>
    <button className="replace-all-button" disabled={!search.trim() || !results.length} onClick={() => onReplaceAll(replacement)}>Replace all ({results.length})</button>
    <p className="search-hint">Search and replace use semantic text, preserve mixed Arabic and English direction, and can be undone one change at a time.</p>
    {results.map(({ page, object }) => <button className="search-result" key={object.id} onClick={() => onSelect(object.id)}><small>Page {page} · {object.language} · {object.direction}</small><strong>{object.text}</strong></button>)}
    {search && !results.length && <div className="no-results">No semantic text matches.</div>}
  </div>;
}
