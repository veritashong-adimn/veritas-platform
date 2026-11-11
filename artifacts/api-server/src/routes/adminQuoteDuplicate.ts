import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

// 견적 신규 생성 전 '중복 가능성' 안내용 조회(읽기 전용). 생성을 차단하지 않는다 — 화면이 확인창으로 안내만 한다.
//  · 기준: 같은 거래처(company_id 또는 requesting_company_id) + 같은 프로젝트명(공백 정규화·대소문자 무시), 취소 프로젝트 제외.
//  · 경로 충돌 회피: GET /admin/quotes/:id 와 겹치지 않도록 별도 경로 사용.
const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

router.get("/admin/quote-duplicate-check", ...adminGuard, async (req, res) => {
  const companyId = Number(req.query.companyId);
  const title = String(req.query.title ?? "").trim();
  if (!Number.isInteger(companyId) || companyId <= 0 || !title) { res.json({ candidates: [] }); return; }
  try {
    const r = await db.execute(sql`
      SELECT p.id, p.title, p.status, p.created_at AS "createdAt",
             (SELECT string_agg(q.quote_number, ', ' ORDER BY q.id) FROM quotes q WHERE q.project_id = p.id AND q.deleted_at IS NULL) AS "quoteNumbers"
        FROM projects p
       WHERE (p.company_id = ${companyId} OR p.requesting_company_id = ${companyId})
         AND p.status <> 'cancelled'
         AND lower(regexp_replace(trim(p.title), '\\s+', ' ', 'g')) = lower(regexp_replace(${title}, '\\s+', ' ', 'g'))
       ORDER BY p.id DESC LIMIT 5`);
    res.json({ candidates: r.rows });
  } catch (err) {
    req.log.error({ err }, "Admin: quote duplicate-check failed");
    res.status(500).json({ error: "중복 확인 실패." });
  }
});

export default router;
