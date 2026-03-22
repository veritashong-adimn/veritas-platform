import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
export const bucketName = process.env.R2_BUCKET_NAME ?? "";

export function isR2Configured(): boolean {
  return !!(accountId && accessKeyId && secretAccessKey && bucketName);
}

let _client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!_client) {
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("R2 환경 변수가 설정되지 않았습니다. R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME을 설정해주세요.");
    }
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return _client;
}

export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return `https://${bucketName}.${accountId}.r2.cloudflarestorage.com/${key}`;
}
