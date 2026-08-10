import { createHash, timingSafeEqual } from "node:crypto";
import { Client, type FileEntry, type SFTPWrapper, type Stats } from "ssh2";
import type { EgressAccount } from "./config.js";
import { EgressHttpError } from "./auth.js";
import type { TransportCredentials } from "./sessions.js";

export interface RemoteFile {
  name: string;
  size: number;
  modifiedAt: number;
}

interface SftpSession {
  client: Client;
  sftp: SFTPWrapper;
}

export async function uploadInbox(account: EgressAccount, credentials: TransportCredentials, filename: string, bytes: Buffer): Promise<{
  filename: string;
  size: number;
  alreadyExisted: boolean;
}> {
  assertFilename(filename);
  const session = await connect(account, credentials);
  const remotePath = joinRemote(account.sftp.inbox, filename);
  const temporaryPath = `${remotePath}.uploading`;
  try {
    const existing = await statIfExists(session.sftp, remotePath);
    if (existing) {
      if (existing.size !== bytes.length) {
        throw new EgressHttpError(
          409,
          "EGRESS_SFTP_COLLISION",
          `${filename} already exists with size ${existing.size}, expected ${bytes.length}`,
        );
      }
      const remoteBytes = await readFile(session.sftp, remotePath);
      const expectedHash = createHash("sha256").update(bytes).digest();
      const remoteHash = createHash("sha256").update(remoteBytes).digest();
      if (!timingSafeEqual(expectedHash, remoteHash)) {
        throw new EgressHttpError(
          409,
          "EGRESS_SFTP_COLLISION",
          `${filename} already exists with the expected size but different content`,
        );
      }
      return { filename, size: existing.size, alreadyExisted: true };
    }
    await writeFile(session.sftp, temporaryPath, bytes);
    const temporary = await stat(session.sftp, temporaryPath);
    if (temporary.size !== bytes.length) {
      await unlinkIfExists(session.sftp, temporaryPath);
      throw new EgressHttpError(
        502,
        "EGRESS_SFTP_SIZE_MISMATCH",
        `Temporary upload size ${temporary.size}, expected ${bytes.length}`,
      );
    }
    await rename(session.sftp, temporaryPath, remotePath);
    return { filename, size: temporary.size, alreadyExisted: false };
  } finally {
    session.client.end();
  }
}

export async function listOutbox(account: EgressAccount, credentials: TransportCredentials, limit: number): Promise<RemoteFile[]> {
  const session = await connect(account, credentials);
  try {
    const entries = await readdir(session.sftp, account.sftp.outbox);
    return entries
      .filter(
        (entry) =>
          (entry.attrs.mode & 0o170000) !== 0o040000 && entry.filename !== "." && entry.filename !== "..",
      )
      .sort((left, right) => left.attrs.mtime - right.attrs.mtime || left.filename.localeCompare(right.filename))
      .slice(0, limit)
      .map((entry) => ({ name: entry.filename, size: entry.attrs.size, modifiedAt: entry.attrs.mtime * 1000 }));
  } finally {
    session.client.end();
  }
}

export async function downloadOutbox(account: EgressAccount, credentials: TransportCredentials, filename: string): Promise<Buffer> {
  assertFilename(filename);
  const session = await connect(account, credentials);
  try {
    return await readFile(session.sftp, joinRemote(account.sftp.outbox, filename));
  } finally {
    session.client.end();
  }
}

export async function deleteOutbox(account: EgressAccount, credentials: TransportCredentials, filename: string): Promise<void> {
  assertFilename(filename);
  const session = await connect(account, credentials);
  try {
    try {
      await unlink(session.sftp, joinRemote(account.sftp.outbox, filename));
    } catch (error) {
      if ((error as { code?: number }).code !== 2) {
        throw error;
      }
    }
  } finally {
    session.client.end();
  }
}

async function connect(account: EgressAccount, credentials: TransportCredentials): Promise<SftpSession> {
  const client = new Client();
  const expectedFingerprint = normalizeFingerprint(account.sftp.hostKeySha256);
  await new Promise<void>((resolve, reject) => {
    client
      .once("ready", resolve)
      .once("error", reject)
      .connect({
        host: account.sftp.host,
        port: account.sftp.port,
        username: credentials.loginId,
        password: credentials.loginPassword,
        readyTimeout: 30_000,
        keepaliveInterval: 10_000,
        algorithms: { cipher: ["aes128-ctr", "aes192-ctr", "aes256-ctr"] },
        hostVerifier: (key: Buffer) => {
          const actual = createHash("sha256").update(key).digest("base64").replace(/=+$/u, "");
          const supplied = Buffer.from(actual, "utf8");
          const expected = Buffer.from(expectedFingerprint, "utf8");
          return supplied.length === expected.length && timingSafeEqual(supplied, expected);
        },
      });
  });
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)));
  });
  return { client, sftp };
}

function normalizeFingerprint(value: string): string {
  return value.trim().replace(/^SHA256:/u, "").replace(/=+$/u, "");
}

function assertFilename(filename: string): void {
  if (!filename || filename === "." || filename === ".." || filename.includes("/") || filename.includes("\\")) {
    throw new EgressHttpError(400, "EGRESS_FILENAME_INVALID", "Remote filename is invalid");
  }
}

function joinRemote(directory: string, filename: string): string {
  return `${directory.replace(/\/+$/u, "")}/${filename}`;
}

function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.stat(path, (error, stats) => (error ? reject(error) : resolve(stats))));
}

async function statIfExists(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  try {
    return await stat(sftp, path);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 2) {
      return null;
    }
    throw error;
  }
}

function writeFile(sftp: SFTPWrapper, path: string, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => sftp.writeFile(path, bytes, (error) => (error ? reject(error) : resolve())));
}

function readFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => sftp.readFile(path, (error, bytes) => (error ? reject(error) : resolve(bytes))));
}

function rename(sftp: SFTPWrapper, source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.rename(source, target, (error) => (error ? reject(error) : resolve())));
}

function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => sftp.unlink(path, (error) => (error ? reject(error) : resolve())));
}

async function unlinkIfExists(sftp: SFTPWrapper, path: string): Promise<void> {
  try {
    await unlink(sftp, path);
  } catch {
    // Best-effort cleanup of a temporary upload.
  }
}

function readdir(sftp: SFTPWrapper, path: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => sftp.readdir(path, (error, entries) => (error ? reject(error) : resolve(entries))));
}
