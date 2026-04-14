import { Router, type IRouter } from "express";
import { db, productsTable, productOptionsTable, productRequestsTable } from "@workspace/db";
import { eq, desc, sql, and, ilike, or } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import multer from "multer";
import * as XLSX from "xlsx";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly = [requireAuth, requireRole("admin")];

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const VALID_SERVICE_TYPES = ["TR", "IN"] as const;
const VALID_LANG_PAIRS = ["KOEN", "ENKO", "KOCN", "KOJA"] as const;
const VALID_CATEGORIES_TR = ["GEN", "TECH", "MED", "LAW"] as const;
const VALID_CATEGORIES_IN = ["SIM", "CON", "MIT", "EXH"] as const;
const VALID_UNITS_TR = ["어절", "글자", "페이지", "건"] as const;
const VALID_UNITS_IN = ["시간"] as const;

const LANG_PAIR_LABEL: Record<string, string> = {
  KOEN: "한영", ENKO: "영한", KOCN: "한중", KOJA: "한일",
};
const CATEGORY_LABEL_TR: Record<string, string> = {
  GEN: "일반번역", TECH: "기술번역", MED: "의료번역", LAW: "법률번역",
};
const CATEGORY_LABEL_IN: Record<string, string> = {
  SIM: "동시통역", CON: "순차통역", MIT: "미팅통역", EXH: "전시통역",
};

function autoProductName(svcType: string, langPair: string, category: string): string {
  const langLabel = LANG_PAIR_LABEL[langPair] ?? langPair;
  if (svcType === "IN") {
    const catLabel = CATEGORY_LABEL_IN[category] ?? `${category}통역`;
    return `${langLabel} ${catLabel}`;
  }
  const catLabel = CATEGORY_LABEL_TR[category] ?? `${category}번역`;
  return `${langLabel} ${catLabel}`;
}

// ─── 엑셀 공통 설정 ──────────────────────────────────────────────────────────
const EXCEL_HEADERS = [
  "서비스유형*(TR/IN)", "언어쌍*(KOEN/ENKO/KOCN/KOJA)", "카테고리*(GEN/TECH/MED/LAW/SIM/CON/MIT/EXH)",
  "상품명*", "단위*(어절/글자/페이지/건/시간)", "기본단가*", "기본진행시간(통역용)", "초과단가(통역용)", "비고",
];
const COL_WIDTHS = [18, 24, 36, 20, 22, 10, 16, 14, 24];
const UNIT_MAP: Record<string, string> = {
  eojeol: "어절", char: "글자", page: "페이지", hour: "시간", 건: "건",
};
const UNIT_MAP_REV: Record<string, string> = {
  어절: "eojeol", 글자: "char", 페이지: "page", 시간: "hour", 건: "건",
};
const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function productToRow(p: typeof productsTable.$inferSelect): (string | number)[] {
  return [
    p.productType === "interpretation" ? "IN" : "TR",
    p.languagePair ?? "",
    p.category ?? "",
    p.name,
    UNIT_MAP[p.unit ?? "건"] ?? p.unit ?? "건",
    p.basePrice ?? 0,
    p.interpretationDuration ?? "",
    p.overtimePrice ?? "",
    p.description ?? "",
  ];
}

