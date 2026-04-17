import { requireUser } from "../_lib/auth";
import { createTranslatedPdf } from "../_lib/pdf-translation";
import { error } from "../_lib/http";
import type { Env } from "../_lib/types";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type OcrPageImageInput = {
  pageNumber: number;
  imageDataUrl: string;
};

function normalizeOcrPageImages(value: string | null) {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("OCR page image payload is invalid.");
  }

  return parsed.map((page) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new Error("OCR page image payload is invalid.");
    }

    const parsedPage = page as Partial<OcrPageImageInput>;
    if (
      !Number.isInteger(parsedPage.pageNumber) ||
      Number(parsedPage.pageNumber) < 1 ||
      typeof parsedPage.imageDataUrl !== "string" ||
      !parsedPage.imageDataUrl.startsWith("data:image/")
    ) {
      throw new Error("OCR page image payload is invalid.");
    }

    return {
      pageNumber: Number(parsedPage.pageNumber),
      imageDataUrl: parsedPage.imageDataUrl
    };
  });
}

export const onRequestPost = async (context: {
  request: Request;
  env: Env;
}) => {
  try {
    await requireUser(context.request, context.env);

    if (!context.env.GEMINI_API_KEY) {
      return error("Missing GEMINI_API_KEY in Cloudflare environment.", 500);
    }

    const formData = await context.request.formData();
    const file = formData.get("file");
    const pageImages = normalizeOcrPageImages(
      typeof formData.get("pageImages") === "string"
        ? String(formData.get("pageImages"))
        : null
    );

    if (!(file instanceof File)) {
      return error("PDF file is required.");
    }

    if (file.type !== "application/pdf") {
      return error("Only PDF uploads are supported.");
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return error("PDF uploads must be 10 MB or smaller.");
    }

    const translatedPdf = await createTranslatedPdf(
      await file.arrayBuffer(),
      context.env.GEMINI_API_KEY,
      pageImages
    );
    const safeName = file.name.replace(/\.pdf$/i, "");
    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set(
      "Content-Disposition",
      `inline; filename="${safeName.replace(/"/g, "")}-english.pdf"`
    );

    return new Response(translatedPdf, { headers });
  } catch (requestError) {
    return error(
      requestError instanceof Error
        ? requestError.message
        : "Unable to create the translated PDF.",
      500
    );
  }
};
