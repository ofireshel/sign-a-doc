import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { getDocument } from "pdfjs-serverless";

type PdfTextBlock = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

type TranslationPage = {
  pageNumber: number;
  blocks: PdfTextBlock[];
};

type OcrPageImage = {
  pageNumber: number;
  imageDataUrl: string;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

const MAX_TRANSLATION_PAGES = 3;
const MAX_TRANSLATION_BLOCKS = 400;
const MAX_TRANSLATION_CHARACTERS = 25000;
const translationResponseSchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pageNumber: { type: "integer" },
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" }
              },
              required: ["id", "text"]
            }
          }
        },
        required: ["pageNumber", "blocks"]
      }
    }
  },
  required: ["pages"]
} as const;
const ocrResponseSchema = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          box_2d: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4
          }
        },
        required: ["text", "box_2d"]
      }
    }
  },
  required: ["blocks"]
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizePdfText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isPdfTextItem(
  value: unknown
): value is {
  str: string;
  width: number;
  height: number;
  transform: number[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const item = value as {
    str?: unknown;
    width?: unknown;
    height?: unknown;
    transform?: unknown;
  };

  return (
    typeof item.str === "string" &&
    typeof item.width === "number" &&
    typeof item.height === "number" &&
    Array.isArray(item.transform) &&
    item.transform.length >= 6 &&
    item.transform.every((entry) => typeof entry === "number")
  );
}

function mergePdfTextInline(previousText: string, nextText: string) {
  if (!previousText) {
    return nextText;
  }

  if (/[-/(\[]$/.test(previousText) || /^[,.;:!?)]/.test(nextText)) {
    return `${previousText}${nextText}`;
  }

  return `${previousText} ${nextText}`;
}

function shouldMergePdfTextTokens(previous: PdfTextBlock, next: PdfTextBlock) {
  const baselineTolerance = Math.max(previous.height, next.height) * 0.7;
  const gap = next.x - (previous.x + previous.width);
  return (
    Math.abs(previous.y - next.y) < baselineTolerance &&
    gap > -0.01 &&
    gap < Math.max(previous.height, next.height) * 2.2
  );
}

function shouldMergePdfTextLines(previous: PdfTextBlock, next: PdfTextBlock) {
  const verticalGap = next.y - (previous.y + previous.height);
  const horizontalOffset = Math.abs(previous.x - next.x);
  const widthRatio =
    Math.max(previous.width, next.width) /
    Math.max(Math.min(previous.width, next.width), 0.01);
  const centerOffset = Math.abs(
    previous.x + previous.width / 2 - (next.x + next.width / 2)
  );

  return (
    verticalGap >= -0.01 &&
    verticalGap < Math.max(previous.height, next.height) * 1.8 &&
    horizontalOffset < 0.045 &&
    centerOffset < 0.055 &&
    widthRatio < 2.8
  );
}

function blockNeedsTranslation(text: string) {
  const letters = Array.from(text).filter((character) => /\p{Letter}/u.test(character));
  if (!letters.length) {
    return false;
  }

  const nonLatinLetters = letters.filter(
    (character) => !/\p{Script=Latin}/u.test(character)
  ).length;

  return (
    nonLatinLetters > 0 &&
    nonLatinLetters >= Math.max(1, Math.floor(letters.length * 0.25))
  );
}

function extractPdfTextBlocks(
  items: unknown[],
  viewport: { width: number; height: number }
) {
  const rawBlocks: PdfTextBlock[] = [];

  items.forEach((item) => {
    if (!isPdfTextItem(item)) {
      return;
    }

    const text = normalizePdfText(item.str);
    if (!text) {
      return;
    }

    const x = clamp(item.transform[4] / viewport.width, 0, 0.98);
    const y = clamp(
      (viewport.height - item.transform[5] - item.height) / viewport.height,
      0,
      0.98
    );
    const width = clamp(
      Math.max(
        item.width,
        Math.min(item.height * Math.max(text.length * 0.45, 1), viewport.width)
      ) / viewport.width,
      0.01,
      0.98 - x
    );
    const height = clamp(Math.max(item.height, 11) / viewport.height, 0.014, 0.12);

    rawBlocks.push({
      id: "",
      text,
      x,
      y,
      width,
      height,
      fontSize: clamp(Math.max(item.height, 11) / viewport.height, 0.014, 0.09)
    });
  });

  rawBlocks.sort((left, right) => {
    if (Math.abs(left.y - right.y) > 0.01) {
      return left.y - right.y;
    }
    return left.x - right.x;
  });

  const inlineMergedBlocks: PdfTextBlock[] = [];

  rawBlocks.forEach((block) => {
    const previous = inlineMergedBlocks[inlineMergedBlocks.length - 1];
    if (previous && shouldMergePdfTextTokens(previous, block)) {
      previous.text = mergePdfTextInline(previous.text, block.text);
      previous.width = clamp(
        Math.max(previous.width, block.x + block.width - previous.x),
        0.01,
        0.98 - previous.x
      );
      previous.height = Math.max(previous.height, block.height);
      previous.fontSize = Math.max(previous.fontSize, block.fontSize);
      return;
    }

    inlineMergedBlocks.push({ ...block });
  });

  return inlineMergedBlocks.map((block, index) => ({
    ...block,
    id: `text-${index + 1}`
  }));
}

async function extractTranslationPages(originalPdf: ArrayBuffer) {
  const document = await getDocument({
    data: new Uint8Array(originalPdf.slice(0))
  }).promise;

  if (document.numPages > MAX_TRANSLATION_PAGES) {
    throw new Error(
      `This PDF cannot be translated because it has more than ${MAX_TRANSLATION_PAGES} pages.`
    );
  }

  const pages: TranslationPage[] = [];

  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const blocks = extractPdfTextBlocks(textContent.items, viewport).filter((block) =>
      blockNeedsTranslation(block.text)
    );

    pages.push({
      pageNumber: index,
      blocks
    });
  }

  return pages;
}

function normalizeTranslationPages(value: TranslationPage[]) {
  const populatedPages = value.filter((page) => page.blocks.length);

  if (!populatedPages.length) {
    throw new Error(
      "This PDF could not be translated because no translatable text was detected, even after OCR."
    );
  }

  const blockCount = populatedPages.reduce((total, page) => total + page.blocks.length, 0);
  const characterCount = populatedPages.reduce(
    (total, page) =>
      total +
      page.blocks.reduce((pageTotal, block) => pageTotal + block.text.length, 0),
    0
  );

  if (blockCount > MAX_TRANSLATION_BLOCKS) {
    throw new Error(
      `PDF translation currently supports up to ${MAX_TRANSLATION_BLOCKS} text blocks at a time.`
    );
  }

  if (characterCount > MAX_TRANSLATION_CHARACTERS) {
    throw new Error(
      `PDF translation currently supports up to ${MAX_TRANSLATION_CHARACTERS.toLocaleString()} extracted characters at a time.`
    );
  }
}

function extractGeminiText(payload: GeminiResponse) {
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty translation response.");
  }

  return text;
}

