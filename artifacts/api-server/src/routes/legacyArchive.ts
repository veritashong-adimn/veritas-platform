// ─── Legacy CRM Archive Lite — Import API (C-4A) ──────────────────────────────
//   POST /admin/legacy-archive/analyze   과거 CRM Excel 분석(Preview, DB 미변경)
//   POST /admin/legacy-archive/execute   legacy_archive_rows 저장(원본 보존, Master 생성 없음)
//
// 원칙(C-4A):
//   · Current Master(Product/Company/Contact/Translator)를 절대 생성하지 않는다.
//   · source_raw 원본 보존. normalized 필드는 별도. 파싱 실패해도 row 는 버리지 않는다.
//   · 멱등: row_hash(파일명 무관). 중복 row 는 Execute 시 skip.
//   · search/detail/sales-history 엔드포인트는 C-4B 이후.
import { findActivationBySaleNo } from "../services/legacySaleActivation";
import { linkedContactNameOfSaleNo, reviewNeededOfSaleRow } from "../services/legacyContactRestore";
import { Router, type IRouter } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import { db, legacyArchiveRowsTable, importBatchesTable, legacySalesProgressLinksTable } from "@workspace/db";
import crypto from "node:crypto";
import { eq, ne, and, or, ilike, gte, lte, count, desc, asc, sql, isNotNull, type SQL } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  buildArchivePreview, analyzeArchiveDuplicates, computeFileHash, planArchiveImport, sourceIdentityKey,
  buildExcelPreviewPage, clampPreviewPageSize, analyzeExcelIdentity, analyzeRecordMatching, matchIncomingRows,
  ARCHIVE_SOURCE_TYPES, maskSourceRawForRead, maskSheetsForDisplay, maskRrnValue,
  type ArchiveSourceType, type ArchivePreviewRow, type MatchableRow,
} from "../services/legacyArchiveResolve";
import { executeArchiveSync, loadStoredIdentities, SyncError } from "../services/legacyArchiveSync";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    if (name.endsWith(".xls") || name.endsWith(".xlsx")) cb(null, true);
    else cb(new Error(".xls 또는 .xlsx 파일만 업로드할 수 있습니다."));
  },
});

const SOURCE_SYSTEM = "old_crm";

// (C-4I-f) multer 는 Content-Disposition 의 filename 을 latin1 로 파싱한다. UTF-8 한글 파일명이 'í…' 처럼 깨지므로
//   원본 bytes 를 복원해 UTF-8 로 재디코딩한다. 다른 import 라우트와 동일 처리.
//   파일 bytes(file_hash)·행 내용(row_hash)과 무관한 '표시/보존용 파일명'에만 영향 → 멱등/식별 로직 불변.
function decodeFileName(raw: string | undefined): string {
  if (!raw) return "";
  try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; }
}

function coerceSourceType(v: unknown): ArchiveSourceType | null {
  return ARCHIVE_SOURCE_TYPES.includes(v as ArchiveSourceType) ? (v as ArchiveSourceType) : null;
}

// (C-4D) 동일 파일(file_hash)+source_type 로 이미 저장된 source identity 조회 — 재업로드 멱등 판정용(read-only).
//   반환: Map(`${source_sheet}\0${source_row}` → 저장된 row_hash). row_hash 는 내용 일치 확인(충돌 감지)용.
//   row_hash 로는 조회하지 않는다(파일 내부 동일행이 같은 row_hash 를 공유하므로 identity 가 될 수 없음, §3).
//   되돌린(rolled_back) 배치의 행은 제외 — 되돌린 뒤 같은 파일을 다시 반영할 수 있어야 한다.
async function loadExistingIdentities(dbx: any, fileHash: string, sourceType: ArchiveSourceType): Promise<Map<string, string>> {
  return loadStoredIdentities(dbx, fileHash, sourceType);
}

// source identity 충돌(동일 위치·내용 상이) 시 던지는 에러 — route 는 409 로 응답하고 transaction 은 롤백된다.
class ArchiveIdentityConflictError extends Error {
  code = "ARCHIVE_IDENTITY_CONFLICT";
  conflicts: unknown[];
  constructor(conflicts: unknown[]) {
    super(`source identity 충돌 ${conflicts.length}건 — 동일 파일의 동일 위치에 다른 내용이 이미 보존되어 있습니다(원본 무결성 위험).`);
    this.conflicts = conflicts;
  }
}

export interface ArchiveImportResult {
  total: number;
  created: number;
  skippedDuplicate: number;
  warnings: number;
  batchId: number | null;
  sheetNames: string[];
  // (C-4G) 스냅샷 세대
  mode: "new_snapshot" | "duplicate_file";   // 새 CRM 스냅샷 | 이미 등록된 동일 파일
  snapshotId: number | null;                 // 생성/해당 snapshot(import_batch) id
  supersededSnapshotIds: number[];           // 이번에 historical 로 강등된 이전 current 스냅샷
  // (C-4I-b) Effective 매칭 결과(저장 시점 판정 집계)
  matching: { NEW: number; SAME: number; UPDATED: number; AMBIGUOUS: number };
}

