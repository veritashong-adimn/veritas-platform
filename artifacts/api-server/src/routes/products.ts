import { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq, desc, ilike, or } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 상품 목록 ───────────────────────────────────────────────────────────────
router.get("/admin/products", ...adminGuard, async (req, res) => {
  try {
    const { search, category, activeOnly } = req.query as { search?: string; category?: string; activeOnly?: string };

    let rows = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter(p =>
        p.name.toLowerCase().includes(s) ||
        p.code.toLowerCase().includes(s) ||
        (p.languagePair ?? "").toLowerCase().includes(s) ||
        (p.field ?? "").toLowerCase().includes(s)
      );
    }

    if (category?.trim()) {
      rows = rows.filter(p => p.category === category);
    }

    if (activeOnly === "true") {
      rows = rows.filter(p => p.active);
    }

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Products: failed to list");
    res.status(500).json({ error: "상품 조회 실패." });
  }
});

// ─── 상품 생성 ───────────────────────────────────────────────────────────────
router.post("/admin/products", ...adminGuard, async (req, res) => {
  const { code, name, category, unit, basePrice, languagePair, field } = req.body as {
    code?: string; name?: string; category?: string; unit?: string;
    basePrice?: number; languagePair?: string; field?: string;
  };

  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: "코드와 상품명은 필수입니다." }); return;
  }

  try {
    const [product] = await db
      .insert(productsTable)
      .values({
        code: code.trim(), name: name.trim(), category,
        unit: unit ?? "건", basePrice: basePrice ?? 0,
        languagePair, field,
      })
      .returning();
    res.status(201).json(product);
  } catch (err) {
    req.log.error({ err }, "Products: failed to create");
    res.status(500).json({ error: "상품 생성 실패." });
  }
});

// ─── 상품 단건 조회 ──────────────────────────────────────────────────────────
router.get("/admin/products/:id", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!product) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }
    res.json(product);
  } catch (err) {
    req.log.error({ err }, "Products: failed to get");
    res.status(500).json({ error: "상품 조회 실패." });
  }
});

// ─── 상품 수정 ───────────────────────────────────────────────────────────────
router.patch("/admin/products/:id", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const { code, name, category, unit, basePrice, languagePair, field, active } = req.body;

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(productsTable)
      .set({
        code: code?.trim() ?? existing.code,
        name: name?.trim() ?? existing.name,
        category: category ?? existing.category,
        unit: unit ?? existing.unit,
        basePrice: basePrice ?? existing.basePrice,
        languagePair: languagePair ?? existing.languagePair,
        field: field ?? existing.field,
        active: active !== undefined ? Boolean(active) : existing.active,
      })
      .where(eq(productsTable.id, productId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Products: failed to update");
    res.status(500).json({ error: "상품 수정 실패." });
  }
});

// ─── 상품 비활성화 토글 ──────────────────────────────────────────────────────
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

// ─── 상품 삭제 ───────────────────────────────────────────────────────────────
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
