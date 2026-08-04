# Current limitations and next delivery slices

## Deliberate safety boundaries

- Native text extraction and selection are implemented, but arbitrary existing PDF text operators are not rewritten in the browser. Changed native text triggers a reconstruction hold instead of visual cover-up or page flattening.
- Arabic and mixed-direction editing is supported in the browser interaction layer through Unicode bidi and native shaping. New or reconstructed Arabic PDF text remains held until the HarfBuzz and embeddable-font worker is added.
- OCR, table recognition, image stream extraction, signature/stamp classification, and font matching are provider interfaces in this proof of concept, not falsely reported as complete models.
- Page rendering is progressive at import time. Viewport virtualization and cancellation are the next performance slice for 100+ page documents.
- The current table demo is structured data with cell confidence; interactive row/column mutation and CSV/XLSX exchange are scheduled for the table engine.
- Original links, vector paths, page rotation, bookmarks, metadata policies, and AcroForm appearance regeneration are retained as pipeline requirements but are not all yet round-tripped.

## Test fixture plan

The benchmark package should include only legally distributable PDFs and paired expected IR/export results:

1. Native English invoice and contract.
2. Native Arabic certificate and form.
3. Arabic/English bank statement with numbers, URLs, and RTL table columns.
4. Low-resolution Arabic and English scanned forms.
5. Borderless, merged-cell, and multi-page tables.
6. Files with logos, signatures, stamps, QR codes, watermarks, rotations, and AcroForms.

Every fixture needs a manifest with expected reading order, text/table confidence, and visual-diff tolerance. Round-trip CI should render original and exported pages, calculate pixel/perceptual similarity, and report positional drift rather than claiming pixel perfection.

## Collaboration roadmap

1. Persist operation logs in IndexedDB and add a versioned document schema.
2. Add collaborative operation transport with conflict-aware text/table operations.
3. Add annotation and comment threads that attach to stable semantic object IDs.
4. Integrate cloud storage with encrypted transfer, retention controls, and per-document OCR upload consent.
5. Add standards-compliant digital signatures after reconstruction/export fidelity is established.
