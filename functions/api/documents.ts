import { Resend } from "resend";
import { requireUser, getRequestMeta } from "../_lib/auth";
import { encryptDocument } from "../_lib/encryption";
import { error, json } from "../_lib/http";
import type { Env } from "../_lib/types";
import {
  createSigningToken,
  getBaseUrl,
  logAuditEvent,
  parseFieldPosition
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

export const onRequestGet = async (context: { request: Request; env: Env }) => {
  try {
    const user = await requireUser(context.request, context.env);
    const rows = await context.env.DB.prepare(
      `
        SELECT
          d.id,
          d.title,
          d.file_name,
          d.recipient_email,
          d.status,
          d.created_at,
          d.signed_at,
          sr.token
        FROM documents d
        LEFT JOIN sign_requests sr ON sr.document_id = d.id
        WHERE d.sender_user_id = ?
        ORDER BY d.created_at DESC
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
        token: string;
      }>();

    const baseUrl = getBaseUrl(context.env, context.request);
    return json(
      (rows.results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        fileName: row.file_name,
        recipientEmail: row.recipient_email,
        status: row.status,
        createdAt: row.created_at,
        signedAt: row.signed_at,
        signingUrl: `${baseUrl}/#/sign/${row.token}`
      }))
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
    const fieldValue = String(formData.get("field") ?? "");
    const file = formData.get("file");

    if (!title || !recipientEmail || !fieldValue || !(file instanceof File)) {
      return error("Title, recipient email, signature field, and PDF file are required.");
    }

    if (file.type !== "application/pdf") {
      return error("Only PDF uploads are supported.");
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return error("PDF uploads must be 10 MB or smaller.");
    }

    const field = parseFieldPosition(fieldValue);
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
        JSON.stringify(field),
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
        recipientEmail
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
        signingUrl
      }
    });

    const safeTitle = escapeHtml(title);
    const safeSenderEmail = escapeHtml(user.email ?? "A sender");

    const resend = new Resend(context.env.RESEND_API_KEY);
    await resend.emails.send({
      from: context.env.RESEND_FROM_EMAIL,
      to: [recipientEmail],
      subject: `Signature requested: ${title}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>SIGN-A-DOC signature request</h2>
          <p>${safeSenderEmail} requested your signature on <strong>${safeTitle}</strong>.</p>
          <p>Log in with this email address and open the document here:</p>
          <p><a href="${signingUrl}">${signingUrl}</a></p>
          <p>If you were not expecting this request, you can ignore this email.</p>
        </div>
      `
    });

    return json({ signingUrl }, { status: 201 });
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
