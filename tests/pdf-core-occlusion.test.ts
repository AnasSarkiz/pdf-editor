import assert from "node:assert/strict";
import test from "node:test";
import { pdfCoreTesting } from "../app/lib/pdf-core";

test("foreground paint extraction converts a multi-segment PDF.js stroke through the page CTM", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const path = Float32Array.from([
    0, 10, 10,
    1, 90, 10,
    0, 10, 90,
    1, 90, 90,
  ]);
  const operators = [
    pdfjs.OPS.showText,
    pdfjs.OPS.save,
    pdfjs.OPS.setLineWidth,
    pdfjs.OPS.transform,
    pdfjs.OPS.constructPath,
    pdfjs.OPS.restore,
    pdfjs.OPS.setFillRGBColor,
    pdfjs.OPS.constructPath,
    pdfjs.OPS.paintImageXObject,
  ];
  const args: unknown[][] = [
    [[{ unicode: "Text" }]],
    [],
    [2],
    [2, 0, 0, 2, 10, 20],
    [pdfjs.OPS.stroke, [path], Float32Array.from([10, 10, 90, 90])],
    [],
    ["#ff0000"],
    [pdfjs.OPS.endPath, [path], Float32Array.from([10, 10, 90, 90])],
    ["img_1"],
  ];

  const candidates = pdfCoreTesting.extractForegroundPaintCandidates(
    pdfjs,
    operators,
    args,
    [1, 0, 0, -1, 0, 300],
  );
  assert.deepEqual(candidates.map((candidate) => candidate.operatorIndex), [4, 8]);

  // The recorded stroke bbox covers both distant table rules. They remain
  // separate occluders instead of becoming one table-sized clipping box.
  const recorded = new Map([
    [4, { x: 27, y: 97, width: 166, height: 166 }],
    [8, { x: 90, y: 250, width: 20, height: 20 }],
  ]);
  const analysis = pdfCoreTesting.sourceForegroundAnalysis(
    0,
    candidates,
    (operatorIndex) => recorded.get(operatorIndex),
  );
  assert.deepEqual(analysis.occlusions, [
    { operatorIndex: 4, bbox: { x: 30, y: 258, width: 160, height: 4 } },
    { operatorIndex: 4, bbox: { x: 30, y: 98, width: 160, height: 4 } },
  ]);
  assert.equal(analysis.occlusions.some((occlusion) => occlusion.operatorIndex === 4 && occlusion.bbox.height > 20), false);
  // An image can contain transparent padding, so it becomes a CTM-derived
  // guard bound rather than an opaque clip based on its recorded rectangle.
  assert.deepEqual(analysis.unsafeBounds, [{ x: 0, y: 299, width: 1, height: 1 }]);
  assert.equal(analysis.hasUnboundedRisk, false);
});

test("foreground occlusions contain only paints later than the safely matched text operator", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const behind = Float32Array.from([0, 20, 250, 1, 100, 250, 1, 100, 270, 1, 20, 270, 4]);
  const ahead = Float32Array.from([0, 180, 80, 1, 220, 80, 1, 220, 110, 1, 180, 110, 4]);
  const candidates = pdfCoreTesting.extractForegroundPaintCandidates(
    pdfjs,
    [pdfjs.OPS.constructPath, pdfjs.OPS.showText, pdfjs.OPS.constructPath],
    [
      [pdfjs.OPS.fill, [behind], Float32Array.from([20, 250, 100, 270])],
      [[{ unicode: "Text" }]],
      [pdfjs.OPS.fill, [ahead], Float32Array.from([180, 80, 220, 110])],
    ],
    [1, 0, 0, -1, 0, 300],
  );
  const occlusions = pdfCoreTesting.sourceForegroundOcclusions(
    1,
    candidates,
    () => undefined,
  );
  // The later rectangle does not overlap the original text. It is still
  // retained so moved or expanded text can pass behind it.
  assert.deepEqual(occlusions, [
    { operatorIndex: 2, bbox: { x: 180, y: 190, width: 40, height: 30 } },
  ]);
});

test("an axis-aligned PDF clip remains representable and clips later opaque rectangles", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const clip = Float32Array.from([0, 0, 0, 1, 50, 0, 1, 50, 50, 1, 0, 50, 4]);
  const fill = Float32Array.from([0, 40, 40, 1, 70, 40, 1, 70, 70, 1, 40, 70, 4]);
  const candidates = pdfCoreTesting.extractForegroundPaintCandidates(
    pdfjs,
    [pdfjs.OPS.eoClip, pdfjs.OPS.constructPath, pdfjs.OPS.constructPath],
    [
      [],
      [pdfjs.OPS.endPath, [clip], Float32Array.from([0, 0, 50, 50])],
      [pdfjs.OPS.fill, [fill], Float32Array.from([40, 40, 70, 70])],
    ],
    [1, 0, 0, 1, 0, 0],
  );
  assert.deepEqual(pdfCoreTesting.sourceForegroundOcclusions(-1, candidates, () => undefined), [
    { operatorIndex: 2, bbox: { x: 40, y: 40, width: 10, height: 10 } },
  ]);
});

