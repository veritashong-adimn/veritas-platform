-- ─────────────────────────────────────────────────────────────────────────────
-- 대한민국(KR) 공휴일 시드 — 지급일 "직전 영업일" 자동조정용 (holidays 테이블).
--  · 프론트 하드코딩 대신 이 테이블이 단일 출처. 관리자가 추후 추가·수정 가능.
--  · 2025·2026 은 법정·대체·선거일 포함 정밀 시드. 2027 은 양력고정+대체만(음력·임시공휴일은
--    확정 시 관리자 추가 권장 — 보고서 명시).
--  · 재실행 안전: (country_code, holiday_date, holiday_name) 유니크 → ON CONFLICT DO NOTHING.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO holidays (holiday_date, holiday_name, holiday_type, is_substitute_holiday, is_temporary_holiday, country_code, year, active) VALUES
-- ===== 2025 =====
('2025-01-01','신정','public',false,false,'KR',2025,true),
('2025-01-28','설날 연휴','public',false,false,'KR',2025,true),
('2025-01-29','설날','public',false,false,'KR',2025,true),
('2025-01-30','설날 연휴','public',false,false,'KR',2025,true),
('2025-03-01','삼일절','public',false,false,'KR',2025,true),
('2025-03-03','대체공휴일(삼일절)','substitute',true,false,'KR',2025,true),
('2025-05-05','어린이날','public',false,false,'KR',2025,true),
('2025-05-05','부처님오신날','public',false,false,'KR',2025,true),
('2025-05-06','대체공휴일(부처님오신날)','substitute',true,false,'KR',2025,true),
('2025-06-03','제21대 대통령선거','election',false,true,'KR',2025,true),
('2025-06-06','현충일','public',false,false,'KR',2025,true),
('2025-08-15','광복절','public',false,false,'KR',2025,true),
('2025-10-03','개천절','public',false,false,'KR',2025,true),
('2025-10-05','추석 연휴','public',false,false,'KR',2025,true),
('2025-10-06','추석','public',false,false,'KR',2025,true),
('2025-10-07','추석 연휴','public',false,false,'KR',2025,true),
('2025-10-08','대체공휴일(추석)','substitute',true,false,'KR',2025,true),
('2025-10-09','한글날','public',false,false,'KR',2025,true),
('2025-12-25','성탄절','public',false,false,'KR',2025,true),
-- ===== 2026 =====
('2026-01-01','신정','public',false,false,'KR',2026,true),
('2026-02-16','설날 연휴','public',false,false,'KR',2026,true),
('2026-02-17','설날','public',false,false,'KR',2026,true),
('2026-02-18','설날 연휴','public',false,false,'KR',2026,true),
('2026-03-01','삼일절','public',false,false,'KR',2026,true),
('2026-03-02','대체공휴일(삼일절)','substitute',true,false,'KR',2026,true),
('2026-05-05','어린이날','public',false,false,'KR',2026,true),
('2026-05-24','부처님오신날','public',false,false,'KR',2026,true),
('2026-05-25','대체공휴일(부처님오신날)','substitute',true,false,'KR',2026,true),
('2026-06-03','제9회 전국동시지방선거','election',false,true,'KR',2026,true),
('2026-06-06','현충일','public',false,false,'KR',2026,true),
('2026-08-15','광복절','public',false,false,'KR',2026,true),
('2026-08-17','대체공휴일(광복절)','substitute',true,false,'KR',2026,true),
('2026-09-24','추석 연휴','public',false,false,'KR',2026,true),
('2026-09-25','추석','public',false,false,'KR',2026,true),
('2026-09-26','추석 연휴','public',false,false,'KR',2026,true),
('2026-10-03','개천절','public',false,false,'KR',2026,true),
('2026-10-05','대체공휴일(개천절)','substitute',true,false,'KR',2026,true),
('2026-10-09','한글날','public',false,false,'KR',2026,true),
('2026-12-25','성탄절','public',false,false,'KR',2026,true),
-- ===== 2027 (양력고정 + 대체공휴일. 음력·임시공휴일은 확정 후 관리자 추가) =====
('2027-01-01','신정','public',false,false,'KR',2027,true),
('2027-03-01','삼일절','public',false,false,'KR',2027,true),
('2027-05-05','어린이날','public',false,false,'KR',2027,true),
('2027-06-06','현충일','public',false,false,'KR',2027,true),
('2027-08-15','광복절','public',false,false,'KR',2027,true),
('2027-08-16','대체공휴일(광복절)','substitute',true,false,'KR',2027,true),
('2027-10-03','개천절','public',false,false,'KR',2027,true),
('2027-10-04','대체공휴일(개천절)','substitute',true,false,'KR',2027,true),
('2027-10-09','한글날','public',false,false,'KR',2027,true),
('2027-10-11','대체공휴일(한글날)','substitute',true,false,'KR',2027,true),
('2027-12-25','성탄절','public',false,false,'KR',2027,true),
('2027-12-27','대체공휴일(성탄절)','substitute',true,false,'KR',2027,true)
ON CONFLICT (country_code, holiday_date, holiday_name) DO NOTHING;
