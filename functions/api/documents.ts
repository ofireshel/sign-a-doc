import { Resend } from "resend";
import { getRequestMeta, requireUser } from "../_lib/auth";
import { encryptDocument } from "../_lib/encryption";
import { error, json } from "../_lib/http";
import type { Env, SignerField } from "../_lib/types";
import {
  createSigningToken,
  getBaseUrl,
  logAuditEvent,
  parseFieldPosition,
  parseSignerFields
} from "../_lib/utils";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseRequestFields(formData: FormData): SignerField[] {
  const fieldsValue = String(formData.get("fields") ?? "").trim();
  if (fieldsValue) {
    return parseSignerFields(fieldsValue);
  }

  const legacyFieldValue = String(formData.get("field") ?? "").trim();
  if (!legacyFieldValue) {
    throw new Error("Add at least one signature or initials field.");
  }

  return [
    {
      ...parseFieldPosition(legacyFieldValue),
      kind: "signature"
    }
  ];
}

function summarizeFields(fields: SignerField[]) {
  return fields.reduce(
    (summary, field) => {
      if (field.kind === "initials") {
        summary.initialsMarks += 1;
      } else {
        summary.signatureMarks += 1;
      }

      summary.totalMarks += 1;
      return summary;
    },
    {
      totalMarks: 0,
      signatureMarks: 0,
      initialsMarks: 0
    }
  );
}

function describeRequestedMarks(fields: SignerField[]) {
  const hasSignature = fields.some((field) => field.kind === "signature");
  const hasInitials = fields.some((field) => field.kind === "initials");

  if (hasSignature && hasInitials) {
    return "signature and initials";
  }

  if (hasInitials) {
    return "initials";
  }

  return "signature";
}

