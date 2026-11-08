/**
 * 회사 자료보관함 — AI 자동 분석·분류 (등록 처리 목적 한정).
 *
 *  · 업로드 직후 원본·문서는 먼저 저장되고(유실 방지), 이 모듈이 비동기로 분류 결과를 반영한다.
 *  · 저장 폴더는 기존 폴더 중에서만 선택한다(AI 가 폴더를 새로 만들지 않음). 불명확하면 「분류 확인 필요」 폴더에 그대로 둔다.
 *  · 문서에 없는 사실은 만들지 않는다 — 날짜는 원문 발췌(evidence)가 실제 본문에 있을 때만 반영.
 *  · DB 스키마 변경 없이: 기존 컬럼(유형·제목·요약·키워드·작성일·만료일·보안등급·폴더)에 반영하고,
 *    컬럼이 없는 분석 항목(시행일·관련 업무/부서·개인정보 여부·신뢰도·중복/개정 후보)은 감사로그(ai_classify) metadata 에 보존.
 *  · AI 직원의 업무 활용(aiAllowed)·공식 서식/매뉴얼 지정(isStandardForm)은 여기서 절대 켜지 않는다(관리자 승인 사항).
 */
import OpenAI from "openai";
import {
  db, archiveDocumentsTable, archiveDocumentVersionsTable, archiveFoldersTable, archiveAuditLogsTable,
} from "@workspace/db";
import { and, eq, isNull, ne, desc } from "drizzle-orm";
import { loadAclContext, folderPath, folderUsable } from "./archiveAccess";

// ─── 기본 분류체계(8) ↔ 기존 자료유형(docType) ────────────────────────────────
export const ARCHIVE_CATEGORIES = [
  { key: "form", label: "문서 서식", docType: "form_template" },
  { key: "manual", label: "업무매뉴얼", docType: "manual" },
  { key: "process", label: "업무프로세스", docType: "policy" },
  { key: "contract", label: "계약·협약", docType: "contract" },
  { key: "email", label: "이메일·공문", docType: "email" },
  { key: "hr", label: "인사·복지", docType: "general" },
  { key: "management", label: "경영·기획·통계", docType: "report" },
  { key: "other", label: "기타·분류 확인 필요", docType: "other" },
] as const;
export type ArchiveCategoryKey = (typeof ARCHIVE_CATEGORIES)[number]["key"];

export const REVIEW_FOLDER_NAME = "분류 확인 필요";

/** 「분류 확인 필요」 폴더 — 기존 폴더가 있으면 재사용, 없을 때만 1회 생성(동시 업로드 중복 생성 방지 잠금). */
let reviewFolderLock: Promise<number> | null = null;
export async function ensureReviewFolder(actorId: number | null): Promise<number> {
  if (reviewFolderLock) return reviewFolderLock;
  reviewFolderLock = (async () => {
    const [found] = await db.select({ id: archiveFoldersTable.id }).from(archiveFoldersTable)
      .where(and(eq(archiveFoldersTable.name, REVIEW_FOLDER_NAME), eq(archiveFoldersTable.isActive, true), isNull(archiveFoldersTable.deletedAt)))
      .orderBy(archiveFoldersTable.id).limit(1);
    if (found) return found.id;
    const [f] = await db.insert(archiveFoldersTable).values({
      name: REVIEW_FOLDER_NAME, description: "AI 분류가 불명확하거나 내용 추출이 불가한 자료 — 관리자가 확인 후 이동",
      sortOrder: 9990, isSystem: true, createdBy: actorId,
    }).returning({ id: archiveFoldersTable.id });
    return f.id;
  })();
  try { return await reviewFolderLock; } finally { reviewFolderLock = null; }
}

// ─── AI 분석 ────────────────────────────────────────────────────────────────

