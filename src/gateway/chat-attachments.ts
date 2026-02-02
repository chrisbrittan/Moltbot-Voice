import {
  extractFileContentFromSource,
  DEFAULT_INPUT_FILE_MIMES,
  DEFAULT_INPUT_FILE_MAX_BYTES,
  DEFAULT_INPUT_FILE_MAX_CHARS,
  DEFAULT_INPUT_PDF_MAX_PAGES,
  DEFAULT_INPUT_PDF_MAX_PIXELS,
  DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  type InputFileLimits,
} from "../media/input-files.js";
import { detectMime } from "../media/mime.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ParsedMessageWithAttachments = {
  message: string;
  images: ChatImageContent[];
};

/** @deprecated Use ParsedMessageWithAttachments */
export type ParsedMessageWithImages = ParsedMessageWithAttachments;

type AttachmentLog = {
  warn: (message: string) => void;
};

function normalizeMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isPdfMime(mime?: string): boolean {
  return mime === "application/pdf";
}

async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) {
    return undefined;
  }

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) {
    return undefined;
  }

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

/**
 * Parse attachments and extract images/documents as structured content blocks.
 * Returns the message text (with PDF text prepended) and an array of image content blocks
 * compatible with Claude API's image format.
 *
 * Supports:
 * - Images (JPEG, PNG, GIF, WebP) - returned as image content blocks
 * - PDFs - text extracted and prepended to message, pages rendered as images if text-light
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number; log?: AttachmentLog },
): Promise<ParsedMessageWithAttachments> {
  const maxBytes = opts?.maxBytes ?? 5_000_000; // 5 MB
  const log = opts?.log;
  if (!attachments || attachments.length === 0) {
    return { message, images: [] };
  }

  const images: ChatImageContent[] = [];
  const extractedTexts: string[] = [];

  // Build limits for PDF extraction
  const fileLimits: InputFileLimits = {
    maxBytes: maxBytes,
    maxChars: DEFAULT_INPUT_FILE_MAX_CHARS,
    allowedMimes: new Set([...DEFAULT_INPUT_FILE_MIMES, "application/pdf"]),
    allowUrl: false,
    timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
    maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
    pdf: {
      maxPages: DEFAULT_INPUT_PDF_MAX_PAGES,
      maxPixels: DEFAULT_INPUT_PDF_MAX_PIXELS,
      minTextChars: DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
    },
  };

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const mime = att.mimeType ?? "";
    const content = att.content;
    const label = att.fileName || att.type || `attachment-${idx + 1}`;

    if (typeof content !== "string") {
      throw new Error(`attachment ${label}: content must be base64 string`);
    }

    let sizeBytes = 0;
    let b64 = content.trim();
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,...")
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(b64);
    if (dataUrlMatch) {
      b64 = dataUrlMatch[1];
    }
    // Basic base64 sanity: length multiple of 4 and charset check.
    if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    try {
      sizeBytes = Buffer.from(b64, "base64").byteLength;
    } catch {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    if (sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`);
    }

    const providedMime = normalizeMime(mime);
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
    const effectiveMime = sniffedMime ?? providedMime;

    // Handle PDFs
    if (isPdfMime(effectiveMime)) {
      log?.warn(`attachment ${label}: processing PDF`);
      try {
        const result = await extractFileContentFromSource({
          source: {
            type: "base64",
            data: b64,
            mediaType: "application/pdf",
            filename: att.fileName || label,
          },
          limits: fileLimits,
        });

        // Add extracted text
        if (result.text?.trim()) {
          extractedTexts.push(`[PDF: ${label}]\n${result.text}`);
        }

        // Add rendered page images if available
        if (result.images) {
          for (const img of result.images) {
            images.push({
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
            });
          }
        }
      } catch (err) {
        log?.warn(`attachment ${label}: PDF extraction failed: ${String(err)}`);
        throw new Error(`attachment ${label}: failed to process PDF - ${String(err)}`);
      }
      continue;
    }

    // Handle images
    if (sniffedMime && !isImageMime(sniffedMime)) {
      log?.warn(`attachment ${label}: detected non-image/non-PDF (${sniffedMime}), dropping`);
      continue;
    }
    if (!sniffedMime && !isImageMime(providedMime)) {
      log?.warn(`attachment ${label}: unable to detect mime type, dropping`);
      continue;
    }
    if (sniffedMime && providedMime && sniffedMime !== providedMime) {
      log?.warn(
        `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
      );
    }

    images.push({
      type: "image",
      data: b64,
      mimeType: sniffedMime ?? providedMime ?? mime,
    });
  }

  // Prepend extracted PDF text to message
  let finalMessage = message;
  if (extractedTexts.length > 0) {
    const pdfContent = extractedTexts.join("\n\n---\n\n");
    finalMessage = message.trim() ? `${pdfContent}\n\n---\n\nUser message: ${message}` : pdfContent;
  }

  return { message: finalMessage, images };
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) {
    return message;
  }

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const mime = att.mimeType ?? "";
    const content = att.content;
    const label = att.fileName || att.type || `attachment-${idx + 1}`;

    if (typeof content !== "string") {
      throw new Error(`attachment ${label}: content must be base64 string`);
    }
    if (!mime.startsWith("image/")) {
      throw new Error(`attachment ${label}: only image/* supported`);
    }

    let sizeBytes = 0;
    const b64 = content.trim();
    // Basic base64 sanity: length multiple of 4 and charset check.
    if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    try {
      sizeBytes = Buffer.from(b64, "base64").byteLength;
    } catch {
      throw new Error(`attachment ${label}: invalid base64 content`);
    }
    if (sizeBytes <= 0 || sizeBytes > maxBytes) {
      throw new Error(`attachment ${label}: exceeds size limit (${sizeBytes} > ${maxBytes} bytes)`);
    }

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${content})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) {
    return message;
  }
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