export const onRequestGet = async (context: { request: Request; env: Env }) => {
  try {
    const user = await requireUser(context.request, context.env);
    const [documentRows, requestRows] = await Promise.all([
      context.env.DB.prepare(
        `
          SELECT
            id,
            title,
            file_name,
            recipient_email,
            status,
            created_at,
            signed_at
          FROM documents
          WHERE sender_user_id = ?
          ORDER BY created_at DESC
        `
      )
        .bind(user.id)
        .all<{
          id: string;
          title: string;
          file_name: string;
          recipient_email: string;
          status: string;
          created_at: string;
          signed_at: string | null;
        }>(),
      context.env.DB.prepare(
        `
          SELECT
            sr.document_id,
            sr.token,
            sr.signer_field_json
          FROM sign_requests sr
          INNER JOIN documents d ON d.id = sr.document_id
          WHERE d.sender_user_id = ?
          ORDER BY sr.created_at ASC, sr.id ASC
        `
      )
        .bind(user.id)
        .all<{
          document_id: string;
          token: string;
          signer_field_json: string;
        }>()
    ]);

    const baseUrl = getBaseUrl(context.env, context.request);
    const requestSummaryByDocument = new Map<
      string,
      {
        signingUrl: string;
        totalMarks: number;
        signatureMarks: number;
        initialsMarks: number;
      }
    >();

    for (const row of requestRows.results ?? []) {
      const existing = requestSummaryByDocument.get(row.document_id) ?? {
        signingUrl: `${baseUrl}/#/sign/${row.token}`,
        totalMarks: 0,
        signatureMarks: 0,
        initialsMarks: 0
      };
      const counts = summarizeFields(parseSignerFields(row.signer_field_json));

      existing.totalMarks += counts.totalMarks;
      existing.signatureMarks += counts.signatureMarks;
      existing.initialsMarks += counts.initialsMarks;
      requestSummaryByDocument.set(row.document_id, existing);
    }

    return json(
      (documentRows.results ?? []).map((row) => {
        const summary = requestSummaryByDocument.get(row.id) ?? {
          signingUrl: "",
          totalMarks: 0,
          signatureMarks: 0,
          initialsMarks: 0
        };

        return {
          id: row.id,
          title: row.title,
          fileName: row.file_name,
          recipientEmail: row.recipient_email,
          status: row.status,
          createdAt: row.created_at,
          signedAt: row.signed_at,
          signingUrl: summary.signingUrl,
          totalMarks: summary.totalMarks,
          signatureMarks: summary.signatureMarks,
          initialsMarks: summary.initialsMarks
        };
      })
    );
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to load documents.",
      401
    );
  }
};

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  try {
    const user = await requireUser(context.request, context.env);

    if (!context.env.RESEND_API_KEY || !context.env.RESEND_FROM_EMAIL) {
      return error(
        "Missing RESEND_API_KEY or RESEND_FROM_EMAIL. Configure email before sending signing links.",
        500
      );
    }

    const formData = await context.request.formData();
    const title = String(formData.get("title") ?? "").trim();
    const recipientEmail = String(formData.get("recipientEmail") ?? "")
      .trim()
      .toLowerCase();
    const recipientName = String(formData.get("recipientName") ?? "").trim();
    const file = formData.get("file");

    if (!title || !recipientEmail || !(file instanceof File)) {
      return error("Title, recipient email, and PDF file are required.");
    }

    if (file.type !== "application/pdf") {
      return error("Only PDF uploads are supported.");
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return error("PDF uploads must be 10 MB or smaller.");
    }

    const fields = parseRequestFields(formData);
    const documentId = crypto.randomUUID();
    const signRequestId = crypto.randomUUID();
    const token = createSigningToken();
    const originalFileKey = `documents/${documentId}/original-${file.name}`;
    const baseUrl = getBaseUrl(context.env, context.request);
    const signingUrl = `${baseUrl}/#/sign/${token}`;
    const { ipAddress, userAgent } = getRequestMeta(context.request);
    const encryptedOriginal = await encryptDocument(
      await file.arrayBuffer(),
      context.env
    );

    await context.env.DOCUMENTS.put(originalFileKey, encryptedOriginal, {
      httpMetadata: {
        contentType: "application/octet-stream"
      },
      customMetadata: {
        originalFileName: file.name,
        originalContentType: "application/pdf",
        encrypted: "true"
      }
    });

    const now = new Date().toISOString();

    await context.env.DB.batch([
      context.env.DB.prepare(
        `
          INSERT INTO documents (
            id,
            sender_user_id,
            sender_email,
            title,
            file_name,
            recipient_email,
            original_file_key,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).bind(
        documentId,
        user.id,
        user.email ?? "",
        title,
        file.name,
        recipientEmail,
        originalFileKey,
        "sent",
        now,
        now
      ),
      context.env.DB.prepare(
        `
          INSERT INTO sign_requests (
            id,
            document_id,
            token,
            recipient_email,
            recipient_name,
            signer_field_json,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).bind(
        signRequestId,
        documentId,
        token,
        recipientEmail,
        recipientName || null,
        JSON.stringify(fields),
        "sent",
        now
      )
    ]);

    await logAuditEvent({
      db: context.env.DB,
      documentId,
      signRequestId,
      actorUserId: user.id,
      actorEmail: user.email ?? "",
      eventType: "document_uploaded",
      ipAddress,
      userAgent,
      metadata: {
        title,
        fileName: file.name,
        recipientEmail,
        fieldCount: fields.length
      }
    });

    await logAuditEvent({
      db: context.env.DB,
      documentId,
      signRequestId,
      actorUserId: user.id,
      actorEmail: user.email ?? "",
      eventType: "sign_request_sent",
      ipAddress,
      userAgent,
      metadata: {
        signingUrl,
        fieldCount: fields.length
      }
    });

    const safeTitle = escapeHtml(title);
    const safeSenderEmail = escapeHtml(user.email ?? "A sender");
    const requestedMarks = describeRequestedMarks(fields);

    const resend = new Resend(context.env.RESEND_API_KEY);
    await resend.emails.send({
      from: context.env.RESEND_FROM_EMAIL,
      to: [recipientEmail],
      subject: `Signature requested: ${title}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>SIGN-A-DOC signature request</h2>
          <p>${safeSenderEmail} requested your ${requestedMarks} on <strong>${safeTitle}</strong>.</p>
          <p>Log in with this email address and open the document here:</p>
          <p><a href="${signingUrl}">${signingUrl}</a></p>
          <p>If you were not expecting this request, you can ignore this email.</p>
        </div>
      `
    });

    return json(
      {
        signingUrl,
        fieldCount: fields.length
      },
      { status: 201 }
    );
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to create signing request.",
      500
    );
  }
};

export const onRequestDelete = async (context: {
  request: Request;
  env: Env;
}) => {
  try {
    const user = await requireUser(context.request, context.env);
    const body = (await context.request.json()) as { ids?: string[] };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((value): value is string => typeof value === "string")
      : [];

    if (!ids.length) {
      return error("Select at least one document to delete.");
    }

    const deletedIds: string[] = [];

    for (const id of ids) {
      const document = await context.env.DB.prepare(
        `
          SELECT id, original_file_key, signed_file_key
          FROM documents
          WHERE id = ? AND sender_user_id = ?
          LIMIT 1
        `
      )
        .bind(id, user.id)
        .first<{
          id: string;
          original_file_key: string | null;
          signed_file_key: string | null;
        }>();

      if (!document) {
        continue;
      }

      if (document.original_file_key) {
        await context.env.DOCUMENTS.delete(document.original_file_key);
      }

      if (document.signed_file_key) {
        await context.env.DOCUMENTS.delete(document.signed_file_key);
      }

      await context.env.DB.prepare(`DELETE FROM documents WHERE id = ?`)
        .bind(document.id)
        .run();

      deletedIds.push(document.id);
    }

    return json({
      deletedCount: deletedIds.length,
      deletedIds
    });
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to delete documents.",
      500
    );
  }
};
