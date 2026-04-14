import type {
  FieldKind,
  FieldPosition,
  SignRequestSummary,
  SignerField,
  SigningRecord
} from "./types";

export function createSigningToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function getBaseUrl(env: { APP_BASE_URL?: string }, request: Request) {
  if (env.APP_BASE_URL) {
    return env.APP_BASE_URL.replace(/\/$/, "");
  }

  const url = new URL(request.url);
  return url.origin;
}

function toValidatedFieldPosition(value: Partial<FieldPosition>): FieldPosition {
  const field: FieldPosition = {
    page: Number(value.page),
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height)
  };

  if (
    !Number.isFinite(field.page) ||
    !Number.isFinite(field.x) ||
    !Number.isFinite(field.y) ||
    !Number.isFinite(field.width) ||
    !Number.isFinite(field.height)
  ) {
    throw new Error("Signature field is invalid.");
  }

  if (
    field.page < 1 ||
    field.x < 0 ||
    field.y < 0 ||
    field.width <= 0 ||
    field.height <= 0 ||
    field.x + field.width > 1 ||
    field.y + field.height > 1
  ) {
    throw new Error("Signature field must fit within the selected page.");
  }

  return field;
}

export function parseFieldPosition(value: string): FieldPosition {
  return toValidatedFieldPosition(JSON.parse(value) as Partial<FieldPosition>);
}

export function parseFieldKind(value: unknown): FieldKind {
  if (value === "signature" || value === "initials") {
    return value;
  }

  throw new Error("Field type must be signature or initials.");
}

function parseSignerField(
  value: unknown,
  fallbackKind: FieldKind = "signature"
): SignerField {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Signature field is invalid.");
  }

  const parsed = value as Partial<SignerField>;
  return {
    ...toValidatedFieldPosition(parsed),
    kind:
      typeof parsed.kind === "string"
        ? parseFieldKind(parsed.kind)
        : fallbackKind
  };
}

export function parseSignerFields(
  value: string,
  fallbackKind: FieldKind = "signature"
): SignerField[] {
  const parsed = JSON.parse(value) as unknown;

  if (Array.isArray(parsed)) {
    if (!parsed.length) {
      throw new Error("Add at least one signature or initials field.");
    }

    return parsed.map((field) => parseSignerField(field, fallbackKind));
  }

  return [parseSignerField(parsed, fallbackKind)];
}

export async function logAuditEvent(args: {
  db: D1Database;
  documentId: string;
  signRequestId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  eventType: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: unknown;
}) {
  await args.db
    .prepare(
      `
        INSERT INTO audit_events (
          id,
          document_id,
          sign_request_id,
          actor_user_id,
          actor_email,
          event_type,
          ip_address,
          user_agent,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      args.documentId,
      args.signRequestId ?? null,
      args.actorUserId ?? null,
      args.actorEmail ?? null,
      args.eventType,
      args.ipAddress ?? null,
      args.userAgent ?? null,
      args.metadata ? JSON.stringify(args.metadata) : null
    )
    .run();
}

export async function getSigningRecord(
  db: D1Database,
  token: string
): Promise<SigningRecord | null> {
  const result = await db
    .prepare(
      `
        SELECT
          sr.id AS sign_request_id,
          d.id AS document_id,
          d.title,
          d.file_name,
          d.sender_user_id,
          d.sender_email,
          d.recipient_email,
          d.original_file_key,
          d.signed_file_key,
          d.status AS document_status,
          d.signed_at,
          sr.status AS request_status,
          sr.token,
          sr.recipient_name,
          sr.signer_field_json
        FROM sign_requests sr
        INNER JOIN documents d ON d.id = sr.document_id
        WHERE sr.token = ?
        LIMIT 1
      `
    )
    .bind(token)
    .first<SigningRecord>();

  return result ?? null;
}

export async function getDocumentSignRequests(
  db: D1Database,
  documentId: string
): Promise<SignRequestSummary[]> {
  const result = await db
    .prepare(
      `
        SELECT
          id,
          document_id,
          token,
          recipient_email,
          recipient_name,
          signer_field_json,
          status,
          signed_at
        FROM sign_requests
        WHERE document_id = ?
        ORDER BY created_at ASC, id ASC
      `
    )
    .bind(documentId)
    .all<SignRequestSummary>();

  return result.results ?? [];
}