// Execute 코어(구 경로) — 호출자가 트랜잭션을 통제한다(test 는 rollback).
// ※ 운영 화면의 반영은 executeArchiveSync(승인 토큰·중복 의심 보류)로 대체됨. 이 함수는 기존 격리 테스트 호환용으로만 유지.
// Current Master 를 생성하지 않는다: legacy_archive_rows + import_batches 만 write.
// (C-4D) dedupe 기준 = source identity(file_hash+type+sheet+row). row_hash 로 skip 하지 않는다.
//   · 파일 내부 동일내용·다른행 → 전부 저장(원본 보존).
//   · 동일 파일 재업로드(파일명 무관) → source identity 일치분 skip.
//   · 동일 위치인데 내용 상이 → ArchiveIdentityConflictError(자동 overwrite/skip 금지).
export async function executeArchiveImport(
  dbx: any,
  opts: { buffer: Buffer; sourceType: ArchiveSourceType; fileName: string; performerId: number | null },
): Promise<ArchiveImportResult> {
  const fileHash = computeFileHash(opts.buffer);
  const sheets = buildArchivePreview(opts.buffer, opts.sourceType);
  const allRows: ArchivePreviewRow[] = sheets.flatMap(s => s.rows);
  const sheetNames = sheets.map(s => s.sheetName);
  const warnings = allRows.reduce((n, r) => n + r.warnings.length, 0);

  // 재업로드 멱등: 동일 file_hash+source_type 로 이미 저장된 (sheet,row) → row_hash
  const existing = await loadExistingIdentities(dbx, fileHash, opts.sourceType);
  const plan = planArchiveImport(allRows, existing);
  if (!plan.safeToExecute) throw new ArchiveIdentityConflictError(plan.conflicts);

  const toInsert = plan.toSaveRows;
  const skippedDuplicate = plan.alreadyStoredCount;

  // (C-4G) 동일 파일(file_hash) 전부 이미 등록 → 새 snapshot 생성하지 않음. current/effective 불변.
  if (toInsert.length === 0) {
    return { total: allRows.length, created: 0, skippedDuplicate, warnings, batchId: null, sheetNames, mode: "duplicate_file", snapshotId: null, supersededSnapshotIds: [], matching: { NEW: 0, SAME: 0, UPDATED: 0, AMBIGUOUS: 0 } };
  }

  // (C-4I-b) Effective 매칭 — 저장 전 기존 effective(is_effective=true) baseline 과 대조(Preview 와 동일 core, §20).
  const effBaseline = await dbx.select({
    id: legacyArchiveRowsTable.id, sourceRow: legacyArchiveRowsTable.sourceRow, rowHash: legacyArchiveRowsTable.rowHash,
    recordDate: legacyArchiveRowsTable.recordDate, companyName: legacyArchiveRowsTable.companyName, contactName: legacyArchiveRowsTable.contactName,
    translatorName: legacyArchiveRowsTable.translatorName, productName: legacyArchiveRowsTable.productName, language: legacyArchiveRowsTable.language,
    deliveryDate: legacyArchiveRowsTable.deliveryDate, payoutDate: legacyArchiveRowsTable.payoutDate, payoutPretax: legacyArchiveRowsTable.payoutPretax,
    collectionDate: legacyArchiveRowsTable.collectionDate, collectionStatus: legacyArchiveRowsTable.collectionStatus,
    supplyAmount: legacyArchiveRowsTable.supplyAmount, vatAmount: legacyArchiveRowsTable.vatAmount, totalAmount: legacyArchiveRowsTable.totalAmount,
    logicalGroupKey: legacyArchiveRowsTable.logicalGroupKey, effectiveVersion: legacyArchiveRowsTable.effectiveVersion,
  }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.sourceType, opts.sourceType), eq(legacyArchiveRowsTable.isEffective, true)));
  const baseline: MatchableRow[] = effBaseline.map((r: any) => ({
    id: r.id, sourceRow: r.sourceRow ?? 0, rowHash: r.rowHash, recordDate: r.recordDate ?? null, companyName: r.companyName ?? null, contactName: r.contactName ?? null,
    translatorName: r.translatorName ?? null, productName: r.productName ?? null, language: r.language ?? null, deliveryDate: r.deliveryDate ?? null, payoutDate: r.payoutDate ?? null,
    payoutPretax: r.payoutPretax ?? null, collectionDate: r.collectionDate ?? null, collectionStatus: r.collectionStatus ?? null,
    supplyAmount: r.supplyAmount ?? null, vatAmount: r.vatAmount ?? null, totalAmount: r.totalAmount ?? null, logicalGroupKey: r.logicalGroupKey ?? null, effectiveVersion: r.effectiveVersion ?? null,
  }));
  const { decisions } = matchIncomingRows(toInsert as unknown as MatchableRow[], baseline);
  const matching = { NEW: 0, SAME: 0, UPDATED: 0, AMBIGUOUS: 0 };
  for (const d of decisions) matching[d.classification]++;

  // (C-4I-c) 원본 header 순서 보존 — 최다행(dominant) 시트의 원본 header 배열(JSONB 키순서 소실 대비).
  const domSheet = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), sheets[0]);
  const dominantHeaders = domSheet?.headers ?? [];

  // (C-4G) 새 CRM 스냅샷 생성. isCurrent 는 저장/검증 성공 후 전환.
  const [batch] = await dbx.insert(importBatchesTable).values({
    module: "legacy_archive", importType: "legacy_archive", originalFilename: opts.fileName, sheetName: sheetNames.join(", ") || null,
    totalRows: allRows.length, successRows: 0, warningRows: warnings, errorRows: 0, skippedRows: skippedDuplicate,
    status: "analyzed", createdBy: opts.performerId, sourceSystem: SOURCE_SYSTEM, fileHash, sourceType: opts.sourceType, isCurrent: false,
    headersJson: dominantHeaders,           // (C-4I-c) 조회 화면 전체컬럼 원본 순서용
  }).returning({ id: importBatchesTable.id });

  // 행 저장 — Raw Evidence append(§1-A/B) + per-decision effective 플래그. 삽입 id 순서 보존.
  const insertedIds: number[] = [];
  let created = 0;
  for (let i = 0; i < toInsert.length; i += 500) {
    const chunkRows = toInsert.slice(i, i + 500);
    const inserted = await dbx.insert(legacyArchiveRowsTable).values(chunkRows.map((r, j) => {
      const d = decisions[i + j];
      const isEff = d.classification !== "SAME";                     // SAME 은 evidence 보존하되 effective 중복 방지(§7)
      const groupKey = d.sameSet ? null                              // SAME-set: chain key 미생성(1:1 날조 금지)
        : (d.classification === "UPDATED" || d.classification === "SAME") ? (d.matchedLogicalGroupKey ?? crypto.randomUUID())
        : crypto.randomUUID();                                       // NEW/AMBIGUOUS: 새 chain
      const ver = d.classification === "UPDATED" ? (d.matchedEffectiveVersion ?? 1) + 1 : d.classification === "SAME" ? (d.matchedEffectiveVersion ?? 1) : 1;
      return {
        sourceType: opts.sourceType, sourceSystem: SOURCE_SYSTEM, importBatchId: batch.id, sourceFile: opts.fileName, fileHash,
        sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, recordDate: r.recordDate, companyName: r.companyName, contactName: r.contactName,
        translatorName: r.translatorName, productName: r.productName, language: r.language,
        supplyAmount: r.supplyAmount != null ? String(r.supplyAmount) : null, vatAmount: r.vatAmount != null ? String(r.vatAmount) : null,
        totalAmount: r.totalAmount != null ? String(r.totalAmount) : null, payoutPretax: r.payoutPretax != null ? String(r.payoutPretax) : null,
        deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, collectionDate: r.collectionDate, collectionStatus: r.collectionStatus,
        sourceRaw: r.sourceRaw, rowHash: r.rowHash, isCurrent: true,
        matchStatus: d.classification.toLowerCase(), isEffective: isEff, logicalGroupKey: groupKey, effectiveVersion: ver,
      };
    })).onConflictDoNothing({ target: [legacyArchiveRowsTable.fileHash, legacyArchiveRowsTable.sourceType, legacyArchiveRowsTable.sourceSheet, legacyArchiveRowsTable.sourceRow] }).returning({ id: legacyArchiveRowsTable.id });
    for (const ins of inserted) insertedIds.push(ins.id as number);
    created += inserted.length;
  }

  // (§16-A/I) 저장 row count 검증 — 153 동일행 때문에 줄어들면 실패로 간주하고 rollback.
  if (created !== toInsert.length) throw new Error(`스냅샷 저장 행수 불일치: 저장대상 ${toInsert.length} ≠ 저장됨 ${created}. 롤백합니다.`);

  // (C-4I-b §8) UPDATED supersede — 기존 effective version 을 historical 로 강등(삭제·overwrite 아님). atomic(같은 tx).
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (d.classification === "UPDATED" && d.matchedExistingId != null) {
      await dbx.update(legacyArchiveRowsTable).set({ isEffective: false, supersededById: insertedIds[i] }).where(eq(legacyArchiveRowsTable.id, d.matchedExistingId as number));
    }
  }

  // (C-4G §7·§8) is_current provenance 전환 — effective 와 무관(§4). 실패 시 전체 rollback.
  const superseded = await dbx.update(importBatchesTable).set({ isCurrent: false })
    .where(and(eq(importBatchesTable.module, "legacy_archive"), eq(importBatchesTable.sourceType, opts.sourceType), eq(importBatchesTable.isCurrent, true)))
    .returning({ id: importBatchesTable.id });
  await dbx.update(legacyArchiveRowsTable).set({ isCurrent: false })
    .where(and(eq(legacyArchiveRowsTable.sourceType, opts.sourceType), eq(legacyArchiveRowsTable.isCurrent, true), ne(legacyArchiveRowsTable.importBatchId, batch.id)));
  await dbx.update(importBatchesTable).set({ successRows: created, status: "completed", isCurrent: true }).where(eq(importBatchesTable.id, batch.id));

  // (§16-C/F) invariant — effective 누적 수 & logical_group 당 effective 유일성. 위반 시 rollback.
  const effAfter = Number((await dbx.select({ n: count() }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.sourceType, opts.sourceType), eq(legacyArchiveRowsTable.isEffective, true))))[0].n);
  const expectedEff = baseline.length - matching.UPDATED + (matching.NEW + matching.UPDATED + matching.AMBIGUOUS);
  if (effAfter !== expectedEff) throw new Error(`effective invariant 위반: expected ${expectedEff} ≠ ${effAfter}. 롤백합니다.`);
  const dupGroup = await dbx.select({ k: legacyArchiveRowsTable.logicalGroupKey, n: count() }).from(legacyArchiveRowsTable)
    .where(and(eq(legacyArchiveRowsTable.sourceType, opts.sourceType), eq(legacyArchiveRowsTable.isEffective, true), isNotNull(legacyArchiveRowsTable.logicalGroupKey)))
    .groupBy(legacyArchiveRowsTable.logicalGroupKey).having(sql`count(*) > 1`);
  if (dupGroup.length) throw new Error(`logical_group effective 유일성 invariant 위반: ${dupGroup.length}건. 롤백합니다.`);

  return {
    total: allRows.length, created, skippedDuplicate, warnings, batchId: batch.id, sheetNames,
    mode: "new_snapshot", snapshotId: batch.id,
    supersededSnapshotIds: superseded.map((s: any) => s.id as number).filter((id: number) => id !== batch.id),
    matching,
  };
}

