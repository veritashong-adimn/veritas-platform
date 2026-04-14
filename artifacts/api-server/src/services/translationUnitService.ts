import {
  db,
  translationUnitsTable,
  translationUnitLogsTable,
  projectsTable,
  tasksTable,
  quotesTable,
  quoteItemsTable,
  type InsertTranslationUnit,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { Logger } from "pino";

// ─── 도메인 매핑 ──────────────────────────────────────────────────────────────
const DOMAIN_KEYWORDS: [string, string][] = [
  ["법률", "legal"], ["계약", "legal"], ["법", "legal"],
  ["의료", "medical"], ["의학", "medical"], ["병원", "medical"], ["약", "medical"],
  ["금융", "finance"], ["회계", "finance"], ["세무", "finance"], ["투자", "finance"],
  ["IT", "it"], ["소프트웨어", "it"], ["개발", "it"], ["기술", "it"],
  ["마케팅", "marketing"], ["광고", "marketing"], ["홍보", "marketing"],
  ["기술", "technical"], ["공학", "technical"], ["매뉴얼", "technical"],
];

function inferDomain(text: string): string {
  const t = text.toLowerCase();
  for (const [kw, domain] of DOMAIN_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return domain;
  }
  return "general";
}

// ─── 언어쌍 파싱 ─────────────────────────────────────────────────────────────
function parseLangPair(pair: string | null): { sourceLang: string; targetLang: string } {
  if (!pair) return { sourceLang: "ko", targetLang: "en" };
  const normalized = pair.replace(/→|->|-|\/|·/g, "|");
  const parts = normalized.split("|").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { sourceLang: normalizeLang(parts[0]), targetLang: normalizeLang(parts[1]) };
  }
  return { sourceLang: "ko", targetLang: "en" };
}

function normalizeLang(raw: string): string {
  const map: Record<string, string> = {
    "한": "ko", "한국어": "ko", "korean": "ko",
    "영": "en", "영어": "en", "english": "en",
    "일": "ja", "일본어": "ja", "japanese": "ja",
    "중": "zh", "중국어": "zh", "chinese": "zh",
    "독": "de", "독일어": "de", "german": "de",
    "프": "fr", "프랑스어": "fr", "french": "fr",
    "스페인": "es", "spanish": "es",
  };
  return map[raw.toLowerCase()] ?? raw.toLowerCase().slice(0, 5);
}

// ─── 단어 수 / 글자 수 계산 ───────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

// ─── 1. 세그먼트 분리 ────────────────────────────────────────────────────────
export function segmentTranslationPair(
  sourceText: string,
  targetText: string,
): { source: string; target: string }[] {
  const splitByNewline = (t: string) =>
    t.split(/\n+/).map(s => s.trim()).filter(Boolean);

  const splitBySentence = (t: string) =>
    t.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(Boolean);

  try {
    const srcLines = splitByNewline(sourceText);
    const tgtLines = splitByNewline(targetText);

    if (srcLines.length > 1 && srcLines.length === tgtLines.length) {
      return srcLines.map((s, i) => ({ source: s, target: tgtLines[i] }));
    }

    const srcSents = splitBySentence(sourceText);
    const tgtSents = splitBySentence(targetText);

    if (srcSents.length > 1 && srcSents.length === tgtSents.length) {
      return srcSents.map((s, i) => ({ source: s, target: tgtSents[i] }));
    }
  } catch {
    // fallback below
  }

  return [{ source: sourceText.trim(), target: targetText.trim() }];
}

// ─── 2. 프로젝트 기준 translation_units 생성 ─────────────────────────────────
export async function buildTranslationUnitsFromProject(
  projectId: number,
  log?: Logger,
): Promise<{ count: number; skipped: boolean }> {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return { count: 0, skipped: true };

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
  const translatorId = task?.translatorId ?? null;

  const quotes = await db.select().from(quotesTable).where(eq(quotesTable.projectId, projectId));
  let langPair: string | null = null;
  if (quotes.length > 0) {
    const items = await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quotes[0].id));
    langPair = items.find(it => it.languagePair)?.languagePair ?? null;
  }
  const { sourceLang, targetLang } = parseLangPair(langPair);

  const domain = inferDomain(project.title ?? "");

  return { count: 0, skipped: true };
}

export interface TextPair {
  sourceText: string;
  targetText: string;
  sourceLang?: string;
  targetLang?: string;
  domain?: string;
}

export async function buildTranslationUnitsFromPairs(
  projectId: number,
  pairs: TextPair[],
  actorUserId: number | null,
  log?: Logger,
): Promise<{ count: number }> {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return { count: 0 };

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
  const translatorId = task?.translatorId ?? null;

  let inserted = 0;
  for (const pair of pairs) {
    if (!pair.sourceText?.trim() || !pair.targetText?.trim()) continue;

    const { sourceLang, targetLang } = parseLangPair(
      pair.sourceLang && pair.targetLang
        ? `${pair.sourceLang}|${pair.targetLang}`
        : null,
    );
    const domain = pair.domain ?? inferDomain(project.title ?? "");

    const segments = segmentTranslationPair(pair.sourceText, pair.targetText);

    for (let i = 0; i < segments.length; i++) {
      const { source, target } = segments[i];
      if (!source || !target) continue;

      const [unit] = await db.insert(translationUnitsTable).values({
        projectId,
        taskId: task?.id ?? null,
        sourceText: source,
        targetText: target,
        sourceLang: pair.sourceLang ?? sourceLang,
        targetLang: pair.targetLang ?? targetLang,
        domain,
        translatorId,
        qualityLevel: "unknown",
        securityLevel: "restricted",
        isAnonymized: false,
        sourceCharCount: countChars(source),
        targetCharCount: countChars(target),
        sourceWordCount: countWords(source),
        targetWordCount: countWords(target),
        segmentIndex: i,
        status: "active",
      }).returning();

      await db.insert(translationUnitLogsTable).values({
        translationUnitId: unit.id,
        action: "created",
        actorUserId,
        newValue: JSON.stringify({ projectId, segmentIndex: i }),
      });

      inserted++;
    }
  }

  return { count: inserted };
}