function parseJsonPayload(value: string) {
  const trimmed = value.trim();

  if (trimmed.startsWith("```")) {
    const cleaned = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    return parseJsonPayload(cleaned);
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const extracted = extractFirstJsonValue(trimmed);
    if (!extracted) {
      throw new Error("Gemini returned translation data that was not valid JSON.");
    }

    return JSON.parse(extracted) as unknown;
  }
}

function extractFirstJsonValue(value: string) {
  const startIndex = value.search(/[\{\[]/);
  if (startIndex < 0) {
    return null;
  }

  const opening = value[startIndex];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === "\"") {
        inString = false;
      }

      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === opening) {
      depth += 1;
      continue;
    }

    if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function buildPrompt(pages: TranslationPage[]) {
  return [
    "Translate the following extracted PDF text blocks into natural English for rebuilding a translated PDF.",
    "If a block is already English, keep it in English and preserve its meaning.",
    "Do not summarize, omit, explain, or add commentary.",
    "Preserve line breaks inside each block whenever possible so the translated text still fits the original document layout.",
    "Return JSON only with this exact shape:",
    '{"pages":[{"pageNumber":1,"blocks":[{"id":"block-id","text":"Translated English text"}]}]}',
    "Keep every pageNumber and every block id from the input.",
    "Every input block must appear exactly once in the output.",
    "",
    JSON.stringify({
      pages: pages.map((page) => ({
        pageNumber: page.pageNumber,
        blocks: page.blocks.map((block) => ({
          id: block.id,
          text: block.text
        }))
      }))
    })
  ].join("\n");
}

function buildOcrPrompt(pageNumber: number) {
  return [
    `Read this scanned PDF page ${pageNumber}.`,
    "Return JSON only with this exact shape:",
    '{"blocks":[{"text":"detected text","box_2d":[ymin,xmin,ymax,xmax]}]}',
    "Use box_2d normalized to a 0-1000 scale.",
    "Each block should be a compact single line or short phrase, not a full paragraph.",
    "Translate every non-English text region you can read into natural English.",
    "Skip regions that are already fully English.",
    "Keep each returned block aligned to the original text region on the page.",
    "Include printed form labels and typed/printed values when legible.",
    "Do not include commentary or markdown fences."
  ].join("\n");
}

function parseImageDataUrl(value: string) {
  const match = value.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error("OCR page image data is invalid.");
  }

  const [, mimeType, data] = match;
  return { mimeType, data };
}

