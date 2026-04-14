import { Resend } from "resend";
import { getRequestMeta, requireUser } from "../../../_lib/auth";
import { decryptDocument, encryptDocument } from "../../../_lib/encryption";
import { applySignatureToPdf } from "../../../_lib/pdf";
import { error, json } from "../../../_lib/http";
import type { Env, FieldKind, SignerField } from "../../../_lib/types";
import {
  getDocumentSignRequests,
  getSigningRecord,
  logAuditEvent,
  parseSignerFields
} from "../../../_lib/utils";

type MarkPayload = {
  signatureType?: "draw" | "type";
  typedSignature?: string;
  drawnSignature?: string;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function describeRequestedMarks(fields: SignerField[]) {
  const hasSignature = fields.some((field) => field.kind === "signature");
  const hasInitials = fields.some((field) => field.kind === "initials");

  if (hasSignature && hasInitials) {
    return "signatures and initials";
  }

  if (hasInitials) {
    return "initials";
  }

  return "signatures";
}

function normalizeMarkPayload(kind: FieldKind, payload: MarkPayload | undefined) {
  if (!payload) {
    throw new Error(`Missing ${kind} input.`);
  }

  if (payload.signatureType !== "draw" && payload.signatureType !== "type") {
    throw new Error(`${kind} signatureType must be draw or type.`);
  }

  if (payload.signatureType === "type" && !payload.typedSignature?.trim()) {
    throw new Error(`typed${kind === "initials" ? "Initials" : "Signature"} is required.`);
  }

  if (payload.signatureType === "draw" && !payload.drawnSignature) {
    throw new Error(`drawn${kind === "initials" ? "Initials" : "Signature"} is required.`);
  }

  return {
    signatureType: payload.signatureType,
    typedSignature: payload.typedSignature?.trim(),
    drawnSignature: payload.drawnSignature
  };
}

export const onRequestPost = async (context: {
  request: Request;
  env: Env;
  params: { token: string };
}) => {
  try {
    const user = await requireUser(context.request, context.env);
    const record = await getSigningRecord(context.env.DB, context.params.token);

    if (!record) {
      return error("Signing request not found.", 404);
    }

    if ((user.email ?? "").toLowerCase() !== record.recipient_email.toLowerCase()) {
      return error("You must log in with the invited recipient email.", 403);
    }

    if (record.request_status === "signed") {
      return error("This document has already been signed.", 409);
    }

    if (!context.env.RESEND_API_KEY || !context.env.RESEND_FROM_EMAIL) {
      return error(
        "Missing RESEND_API_KEY or RESEND_FROM_EMAIL. Configure sender notifications before signing.",
        500
      );
    }

    const body = (await context.request.json()) as {
      marks?: {
        signature?: MarkPayload;
        initials?: MarkPayload;
      };
    };
    const fields = parseSignerFields(record.signer_field_json);

    const marks: Partial<
      Record<
        FieldKind,
        {
          signatureType: "draw" | "type";
          typedSignature?: string;
          drawnSignature?: string;
        }
      >
    > = {};
    const requiredKinds = Array.from(new Set(fields.map((field) => field.kind)));

    for (const kind of requiredKinds) {
      marks[kind] = normalizeMarkPayload(kind, body.marks?.[kind]);
    }

    const object = await context.env.DOCUMENTS.get(record.original_file_key);
    if (!object) {
      return error("Original PDF was not found in storage.", 404);
    }

    const signedBytes = await applySignatureToPdf({
      originalPdf: await decryptDocument(await object.arrayBuffer(), context.env),
      fields,
      marks
    });

    const signedAt = new Date().toISOString();
    const { ipAddress, userAgent } = getRequestMeta(context.request);

    await context.env.DB.batch([
      context.env.DB.prepare(
        `
          UPDATE documents
          SET status = ?, updated_at = ?
          WHERE id = ?
        `
      ).bind("in_progress", signedAt, record.document_id),
      context.env.DB.prepare(
        `
          UPDATE sign_requests
          SET status = ?, recipient_user_id = ?, signed_at = ?
          WHERE token = ?
        `
      ).bind("signed", user.id, signedAt, context.params.token)
    ]);

    const allRequests = await getDocumentSignRequests(context.env.DB, record.document_id);
    const pendingRequests = allRequests.filter((request) => request.status !== "signed");
    const isFinalSignature = pendingRequests.length === 0;

    if (isFinalSignature) {
      const safeTitle = escapeHtml(record.title);
      const safeSignerEmail = escapeHtml(user.email ?? "the recipient");
      const resend = new Resend(context.env.RESEND_API_KEY);

      await resend.emails.send({
        from: context.env.RESEND_FROM_EMAIL,
        to: [record.sender_email],
        subject: `Document signed: ${record.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6;">
            <h2>Your document has been signed</h2>
            <p><strong>${safeTitle}</strong> was completed by ${safeSignerEmail}.</p>
            <p>All requested ${describeRequestedMarks(fields)} were applied and the final PDF is attached.</p>
          </div>
        `,
        attachments: [
          {
            filename: `signed-${record.file_name}`,
            content: toBase64(new Uint8Array(signedBytes))
          }
        ]
      });

      await context.env.DOCUMENTS.delete(record.original_file_key);

      await context.env.DB.prepare(
        `
          UPDATE documents
          SET status = ?, signed_file_key = ?, signed_at = ?, updated_at = ?
          WHERE id = ?
        `
      ).bind("signed", null, signedAt, signedAt, record.document_id).run();
    } else {
      const encryptedSignedBytes = await encryptDocument(
        signedBytes.buffer.slice(
          signedBytes.byteOffset,
          signedBytes.byteOffset + signedBytes.byteLength
        ),
        context.env
      );

      await context.env.DOCUMENTS.put(record.original_file_key, encryptedSignedBytes, {
        httpMetadata: {
          contentType: "application/octet-stream"
        },
        customMetadata: {
          originalFileName: record.file_name,
          originalContentType: "application/pdf",
          encrypted: "true"
        }
      });
    }

    await logAuditEvent({
      db: context.env.DB,
      documentId: record.document_id,
      signRequestId: record.sign_request_id,
      actorUserId: user.id,
      actorEmail: user.email ?? "",
      eventType: "document_signed",
      ipAddress,
      userAgent,
      metadata: {
        requiredKinds,
        completedDocument: isFinalSignature,
        fieldCount: fields.length
      }
    });

    return json({
      message:
        "Thanks for signing the document. The signed document was emailed to the requestor, thank you",
      requestStatus: "signed",
      documentStatus: isFinalSignature ? "signed" : "in_progress",
      pendingRequests: pendingRequests.length
    });
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to sign document.",
      500
    );
  }
};
