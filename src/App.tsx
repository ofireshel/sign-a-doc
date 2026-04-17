import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import howItWorksBackground from "./assets/Gemini_Generated_Image_1.png";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

type FieldPosition = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type FieldKind = "signature" | "initials";
type SignatureMode = "draw" | "type";

type RequestField = FieldPosition & {
  kind: FieldKind;
};

type DraftField = RequestField & {
  id: string;
};

type DocumentSummary = {
  id: string;
  title: string;
  fileName: string;
  recipientEmail: string;
  status: string;
  signingUrl: string;
  createdAt: string;
  signedAt: string | null;
  totalMarks: number;
  signatureMarks: number;
  initialsMarks: number;
};

type SigningPayload = {
  document: {
    id: string;
    title: string;
    fileName: string;
    senderEmail: string;
    status: string;
    totalRequests: number;
    pendingRequests: number;
    totalMarks: number;
    signatureMarks: number;
    initialsMarks: number;
  };
  request: {
    token: string;
    recipientEmail: string;
    recipientName: string | null;
    status: string;
    fields: RequestField[];
  };
};

type PdfPagePreview = {
  pageNumber: number;
  imageUrl: string;
  ocrImageDataUrl: string;
  width: number;
  height: number;
};

type PdfEditorField = {
  id: string;
  label: string;
  kind: FieldKind;
  field: FieldPosition;
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_SIZE_LABEL = "10 MB";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const postAuthRedirectStorageKey = "sign-a-doc-post-auth-redirect";
const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      })
    : null;

function fieldKindLabel(fieldKind: FieldKind) {
  return fieldKind === "initials" ? "Initials" : "Signature";
}

function summarizeFields(fields: RequestField[]) {
  return fields.reduce(
    (summary, field) => {
      if (field.kind === "initials") {
        summary.initials += 1;
      } else {
        summary.signatures += 1;
      }

      summary.total += 1;
      return summary;
    },
    {
      total: 0,
      signatures: 0,
      initials: 0
    }
  );
}

function createPreviewFields(
  fields: Array<RequestField | DraftField>
): PdfEditorField[] {
  let signatureCount = 0;
  let initialsCount = 0;

  return fields.map((field, index) => {
    const sequence =
      field.kind === "initials" ? ++initialsCount : ++signatureCount;

    return {
      id: "id" in field ? field.id : `${field.kind}-${index}`,
      label: `${fieldKindLabel(field.kind)} ${sequence}`,
      kind: field.kind,
      field: {
        page: field.page,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height
      }
    };
  });
}