// ─── 상품 코드 자동 생성 ──────────────────────────────────────────────────────
// 규칙: [서비스]-[언어]-[카테고리]-[번호]  예) TR-KOEN-GEN-001
async function generateProductCode(serviceType: string, languagePair: string, category: string): Promise<string> {
  const svc = serviceType.toUpperCase().slice(0, 4);
  const lang = languagePair.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  const cat = category.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  const prefix = `${svc}-${lang}-${cat}`;

  const existing = await db
    .select({ code: productsTable.code })
    .from(productsTable)
    .where(sql`${productsTable.code} LIKE ${prefix + "-%"}`);

  const nums = existing
    .map(p => parseInt(p.code.split("-").pop() ?? "0"))
    .filter(n => !isNaN(n));

  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// ─── 중복 체크 ────────────────────────────────────────────────────────────────
async function findDuplicate(serviceType: string, languagePair: string, category: string, excludeId?: number) {
  const rows = await db
    .select({ id: productsTable.id, code: productsTable.code, name: productsTable.name, active: productsTable.active })
    .from(productsTable)
    .where(and(
      sql`LOWER(${productsTable.productType}) = ${serviceType === "IN" ? "interpretation" : "translation"}`,
      sql`LOWER(${productsTable.languagePair}) = LOWER(${languagePair})`,
      sql`LOWER(${productsTable.category}) = LOWER(${category})`,
    ));
  return rows.filter(r => r.id !== excludeId);
}

// ─── 상품 목록 ────────────────────────────────────────────────────────────────
router.get("/admin/products", ...adminGuard, async (req, res) => {
  try {
    const { search, mainCategory, activeOnly, serviceType, languagePair, category } = req.query as {
      search?: string; mainCategory?: string; activeOnly?: string;
      serviceType?: string; languagePair?: string; category?: string;
    };

    let rows = await db.select().from(productsTable).orderBy(productsTable.active, desc(productsTable.createdAt));

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter(p =>
        p.name.toLowerCase().includes(s) ||
        p.code.toLowerCase().includes(s) ||
        (p.mainCategory ?? "").toLowerCase().includes(s) ||
        (p.subCategory ?? "").toLowerCase().includes(s) ||
        (p.languagePair ?? "").toLowerCase().includes(s) ||
        (p.category ?? "").toLowerCase().includes(s)
      );
    }

    if (mainCategory?.trim()) {
      rows = rows.filter(p => p.mainCategory === mainCategory.trim());
    }

    if (serviceType?.trim()) {
      const svc = serviceType.trim().toUpperCase();
      rows = rows.filter(p =>
        svc === "TR" ? p.productType === "translation" : svc === "IN" ? p.productType === "interpretation" : true
      );
    }

    if (languagePair?.trim()) {
      const lp = languagePair.trim().toUpperCase();
      rows = rows.filter(p => (p.languagePair ?? "").toUpperCase() === lp);
    }

    if (category?.trim()) {
      const cat = category.trim().toUpperCase();
      rows = rows.filter(p => (p.category ?? "").toUpperCase() === cat);
    }

    if (activeOnly === "true") {
      rows = rows.filter(p => p.active);
    } else if (activeOnly === "false") {
      rows = rows.filter(p => !p.active);
    }

    // 활성 상품 먼저 표시
    rows.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

    const allOptions = await db.select().from(productOptionsTable).orderBy(productOptionsTable.sortOrder);
    const result = rows.map(p => ({
      ...p,
      options: allOptions.filter(o => o.productId === p.id),
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Products: failed to list");
    res.status(500).json({ error: "상품 조회 실패." });
  }
});

// ─── 상품 생성 (관리자 전용, 코드 자동 생성) ─────────────────────────────────
router.post("/admin/products", ...adminOnly, async (req, res) => {
  const {
    serviceType, languagePair, category,
    name, mainCategory, subCategory, unit, basePrice, description,
    productType, interpretationDuration, overtimePrice, options,
  } = req.body as {
    serviceType?: string; languagePair?: string; category?: string;
    name?: string; mainCategory?: string; subCategory?: string;
    unit?: string; basePrice?: number; description?: string;
    productType?: string; interpretationDuration?: string; overtimePrice?: number;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "상품명은 필수입니다." }); return;
  }

  const svcType = serviceType?.trim().toUpperCase() || (productType === "interpretation" ? "IN" : "TR");
  const langPair = languagePair?.trim().toUpperCase() || "GEN";
  const cat = category?.trim().toUpperCase() || "GEN";
  const resolvedProductType = svcType === "IN" ? "interpretation" : "translation";

  try {
    // 중복 체크
    const dupes = await findDuplicate(svcType, langPair, cat);
    if (dupes.length > 0) {
      res.status(409).json({
        error: `동일한 서비스/언어/카테고리 상품이 이미 존재합니다.`,
        existing: dupes,
        isDuplicate: true,
      });
      return;
    }

    const code = await generateProductCode(svcType, langPair, cat);

    const [product] = await db
      .insert(productsTable)
      .values({
        code,
        name: name.trim(),
        mainCategory: mainCategory?.trim() || null,
        subCategory: subCategory?.trim() || null,
        unit: unit ?? "건",
        basePrice: basePrice ?? 0,
        description: description?.trim() || null,
        productType: resolvedProductType,
        languagePair: langPair,
        category: cat,
        interpretationDuration: interpretationDuration?.trim() || null,
        overtimePrice: overtimePrice ?? null,
      })
      .returning();

    const optionRows = [];
    if (options && options.length > 0) {
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        if (!o.optionType?.trim() || !o.optionValue?.trim()) continue;
        const [opt] = await db.insert(productOptionsTable).values({
          productId: product.id,
          optionType: o.optionType.trim(),
          optionValue: o.optionValue.trim(),
          sortOrder: o.sortOrder ?? i,
        }).returning();
        optionRows.push(opt);
      }
    }

    await logEvent("product", product.id, "product_created", req.log, req.user as any,
      JSON.stringify({ code, name: product.name, serviceType: svcType, languagePair: langPair, category: cat }));

    res.status(201).json({ ...product, options: optionRows });
  } catch (err) {
    req.log.error({ err }, "Products: failed to create");
    res.status(500).json({ error: "상품 생성 실패." });
  }
});

