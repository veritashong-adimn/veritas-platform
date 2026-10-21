// ─────────────────────────────────────────────────────────────────────────────
// 대량등록 업로드 원본의 암호화 임시 저장소 — VERITAS OS
//
// 목적: 통번역사 Master 재구축을 위해, 브라우저 메모리에서만 사라지던 업로드 원본(.xls)을
//       서버에 "암호화" 보관하여 재분석에 재사용한다. (주민번호 포함 PII)
//
// 보안 원칙:
//   · 원본 바이트는 AES-256-GCM(encrypt())로 암호화하여 디스크에 저장. 평문 파일 미저장.
//   · 저장 디렉터리는 웹에 노출되지 않는 서버 내부 경로(0700). 파일 권한 0600.
//   · 메타데이터(파일명·행수·업로더·시각)만 평문 JSON. 셀 값·주민번호는 메타에 넣지 않는다.
//   · 보존 기간(기본 30일) 경과분은 자동 파기. 작업 완료 시 수동 삭제 가능.
//   · 접근은 호출부(관리자 권한 가드)에서 통제한다. 복호는 서버 내부에서만.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";
import { encrypt, decrypt } from "./encrypt";

const DIR = process.env.IMPORT_SNAPSHOT_DIR || path.join(os.tmpdir(), "veritas-translator-import");
const RETENTION_MS = Number(process.env.IMPORT_SNAPSHOT_RETENTION_DAYS ?? 30) * 24 * 60 * 60 * 1000;

export const SNAPSHOT_DIR = DIR;
export const isValidSnapshotId = (id: string) => /^[a-f0-9]{24}$/.test(id);

export interface SnapshotMeta {
  id: string;
  entity: string;
  filename: string;
  sheetName?: string | null;
  totalRows: number;
  createdAt: string;    // ISO
  createdBy: number | null;
}

function ensureDir() { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); }

/** 업로드 원본을 암호화 저장하고 메타를 반환. 반환값·로그에 셀/주민번호 없음. */
export function saveSnapshot(
  entity: string,
  buffer: Buffer,
  meta: { filename: string; sheetName?: string | null; totalRows: number; createdBy: number | null },
): SnapshotMeta {
  ensureDir();
  const id = randomBytes(12).toString("hex");  // 24 hex
  fs.writeFileSync(path.join(DIR, `${id}.enc`), encrypt(buffer.toString("base64")), { mode: 0o600 });
  const full: SnapshotMeta = { id, entity, createdAt: new Date().toISOString(), filename: meta.filename, sheetName: meta.sheetName ?? null, totalRows: meta.totalRows, createdBy: meta.createdBy };
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(full), { mode: 0o600 });
  return full;
}

export function listSnapshots(entity?: string): SnapshotMeta[] {
  ensureDir();
  return fs.readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as SnapshotMeta; } catch { return null; } })
    .filter((m): m is SnapshotMeta => !!m && (!entity || m.entity === entity))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 복호화된 원본 버퍼를 반환(서버 내부 처리 전용 — 응답/로그로 내보내지 말 것). */
export function readSnapshotBuffer(id: string): Buffer | null {
  if (!isValidSnapshotId(id)) return null;
  const p = path.join(DIR, `${id}.enc`);
  if (!fs.existsSync(p)) return null;
  try { return Buffer.from(decrypt(fs.readFileSync(p, "utf8")), "base64"); } catch { return null; }
}

export function getSnapshotMeta(id: string): SnapshotMeta | null {
  if (!isValidSnapshotId(id)) return null;
  const p = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as SnapshotMeta; } catch { return null; }
}

/** 안전 삭제: 암호문·메타 파일 제거. */
export function deleteSnapshot(id: string): boolean {
  if (!isValidSnapshotId(id)) return false;
  let ok = false;
  for (const ext of [".enc", ".json"]) {
    const p = path.join(DIR, `${id}${ext}`);
    if (fs.existsSync(p)) { try { fs.rmSync(p); ok = true; } catch { /* ignore */ } }
  }
  return ok;
}

/** 보존 기간 경과분 자동 파기. 반환: 삭제 건수. */
export function pruneExpired(): number {
  let n = 0;
  const now = Date.now();
  for (const m of listSnapshots()) {
    if (now - Date.parse(m.createdAt) > RETENTION_MS && deleteSnapshot(m.id)) n++;
  }
  return n;
}