function normalizeOcrBox(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("OCR block box is invalid.");
  }

  const numbers = value.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isFinite(entry))) {
    throw new Error("OCR block box is invalid.");
  }

  const [ymin, xmin, ymax, xmax] = numbers;
  return {
    x: clamp(xmin / 1000, 0, 0.98),
    y: clamp(ymin / 1000, 0, 0.98),
    width: clamp((xmax - xmin) / 1000, 0.01, 0.98),
    height: clamp((ymax - ymin) / 1000, 0.014, 0.12)
  };
}

function normalizeOcrBlocks(pageNumber: number, payload: unknown): TranslationPage {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OCR response payload is invalid.");
  }

  const blocksValue = (payload as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocksValue)) {
    throw new Error("OCR response payload is invalid.");
  }

  const blocks = blocksValue
    .map((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return null;
      }

      const parsedBlock = block as {
        text?: unknown;
        box_2d?: unknown;
        bbox?: unknown;
      };
      const text =
        typeof parsedBlock.text === "string" ? normalizePdfText(parsedBlock.text) : "";
      if (!text) {
        return null;
      }

      const box = normalizeOcrBox(parsedBlock.box_2d ?? parsedBlock.bbox);
      return {
        id: `ocr-${pageNumber}-${index + 1}`,
        text,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        fontSize: Math.max(box.height * 0.78, 0.014)
      };
    })
    .filter((block): block is PdfTextBlock => Boolean(block));

  return {
    pageNumber,
    blocks
  };
}