// ─── 엑셀 템플릿 다운로드 ─────────────────────────────────────────────────────
router.get("/admin/products/template", ...adminGuard, (_req, res) => {
  const wb = XLSX.utils.book_new();
  const sampleRows = [
    ["(자동생성)", "한영 일반번역", "번역", "번역", "일반번역", "어절", 50, "", "", "일반 문서 번역"],
    ["(자동생성)", "한영 동시통역", "통역", "통역", "동시통역", "시간", 200000, "4h", 50000, "컨퍼런스 동시통역"],
  ];
  const ws = XLSX.utils.aoa_to_sheet([EXCEL_HEADERS, ...sampleRows]);
  ws["!cols"] = COL_WIDTHS.map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "상품목록");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''%EC%83%81%ED%92%88_%ED%85%9C%ED%94%8C%EB%A6%BF.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ─── 기존 상품 엑셀 내보내기 ──────────────────────────────────────────────────
router.get("/admin/products/export", ...adminGuard, async (req, res) => {
  try {
    const rows = await db.select().from(productsTable).orderBy(productsTable.mainCategory, productsTable.name);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([EXCEL_HEADERS, ...rows.map(productToRow)]);
    ws["!cols"] = COL_WIDTHS.map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, "상품목록");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''%EC%83%81%ED%92%88%EB%AA%A9%EB%A1%9D_${now}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, "Products export failed");
    res.status(500).json({ error: "내보내기 실패" });
  }
});

// ─── 엑셀 업로드 (일괄 등록 — 신규 표준 컬럼) ────────────────────────────────
router.post("/admin/products/import", ...adminOnly, excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일이 없습니다." }); return; }

  type ImportResult = { created: number; skipped: number; errors: { row: number; message: string }[] };
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    if (rows.length < 2) {
      res.status(400).json({ error: "데이터 행이 없습니다. (헤더 제외 최소 1행 필요)" }); return;
    }

    const dataRows = rows.slice(1);

    for (let i = 0; i < dataRows.length; i++) {
      const rowNum = i + 2;
      const r = dataRows[i];
      // 새 컬럼 순서: 서비스유형 | 언어쌍 | 카테고리 | 상품명 | 단위 | 기본단가 | 진행시간 | 초과단가 | 비고
      const svcRaw = String(r[0] ?? "").trim().toUpperCase();
      const langRaw = String(r[1] ?? "").trim().toUpperCase();
      const catRaw = String(r[2] ?? "").trim().toUpperCase();
      const nameRaw = String(r[3] ?? "").trim();
      const unitRaw = String(r[4] ?? "").trim();
      const basePriceRaw = Number(r[5] ?? 0);
      const interpretationDuration = String(r[6] ?? "").trim() || null;
      const overtimePriceRaw = r[7] !== "" ? Number(r[7]) : null;
      const description = String(r[8] ?? "").trim() || null;

      // 빈 행 스킵
      if (!svcRaw && !langRaw && !catRaw && !nameRaw) continue;

      // 필수 필드 검증
      if (!VALID_SERVICE_TYPES.includes(svcRaw as typeof VALID_SERVICE_TYPES[number])) {
        result.errors.push({ row: rowNum, message: `서비스유형 오류: '${svcRaw}' (TR 또는 IN)` }); continue;
      }
      if (!VALID_LANG_PAIRS.includes(langRaw as typeof VALID_LANG_PAIRS[number])) {
        result.errors.push({ row: rowNum, message: `언어쌍 오류: '${langRaw}' (KOEN/ENKO/KOCN/KOJA)` }); continue;
      }
      const validCats = svcRaw === "IN" ? VALID_CATEGORIES_IN : VALID_CATEGORIES_TR;
      if (!validCats.includes(catRaw as never)) {
        result.errors.push({ row: rowNum, message: `카테고리 오류: '${catRaw}' (서비스유형에 맞는 값 사용)` }); continue;
      }
      const name = nameRaw || autoProductName(svcRaw, langRaw, catRaw);
      if (isNaN(basePriceRaw) || basePriceRaw < 0) {
        result.errors.push({ row: rowNum, message: `기본단가 숫자 오류: '${r[5]}'` }); continue;
      }

      const validUnits = svcRaw === "IN" ? VALID_UNITS_IN : VALID_UNITS_TR;
      const unit = validUnits.includes(unitRaw as never) ? unitRaw : (svcRaw === "IN" ? "시간" : "어절");
      const basePrice = Math.round(basePriceRaw);
      const overtimePrice = overtimePriceRaw !== null && !isNaN(overtimePriceRaw) ? Math.round(overtimePriceRaw) : null;
      const productType = svcRaw === "IN" ? "interpretation" : "translation";

      // 중복 체크
      const dupes = await findDuplicate(svcRaw, langRaw, catRaw);
      if (dupes.length > 0) {
        result.errors.push({ row: rowNum, message: `중복 상품 존재: ${dupes[0].code} (${dupes[0].name})` });
        result.skipped++;
        continue;
      }

      try {
        const code = await generateProductCode(svcRaw, langRaw, catRaw);
        await db.insert(productsTable).values({
          code, name, unit, basePrice, description, productType,
          languagePair: langRaw, category: catRaw, interpretationDuration, overtimePrice,
        });
        result.created++;
      } catch (rowErr) {
        result.errors.push({ row: rowNum, message: `DB 저장 오류: ${(rowErr as Error).message}` });
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Products import failed");
    res.status(500).json({ error: "파일 파싱 실패. 올바른 엑셀 형식인지 확인하세요." });
  }
});