// POST /admin/legacy-archive/analyze — Preview(DB 미변경)
router.post("/admin/legacy-archive/analyze", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  try {
    const sourceType = coerceSourceType(req.body?.sourceType);
    if (!sourceType) { res.status(400).json({ error: "sourceType 은 sales_list | progress | translator_list 중 하나여야 합니다." }); return; }
    if (!req.file?.buffer) { res.status(400).json({ error: "엑셀 파일(file)이 필요합니다." }); return; }
    const fileName = decodeFileName(req.file.originalname);   // (C-4I-f) 한글 파일명 UTF-8 복원

    const fileHash = computeFileHash(req.file.buffer);
    const sheets = buildArchivePreview(req.file.buffer, sourceType);
    const allRows = sheets.flatMap(s => s.rows);
    // 미리보기/진단 응답 전용 마스킹 사본(progress RRN). 원본 sheets 는 rowHash/identity 계산에 그대로 사용.
    const displaySheets = maskSheetsForDisplay(sourceType, sheets);

    // (C-4I-c) 과거 import(헤더 순서 미저장) backfill — 동일 file_hash 배치의 headers_json 이 비어 있으면 파싱한 원본 순서로 1회 채움.
    //   메타데이터 전용 write(아카이브 행 미변경). 저장된 30,142행은 건드리지 않음.
    try {
      const domSheet = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), sheets[0]);
      const domHeaders = domSheet?.headers ?? [];
      if (domHeaders.length > 0) {
        await db.update(importBatchesTable)
          .set({ headersJson: domHeaders })
          .where(and(eq(importBatchesTable.module, "legacy_archive"), eq(importBatchesTable.sourceType, sourceType), eq(importBatchesTable.fileHash, fileHash), sql`${importBatchesTable.headersJson} is null`));
      }
    } catch (e) { req.log.warn({ e }, "headers backfill skipped"); }

    // (C-4D) 저장 계획: 동일 파일(file_hash)+type 로 이미 저장된 source identity 와 대조.
    //   첫 업로드면 existing 비어 있음 → 전부 저장 대상(파일 내부 동일행 포함 보존).
    const existing = await loadExistingIdentities(db, fileHash, sourceType);
    const plan = planArchiveImport(allRows, existing);

    let warningCount = 0;
    const sample: any[] = [];
    for (const r of allRows) {
      if (r.warnings.length) warningCount++;
      if (sample.length < 20) {
        const stored = existing.get(sourceIdentityKey(r.sourceSheet, r.sourceRow));
        const status = stored === undefined ? "new" : (stored === r.rowHash ? "already_stored" : "conflict");
        sample.push({
          sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, status,
          recordDate: r.recordDate, companyName: r.companyName, contactName: r.contactName,
          translatorName: r.translatorName, productName: r.productName, language: r.language,
          supplyAmount: r.supplyAmount, totalAmount: r.totalAmount, payoutPretax: r.payoutPretax,
          collectionStatus: r.collectionStatus, warnings: r.warnings,
          // 내부 보존 키 제외 + progress 주민번호 마스킹(표시 사본). rowHash/status 판정은 위에서 원본 r 로 수행(불변).
          sourceRaw: maskSourceRawForRead(sourceType, r.sourceRaw),
        });
      }
    }

    // ── 파일 내부 "원본 동일행" 상세(§7: 보존 대상, 제외 대상 아님) ──
    // 내용 지문(row_hash) 기준 group. empty set → 파일 내부만(DB 무관) 집계하여 153/141 이 그대로 보인다.
    const { analysis: contentDup, groups: dupGroups } = analyzeArchiveDuplicates(allRows, new Set());
    const duplicateSamples = dupGroups.slice(0, 10).map(g => ({
      rowHash: g.rowHash,
      excelRows: g.excelRows,
      sourceSheet: g.sourceSheet,
      groupCount: g.groupCount,
      classification: g.classification,
      exactDuplicate: g.classification === "EXACT_DUPLICATE",
      companyName: g.representative.companyName,
      contactName: g.representative.contactName,
      productName: g.representative.productName,
      translatorName: g.representative.translatorName,
      language: g.representative.language,
      deliveryDate: g.representative.deliveryDate,
      payoutDate: g.representative.payoutDate,
      payoutPretax: g.representative.payoutPretax,
      // differences 의 valueA/valueB 도 progress RRN 이면 마스킹(표시 전용). 그룹핑/분류는 원본 기준 수행됨(불변).
      differences: g.differences.slice(0, 20).map(d => sourceType === "progress"
        ? { ...d, valueA: maskRrnValue(d.valueA), valueB: maskRrnValue(d.valueB) } : d),
    }));

    // (C-4G) 스냅샷 컨텍스트 — 등록 방식(새 스냅샷/동일 파일) + 기존 current 스냅샷 정보.
    const currentBatch = (await db.select({
      id: importBatchesTable.id, originalFilename: importBatchesTable.originalFilename,
      totalRows: importBatchesTable.totalRows, successRows: importBatchesTable.successRows,
      fileHash: importBatchesTable.fileHash, createdAt: importBatchesTable.createdAt,
    }).from(importBatchesTable)
      .where(and(eq(importBatchesTable.module, "legacy_archive"), eq(importBatchesTable.sourceType, sourceType), eq(importBatchesTable.isCurrent, true)))
      .orderBy(desc(importBatchesTable.id)).limit(1))[0] ?? null;
    const sameFileBatch = (await db.select({ id: importBatchesTable.id }).from(importBatchesTable)
      .where(and(eq(importBatchesTable.module, "legacy_archive"), eq(importBatchesTable.sourceType, sourceType), eq(importBatchesTable.fileHash, fileHash)))
      .limit(1))[0] ?? null;
    const snapshotContext = {
      registrationMode: sameFileBatch ? "duplicate_file" : "new_snapshot",  // 이미 등록된 동일 파일 | 새 CRM 스냅샷
      currentSnapshot: currentBatch ? {
        snapshotId: currentBatch.id, fileName: currentBatch.originalFilename,
        totalRows: currentBatch.totalRows, savedRows: currentBatch.successRows,
        fileHashShort: currentBatch.fileHash ? String(currentBatch.fileHash).slice(0, 12) : null,
        uploadedAt: currentBatch.createdAt,
      } : null,
      newFile: { fileName, fileHashShort: fileHash.slice(0, 12), totalRows: allRows.length },
    };

    // (C-4D) 저장 계획 요약 — 사용자에게 "원본 동일행도 보존을 위해 저장된다"는 의미를 명확히 전달.
    const archivePlan = {
      total: allRows.length,
      toSave: plan.toSaveRows.length,          // 저장 대상(첫 업로드면 total)
      alreadyStored: plan.alreadyStoredCount,  // 이미 보존된 원본행(재업로드 제외)
      reuploadExcluded: plan.alreadyStoredCount,
      sameContentRows: contentDup.duplicateExcludedRows,  // 원본 동일행(파일 내부, 보존됨)
      sameContentGroups: contentDup.duplicateGroups,      // 동일행 그룹
      conflicts: plan.conflicts.length,        // source identity 충돌(내용 상이) → Execute STOP 사유
      warning: warningCount,
      isReupload: plan.isReupload,
      safeToExecute: plan.safeToExecute,       // conflicts===0 이면 저장 가능(파일 내부 동일행은 차단 사유 아님, §8)
    };

    res.json({
      sourceType,
      fileName,
      fileHash,
      sheets: sheets.map(s => ({ sheetName: s.sheetName, headerRowIndex: s.headerRowIndex, recognizedColumns: s.recognizedColumns, rowCount: s.rows.length })),
      // 기존 contract 유지(shape 불변). (C-4D) new = 저장 대상, duplicate = 재업로드 제외.
      summary: { total: allRows.length, new: archivePlan.toSave, duplicate: archivePlan.reuploadExcluded, warning: warningCount },
      archivePlan,
      snapshotContext,          // (C-4G) 등록 방식 + 현재/신규 스냅샷 정보
      conflicts: plan.conflicts.slice(0, 20),
      sample,
      // (C-4D) duplicateAnalysis = "원본 동일행" 상세. safeToSkip 은 더 이상 Execute 차단에 쓰지 않는다.
      duplicateAnalysis: contentDup,
      duplicateSamples,
      // (C-4E) Excel 원본 미리보기 1페이지(headers + 첫 50행). 전체 30k 를 응답에 싣지 않음. 페이지 이동은 preview-rows 사용.
      //   progress 주민번호는 표시 사본(maskSheetsForDisplay)에서 마스킹 — 원본 sheets(rowHash/identity)는 불변.
      excelPreview: buildExcelPreviewPage(displaySheets, 1, 50),
      // (C-4H-2) Excel Identity 진단 — 전체 행 집계 통계만(raw 데이터 미전송). Execute 와 무관(진단 전용). RRN 은 마스킹 사본 집계.
      identityAnalysis: analyzeExcelIdentity(displaySheets),
      // (C-4I-a) Record Matching DRY-RUN — 기존 effective(현재 전행) 대비 NEW/SAME/UPDATED/AMBIGUOUS 분류. DB write 없음.
      recordMatching: await (async () => {
        // 기존 effective rows(read-only). is_effective 컬럼 미도입 단계 → 동일 source_type 전행을 비교 대상으로.
        const existing = await db.select({
          id: legacyArchiveRowsTable.id, sourceRow: legacyArchiveRowsTable.sourceRow, rowHash: legacyArchiveRowsTable.rowHash,
          recordDate: legacyArchiveRowsTable.recordDate, companyName: legacyArchiveRowsTable.companyName, contactName: legacyArchiveRowsTable.contactName,
          translatorName: legacyArchiveRowsTable.translatorName, productName: legacyArchiveRowsTable.productName, language: legacyArchiveRowsTable.language,
          deliveryDate: legacyArchiveRowsTable.deliveryDate, payoutDate: legacyArchiveRowsTable.payoutDate, payoutPretax: legacyArchiveRowsTable.payoutPretax,
          collectionDate: legacyArchiveRowsTable.collectionDate, collectionStatus: legacyArchiveRowsTable.collectionStatus,
          supplyAmount: legacyArchiveRowsTable.supplyAmount, vatAmount: legacyArchiveRowsTable.vatAmount, totalAmount: legacyArchiveRowsTable.totalAmount,
        }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.sourceType, sourceType), eq(legacyArchiveRowsTable.isEffective, true)));
        const toMatchable = (r: any): MatchableRow => ({
          id: r.id ?? null, sourceRow: r.sourceRow ?? 0, rowHash: r.rowHash,
          recordDate: r.recordDate ?? null, companyName: r.companyName ?? null, contactName: r.contactName ?? null,
          translatorName: r.translatorName ?? null, productName: r.productName ?? null, language: r.language ?? null,
          deliveryDate: r.deliveryDate ?? null, payoutDate: r.payoutDate ?? null, payoutPretax: r.payoutPretax ?? null,
          collectionDate: r.collectionDate ?? null, collectionStatus: r.collectionStatus ?? null,
          supplyAmount: r.supplyAmount ?? null, vatAmount: r.vatAmount ?? null, totalAmount: r.totalAmount ?? null,
        });
        return analyzeRecordMatching(allRows.map(toMatchable), existing.map(toMatchable));
      })(),
    });
  } catch (err) {
    req.log.error({ err }, "legacy-archive analyze failed");
    res.status(500).json({ error: "과거자료 분석 실패." });
  }
});

