import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

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

type DocumentSummary = {
  id: string;
  title: string;
  fileName: string;
  recipientEmail: string;
  status: string;
  signingUrl: string;
  createdAt: string;
  signedAt: string | null;
};

type SigningPayload = {
  document: {
    id: string;
    title: string;
    fileName: string;
    senderEmail: string;
    status: string;
  };
  request: {
    token: string;
    recipientEmail: string;
    recipientName: string | null;
    status: string;
    field: FieldPosition;
  };
};

type PdfPagePreview = {
  pageNumber: number;
  imageUrl: string;
  width: number;
  height: number;
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
          <h1>Signature request via email</h1>
        </div>
      </header>

      <ConfigurationNotice />

      {!session && (
        <section className="grid grid--two" id="how-it-works">
          <div className="panel">
            <p className="eyebrow">How it works</p>
            <ol className="list">
              <li>Create an account</li>
              <li>Upload the PDF you want to be signed</li>
              <li>Email recipient via secure link</li>
              <li>Receive an email once signed</li>
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
                        <dt>Signed</dt>
                        <dd>
                          {document.signedAt
                            ? formatDate(document.signedAt)
                            : "Waiting for signer"}
                        </dd>
                      </div>
                    </dl>
                    <label className="inline-label">
                      Signing link
                      <input
                        className="input"
                        readOnly
                        value={document.signingUrl}
                      />
                    </label>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </>
      )}
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
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [field, setField] = useState<FieldPosition | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = Boolean(title && recipientEmail && file && field);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!file || !field) {
      setError("Upload a PDF and place the signature field before sending.");
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
    formData.append("recipientEmail", recipientEmail);
    formData.append("recipientName", recipientName);
    formData.append("field", JSON.stringify(field));
    formData.append("file", file);

    try {
      const response = await authedJsonRequest<{ signingUrl: string }>(
        "/api/documents",
        {
          method: "POST",
          body: formData,
          session
        }
      );

      setTitle("");
      setRecipientEmail("");
      setRecipientName("");
      setFile(null);
      setField(null);
      setFeedback(`Document sent. Signing link: ${response.signingUrl}`);
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
                setField(null);
                setError(`PDF uploads must be ${MAX_UPLOAD_SIZE_LABEL} or smaller.`);
                return;
              }

              setFile(nextFile);
              setField(null);
              setError(null);
            }}
          />
        </label>

        <div className="callout">
          <strong>Signature placement</strong>
          <p className="muted">
            Click the preview below to position the signature box. This keeps
            the safer sender-confirmed placement workflow we discussed earlier.
          </p>
        </div>

        <PdfPlacementEditor
          field={field}
          file={file}
          onChange={setField}
        />

        {feedback ? <p className="success-text">{feedback}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        <button
          className="button button--primary"
          disabled={!canSubmit || submitting}
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
  const { token = "" } = useParams();
  const [payload, setPayload] = useState<SigningPayload | null>(null);
  const [fileBlob, setFileBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typedSignature, setTypedSignature] = useState("");
  const [signatureMode, setSignatureMode] = useState<"draw" | "type">("draw");
  const [drawnSignature, setDrawnSignature] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [signedMessage, setSignedMessage] = useState<string | null>(null);

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

  async function handleSign() {
    if (!session) {
      return;
    }

    if (signatureMode === "type" && !typedSignature.trim()) {
      setError("Type the signature text you want stamped into the PDF.");
      return;
    }

    if (signatureMode === "draw" && !drawnSignature) {
      setError("Draw your signature before submitting the signed document.");
      return;
    }

    setSigning(true);
    setError(null);
    setSignedMessage(null);

    try {
      const response = await authedJsonRequest<{ message: string }>(
        `/api/signing/${token}/sign`,
        {
          method: "POST",
          session,
          json: {
            signatureType: signatureMode,
            typedSignature: typedSignature.trim(),
            drawnSignature
          }
        }
      );
      setSignedMessage(response.message);
      setPayload((current) =>
        current
          ? {
              ...current,
              document: { ...current.document, status: "signed" },
              request: { ...current.request, status: "signed" }
            }
          : current
      );
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
          <h1>Review and sign the requested PDF.</h1>
          <p className="muted hero__copy">
            The signer must log in with the invited email address before
            applying the signature.
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
              document. After login, this page will load the PDF and signature
              box automatically.
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

            {error ? <p className="error-text">{error}</p> : null}

            {payload && fileBlob ? (
              <PdfPlacementEditor
                field={payload.request.field}
                file={fileBlob}
                onChange={() => undefined}
                readOnly
              />
            ) : null}
          </div>

          <div className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Apply signature</p>
                <h2>Choose how to sign</h2>
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
              </dl>
            ) : null}

            <div className="segmented-control">
              <button
                className={
                  signatureMode === "draw"
                    ? "button button--primary"
                    : "button button--ghost"
                }
                onClick={() => setSignatureMode("draw")}
                type="button"
              >
                Draw signature
              </button>
              <button
                className={
                  signatureMode === "type"
                    ? "button button--primary"
                    : "button button--ghost"
                }
                onClick={() => setSignatureMode("type")}
                type="button"
              >
                Type signature
              </button>
            </div>

            {signatureMode === "draw" ? (
              <DrawSignaturePad onChange={setDrawnSignature} />
            ) : (
              <label className="inline-label">
                Signature text
                <input
                  className="input input--signature"
                  value={typedSignature}
                  onChange={(event) => setTypedSignature(event.target.value)}
                  placeholder="Type your name"
                />
              </label>
            )}

            {signedMessage ? <p className="success-text">{signedMessage}</p> : null}

            <button
              className="button button--primary"
              disabled={signing || payload?.request.status === "signed"}
              onClick={handleSign}
              type="button"
            >
              {payload?.request.status === "signed"
                ? "Already signed"
                : signing
                  ? "Applying signature..."
                  : "Finalize signed document"}
            </button>
          </div>
        </section>
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
  field,
  onChange,
  readOnly = false
}: {
  file: File | Blob | null;
  field: FieldPosition | null;
  onChange: (field: FieldPosition) => void;
  readOnly?: boolean;
}) {
  const pages = usePdfPreview(file);

  if (!file) {
    return (
      <div className="pdf-placeholder">
        Upload a PDF to preview it here and place the signature field.
      </div>
    );
  }

  if (!pages.length) {
    return <div className="pdf-placeholder">Rendering PDF preview...</div>;
  }

  return (
    <div className="pdf-stack">
      {pages.map((page) => {
        const hasField = field?.page === page.pageNumber;
        return (
          <div
            className={`pdf-page ${readOnly ? "pdf-page--readonly" : ""}`}
            key={page.pageNumber}
            onClick={(event) => {
              if (readOnly) {
                return;
              }

              const rect = (
                event.currentTarget as HTMLDivElement
              ).getBoundingClientRect();
              const nextWidth = 0.28;
              const nextHeight = 0.09;
              const clickX = (event.clientX - rect.left) / rect.width;
              const clickY = (event.clientY - rect.top) / rect.height;

              onChange({
                page: page.pageNumber,
                x: clamp(clickX - nextWidth / 2, 0.02, 0.98 - nextWidth),
                y: clamp(clickY - nextHeight / 2, 0.02, 0.98 - nextHeight),
                width: nextWidth,
                height: nextHeight
              });
            }}
          >
            <img
              alt={`PDF page ${page.pageNumber}`}
              className="pdf-page__image"
              src={page.imageUrl}
            />
            <span className="pdf-page__number">Page {page.pageNumber}</span>
            {hasField && field ? (
              <div
                className="signature-box"
                style={{
                  left: `${field.x * 100}%`,
                  top: `${field.y * 100}%`,
                  width: `${field.width * 100}%`,
                  height: `${field.height * 100}%`
                }}
              >
                Signature
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DrawSignaturePad({
  onChange
}: {
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
        Clear signature
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

async function authedBlobRequest(url: string, session: Session) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.access_token}`
    }
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
