# Naskh Studio

Naskh Studio is a web-based PDF editor proof of concept built around a normalized, editable document model rather than visual page overlays. It is designed for Arabic, English, and mixed-direction documents.

## What this build demonstrates

- Browser-side PDF signature validation, parsing, native text extraction, form-field detection, image-operation counting, and page rendering with PDF.js.
- Stable semantic objects carrying bounds, transformation, source, confidence, language, and direction metadata.
- Unicode-aware Arabic/English editing surface, inline text editing, selection, add/delete/duplicate text, operation-based undo/redo, semantic search, and confidence review.
- Valid PDF export for safe paths, with explicit holds where an export would otherwise degrade fidelity.
- A deliberately separate OCR/layout/table provider boundary that fails closed until the user has selected a local or server-assisted provider.

## Guardrail

This browser proof of concept will not paint over existing native text or rasterize a whole page to simulate editing. Changes that need full page reconstruction, including newly created Arabic text, are held until the shaping/reconstruction worker is available.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Dependency and licence evaluation](docs/DEPENDENCIES.md)
- [Known limitations, fixture plan, and roadmap](docs/KNOWN_LIMITATIONS.md)

## Commands

```bash
npm install
bun run dev
bun run lint
bun test
bun run build
```

The app has no automatic OCR upload path. Any future server-assisted analysis must make consent, retention, and encryption choices explicit.