// POST /admin/legacy-archive/preview-rows — (C-4E) Excel 원본 미리보기 페이지 조회(READ-ONLY, DB 미접근).
//   프론트가 보유한 동일 File 을 재전송하여 page/pageSize 만 바꿔 요청한다(서버 세션/디스크/DB 저장 없음).
//   분석/중복판정을 수행하지 않으므로 C-4D 결과(total/duplicate 등)에 영향 없음.
router.post("/admin/legacy-archive/preview-rows", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  try {
    const sourceType = coerceSourceType(req.body?.sourceType);
    if (!sourceType) { res.status(400).json({ error: "sourceType 은 sales_list | progress | translator_list 중 하나여야 합니다." }); return; }
    if (!req.file?.buffer) { res.status(400).json({ error: "엑셀 파일(file)이 필요합니다." }); return; }
    const page = Math.max(1, Math.floor(Number(req.body?.page)) || 1);
    const pageSize = clampPreviewPageSize(req.body?.pageSize);
    const sheets = buildArchivePreview(req.file.buffer, sourceType);
    // progress 주민번호는 표시 사본에서 마스킹(원본 미변경). sales_list/translator_list 는 그대로.
    res.json(buildExcelPreviewPage(maskSheetsForDisplay(sourceType, sheets), page, pageSize));
  } catch (err) {
    req.log.error({ err }, "legacy-archive preview-rows failed");
    res.status(500).json({ error: "원본 미리보기 조회 실패." });
  }
});

