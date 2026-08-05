"use client";

import { ChangeEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { downloadPdf, exportPdf, getExportReadiness } from "./lib/export-engine";
import type { DocumentPage, EditableDocument, EditOperation, PageObject, TextBlock, TextDirection, TextStyle } from "./lib/document-model";
import { createDemoDocument, defaultTextStyle, detectTextMeta, identityMatrix, stableId } from "./lib/document-model";
import { isTextReplacementPreview, shouldRenderTextContent } from "./lib/editor-visibility";
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
    const newObject: TextBlock = {
      id: stableId("user-text"),
      type: "text",
      pageId: page.id,
      bbox: { x: 72, y: Math.min(page.height - 90, 520), width: Math.min(320, page.width - 144), height: 32 },
      rotation: 0,
      transform: identityMatrix,
      confidence: 1,
      source: "user",
      zIndex: 99,
      relationships: [],
      ...detectTextMeta("New text"),
      text: "New text",
      originalText: "",
      style: { ...defaultTextStyle, fontSize: 16, color: "#0f766e" },
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
      setNotice(`${file.name} opened locally. Native text is semantic; scanned regions are marked for OCR review.`);
    } catch (error) {
      setNotice(error instanceof Error ? `Unable to open PDF: ${error.message}` : "Unable to open this PDF.");
    } finally {
      setIsImporting(false);
      setProgress(null);
      event.target.value = "";
    }
  }

  async function handleExport(): Promise<void> {
    if (!exportReadiness.canExport) {
      setNotice(exportReadiness.messages[0]);
      setActivePanel("review");
      return;
    }
    try {
      const bytes = await exportPdf(documentModel, originalBytes);
      downloadPdf(bytes, documentModel.metadata.filename);
      setNotice(`Exported ${documentModel.metadata.filename.replace(/\.pdf$/i, "")}-edited.pdf as a valid PDF.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Export failed.");
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

  return (
    <main className="studio-shell" onKeyDown={handlePageKeyDown}>
      <header className="topbar">
        <div className="brand-lockup" aria-label="Naskh Studio">
          <span className="brand-mark">ن</span>
          <span>Naskh <em>Studio</em></span>
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
          <button className="export-button" onClick={handleExport}>Export PDF <span>↗</span></button>
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
            <div className={`analysis-chip ${page.analysisStatus === "needs-review" ? "needs-review" : ""}`}><span /> {page.sourceKind === "scan" ? "OCR review" : page.sourceKind === "hybrid" ? "Hybrid analysis" : "Native extraction"}</div>
          </div>
          <div className="paper-wrap" style={{ width: `${zoom}%` }}>
            <div
              className={`paper ${page.background ? "has-background" : ""}`}
              style={{
                aspectRatio: `${page.width} / ${page.height}`,
              } as CSSProperties}
            >
              <PageRenderSurface page={page} mutedTextId={inlineEditing} />
              {!page.background && <div className="demo-folio">NASKH / 01</div>}
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
                  onTextCommit={(value) => object.type === "text" && updateSelected({ text: value, ...detectTextMeta(value) }, "Edited text")}
                  onEditEnd={() => setInlineEditing(null)}
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
          {activePanel === "properties" && <PropertiesPanel selected={selected} onTextChange={(text) => updateSelected({ text, ...detectTextMeta(text) }, "Edited text")} onStyleChange={(style) => selected?.type === "text" && updateSelected({ style: { ...selected.style, ...style } }, "Changed text style")} onDirectionChange={(direction) => updateSelected({ direction }, "Changed paragraph direction")} onDelete={deleteSelected} onDuplicate={duplicateSelected} />}
          {activePanel === "layers" && <LayersPanel page={page} selectedId={selectedId} onSelect={setSelectedId} />}
          {activePanel === "review" && <ReviewPanel page={page} readiness={exportReadiness} />}
          {activePanel === "search" && <SearchPanel search={search} setSearch={setSearch} document={documentModel} onSelect={(id) => { setSelectedId(id); const located = findObject(documentModel, id); if (located) setCurrentPageIndex(located.pageIndex); }} />}
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

function SemanticObject({ object, pageWidth, pageHeight, selected, matched, showContent, replacementPreview, editing, onSelect, onEdit, onTextCommit, onEditEnd }: { object: PageObject; pageWidth: number; pageHeight: number; selected: boolean; matched: boolean; showContent: boolean; replacementPreview: boolean; editing: boolean; onSelect: () => void; onEdit: () => void; onTextCommit: (value: string) => void; onEditEnd: () => void }) {
  const [draftText, setDraftText] = useState(object.type === "text" ? object.text : "");
  const style = {
    left: `${(object.bbox.x / pageWidth) * 100}%`,
    top: `${(object.bbox.y / pageHeight) * 100}%`,
    width: `${(object.bbox.width / pageWidth) * 100}%`,
    height: `${(object.bbox.height / pageHeight) * 100}%`,
  };
  if (object.type === "table") {
    return <button className={`semantic-object table-object ${selected ? "is-selected" : ""} ${matched ? "is-matched" : ""}`} style={style} onClick={onSelect} aria-label="Recognized table"><span className="table-object-label">{object.rows} × {object.columns} table · {formatConfidence(object.confidence)}</span></button>;
  }
  if (object.type === "form-field") return <button className={`semantic-object field-object ${selected ? "is-selected" : ""}`} style={style} onClick={onSelect} aria-label={`Form field ${object.name}`} />;
  if (object.type !== "text") return <button className={`semantic-object ${selected ? "is-selected" : ""}`} style={style} onClick={onSelect} aria-label={object.type} />;
  const finishEditing = () => {
    if (draftText !== object.text) onTextCommit(draftText);
    onEditEnd();
  };
  const startEditing = () => {
    setDraftText(object.text);
    onEdit();
  };
  const textStyle = {
    color: object.style.color,
    fontFamily: getRenderableFontFamily(object),
    fontSize: `${(object.style.fontSize / pageWidth) * 100}cqw`,
    fontWeight: object.style.fontWeight,
    fontStyle: object.style.fontStyle,
    lineHeight: object.style.lineHeight,
    letterSpacing: `${object.style.letterSpacing / pageWidth * 100}cqw`,
    textAlign: object.style.align,
  };
  return <div className={`semantic-object text-object ${selected ? "is-selected" : ""} ${matched ? "is-matched" : ""} ${showContent ? "show-content" : ""} ${replacementPreview ? "is-replacement-preview" : ""}`} style={style} onClick={(event) => { event.stopPropagation(); onSelect(); }} onDoubleClick={startEditing} role="button" tabIndex={0} aria-label={`Text: ${objectLabel(object)}${replacementPreview ? " (edited preview)" : ""}`}>
    {editing ? <textarea autoFocus wrap="off" value={draftText} dir={object.direction === "auto" ? undefined : object.direction} style={textStyle} onChange={(event) => setDraftText(event.target.value)} onBlur={finishEditing} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setDraftText(object.text); onEditEnd(); } }} /> : <span dir={object.direction === "auto" ? undefined : object.direction} style={textStyle}>{showContent ? object.text : ""}</span>}
    {selected && !replacementPreview && <span className="object-source">{object.source === "native-pdf" ? "native" : object.source}</span>}
  </div>;
}

function getRenderableFontFamily(object: TextBlock): string {
  // PDF.js exposes subset font identifiers (for example, "g_d0_f1") that a
  // browser cannot resolve. Render those with stable platform fonts instead of
  // falling back unpredictably, while retaining a user-selected font.
  if (object.source !== "native-pdf" || !/^g_|^f\d+$/i.test(object.style.fontFamily)) return object.style.fontFamily;
  return object.language === "ar" || object.language === "mixed"
    ? '"Noto Naskh Arabic", "Noto Sans Arabic", Arial, sans-serif'
    : 'Arial, "Helvetica Neue", Helvetica, sans-serif';
}

function PageRenderSurface({ page, mutedTextId }: { page: DocumentPage; mutedTextId: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskSignature = page.objects
    .filter((object): object is TextBlock => object.type === "text" && object.source === "native-pdf" && (object.id === mutedTextId || object.originalText !== object.text))
    .map((object) => `${object.id}:${object.text}`)
    .join("|");

  useEffect(() => {
    if (!page.background || !canvasRef.current) return;
    let disposed = false;
    const canvas = canvasRef.current;
    const image = new Image();
    image.onload = () => {
      if (disposed) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      context.drawImage(image, 0, 0);
      const scaleX = canvas.width / page.width;
      const scaleY = canvas.height / page.height;
      page.objects
        .filter((object): object is TextBlock => object.type === "text" && object.source === "native-pdf" && (object.id === mutedTextId || object.originalText !== object.text))
        .forEach((object) => concealSourceText(context, object, scaleX, scaleY));
    };
    image.src = page.background;
    return () => { disposed = true; };
  }, [page, mutedTextId, maskSignature]);

  if (!page.background) return null;
  return <canvas ref={canvasRef} className="page-render-surface" aria-hidden="true" />;
}

function concealSourceText(context: CanvasRenderingContext2D, object: TextBlock, scaleX: number, scaleY: number): void {
  const paddingX = Math.max(2, scaleX * 1.5);
  const paddingY = Math.max(2, scaleY * 1.5);
  const x = Math.max(0, object.bbox.x * scaleX - paddingX);
  const y = Math.max(0, object.bbox.y * scaleY - paddingY);
  const width = Math.min(context.canvas.width - x, object.bbox.width * scaleX + paddingX * 2);
  const height = Math.min(context.canvas.height - y, object.bbox.height * scaleY + paddingY * 2);
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

function PropertiesPanel({ selected, onTextChange, onStyleChange, onDirectionChange, onDelete, onDuplicate }: { selected: PageObject | null; onTextChange: (value: string) => void; onStyleChange: (value: Partial<TextStyle>) => void; onDirectionChange: (direction: TextDirection) => void; onDelete: () => void; onDuplicate: () => void }) {
  if (!selected) return <div className="empty-inspector"><span className="empty-glyph">⌁</span><strong>Select an object</strong><p>Text, tables, form fields, and recognized graphics keep their own semantic metadata.</p></div>;
  if (selected.type !== "text") return <div className="object-inspector"><span className="eyebrow">{selected.type.replace("-", " ")}</span><h2>{objectLabel(selected)}</h2><div className="confidence-card"><span>Recognition confidence</span><strong>{formatConfidence(selected.confidence)}</strong><i><b style={{ width: `${selected.confidence * 100}%` }} /></i></div><dl><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Bounds</dt><dd>{Math.round(selected.bbox.width)} × {Math.round(selected.bbox.height)} pt</dd></div><div><dt>Direction</dt><dd>{selected.direction}</dd></div></dl><div className="inspector-buttons"><button onClick={onDuplicate}>Duplicate</button><button className="danger" onClick={onDelete}>Delete</button></div></div>;
  return <div className="object-inspector">
    <div className="property-heading"><div><span className="eyebrow">Text block</span><h2>Content & type</h2></div><span className={`source-pill ${selected.source}`}>{selected.source}</span></div>
    <label className="field-label">Text <textarea value={selected.text} dir={selected.direction === "auto" ? undefined : selected.direction} onChange={(event) => onTextChange(event.target.value)} /></label>
    <div className="field-grid">
      <label className="field-label">Font <select value={selected.style.fontFamily.includes("Noto") ? "Noto Naskh Arabic" : "Inter"} onChange={(event) => onStyleChange({ fontFamily: event.target.value === "Noto Naskh Arabic" ? "Noto Naskh Arabic, Arial, sans-serif" : "Inter, Arial, sans-serif" })}><option>Inter</option><option>Noto Naskh Arabic</option><option>Arial</option></select></label>
      <label className="field-label">Size <input type="number" min="7" max="72" value={Math.round(selected.style.fontSize)} onChange={(event) => onStyleChange({ fontSize: Number(event.target.value) || 12 })} /></label>
    </div>
    <div className="format-strip"><button className={selected.style.fontWeight >= 600 ? "is-on" : ""} onClick={() => onStyleChange({ fontWeight: selected.style.fontWeight >= 600 ? 400 : 700 })}><b>B</b></button><button className={selected.style.fontStyle === "italic" ? "is-on" : ""} onClick={() => onStyleChange({ fontStyle: selected.style.fontStyle === "italic" ? "normal" : "italic" })}><i>I</i></button><input aria-label="Text color" type="color" value={selected.style.color} onChange={(event) => onStyleChange({ color: event.target.value })} /><span /></div>
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
  return <div className="review-panel"><div className="panel-heading"><span className="eyebrow">Quality gate</span><h2>Recognition review</h2></div><div className="review-hero"><span>{page.sourceKind === "native" ? "Native source" : page.sourceKind === "hybrid" ? "Hybrid source" : "Scanned source"}</span><strong>{page.nativeTextCount} text objects</strong><small>{page.imageCount} image operations detected</small></div><div className="review-list">{uncertain.length ? uncertain.map((object) => <div key={object.id}><span className="warning-dot" /><p><strong>{objectLabel(object)}</strong><small>{formatConfidence(object.confidence)} confidence · {object.source}</small></p><button>Review</button></div>) : <div className="review-clear"><span>✓</span><p>All current objects meet the review threshold.</p></div>}</div><div className={`export-readiness ${readiness.canExport ? "ready" : "held"}`}><span>{readiness.canExport ? "Export ready" : "Export held"}</span>{readiness.messages.map((message) => <p key={message}>{message}</p>)}</div></div>;
}

function SearchPanel({ search, setSearch, document, onSelect }: { search: string; setSearch: (value: string) => void; document: EditableDocument; onSelect: (id: string) => void }) {
  const results = search.trim() ? document.pages.flatMap((page) => page.objects.filter((object): object is TextBlock => object.type === "text" && object.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((object) => ({ page: page.number, object }))) : [];
  return <div className="search-panel"><div className="panel-heading"><span className="eyebrow">Semantic search</span><h2>Find text</h2></div><label className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Arabic or English text" autoFocus /></label><p className="search-hint">Search runs against native text and accepted OCR spans. It respects Unicode text; no Arabic reversal is used.</p>{results.map(({ page, object }) => <button className="search-result" key={object.id} onClick={() => onSelect(object.id)}><small>Page {page} · {object.language} · {object.direction}</small><strong>{object.text}</strong></button>)}{search && !results.length && <div className="no-results">No semantic text matches.</div>}</div>;
}
