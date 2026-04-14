import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { FieldKind, SignerField } from "./types";

function decodeDataUrlImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/png|image\/jpeg);base64,(.+)$/);
  if (!match) {
    throw new Error("Signature drawing must be a PNG or JPEG data URL.");
  }

  const [, mimeType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { bytes, mimeType };
}

type AppliedMark = {
  signatureType: "draw" | "type";
  typedSignature?: string;
  drawnSignature?: string;
};

function getFieldDimensions(field: SignerField, page: { getSize: () => { width: number; height: number } }) {
  const { width, height } = page.getSize();
  const x = field.x * width;
  const y = height - (field.y + field.height) * height;
  const boxWidth = field.width * width;
  const boxHeight = field.height * height;
  const horizontalPadding = Math.max(10, boxWidth * 0.08);
  const verticalPadding = Math.max(8, boxHeight * 0.14);
  const maxRenderWidth = Math.max(1, boxWidth - horizontalPadding * 2);
  const maxRenderHeight = Math.max(1, boxHeight - verticalPadding * 2);

  return {
    x,
    y,
    boxWidth,
    boxHeight,
    horizontalPadding,
    maxRenderWidth,
    maxRenderHeight
  };
}

async function drawFieldMark(args: {
  pdf: PDFDocument;
  field: SignerField;
  mark: AppliedMark;
  typedFont: PDFFont | null;
}) {
  const page = args.pdf.getPage(args.field.page - 1);

  if (!page) {
    throw new Error("The requested signature page does not exist in the PDF.");
  }

  const {
    x,
    y,
    boxWidth,
    boxHeight,
    horizontalPadding,
    maxRenderWidth,
    maxRenderHeight
  } = getFieldDimensions(args.field, page);

  if (args.mark.signatureType === "draw") {
    if (!args.mark.drawnSignature) {
      throw new Error("Missing drawn signature.");
    }

    const image = decodeDataUrlImage(args.mark.drawnSignature);
    const embeddedImage =
      image.mimeType === "image/png"
        ? await args.pdf.embedPng(image.bytes)
        : await args.pdf.embedJpg(image.bytes);

    const aspectRatio = embeddedImage.width / embeddedImage.height;
    let renderWidth = maxRenderWidth;
    let renderHeight = renderWidth / aspectRatio;

    if (renderHeight > maxRenderHeight) {
      renderHeight = maxRenderHeight;
      renderWidth = renderHeight * aspectRatio;
    }

    page.drawImage(embeddedImage, {
      x: x + (boxWidth - renderWidth) / 2,
      y: y + (boxHeight - renderHeight) / 2,
      width: renderWidth,
      height: renderHeight
    });
    return;
  }

  if (!args.mark.typedSignature) {
    throw new Error("Missing typed signature.");
  }

  if (!args.typedFont) {
    throw new Error("Missing signature font.");
  }

  const fontSize = Math.min(
    args.field.kind === "initials" ? 26 : 22,
    Math.max(12, maxRenderHeight * (args.field.kind === "initials" ? 0.68 : 0.55))
  );

  page.drawText(args.mark.typedSignature, {
    x: x + horizontalPadding,
    y: y + (boxHeight - fontSize) / 2,
    size: fontSize,
    font: args.typedFont,
    color: rgb(0.05, 0.11, 0.22),
    maxWidth: maxRenderWidth
  });
}

export async function applySignatureToPdf(args: {
  originalPdf: ArrayBuffer;
  fields: SignerField[];
  marks: Partial<Record<FieldKind, AppliedMark>>;
}) {
  const pdf = await PDFDocument.load(args.originalPdf);
  const needsTypedFont = Object.values(args.marks).some(
    (mark) => mark?.signatureType === "type"
  );
  const typedFont = needsTypedFont
    ? await pdf.embedFont(StandardFonts.HelveticaOblique)
    : null;

  for (const field of args.fields) {
    const mark = args.marks[field.kind];
    if (!mark) {
      throw new Error(`Missing ${field.kind} input.`);
    }

    await drawFieldMark({
      pdf,
      field,
      mark,
      typedFont
    });
  }

  return pdf.save();
}
