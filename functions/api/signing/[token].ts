import { getRequestMeta, requireUser } from "../../_lib/auth";
import { error, json } from "../../_lib/http";
import type { Env } from "../../_lib/types";
import {
  getSigningRecord,
  logAuditEvent,
  parseFieldPosition
} from "../../_lib/utils";

export const onRequestGet = async (context: {
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

    const { ipAddress, userAgent } = getRequestMeta(context.request);
    await logAuditEvent({
      db: context.env.DB,
      documentId: record.document_id,
      actorUserId: user.id,
      actorEmail: user.email ?? "",
      eventType: "sign_request_viewed",
      ipAddress,
      userAgent,
      metadata: {
        token: context.params.token
      }
    });

    return json({
      document: {
        id: record.document_id,
        title: record.title,
        fileName: record.file_name,
        senderEmail: record.sender_email,
        status: record.document_status
      },
      request: {
        token: record.token,
        recipientEmail: record.recipient_email,
        recipientName: record.recipient_name,
        status: record.request_status,
        field: parseFieldPosition(record.signer_field_json)
      }
    });
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to load signing request.",
      500
    );
  }
};
