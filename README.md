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
- Add movable and resizable highlights, comments, and redactions.
- Review OCR/extraction confidence and inspect the page layer stack.
- Undo and redo object edits and page organization actions.

### Organize pages

- Insert blank pages.
- Move a page earlier or later in the document.
- Duplicate or delete pages.
- Keep the revised page order when exporting.

### OCR and language support

- Extract native PDF text where it is available.
- Run local Arabic + English OCR on image-only scans at 300 dpi.
- Preserve Unicode text, paragraph direction, and mixed Arabic/English content in the editing surface.

### Export

- **Safe native export:** untouched PDFs and compatible newly-added Latin text retain a normal PDF export path.
- **Visual fallback export:** edited native text, Arabic reconstruction, annotations, redactions, and page structure changes export as a high-quality flattened PDF. This ensures the visible result is preserved instead of silently losing an edit.
- **Redaction export:** redactions are part of the flattened output, so the downloaded PDF does not retain the original underlying text stream.

## How to use it

1. Select **Open PDF** and choose a PDF file.
2. Use **Select** to edit existing text, or choose **Text** to add a new text box.
3. Use **Highlight**, **Comment**, or **Redact** to add review markup. Drag the object into place and resize it from its handle.
4. Open the **Organize** inspector tab to reorder, duplicate, insert, or delete pages.
5. Select **Export PDF**. The browser downloads an `-edited.pdf` file.

## Privacy and security

- PDF parsing, rendering, text extraction, and OCR run in the browser.
- Page imagery and scanned-page OCR input are not uploaded by this application.
- OCR language models may download to the browser the first time OCR is used.
- The current redaction workflow creates a flattened output rather than rewriting low-level PDF content streams. It is appropriate for the downloaded visual document, but it is **not yet a compliance-certified redaction system**. Legal, regulatory, or high-risk redactions should wait for the planned verified sanitization worker.

## Development

```bash
npm install
bun run dev
bun run lint
bun test
bun run build
```

## Technical notes

- React + Vinext client application.
- PDF.js handles browser-side PDF reading, native text extraction, and page rendering.
- Tesseract.js provides local Arabic and English OCR for scanned documents.
- pdf-lib produces compatible PDF output and the flattened visual fallback.
- The editor uses a semantic document model so text, tables, forms, annotations, source confidence, language, and direction are independently represented.

## Roadmap

The next professional modules are:

1. Fillable form creation and AcroForm appearance regeneration.
2. Signature placement and signature-request workflows.
3. Page rotation, drag-and-drop thumbnail reordering, merge, split, crop, and compression.
4. Image replace/crop/rotate, watermarking, page numbering, and document metadata editing.
5. Password protection, server-verified sanitizing redaction, and standards-compliant digital signatures.
6. Persistent local drafts, collaboration, cloud-storage integrations, and conversion to/from Office formats.

See [architecture](docs/ARCHITECTURE.md), [dependency and licence evaluation](docs/DEPENDENCIES.md), and [known limitations](docs/KNOWN_LIMITATIONS.md) for implementation detail.
