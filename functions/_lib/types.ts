export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  GEMINI_API_KEY?: string;
  DOCUMENT_ENCRYPTION_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  APP_BASE_URL?: string;
}

export type FieldPosition = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FieldKind = "signature" | "initials";

export type SignerField = FieldPosition & {
  kind: FieldKind;
};

export type SigningRecord = {
  sign_request_id: string;
  document_id: string;
  title: string;
  file_name: string;
  sender_user_id: string;
  sender_email: string;
  recipient_email: string;
  recipient_name: string | null;
  original_file_key: string;
  signed_file_key: string | null;
  document_status: string;
  request_status: string;
  token: string;
  signer_field_json: string;
  signed_at: string | null;
};

export type SignRequestSummary = {
  id: string;
  document_id: string;
  token: string;
  recipient_email: string;
  recipient_name: string | null;
  signer_field_json: string;
  status: string;
  signed_at: string | null;
};
