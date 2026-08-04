# Dependency and licence evaluation

The current proof of concept uses two runtime libraries. The next-stage candidates are included to make decisions and constraints visible before they are coupled to the editor.

| Library / capability | Decision | Licence | Why it fits | Constraint |
| --- | --- | --- | --- | --- |
| PDF.js (`pdfjs-dist`) | Included | Apache-2.0 | Mature browser parser/renderer; exposes text content, annotations, operators, and page viewports | Viewer extraction is not a general PDF content-stream editor |
| pdf-lib | Included | MIT | Creates valid PDFs, embeds/loads pages, adds vector/text content, and runs in browser or worker | Does not itself shape complex scripts or safely rewrite arbitrary existing text operators |
| HarfBuzz WASM | Candidate, required for reconstruction | MIT | Correct Arabic joining, glyph selection, and positioning | Needs a font pipeline and glyph-position PDF writer |
| Tesseract.js + Arabic/English trained data | Candidate for private local OCR | Apache-2.0 | Browser-local OCR option; avoids automatic document upload | Large language data and slower first-page processing |
| Server OCR provider adapter | Candidate | Provider-specific | Higher accuracy for low-resolution forms and tables | Requires explicit consent, encryption, retention, and region-aware policies |
| OpenType parser (`fontkit` or equivalent) | Candidate | MIT / BSD variants depending on choice | Font inspection/subsetting and glyph metrics | Verify exact transitive licence before bundling |
| Table recognition model | Provider boundary only | Model-specific | Supports borders, borderless tables, spans, and confidence | Needs a benchmark set before a production selection |

## Selection rationale

PDF.js is the native-object and rendering layer, not the editing source of truth. pdf-lib is used for controlled PDF output but its limitations define a hard safety boundary: the application must schedule a reconstruction worker for arbitrary native text edits instead of concealing old text with a painted rectangle.

Arabic rendering is not satisfied by a generic PDF font API. The production exporter must shape each span with HarfBuzz against an embedded, licensed font and write positioned glyph runs. This repository keeps that requirement visible by blocking the incomplete export path.

## Licence policy

- Keep a machine-readable third-party notice generated in CI before a release.
- Do not ship proprietary OCR models, fonts, or remote services without their redistribution and data-processing terms being reviewed.
- Bundle Arabic fonts only when their embedding and subsetting permissions are compatible with the intended distribution.
- Preserve original embedded fonts where technically and legally possible; otherwise record the fallback in the export report.
