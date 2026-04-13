import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { FieldPosition } from "./types";

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

export async function applySignatureToPdf(args: {
  originalPdf: ArrayBuffer;
  field: FieldPosition;
  signatureType: "draw" | "type";
  typedSignature?: string;
  drawnSignature?: string;
  signerEmail: string;
}) {
  const pdf = await PDFDocument.load(args.originalPdf);
  const page = pdf.getPage(args.field.page - 1);

  if (!page) {
    throw new Error("The requested signature page does not exist in the PDF.");
  }

  const { width, height } = page.getSize();
  const x = args.field.x * width;
  const y = height - (args.field.y + args.field.height) * height;
  const boxWidth = args.field.width * width;
  const boxHeight = args.field.height * height;
  const horizontalPadding = Math.max(10, boxWidth * 0.08);
  const verticalPadding = Math.max(8, boxHeight * 0.14);
  const maxRenderWidth = Math.max(1, boxWidth - horizontalPadding * 2);
  const maxRenderHeight = Math.max(1, boxHeight - verticalPadding * 2);

  if (args.signatureType === "draw") {
    if (!args.drawnSignature) {
      throw new Error("Missing drawn signature.");
    }

    const image = decodeDataUrlImage(args.drawnSignature);
    const embeddedImage =
      image.mimeType === "image/png"
        ? await pdf.embedPng(image.bytes)
        : await pdf.embedJpg(image.bytes);

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
  } else {
    if (!args.typedSignature) {
      throw new Error("Missing typed signature.");
    }

    const font = await pdf.embedFont(StandardFonts.HelveticaOblique);
    const fontSize = Math.min(22, Math.max(12, maxRenderHeight * 0.55));

    page.drawText(args.typedSignature, {
      x: x + horizontalPadding,
      y: y + (boxHeight - fontSize) / 2,
      size: fontSize,
      font,
      color: rgb(0.05, 0.11, 0.22),
      maxWidth: maxRenderWidth
    });
  }

  return pdf.save();
}
