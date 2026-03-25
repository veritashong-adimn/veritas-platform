import bcrypt from "bcryptjs";
import {
  db, pool,
  usersTable, projectsTable, quotesTable, paymentsTable,
  tasksTable, settlementsTable, companiesTable, contactsTable,
  translatorProfilesTable, translatorRatesTable, logsTable,
} from "@workspace/db";

async function hashPw(pw: string) {
  return bcrypt.hash(pw, 10);
}

async function main() {
  console.log("🌱 샘플 데이터 seed 시작...");

  const customerPw = await hashPw("password123");
  const translatorPw = await hashPw("password123");

  // ── 고객 계정 ────────────────────────────────────────────────
  const [cust1] = await db.insert(usersTable).values({
    email: "kim.customer@example.com", password: customerPw, role: "customer",
  }).onConflictDoNothing().returning();

  const [cust2] = await db.insert(usersTable).values({
    email: "lee.customer@example.com", password: customerPw, role: "customer",
  }).onConflictDoNothing().returning();

  // ── 번역사 계정 ──────────────────────────────────────────────
  const [tr1] = await db.insert(usersTable).values({
    email: "park.translator@example.com", password: translatorPw, role: "translator",
  }).onConflictDoNothing().returning();

  const [tr2] = await db.insert(usersTable).values({
    email: "choi.translator@example.com", password: translatorPw, role: "translator",
  }).onConflictDoNothing().returning();

  const [tr3] = await db.insert(usersTable).values({
    email: "jung.translator@example.com", password: translatorPw, role: "translator",
  }).onConflictDoNothing().returning();

  // ── 거래처 ──────────────────────────────────────────────────
  const [comp1] = await db.insert(companiesTable).values({
    name: "베리타스코 주식회사",
    businessNumber: "123-45-67890",
    industry: "법률/특허",
    address: "서울시 강남구 테헤란로 123",
    website: "https://veritasco.co.kr",
    representativeName: "홍성호",
    email: "contact@veritasco.co.kr",
    phone: "02-1234-5678",
    notes: "장기 거래처, VIP 등급",
  }).onConflictDoNothing().returning();

  const [comp2] = await db.insert(companiesTable).values({
    name: "글로벌링크 코퍼레이션",
    businessNumber: "987-65-43210",
    industry: "IT/소프트웨어",
    address: "서울시 서초구 반포대로 45",
    website: "https://globallink.co.kr",
    representativeName: "이미영",
    email: "biz@globallink.co.kr",
    phone: "02-9876-5432",
    notes: "기술 문서 번역 주요 고객",
  }).onConflictDoNothing().returning();

  // ── 담당자 ───────────────────────────────────────────────────
  if (comp1) {
    await db.insert(contactsTable).values([
      {
        companyId: comp1.id, name: "홍길동", department: "법무팀",
        position: "팀장", email: "hong@veritasco.co.kr", phone: "010-1111-2222",
        notes: "계약서 번역 담당",
      },
      {
        companyId: comp1.id, name: "박수진", department: "경영기획",
        position: "대리", email: "park.sj@veritasco.co.kr", phone: "010-3333-4444",
        notes: "IR 자료 번역 담당",
      },
    ]).onConflictDoNothing();
  }

  if (comp2) {
    await db.insert(contactsTable).values({
      companyId: comp2.id, name: "김재현", department: "기술팀",
      position: "부장", email: "kim.jh@globallink.co.kr", phone: "010-5555-6666",
      notes: "API 문서, 기술 매뉴얼 번역",
    }).onConflictDoNothing();
  }

  // ── 번역사 프로필 + 단가표 ─────────────────────────────────
  if (tr1) {
    await db.insert(translatorProfilesTable).values({
      userId: tr1.id,
      languagePairs: "EN→KO, KO→EN",
      specializations: "법률, 계약서, 특허",
      education: "서울대학교 법학 학사, 통번역대학원 석사",
      region: "서울",
      availabilityStatus: "available",
      rating: "4.8",
      bio: "법률 전문 번역사. 10년 경력. 특허, 계약서, 법원 문서 전문.",
    }).onConflictDoNothing();
    await db.insert(translatorRatesTable).values([
      { translatorId: tr1.id, serviceType: "번역", languagePair: "EN→KO", unit: "word", rate: 80 },
      { translatorId: tr1.id, serviceType: "번역", languagePair: "KO→EN", unit: "word", rate: 100 },
      { translatorId: tr1.id, serviceType: "통역", languagePair: "EN↔KO", unit: "hour", rate: 150000 },
    ]).onConflictDoNothing();
  }

  if (tr2) {
    await db.insert(translatorProfilesTable).values({
      userId: tr2.id,
      languagePairs: "JA→KO, KO→JA",
      specializations: "IT, 소프트웨어, 기술 문서",
      education: "한국외국어대학교 일어과 학사",
      region: "경기",
      availabilityStatus: "available",
      rating: "4.5",
      bio: "일본어·한국어 IT 전문 번역사. 소프트웨어 매뉴얼, 기술 문서 전문.",
    }).onConflictDoNothing();
    await db.insert(translatorRatesTable).values([
      { translatorId: tr2.id, serviceType: "번역", languagePair: "JA→KO", unit: "word", rate: 70 },
      { translatorId: tr2.id, serviceType: "번역", languagePair: "KO→JA", unit: "word", rate: 90 },
    ]).onConflictDoNothing();
  }

  if (tr3) {
    await db.insert(translatorProfilesTable).values({
      userId: tr3.id,
      languagePairs: "ZH→KO, KO→ZH, EN→KO",
      specializations: "의학, 제약, 임상시험",
      education: "연세대학교 의과대학, 중어중문학 복수전공",
      region: "서울",
      availabilityStatus: "busy",
      rating: "4.9",
      bio: "의학·제약 전문 번역사. 임상시험 문서, 의학 논문, 식약처 서류 전문.",
    }).onConflictDoNothing();
    await db.insert(translatorRatesTable).values([
      { translatorId: tr3.id, serviceType: "번역", languagePair: "ZH→KO", unit: "word", rate: 90 },
      { translatorId: tr3.id, serviceType: "번역", languagePair: "KO→ZH", unit: "word", rate: 110 },
      { translatorId: tr3.id, serviceType: "번역", languagePair: "EN→KO", unit: "word", rate: 85 },
    ]).onConflictDoNothing();
  }

  if (!cust1 || !cust2) {
    console.log("⚠️  고객 계정 이미 존재 → 프로젝트 seed 건너뜀 (중복 방지)");
    await pool.end();
    return;
  }

  const c1 = cust1.id;
  const c2 = cust2.id;

  // ── 프로젝트 6종 ─────────────────────────────────────────────

  // 1) created
  const [p1] = await db.insert(projectsTable).values({
    userId: c1, companyId: comp1?.id ?? null,
    title: "[EN→KO] 특허 출원 명세서 번역 (2024-P-001)", status: "created",
  }).returning();
  await db.insert(logsTable).values({ entityType: "project", entityId: p1.id, action: "project_created" });

  // 2) quoted
  const [p2] = await db.insert(projectsTable).values({
    userId: c1, companyId: comp1?.id ?? null,
    title: "[KO→EN] 계약서 검토 및 번역 (#2024-C-012)", status: "quoted",
  }).returning();
  await db.insert(quotesTable).values({ projectId: p2.id, price: "450000", status: "pending" });
  await db.insert(logsTable).values([
    { entityType: "project", entityId: p2.id, action: "project_created" },
    { entityType: "quote",   entityId: p2.id, action: "quote_created" },
  ]);

  // 3) approved
  const [p3] = await db.insert(projectsTable).values({
    userId: c2, companyId: comp2?.id ?? null,
    title: "[JA→KO] 소프트웨어 UI 현지화 (v3.2)", status: "approved",
  }).returning();
  const [q3] = await db.insert(quotesTable).values({ projectId: p3.id, price: "320000", status: "approved" }).returning();
  await db.insert(logsTable).values([
    { entityType: "project", entityId: p3.id, action: "project_created" },
    { entityType: "quote",   entityId: q3.id, action: "quote_created" },
    { entityType: "quote",   entityId: q3.id, action: "quote_approved" },
  ]);

  // 4) paid
  const [p4] = await db.insert(projectsTable).values({
    userId: c2, companyId: comp2?.id ?? null,
    title: "[ZH→KO] 제약 임상시험 보고서 번역", status: "paid",
  }).returning();
  const [q4] = await db.insert(quotesTable).values({ projectId: p4.id, price: "880000", status: "approved" }).returning();
  const [pay4] = await db.insert(paymentsTable).values({ projectId: p4.id, amount: "880000", status: "paid" }).returning();
  await db.insert(logsTable).values([
    { entityType: "project", entityId: p4.id, action: "project_created" },
    { entityType: "quote",   entityId: q4.id, action: "quote_approved" },
    { entityType: "project", entityId: p4.id, action: "payment_paid" },
  ]);

  // 5) in_progress (번역사 배정 + 작업 시작)
  const [p5] = await db.insert(projectsTable).values({
    userId: c1, companyId: comp1?.id ?? null,
    title: "[EN→KO] IR 투자자 설명자료 번역 (2024 Q3)", status: "in_progress",
  }).returning();
  const [q5] = await db.insert(quotesTable).values({ projectId: p5.id, price: "560000", status: "approved" }).returning();
  await db.insert(paymentsTable).values({ projectId: p5.id, amount: "560000", status: "paid" });
  if (tr1) {
    await db.insert(tasksTable).values({ projectId: p5.id, translatorId: tr1.id, status: "working" });
  }
  await db.insert(logsTable).values([
    { entityType: "project", entityId: p5.id, action: "project_created" },
    { entityType: "quote",   entityId: q5.id, action: "quote_approved" },
    { entityType: "project", entityId: p5.id, action: "payment_paid" },
    { entityType: "project", entityId: p5.id, action: "project_matched" },
    { entityType: "task",    entityId: p5.id, action: "task_started" },
  ]);

  // 6) completed (정산까지 완료)
  const [p6] = await db.insert(projectsTable).values({
    userId: c2, companyId: comp2?.id ?? null,
    title: "[KO→EN] 기업 소개서 및 마케팅 자료 번역", status: "completed",
  }).returning();
  const [q6] = await db.insert(quotesTable).values({ projectId: p6.id, price: "240000", status: "approved" }).returning();
  const [pay6] = await db.insert(paymentsTable).values({ projectId: p6.id, amount: "240000", status: "paid" }).returning();
  if (tr2) {
    const [task6] = await db.insert(tasksTable).values({ projectId: p6.id, translatorId: tr2.id, status: "done" }).returning();
    await db.insert(settlementsTable).values({
      projectId: p6.id,
      translatorId: tr2.id,
      paymentId: pay6.id,
      totalAmount: "240000",
      translatorAmount: "168000",
      platformFee: "72000",
      status: "ready",
    });
  }
  await db.insert(logsTable).values([
    { entityType: "project", entityId: p6.id, action: "project_created" },
    { entityType: "quote",   entityId: q6.id, action: "quote_approved" },
    { entityType: "project", entityId: p6.id, action: "payment_paid" },
    { entityType: "task",    entityId: p6.id, action: "task_completed" },
    { entityType: "project", entityId: p6.id, action: "settlement_created" },
  ]);

  console.log("✅ Seed 완료!");
  console.log("  고객:   kim.customer@example.com / lee.customer@example.com (password123)");
  console.log("  번역사: park.translator / choi.translator / jung.translator @example.com (password123)");
  console.log("  거래처: 베리타스코 주식회사, 글로벌링크 코퍼레이션");
  console.log("  프로젝트 6개: created → quoted → approved → paid → in_progress → completed");

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