// POST /admin/legacy-archive/execute — 저장(원본 재검증 후 transaction)
//   반복 업로드 개선: 변경분 미리보기(sync-preview)의 승인 토큰(planToken) + 대표 승인(approve=true) 필수, 관리자만.
//   신규·수정만 반영하고 중복 의심은 approvedAmbiguous 로 승인된 행만 저장한다. 삭제·취소 의심은 보고만.
router.post("/admin/legacy-archive/execute", requireAuth, requireRole("admin"), excelUpload.single("file"), async (req, res) => {
  try {
    const sourceType = coerceSourceType(req.body?.sourceType);
    if (!sourceType) { res.status(400).json({ error: "sourceType 은 sales_list | progress | translator_list 중 하나여야 합니다." }); return; }
    if (!req.file?.buffer) { res.status(400).json({ error: "엑셀 파일(file)이 필요합니다." }); return; }
    if (req.body?.approve !== "true") { res.status(400).json({ error: "대표 승인(approve=true)이 필요합니다. 변경분 미리보기를 확인한 뒤 승인하세요.", code: "APPROVAL_REQUIRED" }); return; }
    const planToken = String(req.body?.planToken ?? "");
    if (!planToken) { res.status(400).json({ error: "승인 토큰(planToken)이 없습니다. 변경분 미리보기를 먼저 실행하세요.", code: "APPROVAL_REQUIRED" }); return; }
    let approved: string[] = [];
    try { const v = JSON.parse(String(req.body?.approvedAmbiguous ?? "[]")); if (Array.isArray(v)) approved = v.map(String); } catch { /* 빈 승인 */ }

    const performerId = (req as any).user?.id ?? null;
    const fileName = decodeFileName(req.file.originalname);   // (C-4I-f) 저장되는 source_file/original_filename 도 한글 복원
    const result = await db.transaction(async (tx) =>
      executeArchiveSync(tx, {
        buffer: req.file!.buffer, sourceType, fileName, performerId,
        scope: req.body?.scope === "full" ? "full" : "range", planToken, approvedAmbiguous: new Set(approved),
      }),
    );
    res.json(result);
  } catch (err) {
    if (err instanceof SyncError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    // (C-4D) source identity 충돌 → 자동 overwrite/skip 금지. 409 로 거부(원본 무결성 보호).
    if ((err as any)?.code === "ARCHIVE_IDENTITY_CONFLICT") {
      res.status(409).json({ error: (err as Error).message, code: "ARCHIVE_IDENTITY_CONFLICT", conflicts: (err as any).conflicts });
      return;
    }
    req.log.error({ err }, "legacy-archive execute failed");
    res.status(500).json({ error: "과거자료 저장 실패." });
  }
});

// ─── C-4B: 검색 / 목록 / 상세 ─────────────────────────────────────────────────

export interface ArchiveSearchFilters {
  sourceType?: ArchiveSourceType | "all";
  q?: string;                 // 통합 키워드(company/contact/translator/product/language)
  dateFrom?: string; dateTo?: string;              // record_date
  company?: string; contact?: string; translator?: string; product?: string; language?: string;
  collectionStatus?: string;  // paid | unpaid (null 은 unpaid 로 취급 안 함)
  collectionDateFrom?: string; collectionDateTo?: string;
  deliveryDateFrom?: string; deliveryDateTo?: string;
  payoutDateFrom?: string; payoutDateTo?: string;
  page?: number; pageSize?: number;
  sort?: string;              // whitelist 외는 기본값
  snapshot?: string;          // (C-4G) 'current'(기본) | 'all'(전체 이력) | <batchId>(특정 스냅샷)
}

const T = legacyArchiveRowsTable;

// (판매목록 정렬) "판매일" 정렬/표시 키. 데이터 진단으로 날짜 필드 의미를 확인한 뒤 확정(과거 CRM 판매목록):
//   우선순위 ① record_date(정규화 판매/견적/체결일, 있으면) → ② 판매번호(YYYY-MM-DD-NNNN) 날짜 접두(100% 보유)
//            → ③ 세금계산서발행(예정)일.  입금일·지급일은 '판매일'이 아니므로 제외(판매번호일≠입금일 80%).
//   모든 후보가 YYYY-MM-DD 텍스트 → 사전식 정렬 = 연대순(::date 캐스팅 예외 없음). 없으면 NULL → NULLS LAST 로 뒤쪽.
//   progress 행은 판매번호/세금계산서 키가 없어 record_date 로 귀결 → 기존 동작 불변(요구 4: 판매 외 자료 영향 없음).
//   원본(source_raw)·DB 미변경: 조회 시점 계산만 수행.
const SALE_SORT_KEY = sql<string>`coalesce(
  to_char(${T.recordDate}, 'YYYY-MM-DD'),
  substring(${T.sourceRaw} ->> '판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'),
  substring(${T.sourceRaw} ->> '세금계산서발행(예정)일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
)`;

// (C-4I-k) 진행관리 '일반 업무용' 화면·다운로드에서 숨기는 원본 컬럼.
//   Volume1 = 수량의 정수절사값(30,142행 중 6,476행이 수량과 상이, 기존 CRM 업무화면엔 없는 중복 컬럼) → 일반 뷰/다운로드에서만 제외.
//   source_raw 원본값은 그대로 보존(삭제 안 함). 원본 스냅샷 다운로드(특정 batchId)에서는 41개 전부 유지.
const PROGRESS_GENERAL_HIDDEN_COLS: ReadonlySet<string> = new Set(["Volume1"]);
// 일반 뷰/다운로드용 컬럼 필터(progress 한정). 다른 유형(sales_list 등)엔 영향 없음.
export function applyGeneralHiddenCols(cols: string[], fullType: ArchiveSourceType): string[] {
  return fullType === "progress" ? cols.filter(c => !PROGRESS_GENERAL_HIDDEN_COLS.has(c)) : cols;
}

// (C-4I-m) 진행관리 원본 Excel 컬럼 순서(A~AO, 41개). 기존 분석(C-4I-h)에서 source_raw 키와 '집합 완전 일치' 확인된 권위 순서.
//   · 최종 확정 규칙 = 원본 Excel 순서. (C-4I-l 의 CRM 업무화면 정렬은 폐기)
//   · headers_json(원본 파일 순서)이 복원돼 있으면 그것을 우선, 없으면 이 권위 상수를 사용한다
//     (요구 4: 메타데이터 미복원 시 '임의 JSONB 키 순서'를 쓰지 않는다).
//   · 상수/메타에 없는 실제 source_raw 키는 삭제하지 않고 뒤에 보존(원본 보존).
const PROGRESS_ORIGINAL_EXCEL_ORDER: string[] = [
  "체결일", "계산서발행일", "견적서발행일", "견적서구분", "거래처명", "고객명", "연락처", "단어수", "글자수", "단가",
  "수량", "Volume1", "공급가액", "부가세", "총액", "입금일", "입금내역", "비고", "담당자", "내용",
  "상품명", "통번역사명", "주민등록번호", "상세정보", "파일명", "언어", "통번역사납품일", "통번역사지급일", "통역장소", "요금(100%)",
  "요율(85%)", "교통비", "출장비", "이동보상비", "저작권료", "취소보상비", "통번역수량", "단위", "통번역단가", "지급액(세전)",
  "지금액(세후)",
];
// progress 원본 Excel 순서 해석(progress 한정). resolvedHeaders = headers_json(있으면 원본 파일 순서) 우선, 없으면 권위 상수.
//   실제 존재 키만 순서대로, 상수/메타에 없는 키는 뒤에 보존. 임의 JSONB 키 순서는 사용하지 않는다.
export function resolveProgressExcelOrder(actualKeys: string[], resolvedHeaders: string[] | null, fullType: ArchiveSourceType): string[] {
  if (fullType !== "progress") return actualKeys;
  const present = new Set(actualKeys);
  const base = (resolvedHeaders && resolvedHeaders.length > 0) ? resolvedHeaders : PROGRESS_ORIGINAL_EXCEL_ORDER;
  const ordered = base.filter(c => present.has(c));
  const seen = new Set(ordered);
  return [...ordered, ...actualKeys.filter(c => !seen.has(c))];
}
// 특정 스냅샷(숫자 batchId) 다운로드 = '원본 스냅샷 다운로드' → 41개 전부 유지. 그 외(current/all)=일반 → Volume1 제외.
function isSpecificSnapshot(snapshot: string | undefined): boolean {
  return /^\d+$/.test((snapshot ?? "current").trim());
}

// 정렬 허용 키(raw column injection 방지): record_date(기본=판매일) | created_at | company_name. 그 외는 판매일로 귀결.
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// 날짜/문자열 유효성(간단): YYYY-MM-DD 만 날짜필터로 허용.
function validDate(s?: string): string | null { return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
// ILIKE wildcard 이스케이프(SQL injection 은 parameterized 로 방지 — wildcard 문자만 중화).
function likeTerm(s: string): string { return `%${s.replace(/[\\%_]/g, (c) => "\\" + c)}%`; }

function buildArchiveWhere(f: ArchiveSearchFilters): SQL | undefined {
  const conds: SQL[] = [];
  // (C-4I-b) 기본 조회 = effective 누적(is_effective). 부분파일 업로드 후에도 과거 자료 소실 없음(§13).
  //   'all'=전체 이력(superseded 포함), 숫자=특정 스냅샷(import_batch provenance).
  const snap = (f.snapshot ?? "current").trim();
  if (snap === "all") { /* 전체 이력: 필터 없음 */ }
  else if (/^\d+$/.test(snap)) conds.push(eq(T.importBatchId, Number(snap)));   // 특정 스냅샷 provenance
  else conds.push(eq(T.isEffective, true));   // 기본값 = effective 누적(C-4G is_current 아님)
  if (f.sourceType && f.sourceType !== "all") conds.push(eq(T.sourceType, f.sourceType));
  if (f.q && f.q.trim()) {
    const term = likeTerm(f.q.trim());
    const ors = [ilike(T.companyName, term), ilike(T.contactName, term), ilike(T.translatorName, term), ilike(T.productName, term), ilike(T.language, term)].filter(Boolean) as SQL[];
    const orExpr = or(...ors);
    if (orExpr) conds.push(orExpr);
  }
  if (f.company?.trim()) conds.push(ilike(T.companyName, likeTerm(f.company.trim())));
  if (f.contact?.trim()) conds.push(ilike(T.contactName, likeTerm(f.contact.trim())));
  if (f.translator?.trim()) conds.push(ilike(T.translatorName, likeTerm(f.translator.trim())));
  if (f.product?.trim()) conds.push(ilike(T.productName, likeTerm(f.product.trim())));
  if (f.language?.trim()) conds.push(ilike(T.language, likeTerm(f.language.trim())));
  // 입금상태: 명시값만. null 은 제외도 포함도 강제하지 않음(= 그대로 필터하지 않으면 전부 포함).
  if (f.collectionStatus === "paid" || f.collectionStatus === "unpaid") conds.push(eq(T.collectionStatus, f.collectionStatus));
  // 날짜범위: 해당 normalized 날짜가 있는 row 에만 적용(null 은 범위필터시 자연 제외).
  const dFrom = validDate(f.dateFrom), dTo = validDate(f.dateTo);
  if (dFrom) conds.push(gte(T.recordDate, dFrom));
  if (dTo) conds.push(lte(T.recordDate, dTo));
  const cFrom = validDate(f.collectionDateFrom), cTo = validDate(f.collectionDateTo);
  if (cFrom) conds.push(gte(T.collectionDate, cFrom));
  if (cTo) conds.push(lte(T.collectionDate, cTo));
  const delFrom = validDate(f.deliveryDateFrom), delTo = validDate(f.deliveryDateTo);
  if (delFrom) conds.push(gte(T.deliveryDate, delFrom));
  if (delTo) conds.push(lte(T.deliveryDate, delTo));
  const pFrom = validDate(f.payoutDateFrom), pTo = validDate(f.payoutDateTo);
  if (pFrom) conds.push(gte(T.payoutDate, pFrom));
  if (pTo) conds.push(lte(T.payoutDate, pTo));
  return conds.length ? and(...conds) : undefined;
}

const LIST_SELECT = {
  id: T.id, sourceType: T.sourceType, recordDate: T.recordDate,
  saleDate: SALE_SORT_KEY,          // (판매목록) 표시·정렬용 판매일(record_date null 인 판매행도 날짜 표시). 원본 미변경.
  companyName: T.companyName, contactName: T.contactName, translatorName: T.translatorName,
  productName: T.productName, language: T.language, totalAmount: T.totalAmount, payoutPretax: T.payoutPretax,
  deliveryDate: T.deliveryDate, payoutDate: T.payoutDate, collectionDate: T.collectionDate, collectionStatus: T.collectionStatus,
  sourceFile: T.sourceFile, sourceSheet: T.sourceSheet, sourceRow: T.sourceRow,
};

export async function searchArchive(dbx: any, f: ArchiveSearchFilters) {
  const where = buildArchiveWhere(f);
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(f.pageSize) || DEFAULT_PAGE_SIZE)));

  // 정렬: 기본 = 판매일(SALE_SORT_KEY) 최신순, 2차 id desc(deterministic). 날짜 없는 자료는 항상 뒤(NULLS LAST).
  //   record_date(기본)·미지정·미허용 정렬키 → 판매일 기준. created_at/company_name 명시 시에만 해당 컬럼.
  const [sortField, sortDirRaw] = (f.sort || "record_date:desc").split(":");
  const dir = sortDirRaw === "asc" ? "asc" : "desc";
  let primary: SQL;
  if (sortField === "created_at") primary = dir === "asc" ? asc(T.createdAt) : desc(T.createdAt);
  else if (sortField === "company_name") primary = dir === "asc" ? asc(T.companyName) : desc(T.companyName);
  else primary = dir === "asc" ? sql`${SALE_SORT_KEY} asc nulls last` : sql`${SALE_SORT_KEY} desc nulls last`;

  const totalRow = await dbx.select({ n: count() }).from(T).where(where);
  const total = Number(totalRow[0]?.n ?? 0);

  const rows = await dbx.select(LIST_SELECT).from(T)
    .where(where)
    .orderBy(primary, desc(T.id))
    .limit(pageSize).offset((page - 1) * pageSize);

  return { rows, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

// (C-4I-c/g) 전체컬럼 조회 — source_raw 원본 전체를 그대로 투영(server pagination). 동일 필터 재사용.
//   normalized 가 아니라 원본 보존값. 상세 이동 없음(이 응답은 목록 테이블 전용).
//   정렬(화면·다운로드 일치): sales_list = 판매일(SALE_SORT_KEY) 최신순, id desc. 그 외(progress) = 원본 Excel 순서(import_batch→source_row→id).
export async function searchArchiveFull(dbx: any, f: ArchiveSearchFilters, fullType?: ArchiveSourceType) {
  const where = buildArchiveWhere(f);
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(f.pageSize) || DEFAULT_PAGE_SIZE)));
  const totalRow = await dbx.select({ n: count() }).from(T).where(where);
  const total = Number(totalRow[0]?.n ?? 0);
  const orderBy: SQL[] = fullType === "sales_list"
    ? [sql`${SALE_SORT_KEY} desc nulls last`, sql`${T.id} desc`]
    : [sql`${T.importBatchId} asc`, sql`${T.sourceRow} asc`, sql`${T.id} asc`];
  const rows = await dbx.select({ id: T.id, sourceRow: T.sourceRow, importBatchId: T.importBatchId, sourceSheet: T.sourceSheet, sourceRaw: T.sourceRaw })
    .from(T).where(where).orderBy(...orderBy)
    .limit(pageSize).offset((page - 1) * pageSize);
  return { rows, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

// (C-4I-c) 진행관리 전체컬럼 조회용 canonical header 순서 — 최신 current 스냅샷의 headers_json(원본 순서).
//   미저장(과거 import)면 resolved=false → 호출측에서 source_raw 키 union 으로 폴백(원본순서 아님, 재-Preview 시 backfill).
export async function progressCanonicalHeaders(dbx: any, sourceType: ArchiveSourceType): Promise<{ headers: string[]; resolved: boolean }> {
  const b = await dbx.select({ h: importBatchesTable.headersJson }).from(importBatchesTable)
    .where(and(eq(importBatchesTable.module, "legacy_archive"), eq(importBatchesTable.sourceType, sourceType), eq(importBatchesTable.isCurrent, true)))
    .orderBy(desc(importBatchesTable.id)).limit(1);
  const hj = b[0]?.h;
  return Array.isArray(hj) && hj.length > 0 ? { headers: hj as string[], resolved: true } : { headers: [], resolved: false };
}

export async function getArchiveRow(dbx: any, id: number) {
  const rows = await dbx.select().from(T).where(eq(T.id, id)).limit(1);
  return rows[0] ?? null;
}

// (C-4J-2C-7) 판매건(sale_row_id)에 연결된 통번역 진행관리 수행행 조회 — 완전 READ-ONLY.
//   · 기존 매핑 테이블(legacy_sales_progress_links, decision='confirmed')만 조회한다. 매핑 재실행/추정 연결 없음.
//   · 원본 progress 행(source_raw 포함)을 그대로 반환(값 추정·생성 없음). 원본 행 순서(source_row) 유지.
//   · 동일 통번역사의 여러 수행행도 병합하지 않고 각 행을 그대로 반환한다.
const L = legacySalesProgressLinksTable;
export async function getLinkedProgress(dbx: any, saleRowId: number) {
  return dbx.select({
    linkId: L.id, progressRowId: T.id, sourceRow: T.sourceRow,
    translatorName: T.translatorName, language: T.language, productName: T.productName,
    recordDate: T.recordDate, deliveryDate: T.deliveryDate, payoutDate: T.payoutDate, payoutPretax: T.payoutPretax,
    sourceRaw: T.sourceRaw, matchMethod: L.matchMethod, matchKey: L.matchKey,
  }).from(L).innerJoin(T, eq(T.id, L.progressRowId))
    // 반복 업로드: 수정으로 대체된 이전 버전 행·되돌린 이관 연결은 제외(새 버전으로 이관된 연결만 표시 → 중복 표시 방지).
    .where(and(eq(L.saleRowId, saleRowId), eq(L.decision, "confirmed"), eq(T.isEffective, true)))
    .orderBy(asc(T.sourceRow), asc(L.id));
}

// 쿼리스트링 → 검색 필터. 목록/다운로드 엔드포인트가 동일 규칙을 공유(화면·다운로드 필터 정합성).
function parseArchiveFilters(qp: Record<string, string | undefined>): ArchiveSearchFilters {
  return {
    sourceType: coerceSourceType(qp.sourceType) ?? "all",
    q: qp.q, dateFrom: qp.dateFrom, dateTo: qp.dateTo,
    company: qp.company, contact: qp.contact, translator: qp.translator, product: qp.product, language: qp.language,
    collectionStatus: qp.collectionStatus,
    collectionDateFrom: qp.collectionDateFrom, collectionDateTo: qp.collectionDateTo,
    deliveryDateFrom: qp.deliveryDateFrom, deliveryDateTo: qp.deliveryDateTo,
    payoutDateFrom: qp.payoutDateFrom, payoutDateTo: qp.payoutDateTo,
    page: qp.page ? Number(qp.page) : undefined, pageSize: qp.pageSize ? Number(qp.pageSize) : undefined, sort: qp.sort,
    snapshot: qp.snapshot,       // (C-4G) 기본 current(=effective)
  };
}

// GET /admin/legacy-archive — 검색/목록(server-side pagination)
router.get("/admin/legacy-archive", ...adminGuard, async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const filters = parseArchiveFilters(qp);
    // (C-4I-c/e/g) 전체컬럼(full) 뷰 대상 유형 판정 — 서버 데이터 기준. 원본 header·순서·값(source_raw) 그대로.
    //   · progress 탭 → 원본 41컬럼 full.
    //   · sales_list 탭 → 원본 9컬럼 full(판매번호 등 원본 명칭·전체 문자열. '입금/지급일' 통합명 미사용).
    //   · '전체' 탭 → 결과가 단일 유형이면 그 유형(progress/sales_list) full, 서로 다른 유형 혼합이면 요약 목록.
    //   어떤 경우에도 count/정렬/페이지네이션 규칙은 불변.
    let fullType: ArchiveSourceType | null =
      filters.sourceType === "progress" ? "progress" :
      filters.sourceType === "sales_list" ? "sales_list" :
      filters.sourceType === "translator_list" ? "translator_list" : null;
    if (!fullType && filters.sourceType === "all") {
      const typeRows = await db.selectDistinct({ t: T.sourceType }).from(T).where(buildArchiveWhere(filters));
      const types = typeRows.map((r: any) => r.t).filter(Boolean);
      if (types.length === 1) fullType = types[0] as ArchiveSourceType;
    }
    if (fullType) {
      const full = await searchArchiveFull(db, filters, fullType);
      const { headers, resolved } = await progressCanonicalHeaders(db, fullType);
      // 실제 존재 키 집합(현재 페이지 source_raw 키 + headers_json union).
      const keySet = new Set<string>(resolved ? headers : []);
      const keyUnion: string[] = resolved ? [...headers] : [];
      // 내부 보존 키(__resident_number_enc 등)는 화면 컬럼에서 제외(암호문·마커는 표시 대상 아님). progress/sales_list 엔 '__' 키가 없어 무영향.
      for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!k.startsWith("__") && !keySet.has(k)) { keySet.add(k); keyUnion.push(k); }
      // 응답 rows 의 source_raw 사본에 읽기 마스킹 적용(내부 키 제거 + progress 주민번호 마스킹). 저장 원본 미변경.
      for (const r of full.rows as any[]) r.sourceRaw = maskSourceRawForRead(fullType, r.sourceRaw);
      let cols: string[];
      let headersResolved: boolean;
      if (fullType === "progress") {
        // (C-4I-m) 진행관리 일반 조회 = 원본 Excel 순서(headers_json 우선, 없으면 권위 상수). 임의 JSONB 키순서 미사용.
        cols = resolveProgressExcelOrder(keyUnion, resolved ? headers : null, "progress");
        // (C-4I-k) Volume1 만 일반 화면/다운로드에서 제외 → 40컬럼. 수량 등 원본값 그대로.
        cols = applyGeneralHiddenCols(cols, "progress");
        headersResolved = true;   // 원본 Excel 순서(권위) 적용 → 임시순서 경고 불필요
      } else {
        // sales_list 등: 기존 동작(headers_json resolved 우선 + 현재 페이지 키 union 폴백).
        cols = keyUnion;
        headersResolved = resolved;
      }
      res.json({ view: "full", sourceType: fullType, headers: cols, headersResolved, rows: full.rows, pagination: full.pagination });
      return;
    }
    const result = await searchArchive(db, filters);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "legacy-archive search failed");
    res.status(500).json({ error: "과거자료 검색 실패." });
  }
});

