# Overview

This project is a pnpm workspace monorepo using TypeScript, designed as an MVP for a translation and interpretation platform. The platform aims to connect customers needing translation services with qualified translators, facilitating project management, quoting, task assignment, payments, and settlements.

Key capabilities include:
- User authentication and authorization with JWT (with email normalization, detailed failure logging, and admin password reset API).
- Project creation and management for customers (with visual status stepper: 접수→견적→승인→결제→번역사 배정→번역 중→완료).
- **견적 항목 기반 구조 (신규)**: 모든 견적 유형(B2B 일반/선입금 차감)에 항목(QuoteItem) 기반 입력 통합. `quote_items` 테이블에 `language_pair` 컬럼 추가. 항목명/언어쌍/단위/수량/단가/세율 입력 → 부가세·합계 자동계산 → 총합계 = 견적금액. 선입금 차감 유형도 이번 항목 합계로 차감금액 자동결정(수동 입력 제거). 기존 단순금액 입력 방식 제거(항목 방식으로 통합).
- Quote generation and approval workflow.
- Translator matching and task assignment (AI-scored match-candidates top-3, direct assign API).
- Payment processing and settlement management for translators.
- Admin CRM dashboard: **좌측 사이드바 레이아웃** (dark #1e2433, 220px, 접기/펼치기 가능). 메뉴 그룹: 운영관리(대시보드/프로젝트/결제/작업/정산/**선입금 현황**/**누적 청구**), 사용자/고객(사용자관리/고객관리/거래처/담당자), 번역/단가(번역사/상품·단가), 기타(게시판/운영 테스트). 상단 바에 햄버거+페이지 제목+새로고침. 사이드바 하단 사용자 이메일+로그아웃.
- **프로젝트 검색 고도화**: 빠른 필터(전체/미청구/미수금/선입금차감/잔액남음/누적진행중), 상세필터(견적서유형/청구방식/입금예정일), 프로젝트 테이블에 견적유형·결제 여부 컬럼 추가. API params: quickFilter, quoteType, billingType, paymentDueDateFrom, paymentDueDateTo, companyId.
- **선입금 계정 원장 시스템 (신규)**: `prepaid_accounts` + `prepaid_ledger` DB 테이블. 거래처별 선입금 계정(최초입금액, 현재잔액)과 모든 거래내역(입금/차감/조정)을 원장 방식으로 관리. API: `GET/POST /api/admin/prepaid-accounts`, `GET /api/admin/prepaid-accounts/:id`, `POST /api/admin/prepaid-accounts/:id/transactions`, `DELETE /api/admin/prepaid-ledger/:entryId`. PrepaidLedgerModal 컴포넌트로 잔액 요약+원장 테이블+거래 추가 지원. 선입금 현황 탭: 계정 카드 그리드(잔액/사용률 바), 신규 계정 등록 폼. CompanyDetailModal에도 거래처별 선입금 계정 카드 + 원장 보기 기능 추가.
- **누적 청구 탭**: `GET /api/admin/billing-batches` → billing_batches 목록(상태/기간/건수/금액). 상태 필터(전체/초안/발송/승인/완료) 지원.
- **누적 견적 작업 항목(Work Items) 시스템**: `billing_batch_work_items` 테이블 (batchId, sortOrder, workDate, projectName, language, description, quantity, unitPrice, amount). API: `POST/PUT/DELETE /api/admin/billing-batches/:batchId/work-items/:itemId?`. `GET /billing-batches/active` 응답에 `workItems` 배열 포함. 발행(`/issue`) 시 work items 기반 금액 계산 및 quoteItems 생성. ProjectDetailModal 내 인라인 추가/수정/삭제 UI 탑재.
- **거래처 상세 확장**: API 응답에 prepaidBalance, unpaidAmount, activeAccumulatedCount, lastProjectDate, lastPaymentDate 추가. CompanyDetailModal에 선입금잔액/미수금/누적청구진행 카드 표시.
- **프로젝트 업무/재무 상태 분리**: `financialStatusEnum`("unbilled"/"billed"/"receivable"/"paid") + `financial_status` DB 컬럼 추가. `PATCH /admin/projects/:id/financial-status` 엔드포인트. AdminDashboard 필터 3단(업무/재무/빠른) 분리, 리스트에 업무+재무 배지 동시 표시. ProjectDetailModal 재무 상태 토글 버튼 섹션 추가. 상태 전이 맵: approved→matched(paid 스킵).
- **거래처 담당자 관리 (B2B CRM)**: `contacts` 테이블 확장 (mobile/officePhone/memo/isPrimary/isQuoteContact/isBillingContact/isActive/updatedAt 추가). API: GET/POST /admin/contacts, GET/POST /admin/company-contacts, GET /admin/contacts/:id, PATCH /admin/contacts/:id, DELETE /admin/contacts/:id (soft delete - 프로젝트 이력 있으면 is_active=false, 없으면 hard delete). 기본 담당자(isPrimary) 중복 방지: 새로 지정 시 기존 자동 해제. 검색: keyword 파라미터로 이름/이메일/휴대폰/거래처명 통합 검색. 로그: company_contact_created/updated/deleted/primary_changed. CompanyDetailModal 담당자 섹션 전면 개편 (추가폼/카드형 목록/인라인 수정폼/역할 배지/비활성 토글). AdminDashboard 담당자 탭: 거래처명/역할 배지/활성 상태 컬럼 추가.
- **통번역사 정산/지급 정보 관리 (확장)**: `translator_sensitive` 테이블에 20개 필드(지급방식별 조건부): paymentMethod(5종), residentNumber(AES-256 암호화), bankName/bankAccount/accountHolder(국내공통), businessNumber/businessName/businessOwner/taxInvoiceEmail(사업자), paypalEmail/englishName/country/currency/remittanceMemo(PayPal), addressEn/bankNameEn/swiftCode/routingNumber/iban(해외송금), baseCurrency/remittanceFeePayer/paymentHold/settlementMemo(공통추가). **지급방식 5종**: domestic_withholding(국내 3.3% 원천징수), domestic_business(국내 사업자/세금계산서), overseas_paypal(해외 PayPal), overseas_bank(해외 은행송금), other(기타). **SensitiveInfoModal**: 지급방식 선택 버튼 → 방식별 조건부 필드 표시, 뷰 모드 방식별 요약, 지급보류 체크박스, 수수료부담 드롭다운. **TranslatorCreateModal**: 동일 구조 5종 버튼 + 조건부 필드 + 등록 시 sensitive API 자동 호출. **보안**: RBAC `translator.sensitive`(admin+finance만), 조회·수정 감사 로그, 앱 로드 시 서버에서 권한 자동 갱신(localStorage 캐시 불일치 방지).
- **번역/통역 상품 구조 분리**: `products` 테이블에 `productType`(text, default 'translation'), `interpretationDuration`(text), `overtimePrice`(integer) 컬럼 추가. 상품 등록·수정 폼에 번역/통역 토글 버튼 → 번역: 단위 드롭다운 표시, 통역: 기본진행시간+초과단가 필드 표시. 상품 목록에 📄번역/🎤통역 배지 + 기본시간·초과단가 태그 표시. 견적 항목 폼에서 상품 선택 시 productType 자동 감지: 번역 → 단위/수량/단가 입력, 통역 → 보라색 UI(진행시간+총금액 입력). 상품 선택 드롭다운에 📄/🎤 아이콘으로 시각적 구분. API POST/PATCH /admin/products에서 3개 신규 필드 모두 처리.
- **Divisions 시스템 (대형 고객사 지원)**: `divisions` 테이블(company_id FK, name, type). `contacts.division_id` nullable. `projects` 테이블에 requesting_company_id/requesting_division_id/billing_company_id/payer_company_id 4개 필드 추가. API: GET/POST /admin/companies/:id/divisions, PATCH/DELETE /admin/divisions/:id, POST/PATCH /admin/contacts (divisionId 지원), POST /admin/projects + PATCH /admin/projects/:id/info (4개 신규 필드). 거래처 상세에 브랜드별 프로젝트 수·매출·담당자 수 통계 포함. 프로젝트 리스트에 divisionName/billingCompanyName/payerCompanyName/requestingCompanyName 표시 (단순/복합 모드 분기). AdminDashboard 프로젝트 생성 폼에 브랜드 선택+청구처/납부처 분리 UI (스마트 기본값: 모두 동일 → "다르게 설정" 토글). ProjectDetailModal 기본정보 수정 폼에 브랜드/청구처/납부처 필드, 뷰 모드에 브랜드·청구처 표시. 거래처 상세 모달(CompanyDetailModal): 담당자 등록/수정 폼에 브랜드/부서 연결 드롭다운(divisions 존재 시만 표시), 담당자 카드에 소속 브랜드 뱃지, 프로젝트 목록에 의뢰 브랜드 뱃지. TranslatorListItem 타입에 education/major 필드 추가. companyBillingType 스코프 오류 수정.
- Project detail modal (7-tab UI: 기본정보/거래처·담당자/번역사/견적결제정산/커뮤니케이션/메모/이벤트로그), company/contact management, translator profiles and rate management, user management (activation/role/password-reset), product master, board/bulletin.
- **파일 관리**: 프로젝트별 파일 업로드/다운로드/삭제. GCS presigned URL 방식(2단계: URL 발급 → GCS PUT → DB 등록). 파일 유형: source(원본), translated(번역본), attachment(기타). ProjectDetailModal 내 "📎 파일" 탭. 다운로드는 Bearer 토큰 인증 후 blob URL로 처리.
- Translator self-service: profile edit + rate table CRUD via own-auth API endpoints.
- File upload for project documents.
- Comprehensive logging of key events.

The business vision is to streamline the process of translation and interpretation services, offering a robust platform for efficient project delivery and fair compensation for translators, while providing detailed administrative oversight.

# User Preferences

I prefer detailed explanations and iterative development. Ask before making major changes. Do not make changes to files outside the `artifacts/api-server/src` directory.

# System Architecture

The project is structured as a pnpm monorepo, organizing code into `artifacts` (deployable applications) and `lib` (shared libraries).

**Technology Stack:**
- **Monorepo:** pnpm workspaces
- **Node.js:** v24
- **TypeScript:** v5.9
- **API Framework:** Express v5
- **Database:** PostgreSQL with Drizzle ORM
- **Validation:** Zod (v4) and `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Build Tool:** esbuild (CJS bundle)

**Core Architectural Decisions:**
- **Monorepo Structure:** Facilitates code sharing and consistent tooling across different parts of the application (e.g., API server, shared libraries for database and API specifications).
- **TypeScript Composite Projects:** Leverages TypeScript's composite project features for efficient type-checking and dependency management across packages, ensuring type safety throughout the monorepo.
- **API-First Development:** Utilizes an OpenAPI 3.1 specification (`openapi.yaml`) as the single source of truth for the API. Orval generates client-side React Query hooks (`api-client-react`) and server-side Zod schemas (`api-zod`) directly from this spec, ensuring strong type consistency between frontend and backend.
- **Authentication:** Implements JWT Bearer token authentication with a 7-day expiry and bcryptjs for password hashing. Role-based access control is enforced via Express middleware.
- **Database Schema:** A normalized PostgreSQL schema manages users, projects, quotes, tasks, payments, settlements, and administrative entities like companies, contacts, and translator rates. Key entities include `users`, `projects`, `quotes`, `quote_items`, `tasks`, `payments`, `settlements`, `billing_batches`, `billing_batch_items`. `billing_batches` / `billing_batch_items` are used for accumulated batch quote (누적 견적서) — monthly invoice grouping for 세금계산서 연계.
- **API Endpoints:** A comprehensive set of RESTful API endpoints are designed to manage all platform functionalities, categorized by domain (Auth, Users, Projects, Settlements, Admin, Payments, Upload, Quotes, Tasks, Logs & Health).
- **Error Handling & Logging:** Key events are logged, such as project creation, quote approvals, task status changes, using a dedicated `logs` table.
- **Admin Features:** Extensive admin panels are provided for managing customers, companies, contacts, translators, products, and platform content (board, notes), including data export functionalities.
- **State Transition Rules:** Explicit allowed transition maps enforced on both backend (400 on invalid transitions) and frontend (dropdown shows only valid next states). Admin can force-override with `force:true`.
- **Seed Data:** `pnpm --filter @workspace/api-server run seed` creates 2 companies, 3 contacts, 3 translators (with profiles+rates), 2 customers, 6 projects (all status states) for full-flow testing.
- **Project List UX:** Pagination (20 per page), quick action buttons (상세보기, 취소) per row, filter pills reset page to 1.
- **Event Log Timeline:** Korean action label mapping + vertical timeline design with icons and color coding; sorted chronologically (oldest first).
- **Quick Cancel API:** `PATCH /api/admin/projects/:id/cancel` for fast project cancellation from list view.

- **PDF 문서 출력:** `services/document.service.ts` + `services/doc-number.ts` + `routes/documents.ts`
  - 견적서: `GET /api/admin/projects/:id/pdf/quote?token=JWT`
  - 거래명세서: `GET /api/admin/projects/:id/pdf/statement?token=JWT`
  - 렌더링: print-ready HTML (A4, @media print) → 브라우저 인쇄 다이얼로그 → PDF 저장
  - `PlatformInfo` (발신기관): 환경변수 `PLATFORM_NAME/REPRESENTATIVE/BIZ_NUMBER/ADDRESS/PHONE/EMAIL`
  - `BankInfo` (계좌): 환경변수 `BANK_NAME/BANK_ACCOUNT/BANK_HOLDER` (미설정 시 "미등록" 표시)
  - 문서번호: `Q-YYYYMMDD-{quoteId:05d}` / `S-YYYYMMDD-{projectId:05d}` (향후 DB 시퀀스 교체 가능)
  - `requireAuth` 미들웨어: `Authorization: Bearer` 헤더 외 `?token=` 쿼리 파라미터도 허용 (문서 다운로드 전용)

- **quote_items 설계 (PENDING — 미마이그레이션):**
  - 초안 파일: `lib/db/src/schema/quote_items.draft.ts`
  - 컬럼: id, quote_id (FK), product_id (FK optional), product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, memo, created_at
  - `products` 연결: `product_id` 옵셔널 FK — 선택 시 name/basePrice/unit 자동 채움
  - API 영향: `routes/quotes.ts` 품목 CRUD 추가, `admin.ts` 견적생성 시 items[] 함께 전달
  - Frontend 영향: 견적 생성 폼 품목 행 UI + PDF 품목 테이블 렌더링
  - 실제 마이그레이션 전 확정 필요

**Frontend 구조 (web-app, 2026-03 리팩토링 완료):**
- 기존 App.tsx 단일 파일(5409줄) → 17개 파일로 분리
- `src/lib/constants.ts`: 공통 타입, API 클라이언트, 레이블 상수 (ALL_PROJECT_STATUSES, ALL_PAYMENT_STATUSES, ALL_SETTLEMENT_STATUSES 포함)
- `src/components/ui/index.tsx`: 공통 UI 컴포넌트 (StatusBadge, RoleBadge, Toast, Card, PrimaryBtn, GhostBtn, FilterPill)
- `src/components/shared/Navbar.tsx`: 네비게이션 바
- `src/components/projects/index.tsx`: 프로젝트 공통 컴포넌트
- `src/components/admin/`: LogModal, TranslatorProfileModal, TranslatorDetailModal, CustomerDetailModal, CompanyDetailModal, ContactDetailModal, ProjectDetailModal (7-탭)
- `src/pages/AuthPage.tsx`: 로그인/회원가입
- `src/pages/AdminDashboard.tsx`: 어드민 CRM 메인 (~1904줄)
- `src/pages/CustomerDashboard.tsx`: 고객 대시보드
- `src/pages/TranslatorDashboard.tsx`: 번역사 대시보드
- `src/App.tsx`: 라우터 전용 (~100줄)

**UI/UX Decisions:**
- Frontend will manage JWTs in localStorage for authenticated sessions.
- Clear separation of concerns between customer, translator, and admin roles with appropriate access controls.
- Forms for user registration, login, project creation, and administrative data entry.
- Display of project statuses, payment details, and settlement information.
- 스타일: Tailwind 미사용, inline styles 방식으로 통일

# External Dependencies

- **PostgreSQL:** Primary database for all application data.
- **Drizzle ORM:** Object-Relational Mapper for interacting with PostgreSQL.
- **Express:** Web application framework for building the API server.
- **Zod:** Schema declaration and validation library, used for API request/response validation and data integrity.
- **bcryptjs:** Library for hashing and comparing passwords securely.
- **Orval:** OpenAPI client code generator, used to create strongly typed API clients and schemas.
- **AWS S3 (or compatible, e.g., Cloudflare R2):** For file storage and management (implied by file upload feature).