// ─── 상품 요청 목록 (관리자/스태프) ──────────────────────────────────────────
router.get("/admin/product-requests", ...adminGuard, async (req, res) => {
  try {
    const { status } = req.query as { status?: string };
    let rows = await db
      .select()
      .from(productRequestsTable)
      .orderBy(desc(productRequestsTable.createdAt));

    if (status && status !== "all") {
      rows = rows.filter(r => r.status === status);
    }

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to list");
    res.status(500).json({ error: "상품 요청 목록 조회 실패." });
  }
});

// ─── 상품 요청 생성 (관리자/스태프 모두) ─────────────────────────────────────
router.post("/admin/product-requests", ...adminGuard, async (req, res) => {
  const { serviceType, languagePair, category, name, unit, description } = req.body as {
    serviceType?: string; languagePair?: string; category?: string;
    name?: string; unit?: string; description?: string;
  };

  if (!serviceType?.trim() || !languagePair?.trim() || !category?.trim() || !name?.trim()) {
    res.status(400).json({ error: "서비스유형, 언어쌍, 카테고리, 상품명은 필수입니다." }); return;
  }

  const svcType = serviceType.trim().toUpperCase();
  const langPair = languagePair.trim().toUpperCase();
  const cat = category.trim().toUpperCase();

  try {
    // 중복 상품 체크
    const dupes = await findDuplicate(svcType, langPair, cat);
    const dupeInfo = dupes.length > 0
      ? { hasDuplicate: true, existing: dupes }
      : { hasDuplicate: false };

    const performer = req.user as { id: number; email: string } | undefined;
    const [request] = await db.insert(productRequestsTable).values({
      serviceType: svcType,
      languagePair: langPair,
      category: cat,
      name: name.trim(),
      unit: unit ?? "건",
      description: description?.trim() || null,
      requestedBy: performer?.id ?? null,
      requestedByEmail: performer?.email ?? null,
      status: "pending",
    }).returning();

    await logEvent("product_request", request.id, "product_requested", req.log, performer as any,
      JSON.stringify({ serviceType: svcType, languagePair: langPair, category: cat, name: name.trim(), ...dupeInfo }));

    res.status(201).json({ ...request, ...dupeInfo });
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to create");
    res.status(500).json({ error: "상품 요청 생성 실패." });
  }
});