// GET /admin/legacy-archive-snapshots — (C-4G) 스냅샷 이력 목록(source_type 별). 과거 스냅샷 조회 UI 용.
router.get("/admin/legacy-archive-snapshots", ...adminGuard, async (req, res) => {
  try {
    const st = coerceSourceType((req.query as any)?.sourceType);
    const conds: SQL[] = [eq(importBatchesTable.module, "legacy_archive")];
    if (st) conds.push(eq(importBatchesTable.sourceType, st));
    const rows = await db.select({
      id: importBatchesTable.id,
      sourceType: importBatchesTable.sourceType,
      originalFilename: importBatchesTable.originalFilename,
      fileHash: importBatchesTable.fileHash,
      totalRows: importBatchesTable.totalRows,
      successRows: importBatchesTable.successRows,
      isCurrent: importBatchesTable.isCurrent,
      status: importBatchesTable.status,
      createdAt: importBatchesTable.createdAt,
    }).from(importBatchesTable)
      .where(and(...conds))
      .orderBy(desc(importBatchesTable.createdAt), desc(importBatchesTable.id))
      .limit(500);
    // file_hash 는 식별용 앞 12자만 노출(원문 전체 불필요).
    res.json({ snapshots: rows.map((r: any) => ({ ...r, fileHash: r.fileHash ? String(r.fileHash).slice(0, 12) : null })) });
  } catch (err) {
    req.log.error({ err }, "legacy-archive snapshots failed");
    res.status(500).json({ error: "스냅샷 이력 조회 실패." });
  }
});

