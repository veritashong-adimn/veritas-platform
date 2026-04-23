import { logger } from "./logger";

export interface MailOptions {
  to: string;
  subject: string;
  body: string;
}

/**
 * 이메일 발송 유틸리티.
 * SMTP 미설정 환경에서는 콘솔 로그로 출력.
 * 추후 nodemailer 등으로 교체 가능.
 */
export async function sendEmail(opts: MailOptions): Promise<void> {
  const smtpHost = process.env["SMTP_HOST"];

  if (smtpHost) {
    // TODO: nodemailer 연결 시 여기서 실제 발송
    logger.warn("SMTP configured but nodemailer not yet implemented — falling back to console log");
  }

  // 콘솔 출력 (개발/임시)
  logger.info(
    { to: opts.to, subject: opts.subject },
    `[MAIL PREVIEW]\n${"─".repeat(60)}\nTo: ${opts.to}\nSubject: ${opts.subject}\n\n${opts.body}\n${"─".repeat(60)}`,
  );
}

/** 초대 이메일 */
export function buildInviteEmail(opts: {
  name: string;
  inviteUrl: string;
  projectTitle?: string;
}): MailOptions {
  const greeting = opts.name ? `안녕하세요, ${opts.name}님.` : "안녕하세요.";
  const projectLine = opts.projectTitle
    ? `\n프로젝트명: ${opts.projectTitle}\n`
    : "";

  return {
    to: "",
    subject: "[초대] 프로젝트 확인을 위해 계정을 생성해주세요",
    body: `${greeting}

통번역 플랫폼에 초대되었습니다.${projectLine}
아래 링크를 통해 비밀번호를 설정하고 로그인하세요.

${opts.inviteUrl}

링크는 48시간 후 만료됩니다.

감사합니다.`,
  };
}

/** 프로젝트 생성 알림 이메일 */
export function buildProjectNotificationEmail(opts: {
  name: string;
  projectTitle: string;
  appUrl: string;
}): MailOptions {
  return {
    to: "",
    subject: "[프로젝트 안내] 새로운 프로젝트가 등록되었습니다",
    body: `안녕하세요${opts.name ? `, ${opts.name}님` : ""}.

새로운 프로젝트가 등록되었습니다.

프로젝트명: ${opts.projectTitle}

로그인 후 상세 내용을 확인해주세요.
${opts.appUrl}

감사합니다.`,
  };
}
