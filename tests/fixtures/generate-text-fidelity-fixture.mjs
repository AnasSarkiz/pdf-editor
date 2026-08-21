import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const output = resolve(process.argv[2] ?? "tmp/pdfs/text-fidelity.pdf");
const pdf = await PDFDocument.create();
const page = pdf.addPage([500, 300]);
const regular = await pdf.embedFont(StandardFonts.Helvetica);
const boldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);

for (let index = 0; index < 100; index += 1) {
  const progress = index / 99;
  page.drawRectangle({
    x: index * 5,
    y: 120,
    width: 5.1,
    height: 120,
    color: rgb(0.9 - progress * 0.15, 0.95 - progress * 0.1, 1 - progress * 0.08),
  });
}

page.drawLine({ start: { x: 25, y: 177 }, end: { x: 475, y: 177 }, thickness: 1.25, color: rgb(0.2, 0.48, 0.56) });
page.drawText("Replace this native text", {
  x: 60,
  y: 190,
  size: 12,
  font: boldItalic,
  color: rgb(0.2, 0.4, 0.6),
  characterSpacing: 0.35,
});
page.drawText("Short baseline sample", { x: 60, y: 154, size: 8.5, font: regular, color: rgb(0.12, 0.15, 0.18) });

page.drawRectangle({ x: 25, y: 35, width: 450, height: 60, color: rgb(0.08, 0.12, 0.17) });
page.drawText("Delete this light text", { x: 60, y: 61, size: 11, font: regular, color: rgb(0.92, 0.96, 1) });
page.drawText("Rotated", { x: 425, y: 250, size: 9, font: boldItalic, rotate: degrees(17), color: rgb(0.5, 0.16, 0.24) });

pdf.setTitle("PDF Editor text fidelity regression fixture");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, await pdf.save());
console.log(output);