export interface ArchiveAiResult {
  category: ArchiveCategoryKey;
  folderId: number | null;
  confidence: "high" | "medium" | "low";
  title: string | null;
  summary: string | null;
  keywords: string[];
  relatedWork: string | null;
  relatedDepartment: string | null;
  documentDate: string | null;
  effectiveDate: string | null;
  expiresAt: string | null;
  dateEvidence: Record<string, string | null>;
  containsPersonalInfo: boolean;
  personalInfoTypes: string[];
  containsConfidential: boolean;
  formKind: string | null;
  manualKind: string | null;
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** 날짜: YYYY-MM-DD 이고, 원문 발췌가 본문에 실제로 있으며 발췌에 해당 연도가 포함될 때만 인정 */
function verifiedDate(v: any, normText: string): { value: string | null; evidence: string | null } {
  const value = typeof v?.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.value) && !Number.isNaN(Date.parse(v.value)) ? v.value : null;
  const evidence = str(v?.evidence, 200);
  if (!value || !evidence) return { value: null, evidence: null };
  const ev = norm(evidence);
  // 발췌 속 숫자에 연(4자리 또는 2자리)·월·일이 모두 있어야 함 — 발췌와 다른 날짜를 만든 경우 배제
  const nums = (evidence.match(/\d+/g) ?? []).map(Number);
  const [y, m, d] = value.split("-").map(Number);
  const matches = (nums.includes(y) || nums.includes(y % 100)) && nums.includes(m) && nums.includes(d);
  return ev.length >= 4 && normText.includes(ev) && matches ? { value, evidence } : { value: null, evidence: null };
}

const RRN_RE = /\b\d{6}\s?-\s?[1-4]\d{6}\b/;

export async function analyzeArchiveText(input: {
  text: string; fileName: string; relativePath?: string | null;
  folders: Array<{ id: number; path: string }>;
}): Promise<ArchiveAiResult> {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI 설정이 없습니다.");
  const client = new OpenAI({ apiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
  const body = input.text.slice(0, 12000);
  const folderList = input.folders.slice(0, 300).map(f => `${f.id}: ${f.path}`).join("\n");
  const cats = ARCHIVE_CATEGORIES.map(c => `${c.key}=${c.label}`).join(", ");
  const completion = await client.chat.completions.create({
    model: "gpt-4o", temperature: 0, response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `당신은 통번역 회사의 사내 문서관리 담당자입니다. 업로드된 회사 문서의 본문을 읽고 분류 정보를 JSON 으로만 반환합니다.
규칙:
- 문서에 없는 사실을 만들지 마세요. 확인되지 않는 항목은 null.
- category 는 다음 중 하나: ${cats}. 판단이 어려우면 "other", confidence "low".
  · form: 빈 양식·서식(견적서/계약서/청구서/업무일지/비용청구서 양식 등, 작성용 빈칸 위주) / manual: 업무 수행 방법 안내 / process: 절차·흐름·규정
  · contract: 계약서·업무협약서(MOU)·상도의각서·NDA(작성 완료본) / email: 이메일·공문 / hr: 인사·급여·복지·근로 / management: 경영·기획·영업·통계·보고서
- folderId 는 아래 "기존 폴더 목록"의 id 중 가장 적합한 하나만. 적합한 폴더가 없으면 null. 새 폴더를 제안하지 마세요.
- 날짜(documentDate=작성일, effectiveDate=시행일, expiresAt=만료일)는 본문에 명시된 경우만 {"value":"YYYY-MM-DD","evidence":"본문 원문 그대로 발췌"}, 없으면 {"value":null,"evidence":null}.
- summary 는 본문 근거로 3문장 이내. keywords 는 검색용 핵심어 최대 8개.
- containsPersonalInfo: 주민등록번호·연락처·주소·계좌·급여 등 특정 개인 정보 포함 여부. containsConfidential: 계약금액·영업비밀·내부 기밀 포함 여부.
- formKind: 서식이면 종류(예: "견적서 양식"), manualKind: 매뉴얼이면 업무 분야(예: "정산매뉴얼"), 아니면 null.`,
      },
      {
        role: "user",
        content: `파일명: ${input.fileName}\n${input.relativePath ? `업로드 폴더 경로(참고): ${input.relativePath}\n` : ""}
기존 폴더 목록:\n${folderList || "(없음)"}\n\n본문:\n${body}\n\nJSON 스키마:
{"category":string,"folderId":number|null,"confidence":"high"|"medium"|"low","title":string|null,"summary":string|null,"keywords":string[],
"relatedWork":string|null,"relatedDepartment":string|null,"documentDate":{"value":string|null,"evidence":string|null},
"effectiveDate":{"value":string|null,"evidence":string|null},"expiresAt":{"value":string|null,"evidence":string|null},
"containsPersonalInfo":boolean,"personalInfoTypes":string[],"containsConfidential":boolean,"formKind":string|null,"manualKind":string|null}`,
      },
    ],
  });
  const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
  const nt = norm(input.text);
  const folderIds = new Set(input.folders.map(f => f.id));
  const category = (ARCHIVE_CATEGORIES.some(c => c.key === raw.category) ? raw.category : "other") as ArchiveCategoryKey;
  const dd = verifiedDate(raw.documentDate, nt), ed = verifiedDate(raw.effectiveDate, nt), xd = verifiedDate(raw.expiresAt, nt);
  const fid = Number(raw.folderId);
  return {
    category,
    folderId: Number.isInteger(fid) && folderIds.has(fid) ? fid : null,
    confidence: raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low",
    title: str(raw.title, 200),
    summary: str(raw.summary, 600),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k: unknown) => str(k, 40)).filter(Boolean).slice(0, 8) as string[] : [],
    relatedWork: str(raw.relatedWork, 100),
    relatedDepartment: str(raw.relatedDepartment, 100),
    documentDate: dd.value, effectiveDate: ed.value, expiresAt: xd.value,
    dateEvidence: { documentDate: dd.evidence, effectiveDate: ed.evidence, expiresAt: xd.evidence },
    containsPersonalInfo: raw.containsPersonalInfo === true || RRN_RE.test(input.text),
    personalInfoTypes: Array.isArray(raw.personalInfoTypes) ? raw.personalInfoTypes.map((k: unknown) => str(k, 30)).filter(Boolean).slice(0, 8) as string[] : [],
    containsConfidential: raw.containsConfidential === true,
    formKind: str(raw.formKind, 60),
    manualKind: str(raw.manualKind, 60),
  };
}