test("translucent fills and transparent-padded images become guards, never opaque rectangular clips", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const rectangle = Float32Array.from([0, 10, 20, 1, 30, 20, 1, 30, 40, 1, 10, 40, 4]);
  const candidates = pdfCoreTesting.extractForegroundPaintCandidates(
    pdfjs,
    [
      pdfjs.OPS.showText,
      pdfjs.OPS.setGState,
      pdfjs.OPS.constructPath,
      pdfjs.OPS.transform,
      pdfjs.OPS.paintImageXObject,
    ],
    [
      [[{ unicode: "Text" }]],
      [[["ca", 0.5]]],
      [pdfjs.OPS.fill, [rectangle], Float32Array.from([10, 20, 30, 40])],
      [20, 0, 0, 10, 50, 100],
      ["possibly-transparent"],
    ],
    [1, 0, 0, -1, 0, 300],
  );
  const analysis = pdfCoreTesting.sourceForegroundAnalysis(
    0,
    candidates,
    () => ({ x: 0, y: 0, width: 200, height: 300 }),
    200,
    300,
  );
  assert.deepEqual(analysis.occlusions, []);
  assert.deepEqual(analysis.unsafeBounds, [
    { x: 10, y: 260, width: 20, height: 20 },
    { x: 50, y: 190, width: 20, height: 10 },
  ]);
  assert.equal(analysis.hasUnboundedRisk, false);
});

test("curved, nonrectangular, and dashed paints are omitted from clipping", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const triangle = Float32Array.from([0, 0, 0, 1, 20, 0, 1, 10, 20, 4]);
  const dashedLine = Float32Array.from([0, 0, 30, 1, 40, 30]);
  const candidates = pdfCoreTesting.extractForegroundPaintCandidates(
    pdfjs,
    [pdfjs.OPS.constructPath, pdfjs.OPS.setDash, pdfjs.OPS.constructPath],
    [
      [pdfjs.OPS.fill, [triangle], Float32Array.from([0, 0, 20, 20])],
      [[4, 2], 0],
      [pdfjs.OPS.stroke, [dashedLine], Float32Array.from([0, 30, 40, 30])],
    ],
    [1, 0, 0, 1, 0, 0],
  );
  const analysis = pdfCoreTesting.sourceForegroundAnalysis(-1, candidates, () => undefined);
  assert.deepEqual(analysis.occlusions, []);
  assert.equal(analysis.unsafeBounds.length, 2);
  assert.equal(analysis.hasUnboundedRisk, false);
});

test("an exact unique horizontal glyph run safely maps when PDF.js propagates page-wide glyph bounds", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const operators = [
    pdfjs.OPS.beginText,
    pdfjs.OPS.setFont,
    pdfjs.OPS.setTextMatrix,
    pdfjs.OPS.moveText,
    pdfjs.OPS.showText,
    pdfjs.OPS.moveText,
    pdfjs.OPS.showText,
    pdfjs.OPS.moveText,
    pdfjs.OPS.showText,
    pdfjs.OPS.endText,
  ];
  const args: unknown[][] = [
    [],
    ["g_d0_f1", 10],
    [1, 0, 0, 1, 0, 0],
    [40, 50],
    [[{ unicode: "F" }]],
    [8, 0],
    [[{ unicode: "a" }]],
    [8, 0],
    [[{ unicode: "x" }]],
    [],
  ];
  const appearances = pdfCoreTesting.extractTextPaintAppearances(pdfjs, operators, args);
  const target = { text: "Fax", fontName: "g_d0_f1", bbox: { x: 40, y: 50, width: 30, height: 10 }, fontSize: 10 };
  const [match] = pdfCoreTesting.matchTextAppearances(
    [target],
    appearances,
    () => ({ x: 0, y: 0, width: 200, height: 200 }),
    200,
    200,
  );
  assert.equal(match?.operatorIndex, 8);
  assert.deepEqual(match?.operatorIndices, [4, 6, 8]);
  assert.deepEqual(match?.sourceBbox, target.bbox);
  assert.equal(match?.mappingMethod, "exact-glyph-run");
});

test("ambiguous native mappings remain explicitly noneditable", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const oneRunOperators = [
    pdfjs.OPS.beginText,
    pdfjs.OPS.setFont,
    pdfjs.OPS.showText,
    pdfjs.OPS.moveText,
    pdfjs.OPS.showText,
    pdfjs.OPS.endText,
  ];
  const oneRunArgs: unknown[][] = [[], ["g_d0_f1", 10], [[{ unicode: "O" }]], [8, 0], [[{ unicode: "K" }]], []];
  const appearances = pdfCoreTesting.extractTextPaintAppearances(
    pdfjs,
    [...oneRunOperators, ...oneRunOperators],
    [...oneRunArgs, ...oneRunArgs],
  );
  const [match] = pdfCoreTesting.matchTextAppearances(
    [{ text: "OK", fontName: "g_d0_f1", bbox: { x: 40, y: 50, width: 20, height: 10 }, fontSize: 10 }],
    appearances,
    () => ({ x: 0, y: 0, width: 200, height: 200 }),
    200,
    200,
  );
  assert.equal(match, undefined);
  assert.deepEqual(pdfCoreTesting.nativeSourceSafety(false), {
    sourceMappingVerified: false,
    sourceEditSafety: "unmapped",
    editable: false,
    confidence: 0.86,
  });
});

test("an unsafe paint with only dependency-propagated bounds produces an explicit edit lock", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const candidates = pdfCoreTesting.extractForegroundPaintCandidates(
    pdfjs,
    [pdfjs.OPS.showText, pdfjs.OPS.shadingFill],
    [[[{
      unicode: "Text",
    }]], ["unresolved-gradient"]],
    [1, 0, 0, 1, 0, 0],
  );
  const analysis = pdfCoreTesting.sourceForegroundAnalysis(
    0,
    candidates,
    () => ({ x: 0, y: 0, width: 200, height: 300 }),
    200,
    300,
  );
  assert.equal(analysis.hasUnboundedRisk, true);
  assert.deepEqual(pdfCoreTesting.nativeSourceSafety(true, analysis), {
    sourceMappingVerified: true,
    sourceEditSafety: "unbounded-risk",
    editable: false,
    confidence: 1,
  });
});
