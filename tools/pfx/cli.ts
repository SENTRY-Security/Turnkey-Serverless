#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assemblePfx,
  generateCertificateRequest,
  inspectKeyStore,
  inspectPfx,
  validateBan,
  validateOfficialPfxPassword,
} from "./lib.js";

const FILE_MODE_PRIVATE = 0o600;
const DIRECTORY_MODE_PRIVATE = 0o700;

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const commandArgs = argv.slice(1);
  switch (command) {
    case "request":
      await runRequest(commandArgs);
      return;
    case "assemble":
      await runAssemble(commandArgs);
      return;
    case "inspect-key":
      await runInspectKey(commandArgs);
      return;
    case "inspect":
      await runInspect(commandArgs);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return;
    default:
      throw new Error(`未知指令：${command}\n\n${usageText()}`);
  }
}

async function runRequest(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ban: { type: "string" },
      "out-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const ban = requiredOption(values.ban, "--ban");
  validateBan(ban);
  const password = await promptConfirmedOfficialPassword("設定 KEY/PFX 密碼");
  const timestamp = turnkeyTimestamp(new Date());
  const outputDirectory = resolve(values["out-dir"] ?? defaultOutputDirectory(ban, timestamp));
  await createPrivateDirectory(outputDirectory);

  process.stdout.write("正在依 Turnkey 3.2.1 格式產生 RSA-2048 KEY 與 SHA-256 CSR，可能需要數秒…\n");
  const artifacts = generateCertificateRequest({ ban, password });
  const fileBase = `${ban}_${timestamp}`;
  const keyPath = join(outputDirectory, `${fileBase}.key`);
  const csrPath = join(outputDirectory, `${fileBase}.csr`);
  const metadataPath = join(outputDirectory, `${fileBase}.request.json`);
  await writeNewPrivateFile(keyPath, artifacts.keyStoreBytes);
  await writeNewPrivateFile(csrPath, artifacts.csrPem);
  await writeNewPrivateFile(
    metadataPath,
    `${JSON.stringify(
      {
        ban: artifacts.ban,
        compatibilityTarget: "Turnkey 3.2.1",
        keyContainer: "password-protected PKCS#12 KeyStore with .key extension",
        keyAlgorithm: `RSA-${artifacts.rsaBits}`,
        csrSignatureAlgorithm: "SHA-256 with RSA",
        csrSubject: `CN=${artifacts.ban}`,
        csrRequestedKeyUsage: "Digital Signature",
        csrSha256: artifacts.csrSha256,
        keyStoreSha256: artifacts.keyStoreSha256,
        keyFile: basename(keyPath),
        csrFile: basename(csrPath),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    [
      "完成。",
      `KEY（PKCS#12 私鑰容器；絕不可上傳或寄送）：${keyPath}`,
      `CSR（交給核發 CA）：${csrPath}`,
      `非秘密 metadata：${metadataPath}`,
      "下一步：只提交 CSR；務必保留 KEY 與密碼。取得 CER 後執行 assemble。",
    ].join("\n") + "\n",
  );
}

async function runAssemble(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      key: { type: "string" },
      cer: { type: "string" },
      chain: { type: "string", multiple: true },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const keyPath = resolve(requiredOption(values.key, "--key"));
  const certificatePath = resolve(requiredOption(values.cer, "--cer"));
  const outputPath = resolve(values.out ?? join(dirname(keyPath), `${basename(keyPath, ".key")}.pfx`));
  await assertDoesNotExist(outputPath);
  const password = await promptOfficialPassword("輸入當初設定的 KEY/PFX 密碼");
  const [keyStoreBytes, certificateBytes, chainCertificateBytes] = await Promise.all([
    readFile(keyPath),
    readFile(certificatePath),
    Promise.all((values.chain ?? []).map((path) => readFile(resolve(path)))),
  ]);
  const assembled = assemblePfx({
    keyStoreBytes,
    certificateBytes,
    chainCertificateBytes,
    password,
  });
  await createPrivateDirectory(dirname(outputPath));
  await writeNewPrivateFile(outputPath, assembled.pfxBytes);
  process.stdout.write(
    `${JSON.stringify({ pfxPath: outputPath, ...assembled.summary }, null, 2)}\n` +
      "完成。請先把 CER 登錄到電子發票平台，再將 PFX 與密碼放入 Finance secrets 管理流程。\n",
  );
}