// ─── 중복·개정 후보 ──────────────────────────────────────────────────────────

/** 파일명/제목 핵심어 — 확장자·날짜·버전 표기·괄호·공백 제거 */
export function titleCore(s: string): string {
  return s.toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/(19|20)\d{2}[.\-_년\s]?\d{0,2}[.\-_월\s]?\d{0,2}일?/g, "")
    .replace(/\b(v|ver|rev)\s?\d+(\.\d+)*\b/g, "")
    .replace(/(최종|수정본|개정본|개정|사본|복사본|final|copy|draft|초안)/g, "")
    .replace(/[\s_\-.·,]+/g, "");
}

async function relatedDocuments(docId: number, sha: string | null, cores: string[]) {
  const others = await db.select({ id: archiveDocumentsTable.id, title: archiveDocumentsTable.title, docType: archiveDocumentsTable.docType })
    .from(archiveDocumentsTable).where(and(isNull(archiveDocumentsTable.deletedAt), ne(archiveDocumentsTable.id, docId)));
  const duplicateOf = sha ? (await db.select({ documentId: archiveDocumentVersionsTable.documentId }).from(archiveDocumentVersionsTable)
    .where(and(eq(archiveDocumentVersionsTable.sha256, sha), ne(archiveDocumentVersionsTable.documentId, docId))))
    .map(r => r.documentId).filter((v, i, a) => a.indexOf(v) === i && others.some(o => o.id === v)) : [];
  const valid = cores.filter(c => c.length >= 4);
  const possibleRevisionOf = valid.length ? others
    .filter(o => !duplicateOf.includes(o.id))
    .filter(o => { const oc = titleCore(o.title); return oc.length >= 4 && valid.some(c => c === oc || (c.length >= 6 && oc.length >= 6 && (c.includes(oc) || oc.includes(c)))); })
    .slice(0, 5).map(o => o.id) : [];
  return { duplicateOf: duplicateOf.slice(0, 10), possibleRevisionOf };
}

// ─── 분류 실행(업로드 후 비동기·재분석) — 예외를 밖으로 던지지 않는다 ─────────────

