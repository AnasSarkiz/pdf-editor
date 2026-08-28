# PDF Editor

A browser-based PDF editor for Arabic, English, and mixed-direction documents.

The editor keeps document work local to the browser: it opens a PDF, builds an editable semantic model, lets the user update text and markup, and downloads an edited PDF without requiring a file upload service.

**Live editor:** [Open PDF Editor](https://naskh-studio-pdf-editor.anassoftwaredev.chatgpt.site)
**Repository:** [github.com/AnasSarkiz/pdf-editor](https://github.com/AnasSarkiz/pdf-editor)

## What works today

### Edit and review

- Open portrait and landscape PDFs up to 100 MB.
- Select, edit, add, duplicate, move, and resize text blocks.
- Change font, size, weight, italic styling, colour, alignment, rotation, line height, letter spacing, and paragraph direction.
- Search and replace semantic Arabic or English text.
- Review OCR/extraction confidence and inspect the page layer stack.
- Undo and redo text/object edits.
- Use the Pan tool to drag around zoomed pages without moving document objects.
- Navigate text blocks with a keyboard: Space selects and Enter starts editing editable text.

### OCR and language support

- Extract native PDF text where it is available.
- Run local Arabic + English OCR on image-only scans at 300 dpi.
- Search and review recognized scan text. OCR source pixels remain locked until recognition can supply a glyph-accurate cleanup mask; a recognized block can still be duplicated as new editable text.
- Preserve Unicode text, paragraph direction, and mixed Arabic/English content in the editing surface.

### Export

- **Safe native export:** untouched PDFs and compatible newly-added Latin text retain a normal PDF export path.
- **Source-aware native editing:** changed or deleted native PDF text is removed from its original position, overlapping text is recomposed, and edited runs use the same canvas renderer in preview and export.
- **Visual fallback export:** source-text edits and Arabic reconstruction export as a high-quality flattened PDF. This preserves the visible result instead of silently dropping an edit.

## How to use it

1. Select **Open PDF** and choose a PDF file.
2. Use **Select** to edit existing text, or choose **Text** to add a new text box.
3. Use the inspector to change text formatting, direction, and spacing.
4. Select **Export PDF**. The browser downloads an `-edited.pdf` file.

### Phones and tablets

- The first PDF open warms the PDF engine in the background; later opens reuse the browser cache.
- Swipe over unselected text to scroll normally. Select a text block first when you intend to move or resize it.
- Choose **Pan** to drag anywhere on a zoomed page without changing objects.
- Import progress identifies whether the browser is reading the file, loading the PDF engine, extracting text, rendering, or running OCR.
- Keep the tab open while local OCR runs. Image-only scans require more memory and time than native-text PDFs.

## Privacy and security

- PDF parsing, rendering, text extraction, and OCR run in the browser.
- Page imagery and scanned-page OCR input are not uploaded by this application.
- OCR language models may download to the browser the first time OCR is used.
- Imported PDF contents stay on the device; the hosted application downloads only its own code and optional OCR language models.
- There is no permanent redaction capability yet. Do not use visual text cover-ups to redact legal, regulatory, or high-risk information; that requires the planned verified sanitization worker.

## Development

```bash
bun install
bun run dev
bun run lint
bunx tsc --noEmit --incremental false
bun test
bun run build
```

## Technical notes

- React + Vinext client application.
- PDF.js handles browser-side PDF reading, native text extraction, and page rendering.
- Tesseract.js provides local Arabic and English OCR for scanned documents.
- pdf-lib produces compatible PDF output and the flattened visual fallback.
- A shared text compositor preserves extracted font metrics, transforms, spacing, source backgrounds, and preview/export parity.
- The editor uses a semantic document model so text, tables, forms, source confidence, language, and direction are independently represented.

## Roadmap

The next professional modules are:

1. Fillable form creation and AcroForm appearance regeneration.
2. Signature placement and signature-request workflows.
3. Review annotations, comment threads, permanent redaction, page rotation, and drag-and-drop thumbnail reordering.
4. Merge, split, crop, compression, image replace/crop/rotate, watermarking, page numbering, and document metadata editing.
5. Password protection, server-verified sanitizing redaction, and standards-compliant digital signatures.
6. Persistent local drafts, collaboration, cloud-storage integrations, and conversion to/from Office formats.

See [architecture](docs/ARCHITECTURE.md), [dependency and licence evaluation](docs/DEPENDENCIES.md), and [known limitations](docs/KNOWN_LIMITATIONS.md) for implementation detail.
