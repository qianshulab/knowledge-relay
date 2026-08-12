import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const SCRYPT_KEY_LENGTH = 64;

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashPassword(password: string): string {
  if (password.length < 8) throw new Error("密码至少需要 8 个字符");
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, saltText, keyText] = stored.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(keyText, "base64url");
    const candidate = crypto.scryptSync(password, salt, expected.length);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static async load(dataDir: string): Promise<SecretBox> {
    const secretPath = path.join(dataDir, "app-secret.key");
    let key: Buffer;
    try {
      key = await fs.readFile(secretPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = crypto.randomBytes(32);
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(secretPath, key, { mode: 0o600, flag: "wx" });
    }
    if (key.length !== 32) throw new Error("data/app-secret.key 格式不正确");
    return new SecretBox(key);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string): string {
    const [version, ivText, tagText, ciphertextText] = value.split(".");
    if (version !== "v1" || !ivText || !tagText || ciphertextText === undefined) {
      throw new Error("加密数据格式不正确");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
