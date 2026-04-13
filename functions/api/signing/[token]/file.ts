import { requireUser } from "../../../_lib/auth";
import { decryptDocument } from "../../../_lib/encryption";
import { error } from "../../../_lib/http";
import type { Env } from "../../../_lib/types";
import { getSigningRecord } from "../../../_lib/utils";

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

    const object = await context.env.DOCUMENTS.get(record.original_file_key);
    if (!object) {
      return error("Original PDF was not found in storage.", 404);
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set(
      "Content-Disposition",
      `inline; filename="${record.file_name.replace(/"/g, "")}"`
    );

    return new Response(
      await decryptDocument(await object.arrayBuffer(), context.env),
      {
      headers
      }
    );
  } catch (requestError) {
    return error(
      requestError instanceof Error ? requestError.message : "Unable to load original PDF.",
      500
    );
  }
};