async function ocrTranslationPage(pageImage: OcrPageImage, geminiApiKey: string) {
  const { mimeType, data } = parseImageDataUrl(pageImage.imageDataUrl);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: ocrResponseSchema,
          temperature: 0
        },
        contents: [
          {
            parts: [
              {
                text: buildOcrPrompt(pageImage.pageNumber)
              },
              {
                inlineData: {
                  mimeType,
                  data
                }
              }
            ]
          }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error(`OCR failed with status ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  return normalizeOcrBlocks(
    pageImage.pageNumber,
    parseJsonPayload(extractGeminiText(payload))
  );
}

async function extractTranslationPagesFromOcr(
  pageImages: OcrPageImage[],
  pageNumbers: number[],
  geminiApiKey: string
) {
  const imageMap = new Map(pageImages.map((page) => [page.pageNumber, page]));
  return Promise.all(
    pageNumbers.map(async (pageNumber) => {
      const pageImage = imageMap.get(pageNumber);
      if (!pageImage) {
        throw new Error(
          `This PDF needs OCR for page ${pageNumber}, but the page image was not available.`
        );
      }

      return ocrTranslationPage(pageImage, geminiApiKey);
    })
  );
}

function alignTranslatedPages(
  sourcePages: TranslationPage[],
  translatedValue: unknown
): TranslationPage[] {
  if (
    !translatedValue ||
    typeof translatedValue !== "object" ||
    Array.isArray(translatedValue)
  ) {
    throw new Error("Gemini returned an invalid translation payload.");
  }

  const translatedPagesValue = (translatedValue as { pages?: unknown }).pages;
  if (!Array.isArray(translatedPagesValue)) {
    throw new Error("Gemini translation payload is missing pages.");
  }

  const translatedPageMap = new Map<number, Map<string, string>>();

  translatedPagesValue.forEach((page) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      return;
    }

    const parsedPage = page as {
      pageNumber?: unknown;
      blocks?: unknown;
    };

    if (!Number.isInteger(parsedPage.pageNumber) || !Array.isArray(parsedPage.blocks)) {
      return;
    }

    const blockMap = new Map<string, string>();
    parsedPage.blocks.forEach((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return;
      }

      const parsedBlock = block as {
        id?: unknown;
        text?: unknown;
      };

      if (
        typeof parsedBlock.id === "string" &&
        parsedBlock.id.trim() &&
        typeof parsedBlock.text === "string"
      ) {
        blockMap.set(parsedBlock.id.trim(), parsedBlock.text.trim());
      }
    });

    translatedPageMap.set(Number(parsedPage.pageNumber), blockMap);
  });

  return sourcePages.map((page) => {
    const translatedBlocks = translatedPageMap.get(page.pageNumber);
    if (!translatedBlocks) {
      throw new Error(`Gemini translation is missing page ${page.pageNumber}.`);
    }

    return {
      ...page,
      blocks: page.blocks.map((block) => {
        const translatedText = translatedBlocks.get(block.id);
        if (!translatedText) {
          throw new Error(`Gemini translation is missing block ${block.id}.`);
        }

        return {
          ...block,
          text: translatedText
        };
      })
    };
  });
}

function wrapLine(font: PDFFont, text: string, fontSize: number, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [""];
  }

  const lines: string[] = [];
  let currentLine = words[0];

  for (let index = 1; index < words.length; index += 1) {
    const candidate = `${currentLine} ${words[index]}`;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    currentLine = words[index];
  }

  lines.push(currentLine);
  return lines;
}

function layoutText(font: PDFFont, text: string, fontSize: number, maxWidth: number) {
  return text.split("\n").flatMap((line) => wrapLine(font, line, fontSize, maxWidth));
}

function sanitizePdfTextForWinAnsi(value: string) {
  const replaced = value
    .replace(/\u00A0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2022\u25CF\u25E6]/g, "*")
    .replace(/[\u2610\u2611\u2612\uF06F]/g, "[ ]")
    .replace(/\u2713/g, "v")
    .replace(/\u2717/g, "x");

  return Array.from(replaced.normalize("NFKD"))
    .filter((character) => {
      if (character === "\n" || character === "\r" || character === "\t") {
        return true;
      }

      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint <= 255;
    })
    .join("")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function fitFontSize(
  font: PDFFont,
  text: string,
  initialFontSize: number,
  maxWidth: number,
  maxHeight: number
) {
  let fontSize = initialFontSize;

  while (fontSize >= 6.5) {
    const lines = layoutText(font, text, fontSize, maxWidth);
    const lineHeight = fontSize * 1.16;
    if (lines.length * lineHeight <= maxHeight) {
      return { fontSize, lines, lineHeight };
    }

    fontSize -= 0.5;
  }

  const finalFontSize = 6.5;
  const lines = layoutText(font, text, finalFontSize, maxWidth);
  return {
    fontSize: finalFontSize,
    lines,
    lineHeight: finalFontSize * 1.16
  };
}

async function stampTranslatedPdf(
  originalPdf: ArrayBuffer,
  translatedPages: TranslationPage[]
) {
  const pdf = await PDFDocument.load(originalPdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  translatedPages.forEach((translatedPage) => {
    const page = pdf.getPage(translatedPage.pageNumber - 1);
    if (!page) {
      return;
    }

    const { width: pageWidth, height: pageHeight } = page.getSize();

    translatedPage.blocks.forEach((block) => {
      const safeText = sanitizePdfTextForWinAnsi(block.text);
      if (!safeText.trim()) {
        return;
      }

      const x = block.x * pageWidth;
      const y = pageHeight - (block.y + block.height) * pageHeight;
      const boxWidth = block.width * pageWidth;
      const initialFontSize = Math.max(block.fontSize * pageHeight, 9);
      const boxHeight = Math.max(block.height * pageHeight * 1.4, initialFontSize * 1.35);
      const paddingX = Math.min(Math.max(boxWidth * 0.025, 1.5), 4);
      const paddingY = Math.min(Math.max(boxHeight * 0.05, 1), 3);
      const availableWidth = Math.max(boxWidth - paddingX * 2, 10);
      const availableHeight = Math.max(boxHeight - paddingY * 2, 10);
      const { fontSize, lines, lineHeight } = fitFontSize(
        font,
        safeText,
        initialFontSize,
        availableWidth,
        availableHeight
      );

      page.drawRectangle({
        x: Math.max(0, x - 1),
        y: Math.max(0, y - 1),
        width: Math.min(pageWidth - x + 1, boxWidth + 2),
        height: Math.min(pageHeight - y + 1, boxHeight + 2),
        color: rgb(1, 1, 1),
        opacity: 1
      });

      let currentY = y + boxHeight - paddingY - fontSize;
      lines.forEach((line) => {
        if (currentY < y + paddingY - 1) {
          return;
        }

        page.drawText(line, {
          x: x + paddingX,
          y: currentY,
          size: fontSize,
          font,
          color: rgb(0.07, 0.11, 0.18),
          maxWidth: availableWidth
        });

        currentY -= lineHeight;
      });
    });
  });

  return pdf.save();
}

async function requestTranslatedPages(pages: TranslationPage[], geminiApiKey: string) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: translationResponseSchema
        },
        contents: [
          {
            parts: [
              {
                text: buildPrompt(pages)
              }
            ]
          }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Gemini translation failed with status ${response.status}: ${await response.text()}`
    );
  }

  const payload = (await response.json()) as GeminiResponse;
  return alignTranslatedPages(pages, parseJsonPayload(extractGeminiText(payload)));
}

export async function createTranslatedPdf(
  originalPdf: ArrayBuffer,
  geminiApiKey: string,
  ocrPageImages: OcrPageImage[] = []
) {
  const extractionPdf = originalPdf.slice(0);
  const stampingPdf = originalPdf.slice(0);
  const extractedPages = await extractTranslationPages(extractionPdf);
  const textPages = extractedPages.filter((page) => page.blocks.length);
  const missingPageNumbers = extractedPages
    .filter((page) => !page.blocks.length)
    .map((page) => page.pageNumber);
  const ocrPages = missingPageNumbers.length
    ? await extractTranslationPagesFromOcr(ocrPageImages, missingPageNumbers, geminiApiKey)
    : [];
  const translationPages = [...textPages, ...ocrPages].sort(
    (left, right) => left.pageNumber - right.pageNumber
  );
  normalizeTranslationPages(translationPages);
  const translatedPages = await requestTranslatedPages(translationPages, geminiApiKey);
  return stampTranslatedPdf(stampingPdf, translatedPages);
}