// GET /admin/legacy-archive/:id — 단건 상세(normalized + source_raw + metadata)
router.get("/admin/legacy-archive/:id", ...adminGuard, async (req, res, next) => {
  // 숫자가 아닌 경로(export, export-estimate 등)는 아래에 등록된 전용 라우트로 넘긴다(라우트 충돌 방지).
  if (!/^\d+$/.test(String(req.params.id))) { next(); return; }
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
    const row = await getArchiveRow(db, id);
    if (!row) { res.status(404).json({ error: "과거자료를 찾을 수 없습니다." }); return; }
    // (C-4J-2C-7) 판매건 상세에 연결된 통번역사 수행정보(READ-ONLY) 동봉. 응답 shape 는 additive(기존 필드 불변).
    const linkedProgress = row.sourceType === "sales_list" ? await getLinkedProgress(db, id) : [];
    // 상세 응답 사본에 읽기 마스킹 적용(내부 키 제거 + progress 주민번호 마스킹). 저장 원본 미변경.
    const maskedRow = { ...row, sourceRaw: maskSourceRawForRead(row.sourceType as string, row.sourceRaw as any) };
    // 연결된 progress 수행행의 source_raw(평문 RRN 포함)도 동일 마스킹.
    const maskedLinked = (linkedProgress as any[]).map((lp) => ({ ...lp, sourceRaw: maskSourceRawForRead("progress", lp.sourceRaw) }));
    // 운영 판매건 전환 여부(additive) — 판매번호 기준 매핑(원본 행 버전과 무관).
    const saleNo = row.sourceType === "sales_list" ? String((row.sourceRaw as any)?.["판매번호"] ?? "").trim() : "";
    const activation = saleNo ? await findActivationBySaleNo(db, saleNo) : null;
    // 판매번호에 연결된 고객 담당자 Master(수동 보완·정확 일치 자동 연결) — 없으면 화면은 진행관리표 복원 고객명(미연결)을 보여 준다
    const linkedContactName = saleNo ? ((await db.execute(sql`SELECT ${linkedContactNameOfSaleNo(saleNo)} AS name`)).rows[0] as any)?.name ?? null : null;
    // 고객 담당자 확인 필요(B: 연결키가 같은 판매 복수) — 최신 복원 실행 배치 기준
    const contactReviewNeeded = row.sourceType === "sales_list" ? Boolean(((await db.execute(sql`SELECT ${reviewNeededOfSaleRow(id)} AS v`)).rows[0] as any)?.v) : false;
    res.json({ ...maskedRow, linkedProgress: maskedLinked, activation, linkedContactName, contactReviewNeeded });
  } catch (err) {
    req.log.error({ err }, "legacy-archive detail failed");
    res.status(500).json({ error: "과거자료 상세 조회 실패." });
  }
});

// ─── C-4I-d: Excel 다운로드(READ-ONLY, 스트리밍) ──────────────────────────────
//   · 현재 검색 결과 전체(scope=search) 또는 현재 탭의 전체 유효기록(scope=all) 을 .xlsx 로 내보낸다.
//   · source_raw 원본값을 원본 header 순서로 출력(normalized 아님). 첫 컬럼은 Excel 행번호(source_row).
//   · DB 는 배치로 읽고 exceljs streaming writer 로 응답에 흘려보내 메모리 상한을 배치 크기로 고정한다.
//   · INSERT/UPDATE/DELETE 없음. 기존 30,142행·원본 이력 불변.
const SOURCE_TYPE_SHEET: Record<ArchiveSourceType, string> = { sales_list: "판매목록", progress: "통번역 진행관리", translator_list: "CRM 통번역사 명부" };
const EXPORT_BATCH = 5000;                 // DB 배치 크기(메모리 상한 = 이 배치 1개 분량)
const EXCEL_MAX_DATA_ROWS = 1_048_575;     // 시트 최대행(1,048,576) − header 1행. 초과 시 시트 분할.

// scope=all → 키워드/텍스트/날짜/입금상태 필터 제거, snapshot=current(effective) 강제, 자료유형(탭)만 유지.
// scope=search → 화면 필터 그대로(page/pageSize/sort 는 다운로드에서 무시: 일치 전행 출력).
function normalizeExportFilters(scope: "search" | "all", f: ArchiveSearchFilters): ArchiveSearchFilters {
  if (scope === "all") return { sourceType: f.sourceType ?? "all", snapshot: "current" };
  return { ...f, page: undefined, pageSize: undefined };
}

// source_raw 값 → Excel 셀. 원본값 손상 금지: null→빈 셀, "" 보존, 숫자/불린/문자열 타입 유지.
// 문자열은 '문자열 셀'로 기록되므로 선행 =,+,-,@ 가 수식으로 실행되지 않는다(값 변경 없이 안전).
function toExcelCell(v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  return JSON.stringify(v);   // 객체/배열 등 비원시값은 원본 표현 유지
}

// 내보낼 자료유형 목록 — 특정 탭이면 그 유형만, 'all' 탭이면 일치 행이 있는 유형만(혼합 시 유형별 시트 분리).
async function resolveExportTypes(dbx: any, base: ArchiveSearchFilters): Promise<ArchiveSourceType[]> {
  if (base.sourceType && base.sourceType !== "all") return [base.sourceType as ArchiveSourceType];
  const out: ArchiveSourceType[] = [];
  for (const t of ARCHIVE_SOURCE_TYPES) {
    const n = Number((await dbx.select({ n: count() }).from(T).where(buildArchiveWhere({ ...base, sourceType: t })))[0]?.n ?? 0);
    if (n > 0) out.push(t);
  }
  return out;
}