function getFieldDimensions(kind: FieldKind) {
  return kind === "initials"
    ? {
        width: 0.16,
        height: 0.075
      }
    : {
        width: 0.28,
        height: 0.09
      };
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(Boolean(supabase));
  const [refreshDocumentsKey, setRefreshDocumentsKey] = useState(0);

  useEffect(() => {
    if (!supabase) {
      setSessionLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setSessionLoading(false);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setSessionLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    const pendingRedirect = window.sessionStorage.getItem(
      postAuthRedirectStorageKey
    );
    if (!pendingRedirect) {
      return;
    }

    if (pendingRedirect !== window.location.href) {
      window.sessionStorage.removeItem(postAuthRedirectStorageKey);
      window.location.replace(pendingRedirect);
      return;
    }

    window.sessionStorage.removeItem(postAuthRedirectStorageKey);
  }, [session]);

  return (
    <Routes>
      <Route
        path="/"
        element={
          <DashboardPage
            session={session}
            sessionLoading={sessionLoading}
            onRefreshDocuments={() =>
              setRefreshDocumentsKey((current) => current + 1)
            }
            refreshDocumentsKey={refreshDocumentsKey}
          />
        }
      />
      <Route
        path="/sign/:token"
        element={
          <SigningPage
            session={session}
            sessionLoading={sessionLoading}
          />
        }
      />
      <Route
        path="*"
        element={
          <div className="shell shell--centered">
            <div className="panel">
              <p className="eyebrow">SIGN-A-DOC</p>
              <h1>Page not found</h1>
              <p className="muted">
                The route you opened is not available. Go back to the dashboard
                to send or sign documents.
              </p>
              <Link className="button button--primary" to="/">
                Return home
              </Link>
            </div>
          </div>
        }
      />
    </Routes>
  );
}

function DashboardPage({
  session,
  sessionLoading,
  refreshDocumentsKey,
  onRefreshDocuments
}: {
  session: Session | null;
  sessionLoading: boolean;
  refreshDocumentsKey: number;
  onRefreshDocuments: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!session) {
      setDocuments([]);
      return;
    }

    setDocumentsLoading(true);
    setDocumentsError(null);

    authedJsonRequest<DocumentSummary[]>("/api/documents", {
      method: "GET",
      session
    })
      .then((data) => setDocuments(data))
      .catch((error) => setDocumentsError(asErrorMessage(error)))
      .finally(() => setDocumentsLoading(false));
  }, [session, refreshDocumentsKey]);

  useEffect(() => {
    setSelectedDocumentIds((current) =>
      current.filter((id) => documents.some((document) => document.id === id))
    );
  }, [documents]);

  async function handleDeleteSelected() {
    if (!session || !selectedDocumentIds.length) {
      return;
    }

    setDeleting(true);
    setDocumentsError(null);

    try {
      const response = await authedJsonRequest<{ deletedIds: string[] }>(
        "/api/documents",
        {
          method: "DELETE",
          session,
          json: { ids: selectedDocumentIds }
        }
      );

      if (response.deletedIds.length) {
        setSelectedDocumentIds([]);
        onRefreshDocuments();
      }
    } catch (deleteError) {
      setDocumentsError(asErrorMessage(deleteError));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Secure, free, simple</p>
          <h1>Document Sign</h1>
        </div>
      </header>

      <ConfigurationNotice />

      {!session && (
        <section className="grid grid--two" id="how-it-works">
          <div
            className="panel panel--how-it-works"
            style={{
              "--how-it-works-bg": `url("${howItWorksBackground}")`
            } as React.CSSProperties}
          >
            <p className="eyebrow">How it works</p>
            <ol className="list">
              <li>Upload the PDF you want to be signed</li>
              <li>Mark every signature and initials spot</li>
              <li>Email recipient via secure link</li>
            </ol>
          </div>
          <div id="start-signing">
            <AuthPanel />
          </div>
        </section>
      )}

      {session && (
        <>
          <section className="toolbar">
            <div>
              <p className="muted">Signed in as</p>
              <strong>{session.user.email}</strong>
            </div>
            <button
              className="button button--ghost"
              onClick={async () => {
                await supabase?.auth.signOut();
              }}
              type="button"
            >
              Sign out
            </button>
          </section>

          <section className="grid grid--two">
            <NewRequestPanel
              session={session}
              onCreated={onRefreshDocuments}
            />

            <div className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Dashboard</p>
                  <h2>Sent documents</h2>
                </div>
                <div className="section-actions">
                  <button
                    className="button button--ghost"
                    disabled={!documents.length}
                    onClick={() =>
                      setSelectedDocumentIds((current) =>
                        current.length === documents.length
                          ? []
                          : documents.map((document) => document.id)
                      )
                    }
                    type="button"
                  >
                    {selectedDocumentIds.length === documents.length &&
                    documents.length
                      ? "Clear selection"
                      : "Mark all"}
                  </button>
                  <button
                    className="button button--danger"
                    disabled={!selectedDocumentIds.length || deleting}
                    onClick={handleDeleteSelected}
                    type="button"
                  >
                    {deleting
                      ? "Deleting..."
                      : `Delete selected${
                          selectedDocumentIds.length
                            ? ` (${selectedDocumentIds.length})`
                            : ""
                        }`}
                  </button>
                </div>
              </div>

              {sessionLoading || documentsLoading ? (
                <p className="muted">Loading documents...</p>
              ) : null}

              {documentsError ? (
                <p className="error-text">{documentsError}</p>
              ) : null}

              {!documentsLoading && !documents.length ? (
                <p className="muted">
                  No documents have been sent yet. Upload your first PDF to
                  start the signing workflow.
                </p>
              ) : null}

              <div className="stack">
                {documents.map((document) => (
                  <article className="document-card" key={document.id}>
                    <div className="document-card__header">
                      <div className="document-card__title-row">
                        <label className="document-select">
                          <input
                            checked={selectedDocumentIds.includes(document.id)}
                            className="document-select__input"
                            onChange={(event) =>
                              setSelectedDocumentIds((current) =>
                                event.target.checked
                                  ? [...current, document.id]
                                  : current.filter((id) => id !== document.id)
                              )
                            }
                            type="checkbox"
                          />
                          <span>Mark</span>
                        </label>
                        <div>
                          <h3>{document.title}</h3>
                          <p className="muted">
                            {document.fileName} for {document.recipientEmail}
                          </p>
                        </div>
                      </div>
                      <StatusPill status={document.status} />
                    </div>
                    <dl className="meta-list">
                      <div>
                        <dt>Created</dt>
                        <dd>{formatDate(document.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Requested marks</dt>
                        <dd>{document.totalMarks || 0}</dd>
                      </div>
                      <div>
                        <dt>Breakdown</dt>
                        <dd>
                          {document.signatureMarks || 0} signatures,{" "}
                          {document.initialsMarks || 0} initials
                        </dd>
                      </div>
                      <div>
                        <dt>Signed</dt>
                        <dd>
                          {document.signedAt
                            ? formatDate(document.signedAt)
                            : "Waiting for the requested recipient"}
                        </dd>
                      </div>
                    </dl>
                    <input
                      className="input"
                      readOnly
                      value={document.signingUrl ?? ""}
                    />
                  </article>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      <footer className="site-disclaimer panel">
        <p className="eyebrow">Disclaimer</p>
        <p className="muted">
          Document sign will never keep a copy of your document. After the
          signing process is complete, the signed document is sent to the
          requestor by email and no copy is retained. All rights reserved 2026.
        </p>
        <p className="muted">
          If you like this free Document Sign site, please consider donating as
          it wasn&apos;t free to create.{" "}
          <a
            className="site-disclaimer__link"
            href="https://www.paypal.com/donate/?business=CMYHGQAA26SZG&no_recurring=0&currency_code=USD"
            rel="noreferrer"
            target="_blank"
          >
            Donate via PayPal
          </a>
        </p>
      </footer>
    </div>
  );
}

function NewRequestPanel({
  session,
  onCreated
}: {
  session: Session;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [fields, setFields] = useState<DraftField[]>([]);
  const [placementKind, setPlacementKind] = useState<FieldKind | null>(null);
  const [placing, setPlacing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fieldSummary = useMemo(() => summarizeFields(fields), [fields]);
  const canSubmit = Boolean(title.trim() && file && recipientEmail.trim());

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!file) {
      setError("Upload a PDF before sending the request.");
      return;
    }

    if (!recipientEmail.trim()) {
      setError("Enter the recipient email address.");
      return;
    }

    if (!fields.length) {
      setError("Place at least one signature or initials mark on the PDF.");
      return;
    }

    if (placing) {
      setError("Click Done after placing the last mark.");
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`PDF uploads must be ${MAX_UPLOAD_SIZE_LABEL} or smaller.`);
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    setError(null);

    const formData = new FormData();
    formData.append("title", title);
    formData.append("recipientEmail", recipientEmail.trim());
    formData.append("recipientName", recipientName.trim());
    formData.append(
      "fields",
      JSON.stringify(
        fields.map(({ id, ...field }) => field)
      )
    );
    formData.append("file", file);

    try {
      const response = await authedJsonRequest<{
        signingUrl: string;
        fieldCount: number;
      }>("/api/documents", {
        method: "POST",
        body: formData,
        session
      });

      setTitle("");
      setFile(null);
      setRecipientEmail("");
      setRecipientName("");
      setFields([]);
      setPlacementKind(null);
      setPlacing(false);
      setFeedback(
        `Document sent with ${response.fieldCount} requested ${
          response.fieldCount === 1 ? "mark" : "marks"
        }.`
      );
      onCreated();
    } catch (submitError) {
      setError(asErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Sender flow</p>
          <h2>Upload and send a signing request</h2>
        </div>
      </div>

      <form className="stack" onSubmit={handleSubmit}>
        <label className="inline-label">
          Document title
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Board approval letter"
          />
        </label>

        <div className="grid grid--two">
          <label className="inline-label">
            Recipient email
            <input
              className="input"
              type="email"
              value={recipientEmail}
              onChange={(event) => setRecipientEmail(event.target.value)}
              placeholder="recipient@example.com"
            />
          </label>

          <label className="inline-label">
            Recipient name (optional)
            <input
              className="input"
              value={recipientName}
              onChange={(event) => setRecipientName(event.target.value)}
              placeholder="Jane Recipient"
            />
          </label>
        </div>

        <label className="inline-label">
          PDF document
          <input
            className="input"
            accept="application/pdf"
            type="file"
            onChange={(event) => {
              const nextFile = event.target.files?.[0] ?? null;

              if (nextFile && nextFile.size > MAX_UPLOAD_BYTES) {
                setFile(null);
                setFields([]);
                setPlacementKind(null);
                setPlacing(false);
                setError(`PDF uploads must be ${MAX_UPLOAD_SIZE_LABEL} or smaller.`);
                return;
              }

              setFile(nextFile);
              setFields([]);
              setPlacementKind(null);
              setPlacing(false);
              setError(null);
            }}
          />
        </label>

        <div className="callout">
          <strong>Place requested marks</strong>
          <p className="muted">
            Choose <strong>Signature</strong> or <strong>Initials</strong>,
            click the PDF in every required spot, double-click any placed box to
            remove it, then click <strong>Done</strong>.
          </p>
        </div>

        <div className="placement-toolbar">
          <div className="segmented-control">
            <button
              className={`button button--signature ${
                placing && placementKind === "signature"
                  ? "button--signature-active"
                  : ""
              }`}
              onClick={() => {
                setPlacementKind("signature");
                setPlacing(true);
                setFeedback(null);
                setError(null);
              }}
              type="button"
            >
              Signature
            </button>
            <button
              className={`button button--initials ${
                placing && placementKind === "initials"
                  ? "button--initials-active"
                  : ""
              }`}
              onClick={() => {
                setPlacementKind("initials");
                setPlacing(true);
                setFeedback(null);
                setError(null);
              }}
              type="button"
            >
              Initials
            </button>
          </div>

          <button
            className="button button--primary"
            disabled={!placing}
            onClick={() => setPlacing(false)}
            type="button"
          >
            Done
          </button>
        </div>

        <p className="muted">
          {placing && placementKind
            ? `Placing ${fieldKindLabel(placementKind).toLowerCase()} marks. Click anywhere on the PDF to add more.`
            : fields.length
              ? "Placement is paused. Choose Signature or Initials to add more marks."
              : "Choose Signature or Initials to start marking the document."}
        </p>

        <div className="mark-summary-grid">
          <div className="request-card">
            <strong>Total marks</strong>
            <span className="muted">{fieldSummary.total}</span>
          </div>
          <div className="request-card">
            <strong>Signature marks</strong>
            <span className="muted">{fieldSummary.signatures}</span>
          </div>
          <div className="request-card">
            <strong>Initials marks</strong>
            <span className="muted">{fieldSummary.initials}</span>
          </div>
        </div>

        <PdfPlacementEditor
          file={file}
          fields={createPreviewFields(fields)}
          placementKind={placing ? placementKind : null}
          session={session}
          onAddField={(kind, field) => {
            setFields((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                kind,
                ...field
              }
            ]);
            setError(null);
          }}
          onRemoveField={(id) => {
            setFields((current) =>
              current.filter((field) => field.id !== id)
            );
            setError(null);
          }}
        />

        {feedback ? <p className="success-text">{feedback}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        <button
          className="button button--primary"
          disabled={submitting}
          type="submit"
        >
          {submitting ? "Sending..." : "Send signing request"}
        </button>
      </form>
    </div>
  );
}

function SigningPage({
  session,
  sessionLoading
}: {
  session: Session | null;
  sessionLoading: boolean;
}) {
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const [payload, setPayload] = useState<SigningPayload | null>(null);
  const [fileBlob, setFileBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [signatureMode, setSignatureMode] = useState<SignatureMode>("draw");
  const [typedSignature, setTypedSignature] = useState("");
  const [drawnSignature, setDrawnSignature] = useState<string | null>(null);
  const [initialsMode, setInitialsMode] = useState<SignatureMode>("draw");
  const [typedInitials, setTypedInitials] = useState("");
  const [drawnInitials, setDrawnInitials] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    if (!session || !token) {
      return;
    }

    setLoading(true);
    setError(null);

    Promise.all([
      authedJsonRequest<SigningPayload>(`/api/signing/${token}`, {
        method: "GET",
        session
      }),
      authedBlobRequest(`/api/signing/${token}/file`, session)
    ])
      .then(([nextPayload, nextBlob]) => {
        setPayload(nextPayload);
        setFileBlob(nextBlob);
      })
      .catch((loadError) => setError(asErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, [session, token]);

  useEffect(() => {
    if (!feedback || payload?.request.status !== "signed") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      navigate("/");
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [feedback, navigate, payload?.request.status]);

  const hasSignatureFields =
    payload?.request.fields.some((field) => field.kind === "signature") ?? false;
  const hasInitialsFields =
    payload?.request.fields.some((field) => field.kind === "initials") ?? false;

  async function handleSign() {
    if (!session || !payload) {
      return;
    }

    if (hasSignatureFields) {
      if (signatureMode === "type" && !typedSignature.trim()) {
        setError("Type the signature text you want stamped into the PDF.");
        return;
      }

      if (signatureMode === "draw" && !drawnSignature) {
        setError("Draw the signature before completing the document.");
        return;
      }
    }

    if (hasInitialsFields) {
      if (initialsMode === "type" && !typedInitials.trim()) {
        setError("Type the initials text you want stamped into the PDF.");
        return;
      }

      if (initialsMode === "draw" && !drawnInitials) {
        setError("Draw the initials before completing the document.");
        return;
      }
    }

    setSigning(true);
    setError(null);
    setFeedback(null);

    try {
      const response = await authedJsonRequest<{
        message: string;
        requestStatus: string;
        documentStatus: string;
        pendingRequests: number;
      }>(`/api/signing/${token}/sign`, {
        method: "POST",
        session,
        json: {
          marks: {
            signature: hasSignatureFields
              ? {
                  signatureType: signatureMode,
                  typedSignature: typedSignature.trim(),
                  drawnSignature
                }
              : undefined,
            initials: hasInitialsFields
              ? {
                  signatureType: initialsMode,
                  typedSignature: typedInitials.trim(),
                  drawnSignature: drawnInitials
                }
              : undefined
          }
        }
      });

      setPayload((current) =>
        current
          ? {
              ...current,
              document: {
                ...current.document,
                status: response.documentStatus,
                pendingRequests: response.pendingRequests
              },
              request: {
                ...current.request,
                status: response.requestStatus
              }
            }
          : current
      );
      setFeedback(response.message);
    } catch (signError) {
      setError(asErrorMessage(signError));
    } finally {
      setSigning(false);
    }
  }

  return (
    <div className="shell">
      <header className="hero hero--compact">
        <div>
          <p className="eyebrow">Signer flow</p>
          <h1>Review and complete the requested PDF.</h1>
          <p className="muted hero__copy">
            The signer must log in with the invited email address before
            applying the requested signature and initials marks.
          </p>
        </div>
        <Link className="button button--ghost" to="/">
          Dashboard
        </Link>
      </header>

      {!session && (
        <section className="grid grid--two">
          <div className="panel">
            <h2>Log in to sign</h2>
            <p className="muted">
              Use the invited email address to authenticate before opening the
              document. After login, this page will load the PDF and all
              requested marks automatically.
            </p>
          </div>
          <AuthPanel />
        </section>
      )}

      {session && (
        <section className="grid grid--two">
          <div className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Document preview</p>
                <h2>{payload?.document.title ?? "Loading document..."}</h2>
              </div>
              {payload ? <StatusPill status={payload.request.status} /> : null}
            </div>

            {sessionLoading || loading ? (
              <p className="muted">Loading signing request...</p>
            ) : null}

            {payload && fileBlob ? (
              <PdfPlacementEditor
                file={fileBlob}
                fields={createPreviewFields(payload.request.fields)}
                placementKind={null}
                session={session}
                readOnly
              />
            ) : null}
          </div>

          <div className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Apply requested marks</p>
                <h2>Complete the document</h2>
              </div>
            </div>

            {payload ? (
              <dl className="meta-list">
                <div>
                  <dt>Requested for</dt>
                  <dd>{payload.request.recipientEmail}</dd>
                </div>
                <div>
                  <dt>Requested by</dt>
                  <dd>{payload.document.senderEmail}</dd>
                </div>
                <div>
                  <dt>Document progress</dt>
                  <dd>
                    {payload.document.totalRequests - payload.document.pendingRequests}/
                    {payload.document.totalRequests} completed
                  </dd>
                </div>
                <div>
                  <dt>Total marks</dt>
                  <dd>{payload.document.totalMarks}</dd>
                </div>
                <div>
                  <dt>Signatures</dt>
                  <dd>{payload.document.signatureMarks}</dd>
                </div>
                <div>
                  <dt>Initials</dt>
                  <dd>{payload.document.initialsMarks}</dd>
                </div>
              </dl>
            ) : null}

            {hasSignatureFields ? (
              <SignatureInputSection
                count={payload?.document.signatureMarks ?? 0}
                kind="signature"
                mode={signatureMode}
                onDrawnChange={setDrawnSignature}
                onModeChange={setSignatureMode}
                onTypedChange={setTypedSignature}
                typedValue={typedSignature}
              />
            ) : null}

            {hasInitialsFields ? (
              <SignatureInputSection
                count={payload?.document.initialsMarks ?? 0}
                kind="initials"
                mode={initialsMode}
                onDrawnChange={setDrawnInitials}
                onModeChange={setInitialsMode}
                onTypedChange={setTypedInitials}
                typedValue={typedInitials}
              />
            ) : null}

            {feedback ? <p className="success-text">{feedback}</p> : null}
            {error ? <p className="error-text">{error}</p> : null}

            <button
              className="button button--primary"
              disabled={signing || payload?.request.status === "signed"}
              onClick={handleSign}
              type="button"
            >
              {payload?.request.status === "signed"
                ? "Already signed"
                : signing
                  ? "Applying requested marks..."
                  : "Done"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function SignatureInputSection({
  count,
  kind,
  mode,
  onDrawnChange,
  onModeChange,
  onTypedChange,
  typedValue
}: {
  count: number;
  kind: FieldKind;
  mode: SignatureMode;
  onDrawnChange: (value: string | null) => void;
  onModeChange: (mode: SignatureMode) => void;
  onTypedChange: (value: string) => void;
  typedValue: string;
}) {
  return (
    <div className="request-card">
      <div className="section-heading">
        <div>
          <strong>{fieldKindLabel(kind)}</strong>
          <p className="muted">
            {count} requested {count === 1 ? "mark" : "marks"}
          </p>
        </div>
      </div>

      <div className="segmented-control">
        <button
          className={
            mode === "draw" ? "button button--primary" : "button button--ghost"
          }
          onClick={() => onModeChange("draw")}
          type="button"
        >
          Draw {fieldKindLabel(kind).toLowerCase()}
        </button>
        <button
          className={
            mode === "type" ? "button button--primary" : "button button--ghost"
          }
          onClick={() => onModeChange("type")}
          type="button"
        >
          Type {fieldKindLabel(kind).toLowerCase()}
        </button>
      </div>

      {mode === "draw" ? (
        <DrawSignaturePad
          clearLabel={`Clear ${fieldKindLabel(kind).toLowerCase()}`}
          onChange={onDrawnChange}
        />
      ) : (
        <label className="inline-label">
          {fieldKindLabel(kind)} text
          <input
            className="input input--signature"
            value={typedValue}
            onChange={(event) => onTypedChange(event.target.value)}
            placeholder={kind === "initials" ? "Type initials" : "Type your name"}
          />
        </label>
      )}
    </div>
  );
}

function AuthPanel() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleEmailPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    setLoading(true);
    setFeedback(null);
    setError(null);

    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password
        });
        if (signInError) {
          throw signInError;
        }
      } else {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password
        });
        if (signUpError) {
          throw signUpError;
        }
        setFeedback(
          "Account created. Check your email if Supabase email confirmation is enabled."
        );
      }
    } catch (authError) {
      setError(asErrorMessage(authError));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    if (!supabase) {
      setError("Supabase is not configured yet.");
      return;
    }

    setLoading(true);
    setFeedback(null);
    setError(null);
    window.sessionStorage.setItem(
      postAuthRedirectStorageKey,
      window.location.href
    );

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin
      }
    });

    if (oauthError) {
      window.sessionStorage.removeItem(postAuthRedirectStorageKey);
      setError(oauthError.message);
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Authentication</p>
          <h2>{mode === "login" ? "Log in" : "Create account"}</h2>
        </div>
      </div>

      <div className="segmented-control">
        <button
          className={
            mode === "login" ? "button button--primary" : "button button--ghost"
          }
          onClick={() => setMode("login")}
          type="button"
        >
          Log in
        </button>
        <button
          className={
            mode === "signup"
              ? "button button--primary"
              : "button button--ghost"
          }
          onClick={() => setMode("signup")}
          type="button"
        >
          Sign up
        </button>
      </div>

      <button
        className="button button--google"
        disabled={loading}
        onClick={handleGoogleLogin}
        type="button"
      >
        Continue with Google
      </button>

      <div className="divider">or use email and password</div>

      <form className="stack" onSubmit={handleEmailPassword}>
        <label className="inline-label">
          Email
          <input
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </label>

        <label className="inline-label">
          Password
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Choose a secure password"
          />
        </label>

        {feedback ? <p className="success-text">{feedback}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        <button
          className="button button--primary"
          disabled={loading}
          type="submit"
        >
          {loading
            ? "Working..."
            : mode === "login"
              ? "Log in"
              : "Create account"}
        </button>
      </form>
    </div>
  );
}

function PdfPlacementEditor({
  file,
  fields,
  placementKind,
  session,
  onAddField,
  onRemoveField,
  readOnly = false
}: {
  file: File | Blob | null;
  fields: PdfEditorField[];
  placementKind: FieldKind | null;
  session: Session | null;
  onAddField?: (kind: FieldKind, field: FieldPosition) => void;
  onRemoveField?: (id: string) => void;
  readOnly?: boolean;
}) {
  const [translatedFile, setTranslatedFile] = useState<Blob | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const displayFile = showTranslation && translatedFile ? translatedFile : file;
  const pages = usePdfPreview(displayFile);

  useEffect(() => {
    setShowTranslation(false);
    setTranslationLoading(false);
    setTranslationError(null);
    setTranslatedFile(null);
  }, [file]);

  if (!file) {
    return (
      <div className="pdf-placeholder">
        Upload a PDF to preview it here and place signature and initials marks.
      </div>
    );
  }

  if (!pages.length) {
    return <div className="pdf-placeholder">Rendering PDF preview...</div>;
  }

  const canTranslate = Boolean(session);

  async function handleToggleTranslation() {
    if (showTranslation) {
      setShowTranslation(false);
      return;
    }

    if (!file) {
      setTranslationError("Upload or load a PDF before requesting translation.");
      return;
    }

    if (!session) {
      setTranslationError("Log in before translating the PDF preview.");
      return;
    }

    setTranslationError(null);

    if (!translatedFile) {
      setTranslationLoading(true);

      try {
        const sourceFile = file;
        const formData = new FormData();
        formData.append(
          "file",
          sourceFile instanceof File
            ? sourceFile
            : new File([sourceFile], "preview.pdf", { type: "application/pdf" })
        );
        formData.append(
          "pageImages",
          JSON.stringify(
            pages.map((page) => ({
              pageNumber: page.pageNumber,
              imageDataUrl: page.ocrImageDataUrl
            }))
          )
        );
        setTranslatedFile(
          await authedBlobRequest("/api/pdf-translation", session, {
            method: "POST",
            body: formData
          })
        );
      } catch (translationRequestError) {
        setTranslationError(asErrorMessage(translationRequestError));
        return;
      } finally {
        setTranslationLoading(false);
      }
    }

    setShowTranslation(true);
  }

  return (
    <div className="stack">
      <div className="pdf-toolbar">
        <button
          className={`button button--translate ${
            showTranslation ? "button--translate-active" : ""
          }`}
          aria-pressed={showTranslation}
          disabled={translationLoading || !canTranslate}
          onClick={() => {
            handleToggleTranslation().catch(() => undefined);
          }}
          type="button"
        >
          {translationLoading
            ? "Translating..."
            : showTranslation
              ? "Show original PDF"
              : "Show English translation"}
        </button>
        {!canTranslate ? (
          <p className="muted pdf-toolbar__hint">
            Translation is available after sign-in.
          </p>
        ) : (
          <p className="muted pdf-toolbar__hint">
            The translated English version is generated server-side, uses OCR for
            scanned PDFs when needed, and does not replace the stored original
            PDF.
          </p>
        )}
      </div>
      {translationError ? <p className="error-text">{translationError}</p> : null}
      <div className="pdf-stack">
      {pages.map((page) => {
        const pageFields = fields.filter((item) => item.field.page === page.pageNumber);

        return (
          <div
            className={`pdf-page ${
              readOnly ? "pdf-page--readonly" : ""
            }`}
            key={page.pageNumber}
            onClick={(event) => {
              if (readOnly || !placementKind || !onAddField) {
                return;
              }

              const rect = (
                event.currentTarget as HTMLDivElement
              ).getBoundingClientRect();
              const { width, height } = getFieldDimensions(placementKind);
              const clickX = (event.clientX - rect.left) / rect.width;
              const clickY = (event.clientY - rect.top) / rect.height;

              onAddField(placementKind, {
                page: page.pageNumber,
                x: clamp(clickX - width / 2, 0.02, 0.98 - width),
                y: clamp(clickY - height / 2, 0.02, 0.98 - height),
                width,
                height
              });
            }}
          >
            <img
              alt={`PDF page ${page.pageNumber}`}
              className="pdf-page__image"
              src={page.imageUrl}
            />
            <span className="pdf-page__number">Page {page.pageNumber}</span>
            {pageFields.map((item) => (
              <div
                className={`signature-box signature-box--${item.kind} ${
                  !readOnly && placementKind === item.kind
                    ? "signature-box--active"
                    : ""
                }`}
                key={item.id}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!readOnly) {
                    onRemoveField?.(item.id);
                  }
                }}
                style={{
                  left: `${item.field.x * 100}%`,
                  top: `${item.field.y * 100}%`,
                  width: `${item.field.width * 100}%`,
                  height: `${item.field.height * 100}%`
                }}
                title={readOnly ? item.label : `${item.label}. Double-click to remove.`}
              >
                {item.label}
              </div>
            ))}
          </div>
        );
      })}
      </div>
    </div>
  );
}

function DrawSignaturePad({
  clearLabel = "Clear signature",
  onChange
}: {
  clearLabel?: string;
  onChange: (signature: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#0f172a";
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
  }, []);

  function pointerPosition(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function beginDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const point = pointerPosition(event);
    if (!canvas || !context || !point) {
      return;
    }

    drawingRef.current = true;
    context.beginPath();
    context.moveTo(point.x, point.y);
  }

  function continueDrawing(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const point = pointerPosition(event);
    if (!drawingRef.current || !canvas || !context || !point) {
      return;
    }

    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function endDrawing() {
    if (!drawingRef.current) {
      return;
    }

    drawingRef.current = false;
    onChange(exportTrimmedSignature(canvasRef.current));
  }

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        className="signature-pad__canvas"
        height={180}
        onPointerDown={beginDrawing}
        onPointerLeave={endDrawing}
        onPointerMove={continueDrawing}
        onPointerUp={endDrawing}
        width={560}
      />
      <button
        className="button button--ghost"
        onClick={() => {
          const canvas = canvasRef.current;
          const context = canvas?.getContext("2d");
          if (!canvas || !context) {
            return;
          }

          context.clearRect(0, 0, canvas.width, canvas.height);
          context.strokeStyle = "#0f172a";
          context.lineWidth = 2;
          context.lineJoin = "round";
          context.lineCap = "round";
          onChange(null);
        }}
        type="button"
      >
        {clearLabel}
      </button>
    </div>
  );
}

function ConfigurationNotice() {
  const frontendMissing = useMemo(() => {
    const missing: string[] = [];
    if (!supabaseUrl) {
      missing.push("VITE_SUPABASE_URL");
    }
    if (!supabaseAnonKey) {
      missing.push("VITE_SUPABASE_ANON_KEY");
    }
    return missing;
  }, []);

  if (!frontendMissing.length) {
    return null;
  }

  return (
    <section className="panel panel--warning">
      <h2>Configuration still needed</h2>
      <p className="muted">
        The UI is ready, but the deployed app still needs these public frontend
        variables:
      </p>
      <ul className="list">
        {frontendMissing.map((item) => (
          <li key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-pill--${status.toLowerCase()}`}>
      {status}
    </span>
  );
}

function usePdfPreview(file: File | Blob | null) {
  const [pages, setPages] = useState<PdfPagePreview[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      if (!file) {
        setPages([]);
        return;
      }

      const buffer = await file.arrayBuffer();
      const pdf = await getDocument({ data: buffer }).promise;
      const nextPages: PdfPagePreview[] = [];

      for (let index = 1; index <= pdf.numPages; index += 1) {
        const page = await pdf.getPage(index);
        const viewport = page.getViewport({ scale: 1.2 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) {
          continue;
        }

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({
          canvas,
          canvasContext: context,
          viewport
        }).promise;

        nextPages.push({
          pageNumber: index,
          imageUrl: canvas.toDataURL("image/png"),
          ocrImageDataUrl: createOcrImageDataUrl(canvas),
          width: viewport.width,
          height: viewport.height
        });
      }

      if (!cancelled) {
        setPages(nextPages);
      }
    }

    render().catch(() => {
      if (!cancelled) {
        setPages([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [file]);

  return pages;
}

function createOcrImageDataUrl(sourceCanvas: HTMLCanvasElement) {
  const maxWidth = 1200;
  if (sourceCanvas.width <= maxWidth) {
    return sourceCanvas.toDataURL("image/jpeg", 0.58);
  }

  const scale = maxWidth / sourceCanvas.width;
  const targetCanvas = document.createElement("canvas");
  targetCanvas.width = maxWidth;
  targetCanvas.height = Math.round(sourceCanvas.height * scale);
  const context = targetCanvas.getContext("2d");
  if (!context) {
    return sourceCanvas.toDataURL("image/jpeg", 0.58);
  }

  context.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
  return targetCanvas.toDataURL("image/jpeg", 0.58);
}

async function authedJsonRequest<T>(
  url: string,
  options: {
    method: string;
    session: Session;
    body?: FormData;
    json?: unknown;
  }
) {
  const headers = new Headers({
    Authorization: `Bearer ${options.session.access_token}`
  });

  let body: BodyInit | undefined;
  if (options.body) {
    body = options.body;
  } else if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body
  });

  if (!response.ok) {
    throw await readError(response);
  }

  return (await response.json()) as T;
}

async function authedBlobRequest(
  url: string,
  session: Session,
  options: {
    method?: string;
    body?: BodyInit;
  } = {}
) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.access_token}`
    },
    body: options.body
  });

  if (!response.ok) {
    throw await readError(response);
  }

  return response.blob();
}

async function readError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

function asErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function exportTrimmedSignature(canvas: HTMLCanvasElement | null) {
  if (!canvas) {
    return null;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const { width, height } = canvas;
  const { data } = context.getImageData(0, 0, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const padding = 6;
  const cropX = Math.max(0, minX - padding);
  const cropY = Math.max(0, minY - padding);
  const cropWidth = Math.min(width - cropX, maxX - minX + 1 + padding * 2);
  const cropHeight = Math.min(height - cropY, maxY - minY + 1 + padding * 2);

  const targetCanvas = document.createElement("canvas");
  targetCanvas.width = cropWidth;
  targetCanvas.height = cropHeight;
  const targetContext = targetCanvas.getContext("2d");
  if (!targetContext) {
    return canvas.toDataURL("image/png");
  }

  targetContext.clearRect(0, 0, cropWidth, cropHeight);
  targetContext.drawImage(
    canvas,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return targetCanvas.toDataURL("image/png");
}