// ─── 상품 요청 승인 (관리자만) ───────────────────────────────────────────────
router.post("/admin/product-requests/:id/approve", ...adminOnly, async (req, res) => {
  const requestId = Number(req.params.id);
  if (isNaN(requestId) || requestId <= 0) {
    res.status(400).json({ error: "유효하지 않은 요청 id." }); return;
  }

  try {
    const [request] = await db.select().from(productRequestsTable).where(eq(productRequestsTable.id, requestId));
    if (!request) { res.status(404).json({ error: "요청을 찾을 수 없습니다." }); return; }
    if (request.status !== "pending") {
      res.status(409).json({ error: `이미 ${request.status === "approved" ? "승인" : "거절"}된 요청입니다.` }); return;
    }

    // 중복 체크 (승인 시에도)
    const dupes = await findDuplicate(request.serviceType, request.languagePair, request.category);
    if (dupes.length > 0) {
      res.status(409).json({
        error: `동일한 서비스/언어/카테고리 상품이 이미 존재합니다. (${dupes[0].code})`,
        existing: dupes,
        isDuplicate: true,
      });
      return;
    }

    // 상품 코드 자동 생성
    const code = await generateProductCode(request.serviceType, request.languagePair, request.category);
    const resolvedProductType = request.serviceType === "IN" ? "interpretation" : "translation";

    const performer = req.user as { id: number; email: string } | undefined;

    const [product] = await db.insert(productsTable).values({
      code,
      name: request.name,
      unit: request.unit ?? "건",
      description: request.description ?? null,
      productType: resolvedProductType,
      languagePair: request.languagePair,
      category: request.category,
      basePrice: 0,
    }).returning();

    // 요청 상태 approved로 변경
    const [updated] = await db.update(productRequestsTable)
      .set({
        status: "approved",
        approvedBy: performer?.id ?? null,
        approvedByEmail: performer?.email ?? null,
        approvedProductId: product.id,
        updatedAt: new Date(),
      })
      .where(eq(productRequestsTable.id, requestId))
      .returning();

    await logEvent("product_request", requestId, "product_approved", req.log, performer as any,
      JSON.stringify({ code, productId: product.id, name: product.name }));
    await logEvent("product", product.id, "product_created", req.log, performer as any,
      JSON.stringify({ code, fromRequestId: requestId }));

    res.json({ request: updated, product });
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to approve");
    res.status(500).json({ error: "상품 요청 승인 실패." });
  }
});

// ─── 상품 요청 거절 (관리자만) ───────────────────────────────────────────────
router.post("/admin/product-requests/:id/reject", ...adminOnly, async (req, res) => {
  const requestId = Number(req.params.id);
  if (isNaN(requestId) || requestId <= 0) {
    res.status(400).json({ error: "유효하지 않은 요청 id." }); return;
  }

  const { reason } = req.body as { reason?: string };

  try {
    const [request] = await db.select().from(productRequestsTable).where(eq(productRequestsTable.id, requestId));
    if (!request) { res.status(404).json({ error: "요청을 찾을 수 없습니다." }); return; }
    if (request.status !== "pending") {
      res.status(409).json({ error: "대기 중인 요청만 거절할 수 있습니다." }); return;
    }

    const performer = req.user as { id: number; email: string } | undefined;

    const [updated] = await db.update(productRequestsTable)
      .set({
        status: "rejected",
        rejectionReason: reason?.trim() || null,
        approvedBy: performer?.id ?? null,
        approvedByEmail: performer?.email ?? null,
        updatedAt: new Date(),
      })
      .where(eq(productRequestsTable.id, requestId))
      .returning();

    await logEvent("product_request", requestId, "product_rejected", req.log, performer as any,
      JSON.stringify({ reason: reason?.trim() }));

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to reject");
    res.status(500).json({ error: "상품 요청 거절 실패." });
  }
});

// ─── 중복 상품 체크 ────────────────────────────────────────────────────────────
router.get("/admin/products/check-duplicate", ...adminGuard, async (req, res) => {
  const { serviceType, languagePair, category, excludeId } = req.query as {
    serviceType?: string; languagePair?: string; category?: string; excludeId?: string;
  };

  if (!serviceType || !languagePair || !category) {
    res.status(400).json({ error: "serviceType, languagePair, category 모두 필요합니다." }); return;
  }

  try {
    const dupes = await findDuplicate(
      serviceType.toUpperCase(),
      languagePair.toUpperCase(),
      category.toUpperCase(),
      excludeId ? Number(excludeId) : undefined
    );
    res.json({ hasDuplicate: dupes.length > 0, existing: dupes });
  } catch (err) {
    res.status(500).json({ error: "중복 체크 실패." });
  }
});

// ─── 상품 단건 조회 (옵션 포함) ──────────────────────────────────────────────
router.get("/admin/products/:id", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!product) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }
    const options = await db.select().from(productOptionsTable)
      .where(eq(productOptionsTable.productId, productId))
      .orderBy(productOptionsTable.sortOrder);
    res.json({ ...product, options });
  } catch (err) {
    req.log.error({ err }, "Products: failed to get");
    res.status(500).json({ error: "상품 조회 실패." });
  }
});

