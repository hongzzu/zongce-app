// services/r2Client.js
// Cloudflare R2（S3 兼容）客户端。未配置凭证时 R2_ENABLED=false，调用方自动回退本地 zip 模式。
// 凭证来自环境变量：R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME
const { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ENABLED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

let client = null;
let bucket = '';
if (R2_ENABLED) {
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 3,
  });
  bucket = process.env.R2_BUCKET_NAME;
}

/**
 * 流式分片上传（lib-storage 自动 multipart，无需 ContentLength）。
 * 内存友好：分片 16MB × 并发 4，服务器 1.9G 内存下安全。
 * ⚠️ 契约：stream 必须是原生 stream.Readable（lib-storage getChunk 用 instanceof Readable 判断）。
 *   archiver 实例是自定义流（instanceof 为 false）→ 调用方先 archive.pipe(new PassThrough()) 再传入。
 */
async function uploadStream(key, stream, contentType = 'application/zip', contentDisposition = 'attachment') {
  if (!R2_ENABLED) throw new Error('R2 未配置');
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentDisposition: contentDisposition, // 强制浏览器下载而非打开
    },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
    leavePartsOnError: false,
  });
  return upload.done();
}

/** 生成预签名下载 URL（默认 24h） */
async function generatePresignedUrl(key, expiresIn = 86400) {
  if (!R2_ENABLED) throw new Error('R2 未配置');
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, cmd, { expiresIn });
}

/** 删除单个对象 */
async function deleteObject(key) {
  if (!R2_ENABLED) return;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** 列出前缀下所有对象（分页自动翻页），返回 [{ key, lastModified }] */
async function listObjects(prefix) {
  if (!R2_ENABLED) return [];
  const out = [];
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of (r.Contents || [])) out.push({ key: o.Key, lastModified: o.LastModified ? o.LastModified.getTime() : 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

module.exports = { R2_ENABLED, uploadStream, generatePresignedUrl, deleteObject, listObjects };
