import { Router, type IRouter } from "express";
import { db, productsTable, productOptionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import multer from "multer";
import * as XLSX from "xlsx";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 엑셀 공통 설정 ──────────────────────────────────────────────────────────
const EXCEL_HEADERS = [
  "상품코드*", "상품명*", "상품유형*(번역/통역)", "대분류", "중분류",
  "단가단위(어절/글자/페이지/시간/건)", "기본단가*", "기본진행시간(통역용)", "초과단가(통역용)", "비고",
];
const COL_WIDTHS = [12, 20, 16, 12, 12, 22, 10, 16, 14, 24];
const UNIT_MAP: Record<string, string> = {
  eojeol: "어절", char: "글자", page: "페이지", hour: "시간", 건: "건",
};
const UNIT_MAP_REV: Record<string, string> = {
  어절: "eojeol", 글자: "char", 페이지: "page", 시간: "hour", 건: "건",
};
const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function productToRow(p: typeof productsTable.$inferSelect): (string | number)[] {
  return [
    p.code,
    p.name,
    p.productType === "interpretation" ? "통역" : "번역",
    p.mainCategory ?? "",
    p.subCategory ?? "",
    UNIT_MAP[p.unit ?? "건"] ?? p.unit ?? "건",
    p.basePrice ?? 0,
    p.interpretationDuration ?? "",
    p.overtimePrice ?? "",
    p.description ?? "",
  ];
}

// ─── 상품 목록 (옵션 포함) ────────────────────────────────────────────────────
router.get("/admin/products", ...adminGuard, async (req, res) => {
  try {
    const { search, mainCategory, activeOnly } = req.query as {
      search?: string; mainCategory?: string; activeOnly?: string;
    };

    let rows = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter(p =>
        p.name.toLowerCase().includes(s) ||
        p.code.toLowerCase().includes(s) ||
        (p.mainCategory ?? "").toLowerCase().includes(s) ||
        (p.subCategory ?? "").toLowerCase().includes(s)
      );
    }

    if (mainCategory?.trim()) {
      rows = rows.filter(p => p.mainCategory === mainCategory.trim());
    }

    if (activeOnly === "true") {
      rows = rows.filter(p => p.active);
    }

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

// ─── 상품 생성 ────────────────────────────────────────────────────────────────
router.post("/admin/products", ...adminGuard, async (req, res) => {
  const { code, name, mainCategory, subCategory, unit, basePrice, description,
    productType, interpretationDuration, overtimePrice, options } = req.body as {
    code?: string; name?: string; mainCategory?: string; subCategory?: string;
    unit?: string; basePrice?: number; description?: string;
    productType?: string; interpretationDuration?: string; overtimePrice?: number;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
  };

  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: "코드와 상품명은 필수입니다." }); return;
  }

  try {
    const [product] = await db
      .insert(productsTable)
      .values({
        code: code.trim(),
        name: name.trim(),
        mainCategory: mainCategory?.trim() || null,
        subCategory: subCategory?.trim() || null,
        unit: unit ?? "건",
        basePrice: basePrice ?? 0,
        description: description?.trim() || null,
        productType: productType ?? "translation",
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
    ["TRN-001", "한영 일반번역", "번역", "번역", "일반번역", "어절", 50, "", "", "일반 문서 번역"],
    ["INT-001", "한영 동시통역", "통역", "통역", "동시통역", "시간", 200000, "4h", 50000, "컨퍼런스 동시통역"],
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

// ─── 엑셀 업로드 (일괄 등록/수정) ────────────────────────────────────────────
router.post("/admin/products/import", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일이 없습니다." }); return; }

  type ImportResult = { created: number; updated: number; errors: { row: number; message: string }[] };
  const result: ImportResult = { created: 0, updated: 0, errors: [] };

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    if (rows.length < 2) {
      res.status(400).json({ error: "데이터 행이 없습니다. (헤더 제외 최소 1행 필요)" }); return;
    }

    const dataRows = rows.slice(1);
    const existing = await db.select().from(productsTable);
    const codeMap = new Map(existing.map(p => [p.code.trim().toLowerCase(), p]));

    for (let i = 0; i < dataRows.length; i++) {
      const rowNum = i + 2;
      const r = dataRows[i];
      const code = String(r[0] ?? "").trim();
      const name = String(r[1] ?? "").trim();
      const typeRaw = String(r[2] ?? "").trim();
      const mainCategory = String(r[3] ?? "").trim() || null;
      const subCategory = String(r[4] ?? "").trim() || null;
      const unitRaw = String(r[5] ?? "").trim();
      const basePriceRaw = Number(r[6] ?? 0);
      const interpretationDuration = String(r[7] ?? "").trim() || null;
      const overtimePriceRaw = r[8] !== "" ? Number(r[8]) : null;
      const description = String(r[9] ?? "").trim() || null;

      if (!code && !name) continue;

      if (!code) { result.errors.push({ row: rowNum, message: "상품코드 누락" }); continue; }
      if (!name) { result.errors.push({ row: rowNum, message: "상품명 누락" }); continue; }
      if (!["번역", "통역"].includes(typeRaw)) {
        result.errors.push({ row: rowNum, message: `상품유형 오류: '${typeRaw}' (번역 또는 통역)` }); continue;
      }
      if (isNaN(basePriceRaw) || basePriceRaw < 0) {
        result.errors.push({ row: rowNum, message: `기본단가 숫자 오류: '${r[6]}'` }); continue;
      }

      const productType = typeRaw === "통역" ? "interpretation" : "translation";
      const unit = (UNIT_MAP_REV[unitRaw] ?? unitRaw) || "건";
      const basePrice = Math.round(basePriceRaw);
      const overtimePrice = overtimePriceRaw !== null && !isNaN(overtimePriceRaw) ? Math.round(overtimePriceRaw) : null;

      const existingProduct = codeMap.get(code.toLowerCase());
      try {
        if (existingProduct) {
          await db.update(productsTable).set({
            name, mainCategory, subCategory, unit, basePrice, description,
            productType, interpretationDuration, overtimePrice,
          }).where(eq(productsTable.id, existingProduct.id));
          result.updated++;
        } else {
          await db.insert(productsTable).values({
            code, name, mainCategory, subCategory, unit, basePrice, description,
            productType, interpretationDuration, overtimePrice,
          });
          result.created++;
        }
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

// ─── 상품 수정 ────────────────────────────────────────────────────────────────
router.patch("/admin/products/:id", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const { code, name, mainCategory, subCategory, unit, basePrice, description, active,
    productType, interpretationDuration, overtimePrice, options } = req.body as {
    code?: string; name?: string; mainCategory?: string; subCategory?: string;
    unit?: string; basePrice?: number; description?: string; active?: boolean;
    productType?: string; interpretationDuration?: string; overtimePrice?: number | null;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
  };

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(productsTable)
      .set({
        code: code?.trim() ?? existing.code,
        name: name?.trim() ?? existing.name,
        mainCategory: mainCategory !== undefined ? (mainCategory?.trim() || null) : existing.mainCategory,
        subCategory: subCategory !== undefined ? (subCategory?.trim() || null) : existing.subCategory,
        unit: unit ?? existing.unit,
        basePrice: basePrice ?? existing.basePrice,
        description: description !== undefined ? (description?.trim() || null) : existing.description,
        active: active !== undefined ? Boolean(active) : existing.active,
        productType: productType ?? existing.productType,
        interpretationDuration: interpretationDuration !== undefined ? (interpretationDuration?.trim() || null) : existing.interpretationDuration,
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
          productId: productId,
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

    res.json({ ...updated, options: optionRows });
  } catch (err) {
    req.log.error({ err }, "Products: failed to update");
    res.status(500).json({ error: "상품 수정 실패." });
  }
});

// ─── 상품 활성/비활성 토글 ────────────────────────────────────────────────────
router.patch("/admin/products/:id/toggle", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(productsTable)
      .set({ active: !existing.active })
      .where(eq(productsTable.id, productId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Products: failed to toggle");
    res.status(500).json({ error: "상품 상태 변경 실패." });
  }
});

// ─── 상품 삭제 ────────────────────────────────────────────────────────────────
router.delete("/admin/products/:id", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    await db.delete(productsTable).where(eq(productsTable.id, productId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Products: failed to delete");
    res.status(500).json({ error: "상품 삭제 실패." });
  }
});

export default router;
