# Naskh Studio architecture

Naskh Studio is a semantic PDF editor, not a screenshot editor. The source of truth is an `EditableDocument` intermediate representation (IR); the rendered PDF is a view of the source document and the semantic edit layer is a separate interaction surface.

## Current proof-of-concept scope

The browser implementation now validates the highest-risk client path:

1. Validate the PDF signature and size before parsing.
2. Parse a native PDF with PDF.js in a worker.
3. Extract native text items, placement matrices, font identifiers, annotations, and image paint operations.
4. Normalize those into stable semantic objects in one top-left point coordinate system.
5. Render each page separately from its semantic data at a high-quality preview scale.
6. For image-only scanned pages, render a separate 300 dpi canvas and recognize Arabic + English text locally in a browser worker.
7. Support selection, inline text editing, a property inspector, add-text, delete, duplicate, Unicode-aware search, and operation history.
8. Export a valid PDF without rasterizing untouched input pages. Export is held whenever this browser build cannot preserve fidelity safely.

This is deliberately not a claim that arbitrary native PDF content streams can already be rewritten losslessly in the browser. A modified native text block is held for the reconstruction worker rather than covered with a white rectangle or silently flattened.

## Processing pipeline

```mermaid
flowchart LR
  A["PDF file"] --> B["Signature + size validation"]
  B --> C["PDF.js parser worker"]
  C --> D["Native objects\ntext · transforms · forms · image operators"]
  C --> E["Progressive page renderer"]
  D --> F["Normalized EditableDocument IR"]
  G["OCR provider\nlocal / server / hybrid"] --> H["OCR tokens\npolygon · confidence · language"]
  H --> I["Layout + reading order + table providers"]
  I --> F
  F --> J["React interaction layer\nselection · inline edit · inspector"]
  J --> K["Operation log\nundo / redo / serialization"]
  K --> L["Export planner"]
  L --> M["Patch export\nuntouched original pages"]
  L --> N["Reconstruction worker\nchanged native text / shaped Arabic"]
  M --> O["Valid PDF + fidelity report"]
  N --> O
```

## Package boundaries

| Module | Responsibility | UI-free |
| --- | --- | --- |
| `app/lib/document-model.ts` | Strict IR, text metadata, stable IDs, demo fixture | Yes |
| `app/lib/pdf-core.ts` | PDF.js loading, native text/form/image extraction, viewport rendering | Yes |
| `app/lib/recognition.ts` | OCR/layout/table provider interfaces, scan classification, reading order | Yes |
| `app/lib/local-ocr.ts` | Browser-local 300 dpi Arabic + English OCR worker and geometry normalization | Yes |
| `app/lib/export-engine.ts` | Export strategy selection, valid PDF patch/reconstruction proof of concept | Yes |
| `app/page.tsx` | Interaction composition only: selection, tool state, history controls | No |

## Coordinate system

All `bbox` values are points relative to a page whose origin is at top-left. Native PDF coordinates are converted at import. Every object retains its source transformation matrix and rotation, so a reconstruction worker can reason about its original coordinate system rather than relying on DOM pixels.

## Arabic and mixed-direction text

The editor uses browser Unicode bidi handling (`dir="rtl"` / `dir="ltr"` and `unicode-bidi: plaintext`) and detects Arabic at object level. It never reverses Arabic strings. Mixed content remains a Unicode string in the document model and the browser performs shaping/visual ordering for the editing view.

Exporting newly-created or reconstructed Arabic needs two additional worker dependencies: an embeddable Arabic font and HarfBuzz shaping. The export planner blocks that path explicitly until it is present; it does not emit disconnected Arabic glyphs, substitute an incompatible font, or convert the page to an image.

## Export strategies

| Strategy | Status | Intended use |
| --- | --- | --- |
| Patch | Implemented for untouched inputs and new Latin text | Keeps unmodified original pages as PDF objects |
| Reconstruction | Planned worker contract | Changed native content, table edits, shaped Arabic text |
| Flatten | Deliberate opt-in only | Final distribution when the user accepts lost editability |
| OCR layer | Provider contract | Scanned page with a searchable text layer |
| Optimize | Planned | Compression and font subsetting after fidelity validation |

## Security posture

The browser path validates `%PDF-` before parsing, limits this proof of concept to 100 MB, disables PDF.js JavaScript evaluation, and does not send page imagery to an OCR service. Image-only scans are recognized in a local Web Worker using downloaded Arabic and English model files. A future server-assisted provider must make upload consent and retention policy explicit.

## Production worker roadmap

The next worker package should own expensive, cancellable work: page-level OCR, OpenType inspection, HarfBuzz shaping, vector/image extraction, table inference, and granular page reconstruction. Its inputs and results should be versioned IR messages so browser-only, hybrid, and server modes can use the same editor state and test fixtures.