async function runInspectKey(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { key: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const keyPath = resolve(requiredOption(values.key, "--key"));
  const password = await promptOfficialPassword("輸入 KEY 密碼");
  const summary = inspectKeyStore(await readFile(keyPath), password);
  process.stdout.write(`${JSON.stringify({ keyPath, ...summary }, null, 2)}\n`);
}

async function runInspect(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { pfx: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const pfxPath = resolve(requiredOption(values.pfx, "--pfx"));
  const password = await promptOfficialPassword("輸入 PFX 密碼");
  const summary = inspectPfx(await readFile(pfxPath), password);
  process.stdout.write(`${JSON.stringify({ pfxPath, ...summary }, null, 2)}\n`);
}

async function promptConfirmedOfficialPassword(label: string): Promise<string> {
  const first = await promptOfficialPassword(label);
  const second = await promptSecret("再次輸入相同密碼（不顯示）：");
  if (first !== second) {
    throw new Error("兩次輸入的密碼不同，未產生任何憑證檔案");
  }
  return first;
}

async function promptOfficialPassword(label: string): Promise<string> {
  const password = await promptSecret(`${label}（恰好 8 碼 ASCII 英數，不顯示）：`);
  validateOfficialPfxPassword(password);
  return password;
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("密碼只能從互動式 TTY 隱藏輸入；本工具不接受 command-line password");
  }
  process.stdout.write(label);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    const restore = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          restore();
          process.stdout.write("\n");
          rejectPromise(new Error("使用者取消操作"));
          return;
        }
        if (character === "\r" || character === "\n") {
          restore();
          process.stdout.write("\n");
          resolvePromise(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function createPrivateDirectory(path: string): Promise<void> {
  try {
    await access(path, fsConstants.F_OK);
    return;
  } catch {
    // Create only the requested leaf directory. Never chmod a pre-existing
    // parent such as /tmp or a shared operator directory.
  }
  const createdPath = await mkdir(path, { recursive: true, mode: DIRECTORY_MODE_PRIVATE });
  if (createdPath !== undefined) {
    await chmod(path, DIRECTORY_MODE_PRIVATE);
  }
}

async function writeNewPrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", FILE_MODE_PRIVATE);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  await chmod(path, FILE_MODE_PRIVATE);
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return;
  }
  throw new Error(`拒絕覆寫既有檔案：${path}`);
}

function requiredOption(value: string | undefined, optionName: string): string {
  if (!value) {
    throw new Error(`缺少必要參數 ${optionName}`);
  }
  return value;
}

function defaultOutputDirectory(ban: string, timestamp: string): string {
  return join("private", "pfx", `${ban}-${timestamp}`);
}

function turnkeyTimestamp(date: Date): string {
  const components = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return components.map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0")).join("");
}

function printUsage(): void {
  process.stdout.write(`${usageText()}\n`);
}

function usageText(): string {
  return `Turnkey 軟體憑證離線工具

依 Turnkey 3.2.1 產生 PKCS#12 KEY 與 CSR：
  npm run pfx -- request --ban 12345678 [--out-dir ./private/pfx/company]

固定格式：RSA-2048、CN=統編、keyUsage=Digital Signature、SHA256withRSA

檢查 Turnkey KEY：
  npm run pfx -- inspect-key --key ./12345678_20241231115134.key

CA 核發 CER 後組成 PFX：
  npm run pfx -- assemble --key ./12345678_20241231115134.key --cer ./issued.cer [--chain ./ca.cer] [--out ./signing.pfx]

檢查既有 PFX：
  npm run pfx -- inspect --pfx ./signing.pfx

安全限制：這是本機離線 CLI，不是 Worker API。密碼只可從互動式 TTY 隱藏輸入；不接受 --password 或環境變數。`;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`PFX tool error: ${message}\n`);
    process.exitCode = 1;
  });
}
