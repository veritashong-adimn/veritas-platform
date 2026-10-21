// 통번역사 Master 재구축 — 헤드리스 러너(요구사항7·검증/실행).
//  · HTTP 라우트와 동일한 runRebuildExecute 코어를 호출(로직 중복 없음).
//  · 기본 DRY-RUN(검증). --commit 플래그가 있을 때만 confirm 토큰과 함께 실제 실행.
//  · 서버 암호화 스냅샷(브라우저 업로드 원본)을 복호해 사용. 주민번호 원문 미출력.
import { runRebuildExecute } from "./routes/bulkImport";
import { getSnapshotMeta, readSnapshotBuffer } from "./lib/importSnapshot";
import { pool } from "@workspace/db";

async function main() {
  const id = process.argv[2];
  const commit = process.argv.includes("--commit");
  const performerId = Number(process.argv.find((a) => a.startsWith("--performer="))?.split("=")[1] ?? "") || 10;
  if (!id) { console.error("usage: rebuild-run <snapshotId> [--commit] [--performer=ID]"); process.exit(2); }
  const meta = getSnapshotMeta(id);
  const buf = readSnapshotBuffer(id);
  if (!meta || !buf) { console.error("snapshot not found / decrypt failed:", id); process.exit(3); }
  const confirmToken = commit ? id : "";
  const out = await runRebuildExecute(buf, meta, { id: performerId, email: "rebuild-runner" }, { commit, confirmToken }, console as any);
  console.log("RESULT " + JSON.stringify({ status: out.status, mode: commit ? "COMMIT" : "DRY-RUN", body: out.body }));
  await pool.end().catch(() => {});
  process.exit(out.status === 200 ? 0 : 1);
}
main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
