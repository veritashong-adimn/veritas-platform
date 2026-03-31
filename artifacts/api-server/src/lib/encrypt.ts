import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";

const KEY = (() => {
  const secret = process.env.SENSITIVE_ENCRYPT_KEY ?? "dev-fallback-key-change-in-prod-!!";
  return scryptSync(secret, "translator-sensitive-v1", 32);
})();

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(data: string): string {
  const parts = data.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

export function maskResidentNumber(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 13) {
    return `${digits.slice(0, 6)}-*******`;
  }
  return "******-*******";
}
