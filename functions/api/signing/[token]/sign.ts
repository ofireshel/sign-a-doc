import { Resend } from "resend";
import { getRequestMeta, requireUser } from "../../../_lib/auth";
import { decryptDocument } from "../../../_lib/encryption";
import { applySignatureToPdf } from "../../../_lib/pdf";
import { error, json } from "../../../_lib/http";
import type { Env } from "../../../_lib/types";
import {
  getSigningRecord,
  logAuditEvent,
  parseFieldPosition
} from "../../../_lib/utils";

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
      signatureType?: "draw" | "type";
      typedSignature?: string;
      drawnSignature?: string;
    };

    const signatureType = body.signatureType;
    if (signatureType !== "draw" && signatureType !== "type") {
      return error("signatureType must be draw or type.");
    }

    if (signatureType === "type" && !body.typedSignature?.trim()) {
      return error("typedSignature is required for typed signatures.");
    }

    if (signatureType === "draw" && !body.drawnSignature) {
      return error("drawnSignature is required for drawn signatures.");
    }

    const object = await context.env.DOCUMENTS.get(record.original_file_key);
    if (!object) {
      return error("Original PDF was not found in storage.", 404);
    }

    const signedBytes = await applySignatureToPdf({
      originalPdf: await decryptDocument(await object.arrayBuffer(), context.env),
      field: parseFieldPosition(record.signer_field_json),
      signatureType,
      typedSignature: body.typedSignature?.trim(),
      drawnSignature: body.drawnSignature,
      signerEmail: user.email ?? ""
    });

    const signedAt = new Date().toISOString();
    const { ipAddress, userAgent } = getRequestMeta(context.request);

    await context.env.DB.batch([
      context.env.DB.prepare(
        `
          UPDATE documents
          SET status = ?, signed_file_key = ?, signed_at = ?, updated_at = ?
          WHERE id = ?
        `
      ).bind("signed", null, signedAt, signedAt, record.document_id),
      context.env.DB.prepare(
        `
          UPDATE sign_requests
          SET status = ?, recipient_user_id = ?, signed_at = ?
          WHERE token = ?
        `
      ).bind("signed", user.id, signedAt, context.params.token)
    ]);

    await logAuditEvent({
      db: context.env.DB,
      documentId: record.document_id,
      actorUserId: user.id,
      actorEmail: user.email ?? "",
      eventType: "document_signed",
      ipAddress,
      userAgent,
      metadata: {
        signatureType
      }
    });

    const resend = new Resend(context.env.RESEND_API_KEY);
    await resend.emails.send({
      from: context.env.RESEND_FROM_EMAIL,
      to: [record.sender_email],
      subject: `Document signed: ${record.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2>Your document has been signed</h2>
          <p><strong>${record.title}</strong> was signed by ${user.email ?? "the recipient"}.</p>
          <p>The signed PDF is attached to this email. Temporary stored files are encrypted during processing and deleted after delivery.</p>
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

    return json({
      message:
        "Document signed successfully. The signed PDF was emailed to the sender and temporary storage was cleaned up."
    });
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to sign document.",
      500
    );
  }
};
