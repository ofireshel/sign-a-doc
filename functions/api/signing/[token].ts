import { getRequestMeta, requireUser } from "../../_lib/auth";
import { error, json } from "../../_lib/http";
import type { Env } from "../../_lib/types";
import {
  getDocumentSignRequests,
  getSigningRecord,
  logAuditEvent,
  parseSignerFields
} from "../../_lib/utils";

function summarizeFields(value: string) {
  return parseSignerFields(value).reduce(
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
      signRequestId: record.sign_request_id,
      actorUserId: user.id,
      actorEmail: user.email ?? "",
      eventType: "sign_request_viewed",
      ipAddress,
      userAgent,
      metadata: {
        token: context.params.token
      }
    });

    const allRequests = await getDocumentSignRequests(context.env.DB, record.document_id);
    const counts = summarizeFields(record.signer_field_json);

    return json({
      document: {
        id: record.document_id,
        title: record.title,
        fileName: record.file_name,
        senderEmail: record.sender_email,
        status: record.document_status,
        totalRequests: allRequests.length,
        pendingRequests: allRequests.filter((request) => request.status !== "signed").length,
        totalMarks: counts.totalMarks,
        signatureMarks: counts.signatureMarks,
        initialsMarks: counts.initialsMarks
      },
      request: {
        token: record.token,
        recipientEmail: record.recipient_email,
        recipientName: record.recipient_name,
        status: record.request_status,
        fields: parseSignerFields(record.signer_field_json)
      }
    });
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to load signing request.",
      500
    );
  }
};