// ─── 3. 프로젝트 완료 시 자동 축적 (비치명적) ────────────────────────────────
export async function tryBuildOnProjectComplete(
  projectId: number,
  log?: Logger,
): Promise<void> {
  try {
    const existing = await db
      .select({ id: translationUnitsTable.id })
      .from(translationUnitsTable)
      .where(eq(translationUnitsTable.projectId, projectId));

    if (existing.length === 0) {
      log?.info({ projectId }, "Data layer: no text pairs available at completion — skipped");
    }
  } catch (err) {
    log?.warn({ err, projectId }, "Data layer: tryBuildOnProjectComplete failed (non-fatal)");
  }
}

// ─── 4. 비식별화 ──────────────────────────────────────────────────────────────
const ANON_PATTERNS: [RegExp, string][] = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]"],
  [/(\+82|0)[0-9\-\s]{8,14}/g, "[PHONE]"],
  [/\b\d{6}-\d{7}\b/g, "[RRN]"],
  [/[가-힣]{2,5}(씨|님|대표|부장|과장|차장|팀장|실장|이사|사장|회장|원장|교수|박사|선생)/g, "[PERSON]"],
  [/(주식회사|㈜|\(주\))\s*[가-힣A-Za-z0-9]+|[가-힣A-Za-z0-9]+(주식회사|㈜|\(주\)|코퍼레이션|그룹|홀딩스)/g, "[COMPANY]"],
  [/https?:\/\/[^\s]+/g, "[URL]"],
  [/\b\d{3}-\d{4}-\d{4}\b/g, "[PHONE]"],
];

function anonymizeText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of ANON_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export async function anonymizeTranslationUnit(
  unitId: number,
  actorUserId: number | null,
): Promise<{ ok: boolean; error?: string }> {
  const [unit] = await db
    .select()
    .from(translationUnitsTable)
    .where(eq(translationUnitsTable.id, unitId));

  if (!unit) return { ok: false, error: "not_found" };
  if (unit.isAnonymized) return { ok: true };

  try {
    const anonSource = anonymizeText(unit.sourceText);
    const anonTarget = anonymizeText(unit.targetText);

    await db.update(translationUnitsTable)
      .set({
        isAnonymized: true,
        anonymizedSourceText: anonSource,
        anonymizedTargetText: anonTarget,
        updatedAt: new Date(),
      })
      .where(eq(translationUnitsTable.id, unitId));

    await db.insert(translationUnitLogsTable).values({
      translationUnitId: unitId,
      action: "anonymized",
      actorUserId,
      oldValue: JSON.stringify({ isAnonymized: false }),
      newValue: JSON.stringify({ isAnonymized: true }),
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function bulkAnonymizeByProject(
  projectId: number,
  actorUserId: number | null,
): Promise<{ count: number }> {
  const units = await db
    .select({ id: translationUnitsTable.id })
    .from(translationUnitsTable)
    .where(and(eq(translationUnitsTable.projectId, projectId), eq(translationUnitsTable.isAnonymized, false)));

  let count = 0;
  for (const u of units) {
    const r = await anonymizeTranslationUnit(u.id, actorUserId);
    if (r.ok) count++;
  }
  return { count };
}

// ─── 5. 제외 처리 ─────────────────────────────────────────────────────────────
export async function excludeTranslationUnit(
  unitId: number,
  actorUserId: number | null,
): Promise<{ ok: boolean; error?: string }> {
  const [unit] = await db
    .select({ id: translationUnitsTable.id, status: translationUnitsTable.status })
    .from(translationUnitsTable)
    .where(eq(translationUnitsTable.id, unitId));

  if (!unit) return { ok: false, error: "not_found" };

  await db.update(translationUnitsTable)
    .set({ status: "excluded", updatedAt: new Date() })
    .where(eq(translationUnitsTable.id, unitId));

  await db.insert(translationUnitLogsTable).values({
    translationUnitId: unitId,
    action: "excluded",
    actorUserId,
    oldValue: JSON.stringify({ status: unit.status }),
    newValue: JSON.stringify({ status: "excluded" }),
  });

  return { ok: true };
}

// ─── 6. 프로젝트 단위 재생성 ─────────────────────────────────────────────────
export async function rebuildTranslationUnitsForProject(
  projectId: number,
  pairs: TextPair[],
  actorUserId: number | null,
  log?: Logger,
): Promise<{ count: number }> {
  await db.update(translationUnitsTable)
    .set({ status: "excluded", updatedAt: new Date() })
    .where(and(eq(translationUnitsTable.projectId, projectId), eq(translationUnitsTable.status, "active")));

  return buildTranslationUnitsFromPairs(projectId, pairs, actorUserId, log);
}