// 출력 컬럼 header — 최신 스냅샷의 원본 header 순서(resolved). 스냅샷에 없는 추가 source_raw 키는 뒤에 덧붙여 컬럼 누락 방지.
// 미해결(과거 import)이면 폴백: 첫 행(export 정렬 기준)의 source_raw 키 순서를 기본으로, 다른 행에만 있는 키를 뒤에 덧붙인다.
//   · 조회 화면의 폴백(현재 페이지 행들의 키 등장순서 union)과 동일한 규칙 → 화면/다운로드 컬럼 순서 정합.
//   · 결정적(DISTINCT 해시 임의순서 회피). 원본 순서 자체는 [Excel 등록] Preview 1회로 headers_json 이 채워지면 resolved 된다.
//   hideGeneral=true(일반 다운로드)면 progress 의 Volume1 등 일반숨김 컬럼을 제외(40개). false(원본 스냅샷)면 41개 전부.
async function resolveExportHeaders(dbx: any, type: ArchiveSourceType, where: SQL | undefined, hideGeneral: boolean): Promise<string[]> {
  const { headers, resolved } = await progressCanonicalHeaders(dbx, type);
  // 전체 매칭 행의 키 union(누락 방지) — DISTINCT.
  const keyRows = await dbx.selectDistinct({ k: sql<string>`jsonb_object_keys(${T.sourceRaw})` }).from(T).where(where);
  // 내부 보존 키(__resident_number_enc 등)는 다운로드 컬럼에서도 제외 — 목록/상세 응답과 동일(암호문·마커 미노출). progress/sales_list 엔 '__' 키가 없어 무영향.
  const allKeys: string[] = keyRows.map((r: any) => r.k).filter((k: unknown): k is string => typeof k === "string" && !k.startsWith("__"));

  let cols: string[];
  if (type === "progress") {
    // (C-4I-m) 진행관리 = 원본 Excel 순서(headers_json 우선, 없으면 권위 상수). 임의 JSONB 키순서 미사용(요구 4).
    cols = resolveProgressExcelOrder(allKeys, resolved ? headers : null, "progress");
  } else if (resolved) {
    const seen = new Set(headers);
    cols = [...headers, ...allKeys.filter(k => !seen.has(k))];
  } else {
    // sales_list 등: 첫 행의 키 등장순서를 기준으로 폴백.
    const first = await dbx.select({ sourceRaw: T.sourceRaw }).from(T).where(where)
      .orderBy(asc(T.importBatchId), asc(T.sourceRow), asc(T.id)).limit(1);
    const firstKeys: string[] = first[0]?.sourceRaw && typeof first[0].sourceRaw === "object"
      ? Object.keys(first[0].sourceRaw as Record<string, unknown>).filter(k => !k.startsWith("__")) : [];
    const seen = new Set(firstKeys);
    cols = [...firstKeys, ...allKeys.filter(k => !seen.has(k))];
  }
  // (C-4I-k/m) 일반 다운로드: Volume1 제외(progress). 원본 스냅샷 다운로드: 원본 순서·41개(Volume1 포함) 그대로.
  return hideGeneral ? applyGeneralHiddenCols(cols, type) : cols;
}

// 한 자료유형을 배치로 읽어 시트에 흘려보낸다. 행 수가 Excel 시트 한도를 넘으면 (2),(3)… 시트로 분할.
// 정렬(화면과 동일): sales_list = 판매일(SALE_SORT_KEY) 최신순, id desc. progress = import_batch → source_row → id(원본 Excel 순서).
//   → 요구 6(다운로드도 동일 정렬) + 요구 4(판매 외 자료 영향 없음). source_raw 원본값만 투영.
async function streamTypeSheet(wb: ExcelJS.stream.xlsx.WorkbookWriter, type: ArchiveSourceType, where: SQL | undefined, headers: string[]): Promise<number> {
  const headerRow = ["Excel 행", ...headers];
  const orderBy: SQL[] = type === "sales_list"
    ? [sql`${SALE_SORT_KEY} desc nulls last`, sql`${T.id} desc`]
    : [sql`${T.importBatchId} asc`, sql`${T.sourceRow} asc`, sql`${T.id} asc`];
  let part = 1;
  let ws = wb.addWorksheet(SOURCE_TYPE_SHEET[type]);
  ws.addRow(headerRow).commit();
  let rowsInSheet = 0;
  let written = 0;
  let offset = 0;
  for (;;) {
    const batch = await db.select({ sourceRow: T.sourceRow, sourceRaw: T.sourceRaw })
      .from(T).where(where)
      .orderBy(...orderBy)
      .limit(EXPORT_BATCH).offset(offset);
    if (batch.length === 0) break;
    for (const r of batch) {
      if (rowsInSheet >= EXCEL_MAX_DATA_ROWS) {
        await ws.commit();
        part++;
        ws = wb.addWorksheet(`${SOURCE_TYPE_SHEET[type]}(${part})`);
        ws.addRow(headerRow).commit();
        rowsInSheet = 0;
      }
      // 다운로드 셀도 읽기 마스킹 적용(progress 주민번호 마스킹 + __ 키 제외). 저장 원본 미변경.
      const raw = maskSourceRawForRead(type, (r.sourceRaw ?? {}) as Record<string, unknown>);
      ws.addRow([r.sourceRow ?? null, ...headers.map(h => toExcelCell(raw[h]))]).commit();
      rowsInSheet++; written++;
    }
    offset += batch.length;
    if (batch.length < EXPORT_BATCH) break;
  }
  await ws.commit();
  return written;
}

export interface ArchiveExportPlan {
  scope: "search" | "all";
  base: ArchiveSearchFilters;
  entries: { type: ArchiveSourceType; where: SQL | undefined; headers: string[] }[];
}

// 다운로드 계획 — 스트리밍 전에 수행하는 전부 read-only 조회(유형·컬럼 header). 실패 시 깨끗한 JSON 오류를 반환할 수 있게 분리.
export async function planArchiveExport(dbx: any, scope: "search" | "all", filters: ArchiveSearchFilters): Promise<ArchiveExportPlan> {
  const base = normalizeExportFilters(scope, filters);
  // (C-4I-k) 특정 스냅샷(숫자 batchId) 다운로드 = 원본 스냅샷 → 41개 전부. 그 외(current/all 일반 다운로드) → Volume1 제외.
  const hideGeneral = !isSpecificSnapshot(base.snapshot);
  const types = await resolveExportTypes(dbx, base);
  const entries: ArchiveExportPlan["entries"] = [];
  for (const type of types) {
    const where = buildArchiveWhere({ ...base, sourceType: type });
    entries.push({ type, where, headers: await resolveExportHeaders(dbx, type, where, hideGeneral) });
  }
  return { scope, base, entries };
}

// 계획 → .xlsx 스트리밍 기록(READ-ONLY). 응답/파일 어느 stream 에도 쓸 수 있어 테스트에서 재사용한다.
export async function writeArchiveWorkbook(stream: Writable, plan: ArchiveExportPlan): Promise<{ sheets: { label: string; rows: number }[] }> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: false, useSharedStrings: false });
  const sheets: { label: string; rows: number }[] = [];
  if (plan.entries.length === 0) {
    const ws = wb.addWorksheet("과거 CRM 자료");
    ws.addRow(["Excel 행"]).commit();
    await ws.commit();
  } else {
    for (const e of plan.entries) {
      const rows = await streamTypeSheet(wb, e.type, e.where, e.headers);
      sheets.push({ label: SOURCE_TYPE_SHEET[e.type], rows });
    }
  }
  await wb.commit();   // zip 마무리 → stream 종료
  return { sheets };
}

// GET /admin/legacy-archive/export-estimate — 다운로드 대상 행수(유형별). 모달의 "N행 다운로드" 표시용(READ-ONLY).
router.get("/admin/legacy-archive/export-estimate", ...adminGuard, async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const scope = qp.scope === "all" ? "all" : "search";
    const base = normalizeExportFilters(scope, parseArchiveFilters(qp));
    const specific = base.sourceType && base.sourceType !== "all";
    const typesToCount = specific ? [base.sourceType as ArchiveSourceType] : [...ARCHIVE_SOURCE_TYPES];
    const types: { sourceType: ArchiveSourceType; label: string; count: number }[] = [];
    let total = 0;
    for (const t of typesToCount) {
      const n = Number((await db.select({ n: count() }).from(T).where(buildArchiveWhere({ ...base, sourceType: t })))[0]?.n ?? 0);
      total += n;
      if (n > 0 || specific) types.push({ sourceType: t, label: SOURCE_TYPE_SHEET[t], count: n });
    }
    res.json({ scope, sourceType: base.sourceType ?? "all", total, types });
  } catch (err) {
    req.log.error({ err }, "legacy-archive export-estimate failed");
    res.status(500).json({ error: "다운로드 대상 행수 조회 실패." });
  }
});

// GET /admin/legacy-archive/export — .xlsx 스트리밍 다운로드(READ-ONLY).
router.get("/admin/legacy-archive/export", ...adminGuard, async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const scope = qp.scope === "all" ? "all" : "search";

    // 스트리밍 시작 전에 모든 read-only 조회(유형·header)를 끝내 실패 시 깨끗한 JSON 오류를 반환한다.
    const plan = await planArchiveExport(db, scope, parseArchiveFilters(qp));

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const fname = `과거CRM자료_${scope === "all" ? "전체" : "검색결과"}_${stamp}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.setHeader("Cache-Control", "no-store");

    try {
      await writeArchiveWorkbook(res, plan);
    } catch (streamErr) {
      // 스트리밍 도중 실패 → 헤더는 이미 전송됨. 불완전 파일 방지를 위해 연결을 끊는다.
      req.log.error({ streamErr }, "legacy-archive export stream failed");
      res.destroy(streamErr as Error);
    }
  } catch (err) {
    req.log.error({ err }, "legacy-archive export failed");
    if (!res.headersSent) res.status(500).json({ error: "과거자료 다운로드 실패." });
    else res.destroy(err as Error);
  }
});

export default router;
