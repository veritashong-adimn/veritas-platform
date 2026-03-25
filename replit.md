# Overview

This project is a pnpm workspace monorepo using TypeScript, designed as an MVP for a translation and interpretation platform. The platform aims to connect customers needing translation services with qualified translators, facilitating project management, quoting, task assignment, payments, and settlements.

Key capabilities include:
- User authentication and authorization with JWT (with email normalization, detailed failure logging, and admin password reset API).
- Project creation and management for customers (with visual status stepper: 접수→견적→승인→결제→번역사 배정→번역 중→완료).
- Quote generation and approval workflow.
- Translator matching and task assignment (AI-scored match-candidates top-3, direct assign API).
- Payment processing and settlement management for translators.
- Admin CRM dashboard: project detail modal (7-tab UI: 기본정보/거래처·담당자/번역사/견적결제정산/커뮤니케이션/메모/이벤트로그), company/contact management, translator profiles and rate management, user management (activation/role/password-reset), product master, board/bulletin.
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
- **Database Schema:** A normalized PostgreSQL schema manages users, projects, quotes, tasks, payments, settlements, and administrative entities like companies, contacts, and translator rates. Key entities include `users`, `projects`, `quotes`, `tasks`, `payments`, and `settlements`.
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