export async function runArchiveClassification(documentId: number, opts: { actorId: number | null; actorEmail: string | null; relativePath?: string | null }): Promise<string> {
  const audit = (metadata: Record<string, unknown>, versionId: number | null) => db.insert(archiveAuditLogsTable).values({
    documentId, versionId, action: "ai_classify", userId: opts.actorId, userEmail: opts.actorEmail, actorType: "ai", metadata,
  }).catch(() => undefined);
  try {
    const [doc] = await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, documentId));
    if (!doc || doc.deletedAt) return "skipped";
    const [ver] = await db.select().from(archiveDocumentVersionsTable)
      .where(eq(archiveDocumentVersionsTable.documentId, documentId)).orderBy(desc(archiveDocumentVersionsTable.versionNo)).limit(1);
    const fileName = ver?.originalFileName ?? doc.title;
    const reviewFolderId = await ensureReviewFolder(opts.actorId);
    const related = await relatedDocuments(documentId, ver?.sha256 ?? null, [titleCore(fileName), titleCore(doc.title)]);
    const text = (ver?.extractedText ?? "").trim();
    if (!text) {
      await db.update(archiveDocumentsTable).set({ aiStatus: "needs_review", updatedAt: new Date() }).where(eq(archiveDocumentsTable.id, documentId));
      await audit({ result: "needs_review", reason: "내용 추출 불가(이미지·스캔·미지원 형식 등) — 원본 보존", ...related }, ver?.id ?? null);
      return "needs_review";
    }
    const ctx = await loadAclContext();
    // 관리자가 설정한 최신 폴더 구조 기준(매 분류마다 DB 재조회). 비활성·삭제 폴더와 그 하위(상위가 비활성인 폴더)는 신규 배정 후보에서 제외.
    const folders = [...ctx.folders.values()].filter(f => f.id !== reviewFolderId && folderUsable(ctx, f.id)).map(f => ({ id: f.id, path: folderPath(ctx, f.id) }));
    const ai = await analyzeArchiveText({ text, fileName, relativePath: opts.relativePath, folders });
    const confident = ai.category !== "other" && ai.confidence !== "low" && ai.folderId != null;
    const cat = ARCHIVE_CATEGORIES.find(c => c.key === ai.category)!;

    // 반영 규칙(재분석 시 관리자 수정값 보존): 폴더·유형은 「분류 확인 필요」 폴더에 있을 때만, 제목은 파일명 그대로일 때만,
    // 날짜는 비어 있을 때만, 보안등급은 상향만. 요약·키워드는 AI 항목이므로 갱신.
    const [cur] = await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, documentId));
    if (!cur || cur.deletedAt) return "skipped";
    const patch: Partial<typeof archiveDocumentsTable.$inferInsert> = {
      aiSummary: ai.summary, keywords: ai.keywords.length ? ai.keywords.join(", ") : cur.keywords,
      aiStatus: confident ? "classified" : "needs_review", updatedAt: new Date(),
    };
    const inReview = cur.folderId === reviewFolderId;
    if (inReview && confident) { patch.folderId = ai.folderId!; patch.docType = cat.docType; }
    else if (inReview && ai.category !== "other") patch.docType = cat.docType;   // 폴더 불명확해도 유형은 참고 반영(폴더는 확인 필요 유지)
    const stem = fileName.replace(/\.[^.]+$/, "");
    if (ai.title && cur.title === stem) patch.title = ai.title;
    if (ai.documentDate && !cur.documentDate) patch.documentDate = ai.documentDate;
    if (ai.expiresAt && !cur.expiresAt) patch.expiresAt = ai.expiresAt;
    if ((ai.containsPersonalInfo || ai.containsConfidential) && (cur.securityLevel === "internal" || cur.securityLevel === "restricted")) patch.securityLevel = "confidential";
    await db.update(archiveDocumentsTable).set(patch).where(eq(archiveDocumentsTable.id, documentId));
    await audit({
      result: patch.aiStatus, categoryLabel: cat.label, ...ai,
      applied: { folderId: patch.folderId ?? null, folderPath: patch.folderId ? folderPath(ctx, patch.folderId) : null, docType: patch.docType ?? null, title: patch.title ?? null, securityLevel: patch.securityLevel ?? null },
      ...related, relativePath: opts.relativePath ?? null,
    }, ver?.id ?? null);
    return patch.aiStatus as string;
  } catch (err) {
    await db.update(archiveDocumentsTable).set({ aiStatus: "failed", updatedAt: new Date() }).where(eq(archiveDocumentsTable.id, documentId)).catch(() => undefined);
    await audit({ result: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "unknown" }, null);
    return "failed";
  }
}

/** 문서의 최근 AI 분석 기록(감사로그 metadata) */
export async function latestAiAnalysis(documentId: number): Promise<Record<string, unknown> | null> {
  const [row] = await db.select({ metadata: archiveAuditLogsTable.metadata, createdAt: archiveAuditLogsTable.createdAt })
    .from(archiveAuditLogsTable)
    .where(and(eq(archiveAuditLogsTable.documentId, documentId), eq(archiveAuditLogsTable.action, "ai_classify")))
    .orderBy(desc(archiveAuditLogsTable.createdAt)).limit(1);
  return row ? { ...(row.metadata as Record<string, unknown> ?? {}), analyzedAt: row.createdAt } : null;
}