// ─── 상품 수정 (코드/serviceType/languagePair 변경 불가) ──────────────────────
router.patch("/admin/products/:id", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const {
    name, mainCategory, subCategory, unit, basePrice, description, active,
    interpretationDuration, overtimePrice, options,
  } = req.body as {
    name?: string; mainCategory?: string; subCategory?: string;
    unit?: string; basePrice?: number; description?: string; active?: boolean;
    interpretationDuration?: string; overtimePrice?: number | null;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
  };

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }
    if (!existing.active && active !== true) {
      res.status(409).json({ error: "비활성 상품은 먼저 활성화 후 수정하세요." }); return;
    }

    const [updated] = await db
      .update(productsTable)
      .set({
        // code, productType, languagePair, category 는 수정 불가
        name: name?.trim() ?? existing.name,
        mainCategory: mainCategory !== undefined ? (mainCategory?.trim() || null) : existing.mainCategory,
        subCategory: subCategory !== undefined ? (subCategory?.trim() || null) : existing.subCategory,
        unit: unit ?? existing.unit,
        basePrice: basePrice ?? existing.basePrice,
        description: description !== undefined ? (description?.trim() || null) : existing.description,
        active: active !== undefined ? Boolean(active) : existing.active,
        interpretationDuration: interpretationDuration !== undefined
          ? (interpretationDuration?.trim() || null) : existing.interpretationDuration,
        overtimePrice: overtimePrice !== undefined ? (overtimePrice ?? null) : existing.overtimePrice,
      })
      .where(eq(productsTable.id, productId))
      .returning();

    let optionRows: typeof productOptionsTable.$inferSelect[] = [];
    if (options !== undefined) {
      await db.delete(productOptionsTable).where(eq(productOptionsTable.productId, productId));
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        if (!o.optionType?.trim() || !o.optionValue?.trim()) continue;
        const [opt] = await db.insert(productOptionsTable).values({
          productId,
          optionType: o.optionType.trim(),
          optionValue: o.optionValue.trim(),
          sortOrder: o.sortOrder ?? i,
        }).returning();
        optionRows.push(opt);
      }
    } else {
      optionRows = await db.select().from(productOptionsTable)
        .where(eq(productOptionsTable.productId, productId))
        .orderBy(productOptionsTable.sortOrder);
    }

    await logEvent("product", productId, "product_updated", req.log, req.user as any,
      JSON.stringify({ name: updated.name, active: updated.active }));

    res.json({ ...updated, options: optionRows });
  } catch (err) {
    req.log.error({ err }, "Products: failed to update");
    res.status(500).json({ error: "상품 수정 실패." });
  }
});

// ─── 상품 활성/비활성 토글 ────────────────────────────────────────────────────
router.patch("/admin/products/:id/toggle", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const { reason } = req.body as { reason?: string };

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    // 비활성화 시 사유 필수
    if (existing.active && !reason?.trim()) {
      res.status(400).json({ error: "비활성화 사유를 입력해주세요." }); return;
    }

    const setData: Partial<typeof productsTable.$inferInsert> = { active: !existing.active };
    if (existing.active) {
      setData.deactivationReason = reason!.trim();
    } else {
      setData.deactivationReason = null;
    }

    const [updated] = await db
      .update(productsTable)
      .set(setData)
      .where(eq(productsTable.id, productId))
      .returning();

    await logEvent("product", productId, existing.active ? "product_deactivated" : "product_activated",
      req.log, req.user as any, existing.active ? JSON.stringify({ reason: reason?.trim() }) : undefined);

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Products: failed to toggle");
    res.status(500).json({ error: "상품 상태 변경 실패." });
  }
});

// ─── 상품 삭제 → 비활성 처리 (소프트 삭제) ───────────────────────────────────
router.delete("/admin/products/:id", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const { reason } = req.body as { reason?: string };
  const deactivationReason = reason?.trim() || "삭제 요청 → 비활성 처리";

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(productsTable)
      .set({ active: false, deactivationReason })
      .where(eq(productsTable.id, productId))
      .returning();

    await logEvent("product", productId, "product_deactivated", req.log, req.user as any,
      JSON.stringify({ reason: deactivationReason }));

    res.json({ ok: true, deactivated: true, product: updated });
  } catch (err) {
    req.log.error({ err }, "Products: failed to deactivate");
    res.status(500).json({ error: "상품 비활성 처리 실패." });
  }
});

export default router;
