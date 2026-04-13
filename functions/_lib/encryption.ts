import type { Env } from "./types";

const IV_LENGTH = 12;

function decodeBase64(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function getEncryptionKey(env: Env) {
  if (!env.DOCUMENT_ENCRYPTION_KEY) {
    throw new Error(
      "Missing DOCUMENT_ENCRYPTION_KEY. Configure a secret before storing documents."
    );
  }

  const keyMaterial = decodeBase64(env.DOCUMENT_ENCRYPTION_KEY);
  const digest = await crypto.subtle.digest("SHA-256", keyMaterial);

  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);
}

export async function encryptDocument(bytes: ArrayBuffer, env: Env) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    bytes
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const output = new Uint8Array(iv.length + cipherBytes.length);
  output.set(iv, 0);
  output.set(cipherBytes, iv.length);
  return output;
}

export async function decryptDocument(bytes: ArrayBuffer, env: Env) {
  const source = new Uint8Array(bytes);
  if (source.length <= IV_LENGTH) {
    throw new Error("Encrypted document payload is invalid.");
  }

  const iv = source.slice(0, IV_LENGTH);
  const cipher = source.slice(IV_LENGTH);
  const key = await getEncryptionKey(env);

  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    cipher
  );
}
