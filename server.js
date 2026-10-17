// 默认二级审核密码（可由环境变量 DEFAULT_SECONDARY_PASSWORD 覆盖）
// 生产部署请务必修改，勿使用默认值。
const DEFAULT_SECONDARY_PASSWORD = process.env.DEFAULT_SECONDARY_PASSWORD || 'ChangeMe@0000';

// ============================================================
// 综合素质测评审批系统 - 后端主服务
// 学生提交 → 已认定材料由班长审核 / 未认定材料由年级审核
// 年级可改判班级结果；班长/年级可要求补交；公示期学生可异议
// ============================================================
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const officeCrypto = require('officecrypto-tool'); // Excel 真加密（OOXML），2026-08-30 安全防护
const compression = require('compression'); // 2026-08-31 全局 gzip 压缩（多人访问卡顿缓解）
const archiver = require('archiver'); // 2026-08-31 证明材料 zip 打包下载（流式，不占内存）
const { PassThrough } = require('stream'); // 2026-09-01 archiver 自定义流 → 原生 Readable 包装（lib-storage 需 instanceof Readable）
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign } = require('docx'); // 2026-08-31 综测全程备案 Word 生成
const db = require('./db');
const r2 = require('./services/r2Client'); // 2026-09-01 Cloudflare R2 存储（未配置凭证时回退本地模式）

// ============================================================
// 进程级错误兜底：未捕获异常/拒绝会导致进程静默损坏，
// 此处记录原因后退出，交由 systemd（Restart=always）自动拉起。
// （请求级错误已在各路由 try/catch 内处理，此为最后防线）
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ============================================================
// 安全基础：helmet + Cookie 解析 + CORS（仅在已配置 origin 时启用）
// ============================================================
app.use(helmet({
  contentSecurityPolicy: false, // 关闭默认 CSP，前端为简单静态页，开发期间不卡 e2e
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // /uploads 需跨域
}));
app.use(cookieParser());

// CORS（仅当配置 ALLOWED_ORIGIN 时启用，用于跨域 cookie 场景）
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Cookie 安全选项（httpOnly 防 XSS 窃取）
const COOKIE_NAME = 'zc_token';
const SECURE_COOKIE = process.env.NODE_ENV === 'production'; // 本地 dev=false，部署后 =true
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: SECURE_COOKIE,
  maxAge: SESSION_TTL_MS,
  path: '/',
});

app.use(express.json({ limit: '5mb' }));
// 信任 1 层代理（Cloudflare Tunnel 的 cloudflared 是单层本地代理）：
// 开启后 req.ip 才会从 X-Forwarded-For / CF-Connecting-IP 取真实客户端 IP，
// 否则所有经隧道的请求都会被判为 127.0.0.1，导致全站共用一个限流计数。
app.set('trust proxy', 1);
// 全局 gzip（2026-08-31）：只压文本类（json/html/js/css），跳过图片/pdf/zip/office 等已压缩或大二进制
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    return /(json|javascript|text|html|xml)/i.test(ct) && !/(image|video|audio|pdf|zip|office|octet-stream)/i.test(ct);
  },
}));
// 静态资源缓存：版本化 js/css 强缓存 1 年（改版靠 ?v= 变化）；index.html 等 HTML no-cache（每次回源校验，部署后立即生效，2026-09-09h 改）
app.use('/js', express.static(path.join(__dirname, 'public/js'), { maxAge: '365d', etag: true }));
app.use('/css', express.static(path.join(__dirname, 'public/css'), { maxAge: '365d', etag: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h', etag: true,
  setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

// ---------- 文件上传 ----------
db.ensureUploads();
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, db.UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 修复 multer 在 filename 上不应用 defParamCharset 的已知问题（中文文件名乱码）
    // 规则：若 originalname 不含中文，则怀疑是 latin1 错解码，尝试 utf8 反解；
    //      反解后含中文且不含 \uFFFD 才采用，否则保留原值。
    if (!/[\u4e00-\u9fa5]/.test(file.originalname)) {
      try {
        const reDecoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
        if (!/\uFFFD/.test(reDecoded) && /[\u4e00-\u9fa5]/.test(reDecoded)) {
          file.originalname = reDecoded;
        }
      } catch (e) {}
    }
    const safe = file.originalname.replace(/[^\w.\u4e00-\u9fa5-]/g, '_');
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + safe);
  },
});
// 允许的扩展名白名单（分通道，2026-09-06 收紧）：
//  - 证明材料/附件通道（学生提交/补交/重写、复核材料）：仅图片(JPG/JPEG/PNG/WebP，不含 GIF) + PDF
//  - 管理通道（智育成绩导入/智育计算/榜单导出模板）：仅 .xlsx
const ALLOWED_EXTS_PROOF = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
const ALLOWED_EXTS_OFFICE = new Set(['.xlsx']);
// 2026-09-06 学生自填分值白名单：目录中"未定分值"(level.points=null)的项目，仅以下 code 允许学生自填 0~2；
// 其余未定分值项目由评定小组给定分值，学生不可自填（318=院级各类团体/434=专利/435=论文）
const SELF_FILL_CODES = new Set(['318', '434', '435']);
// 2026-09-09 教师评价基准分（业务拍板）：教师评价分采用"名单制"——
//   admin 只上传有特殊分值的学生名单（姓名/学号 + 分值），未在名单中的学生统一按本基准分计。
//   显式给 0 分的学生算 0（不会被兜底顶掉）。见 getTeacherScore 与 /api/admin/scores/import。
const TEACHER_BASE_SCORE = 1.5;
function makeFileFilter(allowed, errMsg) {
  return function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowed.has(ext)) {
      return cb(new MulterError(errMsg + '（当前文件类型：' + (ext || '未知') + '）'));
    }
    cb(null, true);
  };
}
// 2026-09-01 M6：附件内容 magic 校验——按扩展名核对文件头，拒绝改名伪装文件（如 .exe 改名 .pdf 上传）
// 宽松策略（避免误伤真实文件）：图片/PDF 严查文件头；Office 系列（老格式 OLE=D0CF11E0 / 新格式 zip=PK0304）两者皆可。
// 仅读取每文件前 16 字节，同步开销微秒级；webp 只验 RIFF 前缀（放宽，兼容 WPS 等变体）。
const MAGIC_RULES = {
  '.jpg':  [[0xFF, 0xD8, 0xFF]],
  '.jpeg': [[0xFF, 0xD8, 0xFF]],
  '.png':  [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  '.gif':  [[0x47, 0x49, 0x46, 0x38]],
  '.webp': [[0x52, 0x49, 0x46, 0x46]],
  '.pdf':  [[0x25, 0x50, 0x44, 0x46]],
  '.doc':  [[0xD0, 0xCF, 0x11, 0xE0], [0x50, 0x4B, 0x03, 0x04]],
  '.docx': [[0x50, 0x4B, 0x03, 0x04], [0xD0, 0xCF, 0x11, 0xE0]],
  '.xls':  [[0xD0, 0xCF, 0x11, 0xE0], [0x50, 0x4B, 0x03, 0x04]],
  '.xlsx': [[0x50, 0x4B, 0x03, 0x04], [0xD0, 0xCF, 0x11, 0xE0]],
  '.ppt':  [[0xD0, 0xCF, 0x11, 0xE0], [0x50, 0x4B, 0x03, 0x04]],
  '.pptx': [[0x50, 0x4B, 0x03, 0x04], [0xD0, 0xCF, 0x11, 0xE0]],
};
// 校验一批已落盘文件的内容头；返回错误文案或 null（全部通过）
function checkFileMagic(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const buf = Buffer.alloc(16);
  for (const f of files) {
    const ext = path.extname(f.originalname || '').toLowerCase();
    const rules = MAGIC_RULES[ext];
    if (!rules) continue; // 白名单外的扩展名已由 fileFilter 拦截，此处双保险
    if (!f.size) return `文件「${f.originalname}」内容为空，无法作为证明材料`;
    let fd = null;
    try {
      fd = fs.openSync(f.path, 'r');
      const n = fs.readSync(fd, buf, 0, 16, 0);
      const head = buf.subarray(0, n);
      const ok = rules.some(bytes => bytes.length <= head.length && bytes.every((b, i) => head[i] === b));
      if (!ok) return `文件「${f.originalname}」内容与扩展名（${ext}）不符，疑似伪装文件，请上传真实文件`;
    } catch (e) {
      return `文件「${f.originalname}」读取失败，请重新上传`;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  return null;
}
// 用于在拒绝时返回 400
class MulterError extends Error { constructor(msg) { super(msg); this.name = 'MulterError'; this.status = 400; } }
const upload = multer({
  storage,
  fileFilter: makeFileFilter(ALLOWED_EXTS_PROOF, '不支持的文件类型：仅支持 JPG/JPEG/PNG/WebP 图片或 PDF 文件（不支持 GIF）'),
  limits: { fileSize: 20 * 1024 * 1024, files: 30 },
  defParamCharset: 'utf8', // 关键：让 multer 用 UTF-8 解析包含中文的文件名（原默认 latin1 会导致中文文件名乱码）
});
// 2026-09-06 管理通道 multer（成绩导入 / 智育计算 / 榜单导出模板）：仅收 .xlsx，与证明材料上传通道隔离
const officeUpload = multer({
  storage,
  fileFilter: makeFileFilter(ALLOWED_EXTS_OFFICE, '仅支持 .xlsx 成绩/模板文件'),
  limits: { fileSize: 20 * 1024 * 1024, files: 30 },
  defParamCharset: 'utf8',
});
// 2026-09-01 H3：/uploads 静态路由已删除——原实现只查登录不查附件归属，任何登录用户可猜文件名直连他人附件。
// 前端展示/下载全走 /api/preview、/api/download（均经 assertAttachmentAccess 归属校验），删除后该越权口子封堵。

// 并发闸口（2026-08-31）：限制同一类资源型请求的并发数，超出排队，超时返回 503。
// 防止截止前多人同时上传/下载把 2 核小机器打满、拖垮全站。
// 槽位：上传 12 / 下载 15（用户拍板）；排队等待 60s（上传）/ 120s（下载）超时。
// 2026-09-06：闸门告警节流表（每 label 最多 1 条/分钟，防持续满员刷屏）
const _gateAlertAt = {};
function makeGate(limit, label, timeoutMs) {
  let active = 0;
  const waiters = [];
  let lastLog = 0;
  function release() {
    active = Math.max(0, active - 1);
    const w = waiters.shift();
    if (w) { active++; clearTimeout(w.timer); w.fn(); }
  }
  // 2026-09-06：闸门状态日志（满员/排长队/超时时输出，5s 节流防刷屏）——用于定位谁占着闸门
  function logState(why) {
    const now = Date.now();
    if (now - lastLog < 5000) return;
    lastLog = now;
    console.log(`[闸门:${label}] ${why} 活跃=${active} 排队=${waiters.length}`);
  }
  // 2026-09-06：满员/超时 → 企业微信运行告警（每 label 60s 节流）
  function maybeAlert(why) {
    const now = Date.now();
    if (now - (_gateAlertAt[label] || 0) < 60000) return;
    _gateAlertAt[label] = now;
    sendOpsAlert(`上传闸门告急（${label}）：${why}，活跃=${active} 排队=${waiters.length}`);
  }
  // 2026-09-06：每 60s 负载快照（有负载才输出，完全空闲时静默）
  const _snap = setInterval(() => {
    if (active > 0 || waiters.length > 0) {
      console.log(`[闸门:${label}] 负载快照 活跃=${active} 排队=${waiters.length}`);
    }
  }, 60000);
  if (_snap && typeof _snap.unref === 'function') _snap.unref();
  return function gate(req, res, next) {
    const run = () => {
      active++;
      res.once('finish', release);
      res.once('close', release);
      next();
    };
    if (active < limit) return run();
    logState('已满员');
    maybeAlert('队列已满');
    const timer = setTimeout(() => {
      logState('排队超时(返回503)');
      maybeAlert('排队超时(已返回503)');
      const i = waiters.findIndex(x => x.req === req);
      if (i >= 0) waiters.splice(i, 1);
      if (!res.headersSent) res.status(503).json({ error: `当前${label}繁忙（${label}队列已满），请稍后重试` });
    }, timeoutMs);
    waiters.push({ req, timer, fn: run });
  };
}
const uploadGate = makeGate(256, '上传', 60000); // 2026-09-07 上线日预防：12→48→128→200→256（9-6 晚实测峰值~120，白天全校提交预留余量）
const downloadGate = makeGate(15, '下载', 120000); // 2026-09-01 H2：30s→120s，覆盖 30 人同时下载时带宽受限的排队场景
// 2026-09-10 需求#6：并发闸门容量挂到函数属性上，供启动日志打印实际数值（复核/提交等上传类请求走 uploadGate=256，无需回退）
uploadGate.limit = 256;
downloadGate.limit = 15;

// 总文件大小限制 200MB/请求（防恶意大文件攻击；单文件 20MB × 30 = 理论 600MB 太宽）
// 取代所有 upload.array('files', 30)：除了 multer 自带的单文件 20MB / 30 个，还加一道总大小闸口
function uploadFiles(req, res, next) {
  uploadGate(req, res, () => {
    upload.array('files', 30)(req, res, (err) => {
      if (err) return next(err);
      const total = (req.files || []).reduce((s, f) => s + (f.size || 0), 0);
      if (total > 200 * 1024 * 1024) {
        const curMB = (total / 1024 / 1024).toFixed(2);
        for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch (_) {} }
        return res.status(400).json({ error: `文件总大小超过 200MB 上限，请分批上传（当前 ${curMB} MB）` });
      }
      // 2026-09-01 M6：magic 校验（内容与扩展名一致性）；失败清理已落盘文件并拒绝
      const magicErr = checkFileMagic(req.files);
      if (magicErr) {
        for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch (_) {} }
        return res.status(400).json({ error: magicErr });
      }
      // 2026-09-07：孤儿文件兜底清理 v2——修复 9-6 高峰 4699 孤儿/7.7GB 根因
      //  (v1 仅覆盖"正常返回的业务 400/5xx"；实测发现"客户端中断/挂起导致响应未完成"的请求
      //    statusCode 停在 200 不会被清，本次补强：close 且响应未完成 → 延迟 5s 确认文件未被
      //    任何申请引用后再清理，防误删已落库引用)
      let cleaned = false, finished = false;
      const isRef = (fn) => { // 该文件名是否已被任何申请引用（保守：查不到视为已引用）
        try {
          const s = db.load();
          const scan = (items) => (items || []).some(it => it && it.attachment && it.attachment.url && String(it.attachment.url).split('/').pop() === fn);
          return (s.applications || []).some(a => scan(a.certifiedItems) || scan(a.uncertifiedItems) || scan(a.certifiedProofs) || scan(a.uncertifiedProofs));
        } catch (_) { return true; }
      };
      const removeFiles = (label, list) => {
        let n = 0;
        for (const f of (list || req.files || [])) { try { fs.unlinkSync(f.path); n++; } catch (_) {} }
        if (n) console.log(`[上传清理] ${label} 清理落盘文件 ${n} 个`);
      };
      res.once('finish', () => { finished = true; if (res.statusCode >= 400) { removeFiles(`业务失败(status=${res.statusCode})`); cleaned = true; } });
      res.once('close', () => {
        if (cleaned) return;
        if (res.statusCode >= 400) { removeFiles(`业务失败(status=${res.statusCode})`); cleaned = true; return; }
        // 响应未正常完成（客户端中断/挂起/断连）：延迟 5s，确认未被引用才清
        if (!finished && !res.writableEnded) {
          const pending = (req.files || []).filter(f => !isRef(f.filename));
          if (pending.length) setTimeout(() => {
            if (cleaned) return;
            removeFiles('响应中断(未完成)', pending); cleaned = true;
          }, 5000);
        }
      });
      next();
    });
  });
}

// 学生提交截止校验 + 软截止（2026-08-31 重构）：
//   - 距截止 30 分钟内放行但返回 soft 提示（防最后时刻网络抖动丢提交）
//   - 超过：除非学生班级在 admin 配置的 submitOpenClasses 例外名单（延长期限），否则硬拒
// 返回 { blocked } 硬拒；{ soft } 软截止窗口；{ exception } 例外班级放行。
function checkDeadline(className) {
  const cfg = (db.load()).config || {};
  const now = Date.now();
  const softMs = 30 * 60 * 1000;
  const deadline = cfg.gradeDeadline ? new Date(cfg.gradeDeadline).getTime() : 0;
  if (!deadline || Number.isNaN(deadline)) return { blocked: false };
  const left = deadline - now;
  if (left < 0) {
    const open = (cfg.submitOpenClasses || []).map(String);
    if (className && open.includes(String(className))) {
      return { blocked: false, exception: true, message: '本班已获延长期限，可继续提交/修改' };
    }
    return { blocked: true, message: '已超过学生提交截止时间，无法提交' };
  }
  if (left <= softMs) {
    const mins = Math.max(1, Math.ceil(left / 60000));
    return { blocked: false, soft: true, message: `⚠️ 距离学生提交截止仅剩约 ${mins} 分钟，请尽快完成提交；提交成功后请勿重复提交` };
  }
  return { blocked: false };
}

// 解析 multipart 请求体中的 JSON payload；超大（>1MB）或非法 JSON 返回 null，防止恶意 payload 耗尽内存
function parsePayload(req) {
  const raw = req.body && req.body.payload;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw !== 'string' || raw.length > 1024 * 1024) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// ---------- 认证：内存 token + 持久化到 db.sessions（服务重启不丢失登录态） ----------
const tokens = new Map(); // token -> { userId, expiresAt }
function makeToken(userId) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return t;
}
function addSession(token, userId) {
  const d = db.load();
  d.sessions = d.sessions || [];
  const expiresAt = Date.now() + SESSION_TTL_MS;
  d.sessions.push({ token, userId, createdAt: db.now(), expiresAt });
  // 清理过期 session
  const nowTs = Date.now();
  const expiredTokens = d.sessions.filter(s => s.expiresAt && s.expiresAt < nowTs).map(s => s.token);
  d.sessions = d.sessions.filter(s => !(s.expiresAt && s.expiresAt < nowTs));
  expiredTokens.forEach(t => tokens.delete(t));
  // 清理同一用户超过 5 个的旧会话，防止 sessions 无限增长
  const userSess = d.sessions.filter(s => s.userId === userId);
  if (userSess.length > 5) {
    const remove = userSess.slice(0, userSess.length - 5);
    const removeSet = new Set(remove.map(s => s.token));
    d.sessions = d.sessions.filter(s => !removeSet.has(s.token));
    remove.forEach(s => tokens.delete(s.token));
  }
  db.save();
}
function removeSession(token) {
  tokens.delete(token);
  const d = db.load();
  if (d.sessions) {
    d.sessions = d.sessions.filter(s => s.token !== token);
    db.save();
  }
}
// 启动时从持久化会话恢复内存 Map（同时清理过期）
(function restoreSessions() {
  const d = db.load();
  const nowTs = Date.now();
  const alive = [];
  (d.sessions || []).forEach(s => {
    if (s.expiresAt && s.expiresAt < nowTs) return; // 过期丢弃
    alive.push(s);
    tokens.set(s.token, { userId: s.userId, expiresAt: s.expiresAt || (nowTs + SESSION_TTL_MS) });
  });
  if (alive.length !== (d.sessions || []).length) {
    d.sessions = alive;
    db.save();
  }
})();
// 从请求里提取 token：优先从 httpOnly Cookie，回退到 Authorization 头（兼容旧 API 调用）
function extractToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return { token: req.cookies[COOKIE_NAME], fromCookie: true };
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7), fromCookie: false };
  return { token: '', fromCookie: false };
}
function authRequired(req, res, next) {
  const { token } = extractToken(req);
  const sess = tokens.get(token);
  if (!sess) return res.status(401).json({ error: '未登录或登录已过期，请重新登录', code: 'session_expired' });
  if (sess.expiresAt && sess.expiresAt < Date.now()) {
    tokens.delete(token);
    removeSession(token);
    return res.status(401).json({ error: '登录已过期，请重新登录', code: 'session_expired' });
  }
  const user = db.getUserById(sess.userId);
  if (!user) return res.status(401).json({ error: '账号不存在', code: 'session_expired' });
  // 账号冻结（2026-08-30）：冻结后立即失效所有会话
  if (user.frozen) {
    tokens.delete(token);
    removeSession(token);
    return res.status(403).json({ error: '账号已冻结，请联系管理员' });
  }
  req.user = user;
  // 安全防护：附加 IP / UA / 会话标识（供审计日志与水印；优先取 x-forwarded-for 真实客户端 IP）
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  user._ip = xff || req.ip || (req.connection && req.connection.remoteAddress) || '';
  user._ua = (req.headers['user-agent'] || '').slice(0, 200);
  user._token = token.slice(0, 16); // 会话标识（审计用）
  // 自动续期：访问活跃用户滚动过期时间（每请求最多推后一次）
  sess.expiresAt = Date.now() + SESSION_TTL_MS;
  // 低频（≥10 分钟）把续期后的过期时间同步到 db.sessions，避免服务重启后活跃会话被按旧过期时间裁剪
  // 2026-09-01 M4：5 分钟→10 分钟降频，减少 sessions 全量落盘的写放大
  if (!sess._lastPersist || Date.now() - sess._lastPersist > 10 * 60 * 1000) {
    sess._lastPersist = Date.now();
    const d = db.load();
    const rec = (d.sessions || []).find(s => s.token === token);
    if (rec) {
      rec.expiresAt = sess.expiresAt;
      db.save();
    }
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无权执行此操作' });
    next();
  };
}
// 简化响应中的敏感字段
// safeUser：脱敏返回（不含 password/PII）。性能优化（2026-08-30）：接收已加载的 d，避免每用户重复 db.load()
function safeUser(u, d) {
  d = d || db.load();
  const cm = (d.classMajors || {})[u.className] || '';
  return { id: u.id, username: u.username, name: u.name, role: u.role, className: u.className, studentId: u.studentId, major: cm || u.major || '', mustChangePassword: !!u.mustChangePassword, frozen: !!u.frozen };
}

// ============================================================
// 通用工具（2026-09-09 自 /api/monitor/stats 与 /api/grade/stats 提取为顶层单例）
// ============================================================
// 按 studentId 去重，每生仅取 createdAt 最新一份作为代表（返回 Map<studentId, 最新 application>）。
// 用于「活+退」场景：学生已通过新表 + 已作废旧表（withdrawn）时，统计只认最新份，
// 避免旧 withdrawn 段把学生误计入「已退回/退回 X 项」桶误导班长/年级。
// 防御防双活守卫（6baeec19 起在生产）的双保险——正常场景每生至多 1 份，去重兜底。
const _dedupeByStudentLatest = (apps) => {
  const latest = new Map();
  for (const a of apps) {
    const cur = latest.get(a.studentId);
    if (!cur || String(a.createdAt) > String(cur.createdAt)) latest.set(a.studentId, a);
  }
  return latest;
};

// ============================================================
// 年级负责人分配（班级→专业映射页配置的审核权限）
// 结构：db.classGradeAssignments = { "<班名>": { uncertified:["userId",...], round1:[...], round2:[...], round3:[...] } }
// 每类负责人可设多人（数组）；空数组 / 缺省 → 仅 admin 可审核（兜底）
// ============================================================
// 2026-09-05 新增 certModify（已认定修改负责人）：仅负责「已认定段」追改（受班级审批截止闸门），与未认定段（uncertified 桶）分开授权
const GRADE_ASSIGN_TYPES = ['uncertified', 'round1', 'round2', 'round3', 'certModify'];
// 规范化负责人字段：'' / null / undefined → []；单值字符串 → [str]；数组 → 过滤空值（兼容旧单值数据）
function asgArr(v) {
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
  if (v === '' || v == null) return [];
  return [String(v)];
}
function assignmentForClass(className) {
  const d = db.load();
  const a = (d.classGradeAssignments && d.classGradeAssignments[className]) || {};
  return {
    uncertified: asgArr(a.uncertified),
    round1: asgArr(a.round1),
    round2: asgArr(a.round2),
    round3: asgArr(a.round3),
    certModify: asgArr(a.certModify),
  };
}
// grade 被允许审核某 type 的班级集合；admin 返回 null（不过滤）；其它角色返回空集
// 每类负责人可设多人：只要 userId 在数组中即放行
function allowedClassesForGrade(user, type) {
  if (user.role === 'admin') return null;
  if (user.role !== 'grade') return new Set();
  const d = db.load();
  const set = new Set();
  const all = d.classGradeAssignments || {};
  for (const cls of Object.keys(all)) {
    const a = all[cls];
    if (a && asgArr(a[type]).includes(String(user.id))) set.add(cls);
  }
  return set;
}
// 复核榜次与负责人配置 key 的映射：r.round 存 first/second/third；负责人配置（classGradeAssignments）存 round1/round2/round3
// 2026-08-20 冒烟发现：原代码用 'round' + r.round 拼出 roundfirst，与配置 key 不匹配 → 非 admin 的 grade 复核审核/列表全链路失效
const ROUND_TO_KEY = { first: 'round1', second: 'round2', third: 'round3' };
const KEY_TO_ROUND = { 1: 'first', 2: 'second', 3: 'third' };
// grade 被允许审核的 (班级, round) 全集（用于复核列表过滤）；admin 返回 null，其它角色返回 []
function allowedReviewScopes(user) {
  if (user.role === 'admin') return null;
  if (user.role !== 'grade') return [];
  const d = db.load();
  const scopes = [];
  const all = d.classGradeAssignments || {};
  for (const cls of Object.keys(all)) {
    const a = all[cls];
    if (!a) continue;
    for (const r of [1, 2, 3]) {
      if (asgArr(a['round' + r]).includes(String(user.id))) scopes.push({ className: cls, round: KEY_TO_ROUND[r] });
    }
  }
  return scopes;
}
// 审核动作权限判定：grade 只要是指定班级指定 type 的负责人之一即放行，否则 403；admin 直接放行；其它角色 403
function assertGradeCanReview(req, res, className, type) {
  const u = req.user;
  if (u.role === 'admin') return true;
  if (u.role !== 'grade') { res.status(403).json({ error: '无权执行此操作' }); return false; }
  const a = assignmentForClass(className);
  if (!asgArr(a[type]).includes(String(u.id))) {
    const label = type === 'uncertified' ? '未认定项目' : type === 'certModify' ? '已认定修改' : (type.replace('round', '') + '榜复核');
    res.status(403).json({ error: '无权限：班级【' + className + '】的「' + label + '」负责人不是您，仅负责人或管理员可操作' });
    return false;
  }
  return true;
}
// 列表过滤：grade 仅返回其被分配班级的列表；admin/monitor 不受影响（monitor 已由本路由另行过滤）
function scopeListForGrade(list, user, type, getClassName) {
  if (user.role !== 'grade') return list;
  const allowed = allowedClassesForGrade(user, type);
  if (!allowed) return list; // admin 路径（不会走到这里，因 role 已判）
  return list.filter(x => allowed.has(getClassName(x)));
}

// 严格分班（2026-08-30 权限修复）：grade 只能管理被分配（默认 uncertified 维度；2026-09-05 支持 certModify 维度）的班级；monitor/admin 放行（各自另有校验）
function assertGradeManagesClass(req, res, className, type) {
  if (req.user.role !== 'grade') return true;
  const allowed = allowedClassesForGrade(req.user, type || 'uncertified');
  if (allowed && allowed.has(String(className))) return true;
  const dimLabel = type === 'certModify' ? '已认定修改负责人' : '未认定负责人';
  res.status(403).json({ error: `无权限：班级【${className}】不在您的${dimLabel}管理范围内` });
  return false;
}

// ============================================================
// 已认定修改（grade-modify 的已认定段）专用判定（2026-09-05）
// ============================================================
// 班级审批截止闸门：已过 monitorReviewDeadline 且非 reviewOpenClasses 延期班 → true（此时年级不可改已认定段，仅 admin）
function certSectionLocked(className, d) {
  d = d || db.load();
  const cfg0 = (d.config) || {};
  const mr = cfg0.monitorReviewDeadline ? new Date(cfg0.monitorReviewDeadline).getTime() : 0;
  if (!mr || Number.isNaN(mr)) return false; // 未设截止 = 不锁定
  if (Date.now() <= mr) return false;
  const open = (cfg0.reviewOpenClasses || []).map(String);
  return !open.includes(String(className));
}
// 年级可见班级 = 未认定审核桶 ∪ 已认定修改桶（并集）；admin 返回 null（不过滤）；其它角色返回空集
function unionClassesForGrade(user) {
  if (user.role === 'admin') return null;
  if (user.role !== 'grade') return new Set();
  const a = allowedClassesForGrade(user, 'uncertified') || new Set();
  const b = allowedClassesForGrade(user, 'certModify') || new Set();
  return new Set([...a, ...b]);
}
// 当前用户对某申请的逐段修改权限（供列表 / 详情 / 前端显隐）：
//   cert  = 可改已认定段（admin 恒 true；grade 需为该班 certModify 桶且未过闸门）
//   uncert = 可改未认定段（admin 恒 true；grade 需为该班 uncertified 桶，无时间闸门）
//   gate  = 已认定段是否已被班级审批截止锁定（仅提示用；锁定且非负责人时 cert=false）
function myModifyFlags(user, a) {
  const d = db.load();
  if (user.role === 'admin') return { cert: true, uncert: true, gate: false };
  if (user.role !== 'grade') return { cert: false, uncert: false, gate: false };
  const cls = String((a && a.className) || '');
  const cOwn = !!allowedClassesForGrade(user, 'certModify').has(cls);
  const uOwn = !!allowedClassesForGrade(user, 'uncertified').has(cls);
  const gate = certSectionLocked(cls, d);
  return { cert: cOwn && !gate, uncert: uOwn, gate };
}
// 密码强度（2026-09-05）：≥8 位且不能为纯数字
function isStrongPwd(p) {
  p = String(p == null ? '' : p);
  return p.length >= 8 && !/^\d+$/.test(p);
}
const WEAK_PWD_MSG = '密码至少 8 位且不能为纯数字';
// 二级密码是否需要强制修改（2026-09-05 扩展 grade）：grade 依据 mustChangeSecondary 标志或「从未设置二级密码」；admin 兼容旧「默认 默认二级密码」判定
async function needsSecondaryChange(u) {
  if (u.role !== 'admin' && u.role !== 'grade') return false;
  if (u.mustChangeSecondary) return true;
  // 2026-09-05 修复：存量年级账号（改过登录密码但从未设置二级密码）→ 登录后强制设置，
  // 否则其敏感操作（改已认定/未认定等）会被「尚未设置二级审核密码」403 拦死且无引导入口
  if (u.role === 'grade' && !u.secondaryPassword) return true;
  if (u.role === 'admin' && u.secondaryPassword && await db.verifyPassword(DEFAULT_SECONDARY_PASSWORD, u.secondaryPassword)) return true;
  return false;
}

// 附件访问归属校验（2026-08-30 P1 修复）：url 必须属于当前用户可访问的申请/复核，否则 403
// 学生只能访问自己的；班长只能访问本班；年级按职责；admin 全可见；找不到归属拒绝
function assertAttachmentAccess(req, res, url) {
  const d = db.load();
  const u = req.user;
  const hits = [];
  for (const a of d.applications) {
    const urls = [];
    (a.certifiedItems || []).forEach(it => { if (it.attachment && it.attachment.url) urls.push(it.attachment.url); });
    (a.uncertifiedItems || []).forEach(it => { if (it.attachment && it.attachment.url) urls.push(it.attachment.url); });
    (a.certifiedProofs || []).forEach(p => { if (p.attachment && p.attachment.url) urls.push(p.attachment.url); });
    (a.uncertifiedProofs || []).forEach(p => { if (p.attachment && p.attachment.url) urls.push(p.attachment.url); });
    if (urls.includes(url)) hits.push({ kind: 'application', target: a });
  }
  for (const r of d.reviews) {
    const urls = [];
    (r.items || []).forEach(it => {
      if (it.proof && it.proof.url) urls.push(it.proof.url);
      if (it.reviewProof && it.reviewProof.url) urls.push(it.reviewProof.url);
      if (it.rejectProof && it.rejectProof.url) urls.push(it.rejectProof.url);
    });
    if (urls.includes(url)) hits.push({ kind: 'review', target: r });
  }
  if (!hits.length) { res.status(403).json({ error: '无权访问该文件' }); return false; }
  for (const h of hits) {
    const t = h.target;
    if (u.role === 'admin') return true;
    if (u.role === 'student' && t.studentId === u.id) return true;
    if (u.role === 'monitor' && t.className === u.className) return true;
    if (u.role === 'grade') {
      // 2026-09-07：综测申请(application)附件与「申请详情」接口口径一致——grade 可查看申请材料
      // （详情 GET /api/applications/:id 已对 grade 放行全览；此前附件硬编码走 uncertified 桶，
      //  而生产 9-6 起各班只配 certModify 桶 → grade 看得到项目却打不开附件 403）。
      // 复核材料(review)附件仍按 round1/2/3 桶校验（收紧不变）。
      if (h.kind === 'application') return true;
      const type = ROUND_TO_KEY[t.round] || ('round' + t.round);
      const allowed = allowedClassesForGrade(u, type);
      if (allowed && allowed.has(String(t.className))) return true;
    }
  }
  res.status(403).json({ error: '无权访问该文件' });
  return false;
}

// ============================================================
// 认证接口
// ============================================================
// 登录接口限流（防爆破）：
//  - 计数维度：真实客户端 IP（Cloudflare 隧道优先读 CF-Connecting-IP，回退 req.ip）
//  - 仅对"密码错误"计数：参数缺失(400)不计入；成功登录(200)不计入（skipSuccessfulRequests）
//  - 阈值：单 IP 5 分钟内密码错误超过 15 次触发 429，重置窗口 5 分钟
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: (req) => !req.body || !req.body.username || !req.body.password,
  keyGenerator: (req) => {
    // 真实客户端 IP：Cloudflare 隧道优先读 CF-Connecting-IP；否则回退连接套接字 IP
    const cf = (req.headers['cf-connecting-ip'] || '').toString().trim();
    if (cf) return 'cf:' + cf;
    // 直连时聚合 IPv6 到 /56（与 express-rate-limit 默认一致），避免单用户用大量地址绕过
    let ip = req['ip'] || '0.0.0.0';
    if (ip.includes(':')) {
      const parts = ip.replace(/%.*$/, '').split(':');
      ip = parts.slice(0, 4).join(':') + '::/56';
    }
    return 'ip:' + ip;
  },
  message: { error: '尝试次数过多，请 5 分钟后再试' },
});

// ===== 全局 ID 校验中间件（2026-08-31）=====
// 拦截 /api 下路径最后一段为无效 id（'undefined'/'null'/空串）的请求。
// 背景：前端数据缺 id 时会把字面量 undefined/null 注入 URL，导致资源路由
// （如 PUT /api/admin/cert-catalog/:id）静默退化为"新增/新建"语义（已认定目录编辑变新增事故）。
// 注意：Express app.use 挂载路径是"前缀匹配"且参数在 use 阶段填充的是挂载段，
// 无法可靠取到各路由真正 :id 位置的参数；而本系统所有 :id 路由的 id 均在 URL 最后一段，
// 因此直接校验最后一段，简单可靠。正常资源名/文件名不可能是这三个字面量，无误伤。
app.use('/api', (req, res, next) => {
  const segs = String(req.path).split('/').filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : '';
  if (!last || last === 'undefined' || last === 'null') {
    return res.status(400).json({ code: 400, message: '无效的资源 ID，请刷新后重试' });
  }
  next();
});

// ============================================================
// 2026-09-01 M1：敏感/高成本接口按登录账号限流
//  - 计数维度：req.user.id（登录账号）——校园网全校共享少数出口 IP，若按 IP 限流会一人触发全员连坐
//  - 未登录回退 req.ip（正常情况下这些接口都在 authRequired 之后，拿不到 user 的仅兜底）
//  - 阈值：同一账号 1 分钟 20 次（宽松，正常操作远达不到；挡住刷导出/批量删除/爆破二级密码/刷改密）
//  - skipSuccessfulRequests:false：敏感操作成功也计数，防止用高频成功请求反复触发导出任务
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => (req.user && req.user.id ? 'u:' + req.user.id : req.ip),
  handler: (req, res) => res.status(429).json({ error: '操作过于频繁，请 1 分钟后再试' }),
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
  req._auditStart = Date.now();
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = db.getUserByUsername(username);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || req.ip || '';
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const pwdOk = user ? await db.verifyPassword(password, user.password) : false; // 2026-09-01 H1 异步 scrypt
  if (!user || !pwdOk) {
    db.audit({
      actor: { userId: username || '', userName: '', role: '', ip, userAgent: ua, sessionId: '' },
      action: 'login_failure', target: { type: '登录' }, result: 'failure', detail: { error: '账号或密码错误' }, highRisk: 0,
    });
    return res.status(401).json({ error: '账号或密码错误' });
  }
  // 账号冻结（2026-08-30）：冻结期间禁止登录
  if (user.frozen) {
    db.audit({
      actor: { userId: user.username || '', userName: user.name || '', role: user.role, ip, userAgent: ua, sessionId: '' },
      action: 'login_failure', target: { type: '登录' }, result: 'failure', detail: { error: '账号已冻结' }, highRisk: 0,
    });
    return res.status(401).json({ error: '账号已冻结，请联系管理员' });
  }
  const token = makeToken(user.id);
  addSession(token, user.id);
  // 设置 httpOnly Cookie（前端不可读取，防 XSS 盗取）
  res.cookie(COOKIE_NAME, token, cookieOpts());
  // 登录日志带来源 IP/UA（安全增强 2026-08-30）
  addLog(user, 'login', '登录系统', { type: 'login', ip, ua: ua.slice(0, 120) });
  db.audit({
    actor: { userId: user.studentId || user.username || '', userName: user.name || '', role: user.role || '', ip, userAgent: ua, sessionId: token.slice(0, 16) },
    action: 'login_success', target: { type: '登录' }, result: 'success', highRisk: 0,
  });
  // 响应中仍返回 token 字段（兼容 Bearer 调用），但推荐使用 Cookie
  const mustChangeSecondary = await needsSecondaryChange(user);
  res.json({ token, user: { ...safeUser(user), mustChangePassword: !!user.mustChangePassword, mustChangeSecondary } });
  } catch (e) {
    console.error('[login] 异常:', e);
    if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
  }
});

app.post('/api/logout', authRequired, (req, res) => {
  const { token, fromCookie } = extractToken(req);
  removeSession(token);
  if (fromCookie) res.clearCookie(COOKIE_NAME, { path: '/' });
  logAudit(req, 'logout', { type: '退出登录' }, {}, 'success');
  res.json({ ok: true });
});

app.get('/api/me', authRequired, async (req, res) => {
  try {
    const mustChangeSecondary = await needsSecondaryChange(req.user);
    res.json({ user: { ...safeUser(req.user), mustChangePassword: !!req.user.mustChangePassword, mustChangeSecondary } });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
  }
});


// ============================================================
// 学生端 API
// ============================================================



// 我的通知（学生 / 班长 均可查看自己收到的通知）
app.get('/api/my/notifications', authRequired, requireRole('student', 'monitor'), (req, res) => {
  const d = db.load();
  const list = d.notifications.filter(n => n.studentId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ notifications: list });
});

// 标记通知已读（学生 / 班长）
app.post('/api/my/notifications/:id/read', authRequired, requireRole('student', 'monitor'), (req, res) => {
  const d = db.load();
  const n = d.notifications.find(x => x.id === req.params.id && x.studentId === req.user.id);
  if (n) { n.read = true; db.save(); }
  res.json({ ok: true });
});

// 公示列表（学生可见）
app.get('/api/announcements', authRequired, (req, res) => {
  const d = db.load();
  res.json({ announcements: d.announcements.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

// 公示详情：公示期内所有已通过材料
app.get('/api/announcements/:id', authRequired, (req, res) => {
  const d = db.load();
  const a = d.announcements.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '公示不存在' });
  const items = d.submissions.filter(s => s.status === 'approved').map(s => ({
    id: s.id, studentName: s.studentName, className: s.className, type: s.type,
    title: s.title, points: s.points, description: s.description,
    objection: s.objection ? { status: s.objection.status, content: s.objection.content } : null,
  }));
  res.json({ announcement: a, items });
});

// 学生对公示材料提出异议
app.post('/api/announcements/:id/objections', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const a = d.announcements.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '公示不存在' });
  if (a.status !== 'active') return res.status(400).json({ error: '该公示已结束，无法提出异议' });
  const { submissionId, reason } = req.body;
  const s = d.submissions.find(x => x.id === submissionId && x.status === 'approved');
  if (!s) return res.status(400).json({ error: '目标材料不存在或未通过审核' });
  if (s.objection) return res.status(400).json({ error: '该材料已有待处理异议' });
  if (!reason || reason.trim().length < 5) return res.status(400).json({ error: '请填写具体异议理由（至少5个字）' });
  s.objection = {
    id: db.genId('obj'), content: reason.trim(),
    status: 'pending', reply: null, replyBy: null, replyTime: null,
    raisedBy: req.user.name, raisedById: req.user.id, raisedAt: db.now(),
  };
  s.updatedAt = db.now();
  db.save();
  res.json({ ok: true, objection: s.objection });
});

// ============================================================
// 班长端 API（审核本班"已认定"材料）
// ============================================================



// 班长/年级：向学生发送补交/通知
app.post('/api/students/:id/notify', authRequired, requireRole('monitor', 'grade'), (req, res) => {
  const d = db.load();
  const stu = d.users.find(u => u.id === req.params.id && u.role === 'student');
  if (!stu) return res.status(404).json({ error: '学生不存在' });
  if (req.user.role === 'monitor' && stu.className !== req.user.className) return res.status(403).json({ error: '只能通知本班学生' });
  const { content, submissionId } = req.body;
  if (!content || content.trim().length < 3) return res.status(400).json({ error: '请填写通知内容' });
  d.notifications.push({
    id: db.genId('n'), studentId: stu.id, submissionId: submissionId || null,
    content: content.trim(), fromRole: req.user.role, fromName: req.user.name,
    type: 'notice', read: false, createdAt: db.now(),
  });
  db.save();
  res.json({ ok: true });
});

// 催办：年级/管理员/班长 对本班未提交学生发起催办
// - 始终向未提交学生发送通知
// - 年级/管理员发起时，额外通知本班班长（便于班长督促），班长发起时不再通知自己
app.post('/api/urge/class', authRequired, requireRole('grade', 'admin', 'monitor'), (req, res) => {
  const d = db.load();
  const className = req.user.role === 'monitor' ? req.user.className : (req.body.className || req.user.className);
  if (req.user.role === 'monitor' && className !== req.user.className) return res.status(403).json({ error: '只能催办本班' });
  const students = db.getClassStudents(className);
  const apps = d.applications.filter(a => a.className === className);
  const submittedIds = new Set(apps.map(a => a.studentId));
  const notSubmitted = students.filter(s => !submittedIds.has(s.id));
  const now = db.now();
  let sent = 0;
  notSubmitted.forEach(s => {
    d.notifications.push({
      id: db.genId('n'), studentId: s.id, submissionId: null,
      content: '【催办通知】请尽快登录系统提交综测申请材料，以免影响综测认定进度。',
      fromRole: req.user.role, fromName: req.user.name, type: 'urge', read: false, createdAt: now,
    });
    sent++;
  });
  // 年级/管理员发起时，同步提醒本班班长
  let monitorNotified = false;
  if (req.user.role !== 'monitor') {
    const mon = d.users.find(u => u.role === 'monitor' && u.className === className);
    if (mon) {
      d.notifications.push({
        id: db.genId('n'), studentId: mon.id, submissionId: null,
        content: `【催办提醒】${req.user.role === 'admin' ? '管理员' : '年级'}已对「${className}」发起催办，当前有 ${sent} 名学生未提交综测申请，请督促本班同学尽快完成。`,
        fromRole: req.user.role, fromName: req.user.name, type: 'urge', read: false, createdAt: now,
      });
      monitorNotified = true;
    }
  }
  db.save();
  res.json({ ok: true, urged: sent, monitorNotified });
});

// 班长：班级学生列表
app.get('/api/monitor/students', authRequired, requireRole('monitor'), (req, res) => {
  const list = db.getClassStudents(req.user.className).map(safeUser);
  res.json({ students: list });
});

// 班级统计（数据源：applications 表，与「本班综测申请总览」完全一致）
// - 提交条数 = 该生「最新一份」application 数（dedupe 后恒为 1）
// - 通过分值 = 该生最新一份的 certifiedItems 中 status=approved/overridden 的项之 pointsFinal 总和
// - byStatus = 把「每生最新一份」整张 application 按"两段级状态取最差"折叠成单状态后计数
// - 已提交人数 = 提交过 application 的去重学生数
// - 班级总分 = 所有学生（每生最新一份）approved 项 pointsFinal 总和
app.get('/api/monitor/stats', authRequired, requireRole('monitor'), (req, res) => {
  const d = db.load();
  const apps = d.applications.filter(a => a.className === req.user.className);
  const stu = db.getClassStudents(req.user.className);

  // 2026-09-08 修复（班级总览）+ 2026-09-09 提取：按 studentId 去重由顶层 _dedupeByStudentLatest(apps) 承担
  //   （每生仅取 createdAt 最新一份为代表，防「活+退」旧 withdrawn 份误计入退回桶误导班长）
  // 段级 state 优先级：rejected > withdrawn > resubmit > pending > approved（取两段任一最差）
  const eff = (a) => {
    if (a.certifiedStatus === 'rejected' || a.uncertifiedStatus === 'rejected') return 'rejected';
    if (a.certifiedStatus === 'withdrawn' || a.uncertifiedStatus === 'withdrawn') return 'withdrawn';
    if (a.certifiedStatus === 'resubmit' || a.uncertifiedStatus === 'resubmit') return 'resubmit';
    if (a.certifiedStatus === 'pending' || a.uncertifiedStatus === 'pending') return 'pending';
    return 'approved';
  };
  // pointsFinal 在 db.js fix() 中保证 approved/overridden 时 = Number(points)
  const approvedPtsOf = (a) => (a.certifiedItems || [])
    .filter(it => it.status === 'approved' || it.status === 'overridden')
    .reduce((sum, it) => sum + (Number(it.pointsFinal) || 0), 0);

  const appsLatest = _dedupeByStudentLatest(apps);
  const byStatus = {};
  let totalPoints = 0;
  for (const a of appsLatest.values()) {
    const s = eff(a);
    byStatus[s] = (byStatus[s] || 0) + 1;
    totalPoints += approvedPtsOf(a);
  }

  const submittedIds = new Set(apps.map(a => a.studentId));
  res.json({
    className: req.user.className,
    studentCount: stu.length,
    submittedCount: submittedIds.size,
    totalPoints: Number(totalPoints.toFixed(4)),
    byStatus,
    students: stu.map(u => {
      const a = appsLatest.get(u.id);   // 取该生最新一份为代表（无则 undefined）
      let status = 'none', submissionCount = 0, approvedPoints = 0;
      if (a) {
        status = eff(a);
        submissionCount = 1;
        approvedPoints = Number(approvedPtsOf(a).toFixed(4));
      }
      return { ...safeUser(u), submissionCount, approvedPoints, status };
    }),
  });
});

// ============================================================
// 年级端 API
// ============================================================

// 异议列表
app.get('/api/objections', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  let list = d.submissions.filter(s => s.objection).map(s => ({
    submission: { id: s.id, title: s.title, studentName: s.studentName, className: s.className, points: s.points, type: s.type },
    objection: s.objection,
  })).sort((a, b) => String(a.objection.status).localeCompare(String(b.objection.status)));
  if (req.user.role === 'grade') list = scopeListForGrade(list, req.user, 'uncertified', x => x.submission.className);
  res.json({ objections: list });
});

// 处理异议：同意（材料回到待处理）或驳回
app.post('/api/objections/:oid/handle', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const s = d.submissions.find(x => x.objection && x.objection.id === req.params.oid);
  if (!s) return res.status(404).json({ error: '异议不存在' });
  if (s.objection.status !== 'pending') return res.status(400).json({ error: '该异议已处理' });
  if (!assertGradeCanReview(req, res, s.className, 'uncertified')) return;
  const { agree, reply } = req.body;
  if (!reply || reply.trim().length < 3) return res.status(400).json({ error: '请填写处理意见' });
  s.objection.status = 'resolved';
  s.objection.reply = reply.trim();
  s.objection.replyBy = req.user.name;
  s.objection.replyTime = db.now();
  if (agree) {
    // 异议成立：材料回到待审核，通知学生修改
    s.status = 'pending';
    s.currentAuditor = s.category === 'certified' ? 'monitor' : 'grade';
    s.updatedAt = db.now();
    s.auditLog.push({ byRole: 'grade', byName: req.user.name, action: 'objection-agree', comment: `异议成立，材料退回重新审核：${reply.trim()}`, time: db.now() });
    d.notifications.push({
      id: db.genId('n'), studentId: s.studentId, submissionId: s.id,
      content: `您对「${s.title}」的异议经核实成立，材料已退回待审核，如有需要请修改后重新提交。处理意见：${reply.trim()}`,
      fromRole: 'grade', fromName: req.user.name, type: 'notice', read: false, createdAt: db.now(),
    });
  } else {
    s.auditLog.push({ byRole: 'grade', byName: req.user.name, action: 'objection-reject', comment: `异议不成立：${reply.trim()}`, time: db.now() });
    d.notifications.push({
      id: db.genId('n'), studentId: s.studentId, submissionId: s.id,
      content: `您对「${s.title}」的异议经核实不成立，维持原审核结果。处理意见：${reply.trim()}`,
      fromRole: 'grade', fromName: req.user.name, type: 'notice', read: false, createdAt: db.now(),
    });
  }
  db.save();
  res.json({ ok: true });
});

// 发起公示
app.post('/api/announcements', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const { title, content, days } = req.body;
  if (!title) return res.status(400).json({ error: '请填写公示标题' });
  const daysNum = Math.min(30, Math.max(1, parseInt(days) || 7));
  const a = {
    id: db.genId('a'), title, content: content || '',
    startAt: db.now(), endAt: new Date(Date.now() + daysNum * 86400000).toISOString(),
    status: 'active', createdBy: req.user.name, createdAt: db.now(),
  };
  d.announcements.push(a);
  db.save();
  res.json({ ok: true, announcement: a });
});

// 结束公示
app.post('/api/announcements/:id/end', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.announcements.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '公示不存在' });
  a.status = 'ended';
  a.endedAt = db.now();
  db.save();
  res.json({ ok: true });
});

// 年级统计看板（基于 applications 表）
app.get('/api/grade/stats', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  let apps = d.applications;
  let stu = d.users.filter(u => u.role === 'student');
  // 年级账号仅统计其被分配（未认定/复核任一）的班级，避免越权查看全校数据
  if (req.user.role === 'grade') {
    const scopes = allowedReviewScopes(req.user) || [];
    const uc = allowedClassesForGrade(req.user, 'uncertified');
    const allowed = new Set([...scopes.map(s => s.className), ...(uc ? [...uc] : [])]);
    if (allowed.size) {
      apps = apps.filter(a => allowed.has(a.className));
      stu = stu.filter(u => allowed.has(u.className));
    }
  }
  const eff = (a) => {
    if (a.certifiedStatus === 'rejected' || a.uncertifiedStatus === 'rejected') return 'rejected';
    if (a.certifiedStatus === 'withdrawn' || a.uncertifiedStatus === 'withdrawn') return 'withdrawn';
    if (a.certifiedStatus === 'resubmit' || a.uncertifiedStatus === 'resubmit') return 'resubmit';
    if (a.certifiedStatus === 'pending' || a.uncertifiedStatus === 'pending') return 'pending';
    return 'approved';
  };
  // 2026-09-08 修复（统计看板）+ 2026-09-09 提取：按 studentId 去重由顶层 _dedupeByStudentLatest(apps) 承担
  const byStatus = { pending: 0, approved: 0, rejected: 0, resubmit: 0, withdrawn: 0 };
  for (const a of _dedupeByStudentLatest(apps).values()) { const s = eff(a); byStatus[s] = (byStatus[s] || 0) + 1; }
    const byClass = {};
  const classes = [...new Set(stu.map(u => u.className))];
  classes.forEach(c => {
    const cstu = stu.filter(u => u.className === c);
    const capps = apps.filter(a => a.className === c);
    const submittedIds = new Set(capps.map(a => a.studentId));
    const apprPts = capps.reduce((sum, a) => sum + (a.certifiedItems || [])
      .filter(it => it.status === 'approved' || it.status === 'overridden')
      .reduce((s, it) => s + (Number(it.pointsFinal) || 0), 0), 0);
    const cByStatus = { pending: 0, approved: 0, rejected: 0, resubmit: 0, withdrawn: 0 };
    for (const a of _dedupeByStudentLatest(capps).values()) { const s = eff(a); cByStatus[s] = (cByStatus[s] || 0) + 1; }
    byClass[c] = {
      studentCount: cstu.length, submittedCount: submittedIds.size,
      submitRate: cstu.length ? (submittedIds.size / cstu.length * 100).toFixed(1) : 0,
      approvedCount: capps.filter(a => eff(a) === 'approved').length,
      approvedPoints: Number(apprPts.toFixed(4)),
      byStatus: cByStatus,
    };
  });
  const submittedSet = new Set(apps.map(a => a.studentId));
  res.json({
    totalStudents: stu.length,
    // 2026-09-08 修复：totalSubmissions 改为「每生代表份数」，与 byStatus 之和一致（材料状态分布的分母）
    totalSubmissions: _dedupeByStudentLatest(apps).size,
    totalApplications: apps.length, // 保留原始份数（用于备份/审计场景）
    submittedCount: submittedSet.size,
    byStatus, byClass, pendingObjections: 0,
  });
});

// 班级名自然排序：临床医学（纯）各班 1-18 → 临床医学(5加3一体化) 各班 → 其余专业按中文
// 同专业内按班号数字（临床医学1班 < 临床医学2班 < … < 临床医学18班）
function cmpClassName(a, b) {
  const pa = String(a).replace(/\d+班$/, '');
  const pb = String(b).replace(/\d+班$/, '');
  if (pa === pb) {
    const ma = String(a).match(/(\d+)班$/);
    const mb = String(b).match(/(\d+)班$/);
    if (ma && mb) return Number(ma[1]) - Number(mb[1]);
    return String(a).localeCompare(String(b), 'zh-CN');
  }
  const pri = (p) => {
    if (p === '临床医学') return 0;
    if (p.includes('临床医学')) return 1; // 临床医学(5加3一体化) 等
    return 2;
  };
  const pi = pri(pa), pj = pri(pb);
  if (pi !== pj) return pi - pj;
  return pa.localeCompare(pb, 'zh-CN');
}

// ============================================================
// 导出：德育分项详细数据（年级端）
// 列：班级、学号、10 类目（基准分 + 加分，封顶到该类上限）、德育总分、加减分说明
// 数据源（已认定 + 未认定通过审核）：
//   加分按 classify* 归入 10 类目求和 → rawAdd
//   列值 = min(基准分 + rawAdd, 该类上限)；基准分+rawAdd > 上限 时按上限计（封顶）
// 加减分说明：按 "类别：项目+分值；..." 分组合并；同类别只写一次类别名；被改判项红字
//   某类 基准分+rawAdd > 上限 时追加 "XX项x分已达该项加分上限，实际加分为y分"（x=rawAdd，y=上限）
// ============================================================
const GRADE_STAT_HEADERS = [
  { key: 'className', label: '班级', width: 14 },
  { key: 'studentId', label: '学号', width: 16 },
  { key: '政治思想', label: '政治思想', width: 10 },
  { key: '道德修养', label: '道德修养', width: 10 },
  { key: '遵纪守法', label: '遵纪守法', width: 10 },
  { key: '诚实守信', label: '诚实守信', width: 10 },
  { key: '学习态度', label: '学习态度', width: 10 },
  { key: '文明卫生', label: '文明卫生', width: 10 },
  { key: '社会服务', label: '社会服务', width: 10 },
  { key: '集体活动', label: '集体活动', width: 10 },
  { key: '创新能力及劳动素质', label: '创新能力及劳动素质', width: 18 },
  { key: '社会实践报告', label: '社会实践报告', width: 14 },
  { key: 'total', label: '德育总分', width: 12 },
  { key: 'remarks', label: '加减分说明', width: 55 },
];

// 每类目固定基准分（每个学生一样，不依赖复核）
const BASE_SCORES = {
  '政治思想': 3, '道德修养': 2, '遵纪守法': 3, '诚实守信': 2, '学习态度': 3,
  '文明卫生': 1.5, '社会服务': 0, '集体活动': 2, '创新能力及劳动素质': 0, '社会实践报告': 0.6,
};

// 每类目分值上限：列值 = min(基准分 + 该类加分合计, 上限)；超过则按上限计（封顶）
const CAP_SCORES = {
  '政治思想': 3, '道德修养': 2, '遵纪守法': 3, '诚实守信': 2, '学习态度': 3,
  '文明卫生': 2, '社会服务': 2, '集体活动': 4, '创新能力及劳动素质': 4, '社会实践报告': 4,
};

function _effPts(it) {
  if (it.pointsFinal != null && it.pointsFinal !== '') return Number(it.pointsFinal) || 0;
  return Number(it.points) || 0;
}

// 未认定项目展示标题（2026-09-06）：活动/竞赛名称 +（奖项/报道级别）拼接；
// 名称或级别任一缺失则只显示存在的部分；都缺失回退 type/未填项目。
// 用于「加减分说明」等所有展示未认定项目名的场景。
function uncDisplay(it) {
  const n = (it && it.name ? String(it.name) : '').trim();
  const l = (it && it.level ? String(it.level) : '').trim();
  if (n && l) return `${n}（${l}）`;
  if (n) return n;
  if (l) return l;
  const t = (it && it.type ? String(it.type) : '').trim();
  return t || '未填项目';
}

// 2026-09-07 方案B：已认定项目展示名——导出/展示时优先取 certCatalog 当前名称（admin 改名后自动生效，无需回灌历史提交），
// 等级沿用提交值（与原 content=目录名+等级 快照拼法一致）；目录查不到或已禁用时回退提交快照 content。
function certTitle(it) {
  const fb = (it && (it.content || it.code || '未填项目').toString().trim()) || '未填项目';
  if (!it || !it.code) return fb;
  try {
    const cat = (db.load().certCatalog || []).find(c => String(c.code) === String(it.code).trim() && c.enabled !== false);
    if (!cat) return fb;
    const lv = String(it.level || '').trim();
    const fresh = (lv ? cat.name + lv : cat.name).trim();
    return fresh || fb;
  } catch (_) { return fb; }
}

// 数值四舍五入保留 4 位小数（第 5 位四舍五入）；整数或小数点后 <=4 位原样保留
// 与导出 richText 既有的 toFixed(4) 风格一致。仅用于导出落盘，不动库内原始浮点。
function roundTo4(v) {
  if (typeof v !== 'number') return v;
  return Number(v.toFixed(4));
}

// 自然数格式化：四舍五入到 4 位小数后去尾零；用于加减分说明（richText）的项目分值显示
// 2.0→"2", 0.4→"0.4", 0.6→"0.6", 1.23456→"1.2346", 0→"0"
function fmtNum(n) {
  const r = Number((Number(n) || 0).toFixed(4));
  return String(r);
}

// 已认定项目 → 归属类目（社会实践（不含媒体类）归到 社会实践报告）
function classifyCertProject(project) {
  if (project === '社会实践（不含媒体类）') return '社会实践报告';
  return project;
}
// 未认定项目 → 归属类目：媒体类默认归社会实践报告（审核方可在有效类目内改，读取已落库 gradedCategory）；非媒体类按 gradedCategory；无效/缺失返回 null（不计入，需年级补归类）
function classifyUncertItem(it) {
  if (it.type === '社会实践（媒体类）') {
    const c = it.gradedCategory;
    if (c && Object.prototype.hasOwnProperty.call(BASE_SCORES, c)) return c;
    return '社会实践报告';
  }
  const c = it.gradedCategory;
  if (c && Object.prototype.hasOwnProperty.call(BASE_SCORES, c)) return c;
  return null;
}

// 从班名推断专业：去掉末尾"X班"，前缀即专业名
// 例：临床医学1班→临床医学；临床医学(5+3一体化)1班→临床医学(5+3一体化)；医学检验技术2班→医学检验技术
function inferMajor(className) {
  if (!className) return '';
  return String(className).replace(/\d+班$/, '');
}

app.post('/api/export/grade-stats', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const { mode, className, major } = req.body || {};
  const d = db.load();
  let targetClasses; // 要导出的班级列表
  let exportTitle;   // Excel 标题里的分组名
  let labelInvalid;  // 入参缺失时的错误提示

  if (mode === 'class') {
    if (!className) return res.status(400).json({ error: '请选择班级' });
    targetClasses = [className];
    exportTitle = className;
  } else if (mode === 'major') {
    if (!major) return res.status(400).json({ error: '请选择专业' });
    // 推断：所有 inferMajor(c) === major 的班级（需在已用班级中存在）
    const usedClasses = [...new Set(d.users.filter(u => u.role === 'student' && u.className).map(u => u.className))];
    targetClasses = usedClasses.filter(c => inferMajor(c) === major).sort();
    if (!targetClasses.length) return res.status(400).json({ error: `暂无专业「${major}」下的班级数据` });
    exportTitle = major;
  } else if (mode === 'year') {
    // 全量导出（按用户回答：年级 = 导出所有班级，不分组）
    targetClasses = [...new Set(d.users.filter(u => u.role === 'student' && u.className).map(u => u.className))].sort();
    if (!targetClasses.length) return res.status(400).json({ error: '暂无班级数据' });
    exportTitle = '全部年级';
  } else {
    return res.status(400).json({ error: '请指定导出维度（按班级 / 按专业 / 按年级）' });
  }

  const students = d.users
    .filter(u => u.role === 'student' && targetClasses.includes(u.className))
    .sort((a, b) => cmpClassName(a.className, b.className)
      || String(a.studentId).localeCompare(String(b.studentId)));
  if (!students.length) return res.status(400).json({ error: '暂无学生数据' });

  const rows = students.map(stu => {
    const myApps = d.applications.filter(a => a.studentId === stu.id);
    // 2026-09-08 修复（加减分汇总）：排除「段级已退回」的申请——其内 item.status 仍可能是 approved（已通过后才被整段退），
    //   但前端「已退回」标签与业务设计均不计入最终加减分。示例：申行 9-7 整段退回（436+437 approved）不应再出现在加减分说明里。
    const certItems = myApps.filter(a => a.certifiedStatus !== 'withdrawn')
      .flatMap(a => (a.certifiedItems || [])
        .filter(it => it.status === 'approved' || it.status === 'overridden'));
    const uncertItems = myApps.filter(a => a.uncertifiedStatus !== 'withdrawn')
      .flatMap(a => (a.uncertifiedItems || [])
        .filter(it => it.status === 'approved' || it.status === 'overridden'));

    // 复核影响（计算期合并，不改动主数据）
    const eff = buildReviewEffects(d, stu.id);
    const ovKey = (aId, kind, iId) => `${aId}|${kind}|${iId}`;
    const appIdOf = (arr, it) => (myApps.find(a => Array.isArray(a[arr]) && a[arr].includes(it)) || {}).id;
    const certView = certItems.map(it => {
      const k = ovKey(appIdOf('certifiedItems', it), 'cert', it.id);
      const ov = eff.overrides[k];
      return { it, pts: ov != null ? ov.points : _effPts(it), overriddenByReview: ov != null, reviewRound: ov ? ov.round : null };
    });
    const uncView = uncertItems.map(it => {
      const k = ovKey(appIdOf('uncertifiedItems', it), 'uncert', it.id);
      const ov = eff.overrides[k];
      return { it, pts: ov != null ? ov.points : _effPts(it), overriddenByReview: ov != null, reviewRound: ov ? ov.round : null };
    });

    // 每类目加分累计（含复核）
    const addByCol = {};
    Object.keys(BASE_SCORES).forEach(k => { addByCol[k] = 0; });
    certView.forEach(v => { const col = classifyCertProject(v.it.project); if (col in addByCol) addByCol[col] += v.pts; });
    uncView.forEach(v => { const col = classifyUncertItem(v.it); if (col && col in addByCol) addByCol[col] += v.pts; });
    eff.adds.forEach(ad => { if (ad.project in addByCol) addByCol[ad.project] += ad.points; });

    // 每行 = min(基准分 + 该类加分合计, 该类上限)
    const row = { className: stu.className, studentId: stu.studentId };
    let total = 0;
    Object.keys(BASE_SCORES).forEach(k => {
      const base = BASE_SCORES[k] || 0;
      const rawAdd = addByCol[k] || 0;
      const cap = CAP_SCORES[k];
      const val = (cap != null) ? Math.min(base + rawAdd, cap) : (base + rawAdd);
      row[k] = roundTo4(val);
      total += val;
    });
    row.total = roundTo4(total);

    // 加减分说明：已认定 + 未认定 + 复核新增/异议，按类别分组
    const titleCert = certTitle;
    const titleUnc = uncDisplay;
    const byCat = {};
    certView.forEach(v => {
      const col = classifyCertProject(v.it.project);
      (byCat[col] = byCat[col] || []).push({
        title: titleCert(v.it), pts: v.pts, overridden: v.it.status === 'overridden',
        reviewOverride: v.overriddenByReview, origPts: _effPts(v.it), reviewRound: v.reviewRound,
      });
    });
    uncView.forEach(v => {
      const col = classifyUncertItem(v.it);
      if (!col) return;
      (byCat[col] = byCat[col] || []).push({
        title: titleUnc(v.it), pts: v.pts, overridden: v.it.status === 'overridden',
        reviewOverride: v.overriddenByReview, origPts: _effPts(v.it), reviewRound: v.reviewRound,
      });
    });
    eff.adds.forEach(ad => {
      (byCat[ad.project] = byCat[ad.project] || []).push({ title: ad.title, pts: ad.points, overridden: false, reviewAdd: true, reviewRound: ad.round });
    });
    const richText = [];
    // 2026-08-30 修复：所有 run 统一显式声明字体（size/name），红/蓝/黄/绿在基础字体上加 color，
    // 避免 richText 中部分 run 有 font、部分没有时，Excel/WPS 渲染字号不一致（"文明卫生："字号异常）
    const FONT_BASE = { size: 11, name: 'Calibri' };
    const pushRun = (text, colorArg) => {
      const run = { text, font: { ...FONT_BASE } };
      if (colorArg) run.font.color = { argb: colorArg };
      richText.push(run);
    };
    let first = true;
    Object.keys(BASE_SCORES).forEach(k => {
      const items = byCat[k];
      const cap = CAP_SCORES[k];
      const rawAdd = addByCol[k] || 0;
      const base = BASE_SCORES[k] || 0;
      if (!items || !items.length) return;
      if (!first) pushRun(' ');
      first = false;
      pushRun(`${k}：`);
      items.forEach((it, j) => {
        if (j > 0) pushRun('；');
        const sign = it.pts >= 0 ? '+' : '';
        const ptsFmt = fmtNum(it.pts);
        // 复核项按所属榜次取色：一榜蓝 / 二榜黄 / 三榜绿（与复核导出 REVIEW_ROUND_COLORS 一致）
        const reviewTextColor = (round) => {
          if (round === 'second') return 'FFFFB300';
          if (round === 'third') return 'FF2E9E5B';
          return 'FF1F6FEB'; // first / 未知 → 蓝
        };
        let text, colorArg;
        if (it.reviewOverride) {
          // 异议通过：原为 X 项加 X 分，经复核认定为加 X 分（按榜次取色）
          text = `原为${it.title}加${fmtNum(it.origPts)}分，经复核认定为加${ptsFmt}分`;
          colorArg = reviewTextColor(it.reviewRound);
        } else if (it.reviewAdd) {
          // 复核新增（按榜次取色：一榜蓝/二榜黄/三榜绿）
          text = `〔复核新增〕${it.title}+${ptsFmt}`;
          colorArg = reviewTextColor(it.reviewRound);
        } else {
          text = `${it.title}${sign}${ptsFmt}`;
          if (it.overridden) colorArg = 'FFFF0000';
        }
        pushRun(text, colorArg);
      });
      if (cap != null && (base + rawAdd) > cap) {
        const rawAddFmt = fmtNum(rawAdd);
        pushRun(`；${k}项${rawAddFmt}分已达该项加分上限，实际加分为${cap}分`);
      }
    });
    row.remarksRichText = richText;
    return row;
  });

  // 用 exceljs 生成 Excel
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('德育分项详细数据');
  GRADE_STAT_HEADERS.forEach((h, i) => { ws.getColumn(i + 1).width = h.width; });

  // 标题行（Row 1，合并所有列）
  ws.mergeCells(1, 1, 1, GRADE_STAT_HEADERS.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `德育【${exportTitle}】分项详细数据`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // 表头（Row 2）
  const headerRow = ws.getRow(2);
  GRADE_STAT_HEADERS.forEach((h, i) => { headerRow.getCell(i + 1).value = h.label; });
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.height = 22;

  // 数据行（Row 3+）：每列仅显示总额数字（黑字）；德育总分加粗
  rows.forEach((r, idx) => {
    const row = ws.getRow(3 + idx);
    row.getCell(1).value = r.className;
    row.getCell(2).value = r.studentId;
    Object.keys(BASE_SCORES).forEach((k, i) => {
      row.getCell(3 + i).value = r[k];
      row.getCell(3 + i).alignment = { horizontal: 'right' };
    });
    const totalCell = row.getCell(13);
    totalCell.value = r.total;
    totalCell.font = { bold: true };
    totalCell.alignment = { horizontal: 'right' };
    // 加减分说明（richText，被改判项红字）
    const remarksCell = row.getCell(14);
    remarksCell.value = { richText: r.remarksRichText.length ? r.remarksRichText : [{ text: '' }] };
    remarksCell.alignment = { wrapText: true, vertical: 'top' };
  });

  // 全表边框
  const lastRow = 2 + rows.length;
  for (let r = 2; r <= lastRow; r++) {
    for (let c = 1; c <= GRADE_STAT_HEADERS.length; c++) {
      const cell = ws.getCell(r, c);
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    }
  }

  // 输出（安全导出：二级密码 + 页眉水印 + Excel 加密）
  const filename = `德育【${exportTitle}】分项详细数据.xlsx`;
  return await secureSendWorkbook(req, res, wb, {
    pageName: `德育分项详细数据【${exportTitle}】`, filename, logAction: 'export-grade-stats',
    exportAction: 'export', recordCount: students.length, scope: exportTitle,
  });
});

// 综测 4 表快照导出（德育一榜 / 综测二榜 / 综测三榜 / 综测四榜）
// 4 个表按班级/专业/年级维度导出；每个表为一张 sheet，14 列制式，sheet 背景色按表区分
// 加减分说明列：被多榜多次修改的项目按"完整多榜链"展示（原始黑+一榜蓝+二榜黄+三榜紫，→ 连接）
const SNAPSHOT_META = {
  y1: { name: '德育一榜', maxRound: 'none',   color: { solid: 'FF2F6FDB', light: 'FFE7EFFB' } },
  y2: { name: '综测二榜', maxRound: 'first',  color: { solid: 'FFFFB300', light: 'FFFFF6DA' } },
  y3: { name: '综测三榜', maxRound: 'second', color: { solid: 'FF2E9E5B', light: 'FFE6F5EA' } },
  y4: { name: '综测四榜', maxRound: 'third',  color: { solid: 'FF8E24AA', light: 'FFF3E5F5' } },
};
const ROUND_TEXT_COLOR = { first: 'FF1F6FEB', second: 'FFFFB300', third: 'FF8E24AA' };
const ROUND_CN_NAME = { first: '一榜', second: '二榜', third: '三榜' };
app.post('/api/export/snapshot-stats', authRequired, requireRole('admin'), sensitiveLimiter, officeUpload.array('files', 1), async (req, res) => {
  // public=true：公示版（y2/y3/y4）
  //   y2 公示版：14列 + 智育(导入值) + 体育5 + 综测总分（17列）
  //   y3 公示版：14列 + 智育(含二榜复核) + 体育5 + 教师评价 + 综测总分（18列）
  //   y4 公示版：同 y3 公示版（智育含二/三榜复核）
  // 智育/教师评价默认从库（scores）读取；若本次请求上传了文件则临时用文件覆盖（兼容旧入口）
  let reqBody = (req.body || {});
  if (reqBody.payload) { reqBody = parsePayload(req); if (reqBody === null) return res.status(400).json({ error: '请求数据格式错误或数据过大' }); }
  const { snapshot, mode, className, major, public: isPublic } = reqBody;
  const meta = SNAPSHOT_META[snapshot];
  if (!meta) return res.status(400).json({ error: '请指定 snapshot（y1/y2/y3/y4）' });
  const files = req.files || [];
  let zhiscoresBySid = null; // 学号 → 智育成绩（本次上传文件覆盖用）
  let teacherBySid = null;   // 学号 → 教师评价分（本次上传文件覆盖用）
  if (isPublic && files.length) {
    try {
      const ExcelJS = require('exceljs');
      const zb = new ExcelJS.Workbook();
      await zb.xlsx.readFile(files[0].path);
      const ws = zb.worksheets[0];
      const hdr = ws.getRow(1);
      const colMap = {};
      hdr.eachCell((cell, col) => { const h = String(cell.value || '').trim(); if (h) colMap[h] = col; });
      const sidCol = colMap['学号'] || Object.keys(colMap).find(k => k.includes('学号'));
      const zsCol = colMap['智育成绩'] || Object.keys(colMap).find(k => k.includes('智育'));
      const tcCol = colMap['教师评价分'] || Object.keys(colMap).find(k => k.includes('教师'));
      if (!sidCol) return res.status(400).json({ error: '文件需包含「学号」列' });
      zhiscoresBySid = {};
      teacherBySid = {};
      ws.eachRow((row, rn) => {
        if (rn === 1) return;
        const sid = String(row.getCell(sidCol).value || '').trim();
        if (!sid) return;
        if (zsCol) { const z = Number(row.getCell(zsCol).value); if (Number.isFinite(z)) zhiscoresBySid[sid] = z; }
        if (tcCol) { const t = Number(row.getCell(tcCol).value); if (Number.isFinite(t)) teacherBySid[sid] = t; }
      });
      try { require('fs').unlinkSync(files[0].path); } catch (e) {}
    } catch (e) {
      return res.status(400).json({ error: '成绩文件解析失败：' + (e.message || e) });
    }
  }
  if (isPublic && snapshot === 'y1') return res.status(400).json({ error: '德育一榜无公示版' });
  if (!isPublic && snapshot === 'y4') return res.status(400).json({ error: '综测四榜仅支持公示版导出（四榜为终榜，公示口径含智育/体育/教师评价/综测总分）' });

  const d = db.load();
  let targetClasses, exportTitle;
  if (mode === 'class') {
    if (!className) return res.status(400).json({ error: '请选择班级' });
    targetClasses = [className];
    exportTitle = className;
  } else if (mode === 'major') {
    if (!major) return res.status(400).json({ error: '请选择专业' });
    const usedClasses = [...new Set(d.users.filter(u => u.role === 'student' && u.className).map(u => u.className))];
    targetClasses = usedClasses.filter(c => inferMajor(c) === major).sort();
    if (!targetClasses.length) return res.status(400).json({ error: `暂无专业「${major}」下的班级数据` });
    exportTitle = major;
  } else if (mode === 'year') {
    targetClasses = [...new Set(d.users.filter(u => u.role === 'student' && u.className).map(u => u.className))].sort();
    if (!targetClasses.length) return res.status(400).json({ error: '暂无班级数据' });
    exportTitle = '全部年级';
  } else {
    return res.status(400).json({ error: '请指定导出维度（按班级 / 按专业 / 按年级）' });
  }

  const students = d.users
    .filter(u => u.role === 'student' && targetClasses.includes(u.className))
    .sort((a, b) => cmpClassName(a.className, b.className) || String(a.studentId).localeCompare(String(b.studentId)));
  if (!students.length) return res.status(400).json({ error: '暂无学生数据' });

  const rows = students.map(stu => {
    const myApps = d.applications.filter(a => a.studentId === stu.id);
    // 2026-09-08 修复（加减分汇总）：排除「段级已退回」的申请（与 grade-stats L1224 同口径）
    const certItems = myApps.filter(a => a.certifiedStatus !== 'withdrawn')
      .flatMap(a => (a.certifiedItems || []).filter(it => it.status === 'approved' || it.status === 'overridden'));
    const uncertItems = myApps.filter(a => a.uncertifiedStatus !== 'withdrawn')
      .flatMap(a => (a.uncertifiedItems || []).filter(it => it.status === 'approved' || it.status === 'overridden'));

    // 完整多榜链（截至 meta.maxRound）
    const eff = buildReviewChain(d, stu.id, meta.maxRound);
    const ovKey = (aId, kind, iId) => `${aId}|${kind}|${iId}`;
    const appIdOf = (arr, it) => (myApps.find(a => Array.isArray(a[arr]) && a[arr].includes(it)) || {}).id;

    // certItems / uncertItems：算出 finalPts（链末值，若无 chain 则用 _effPts）
    const certView = certItems.map(it => {
      const k = ovKey(appIdOf('certifiedItems', it), 'cert', it.id);
      const chain = eff.overrides[k] || [];
      const finalPts = chain.length ? chain[chain.length - 1].points : _effPts(it);
      return { it, finalPts, chain, overridden: it.status === 'overridden' };
    });
    const uncView = uncertItems.map(it => {
      const k = ovKey(appIdOf('uncertifiedItems', it), 'uncert', it.id);
      const chain = eff.overrides[k] || [];
      const finalPts = chain.length ? chain[chain.length - 1].points : _effPts(it);
      return { it, finalPts, chain, overridden: it.status === 'overridden' };
    });

    // 每类目加分累计（按 finalPts）
    const addByCol = {};
    Object.keys(BASE_SCORES).forEach(k => { addByCol[k] = 0; });
    certView.forEach(v => { const col = classifyCertProject(v.it.project); if (col in addByCol) addByCol[col] += v.finalPts; });
    uncView.forEach(v => { const col = classifyUncertItem(v.it); if (col && col in addByCol) addByCol[col] += v.finalPts; });
    eff.adds.forEach(ad => { if (ad.project in addByCol) addByCol[ad.project] += ad.points; });

    // 14 列制式：5基准+5类目+班级+学号+总分
    const row = { className: stu.className, studentId: stu.studentId };
    let total = 0;
    Object.keys(BASE_SCORES).forEach(k => {
      const base = BASE_SCORES[k] || 0;
      const rawAdd = addByCol[k] || 0;
      const cap = CAP_SCORES[k];
      const val = (cap != null) ? Math.min(base + rawAdd, cap) : (base + rawAdd);
      row[k] = roundTo4(val);
      total += val;
    });
    row.total = roundTo4(total);

    // 阶段二（2026-08-30）：智育/体育/教师评价 附加列
    //   y3（非公示版）本身已含智育+体育（用户确认：y3 生成在智育导入后）
    //   y2 公示版：智育取导入值（maxRound='first'，二榜智育复核尚未发生）
    //   y3 / y3公示版：智育取 'second'（含二榜智育复核）；公示版另加教师评价
    //   y4 公示版：智育取 'third'（含二、三榜智育复核），含教师评价
    const zhiyuRound = (snapshot === 'y3') ? 'second' : (snapshot === 'y4' ? 'third' : 'first');
    if ((snapshot === 'y3' && !isPublic) || (isPublic && ['y2', 'y3', 'y4'].includes(snapshot))) {
      row.zhiyu = roundTo4(getFinalZhiyu(d, stu.studentId, zhiyuRound));
      row.sports = SPORTS_SCORE;
      row.total3 = roundTo4(row.total + row.zhiyu + SPORTS_SCORE);
    }
    if (isPublic && ['y3', 'y4'].includes(snapshot)) {
      row.teacher = roundTo4(getTeacherScore(d, stu.studentId));
      row.total3 = roundTo4(row.total + row.zhiyu + SPORTS_SCORE + row.teacher);
    }

    // 加减分说明：完整多榜链
    const titleCert = certTitle;
    const titleUnc = uncDisplay;
    const byCat = {};
    const pushItem = (cat, opts) => { (byCat[cat] = byCat[cat] || []).push(opts); };

    certView.forEach(v => {
      const col = classifyCertProject(v.it.project);
      pushItem(col, {
        title: titleCert(v.it), origPts: _effPts(v.it), chain: v.chain, overridden: v.overridden,
        kind: v.chain.length ? 'objection' : 'normal',
      });
    });
    uncView.forEach(v => {
      const col = classifyUncertItem(v.it);
      if (!col) return;
      pushItem(col, {
        title: titleUnc(v.it), origPts: _effPts(v.it), chain: v.chain, overridden: v.overridden,
        kind: v.chain.length ? 'objection' : 'normal',
      });
    });
    eff.adds.forEach(ad => {
      pushItem(ad.project, { title: ad.title, origPts: 0, chain: [], overridden: false, kind: 'add', addRound: ad.round, addPoints: ad.points });
    });

    const richText = [];
    // 2026-08-30 修复：所有 run 统一显式声明字体（size/name），染色段在基础字体上加 color，
    // 避免 richText 部分 run 有 font、部分没有时，Excel/WPS 渲染字号不一致
    const FONT_BASE = { size: 11, name: 'Calibri' };
    const pushRun = (text, colorArg) => {
      const run = { text, font: { ...FONT_BASE } };
      if (colorArg) run.font.color = { argb: colorArg };
      richText.push(run);
    };
    let first = true;
    Object.keys(BASE_SCORES).forEach(k => {
      const items = byCat[k];
      const cap = CAP_SCORES[k];
      const rawAdd = addByCol[k] || 0;
      const base = BASE_SCORES[k] || 0;
      if (!items || !items.length) return;
      if (!first) pushRun(' ');
      first = false;
      pushRun(`${k}：`);
      items.forEach((it, j) => {
        if (j > 0) pushRun('；');
        if (it.kind === 'add') {
          // 复核新增：〔复核新增〕标题+分（按 addRound 染色）
          pushRun('〔复核新增〕', ROUND_TEXT_COLOR[it.addRound] || ROUND_TEXT_COLOR.first);
          pushRun(`${it.title}+${fmtNum(it.addPoints)}`);
        } else if (it.kind === 'objection') {
          // 完整链：标题：原 X → 〔一榜认定〕Y → 〔二榜认定〕Z ...
          pushRun(`${it.title}：`);
          pushRun(`原 ${fmtNum(it.origPts)}`);
          it.chain.forEach(seg => {
            const cn = ROUND_CN_NAME[seg.round] || '复核';
            pushRun(' → ');
            pushRun(`〔${cn}认定〕`, ROUND_TEXT_COLOR[seg.round] || ROUND_TEXT_COLOR.first);
            pushRun(fmtNum(seg.points));
          });
        } else {
          // 正常项：标题±X（overridden 红字）
          const sign = it.origPts >= 0 ? '+' : '';
          pushRun(`${it.title}${sign}${fmtNum(it.origPts)}`, it.overridden ? 'FFFF0000' : undefined);
        }
      });
      if (cap != null && (base + rawAdd) > cap) {
        const rawAddFmt = fmtNum(rawAdd);
        pushRun(`；${k}项${rawAddFmt}分已达该项加分上限，实际加分为${cap}分`);
      }
    });
    row.remarksRichText = richText;
    return row;
  });

  // 阶段二（2026-08-30）：动态附加列
  //   y2 公示版   : 14列 + 智育 + 体育 + 综测总分（17列）
  //   y3（非公示版）: 14列 + 智育 + 体育 + 综测总分（17列，y3 生成在智育导入后）
  //   y3 公示版   : 14列 + 智育 + 体育 + 教师评价 + 综测总分（18列）
  //   y4 公示版   : 同 y3 公示版（18列）
  const EXTRA_COLS = [];
  const addCol = (key, label, width) => EXTRA_COLS.push({ key, label, width });
  const hasZhiyu = (snapshot === 'y3' && !isPublic) || (isPublic && ['y2', 'y3', 'y4'].includes(snapshot));
  const hasTeacher = isPublic && ['y3', 'y4'].includes(snapshot);
  if (hasZhiyu) { addCol('zhiyu', '智育成绩', 10); addCol('sports', '体育成绩', 10); }
  if (hasTeacher) addCol('teacher', '教师评价', 10);
  if (hasZhiyu) addCol('total3', '综测总分', 10);

  // 生成 xlsx（1 sheet = 1 个 snapshot）
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(meta.name);
  // 2026-08-30 需求：加减分说明列放到所有数值列之后（公示版/含附加列时位于最后；普通 14 列版不变）
  const headers = EXTRA_COLS.length
    ? [...GRADE_STAT_HEADERS.filter(h => h.key !== 'remarks'), ...EXTRA_COLS, GRADE_STAT_HEADERS.find(h => h.key === 'remarks')]
    : GRADE_STAT_HEADERS;
  const headerCount = headers.length;
  headers.forEach((h, i) => { ws.getColumn(i + 1).width = h.width; });

  // 标题行
  ws.mergeCells(1, 1, 1, headerCount);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `综测【${exportTitle}】${meta.name}${isPublic ? '·公示版' : ''}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.color.solid } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // 表头
  const headerRow = ws.getRow(2);
  headers.forEach((h, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = h.label;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.color.solid } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  // 数据行
  const startRow = 3;
  rows.forEach((r, idx) => {
    const row = ws.getRow(startRow + idx);
    row.getCell(1).value = r.className;
    row.getCell(2).value = r.studentId;
    let cIdx = 3;
    Object.keys(BASE_SCORES).forEach(k => {
      row.getCell(cIdx).value = r[k];
      row.getCell(cIdx).alignment = { horizontal: 'right' };
      cIdx++;
    });
    row.getCell(cIdx).value = r.total; row.getCell(cIdx).alignment = { horizontal: 'right' }; cIdx++;
    // 附加列：智育（库值优先，本次上传覆盖）、体育（固定5）、教师评价、综测总分
    if (hasZhiyu) {
      const zs = (zhiscoresBySid && zhiscoresBySid[r.studentId] != null) ? zhiscoresBySid[r.studentId] : r.zhiyu;
      const zsCell = row.getCell(cIdx);
      if (zs != null) { zsCell.value = roundTo4(zs); zsCell.alignment = { horizontal: 'right' }; }
      else { zsCell.value = ''; }
      cIdx++;
      const spCell = row.getCell(cIdx);
      spCell.value = SPORTS_SCORE; spCell.alignment = { horizontal: 'right' };
      cIdx++;
    }
    if (hasTeacher) {
      const tc = (teacherBySid && teacherBySid[r.studentId] != null) ? teacherBySid[r.studentId] : r.teacher;
      const tcCell = row.getCell(cIdx);
      if (tc != null) { tcCell.value = roundTo4(tc); tcCell.alignment = { horizontal: 'right' }; }
      else { tcCell.value = ''; }
      cIdx++;
    }
    if (hasZhiyu) {
      const total3Cell = row.getCell(cIdx);
      const zs = (zhiscoresBySid && zhiscoresBySid[r.studentId] != null) ? zhiscoresBySid[r.studentId] : r.zhiyu;
      const tc = (teacherBySid && teacherBySid[r.studentId] != null) ? teacherBySid[r.studentId] : r.teacher;
      const total3 = r.total + (zs != null ? zs : 0) + SPORTS_SCORE + (tc != null ? tc : 0);
      total3Cell.value = roundTo4(total3);
      total3Cell.alignment = { horizontal: 'right' };
      total3Cell.font = { bold: true };
      cIdx++;
    }
    // 加减分说明（最后一列，需求 2026-08-30：放到所有列之后）
    const noteCell = row.getCell(cIdx);
    noteCell.value = { richText: r.remarksRichText };
    noteCell.alignment = { wrapText: true, vertical: 'top' };
  });

  // 全表浅色背景 + 边框
  const fillLight = { type: 'pattern', pattern: 'solid', fgColor: { argb: meta.color.light } };
  const lastRow = startRow + rows.length - 1;
  for (let r = 2; r <= lastRow; r++) for (let c = 1; c <= headerCount; c++) {
    const cell = ws.getCell(r, c);
    if (!cell.fill || !cell.fill.fgColor) cell.fill = fillLight;
  }
  for (let r = 1; r <= lastRow; r++) for (let c = 1; c <= headerCount; c++) {
    ws.getCell(r, c).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }

  // 文件名（安全导出：二级密码 + 页眉水印 + Excel 加密）
  const filename = `综测【${exportTitle}】${meta.name}${isPublic ? '·公示版' : ''}.xlsx`;
  return await secureSendWorkbook(req, res, wb, {
    pageName: `${meta.name}${isPublic ? '·公示版' : ''}【${exportTitle}】`, filename, logAction: 'export-snapshot',
    logDetail: `${meta.name}${isPublic ? '公示版' : ''}导出`,
    exportAction: isPublic ? 'export_announce' : 'export', recordCount: students.length, scope: exportTitle,
  });
});

// 综测复核导出（一榜/二榜/三榜）：汇总（10 类目复核增减）+ 明细（逐条复核事项）
// 导出范围：全年级所有学生；未申请复核的学生汇总区留空。工作表背景色按榜次区分。
const REVIEW_ROUND_COLORS = {
  first: { solid: 'FF2F6FDB', light: 'FFE7EFFB', name: '蓝' },
  second: { solid: 'FFFFB300', light: 'FFFFF6DA', name: '黄' },
  third: { solid: 'FF2E9E5B', light: 'FFE6F5EA', name: '绿' },
};
app.post('/api/export/review-stats', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const { round } = req.body || {};
  if (!REVIEW_ROUNDS.includes(round)) return res.status(400).json({ error: '请指定复核榜次（一榜/二榜/三榜）' });
  const color = REVIEW_ROUND_COLORS[round];
  const d = db.load();
  const students = d.users
    .filter(u => u.role === 'student' && u.className)
    .sort((a, b) => cmpClassName(a.className, b.className) || String(a.studentId).localeCompare(String(b.studentId)));

  // 汇总：每生每类目复核增减（仅已认定 approved 项计入）
  const sumByCat = {};   // studentId -> { cat: delta }
  const reviewNote = {}; // studentId -> [{text}]
  const detailRows = [];
  for (const stu of students) {
    sumByCat[stu.id] = {}; Object.keys(BASE_SCORES).forEach(k => sumByCat[stu.id][k] = 0); reviewNote[stu.id] = [];
  }
  for (const r of d.reviews) {
    if (r.round !== round) continue;
    for (const it of r.items) {
      if (it.reviewStatus !== 'approved') continue;
      if (it.target === 'zhiyu') continue; // C 类智育复核不进德育复核汇总（由智育复核链单独体现）
      const stu = d.users.find(u => u.id === r.studentId);
      if (!stu) continue;
      const cat = reviewItemCategory(it);
      if (cat && BASE_SCORES[cat] != null) {
        const delta = it.kind === 'objection' ? (it.reviewPoints - it.originalPoints) : it.reviewPoints;
        sumByCat[stu.id][cat] = (sumByCat[stu.id][cat] || 0) + delta;
      }
      if (it.kind === 'objection') {
        reviewNote[stu.id].push(`原为${it.title}加${fmtNum(it.originalPoints)}分，经复核认定为加${fmtNum(it.reviewPoints)}分`);
      } else {
        reviewNote[stu.id].push(`〔复核新增〕${it.title}+${fmtNum(it.reviewPoints)}（${cat || '未归类'}）`);
      }
      detailRows.push({
        className: r.className, studentId: r.studentIdNo, type: it.kind === 'add' ? 'A类·新增' : 'B类·异议',
        title: it.title, category: cat || (it.kind === 'add' ? '（待归类）' : ''),
        originalPoints: it.originalPoints, requestedPoints: it.requestedPoints, reviewPoints: it.reviewPoints,
        status: '已认定', comment: it.reviewComment || '',
      });
    }
  }

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(ROUND_CN[round] + '复核');
  // 背景色：整体浅色填充
  const fillLight = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.light } };

  // 标题
  ws.mergeCells(1, 1, 1, 12);
  const t = ws.getCell(1, 1);
  t.value = `综测复核【${ROUND_CN[round]}】汇总与明细（全年级）`;
  t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.solid } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // ---- 汇总区 ----
  const sumHeader = ['班级', '学号', ...Object.keys(BASE_SCORES), '复核说明'];
  const sumStart = 3;
  const sumHeaderRow = ws.getRow(sumStart);
  sumHeader.forEach((h, i) => {
    const c = sumHeaderRow.getCell(i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.solid } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  students.forEach((stu, idx) => {
    const row = ws.getRow(sumStart + 1 + idx);
    row.getCell(1).value = stu.className;
    row.getCell(2).value = stu.studentId;
    Object.keys(BASE_SCORES).forEach((k, i) => {
      const v = sumByCat[stu.id][k];
      const c = row.getCell(3 + i);
      c.value = v ? roundTo4(v) : '';   // 未申请/无增减留空
      c.alignment = { horizontal: 'right' };
    });
    const note = reviewNote[stu.id].join('；');
    row.getCell(3 + Object.keys(BASE_SCORES).length).value = note;
    row.getCell(3 + Object.keys(BASE_SCORES).length).alignment = { wrapText: true, vertical: 'top' };
  });
  const sumEnd = sumStart + students.length;
  // 汇总区背景浅色
  for (let r = sumStart; r <= sumEnd; r++) for (let c = 1; c <= sumHeader.length; c++) {
    const cell = ws.getCell(r, c); if (!cell.fill || !cell.fill.fgColor) cell.fill = fillLight;
  }

  // ---- 明细区 ----
  const detailStart = sumEnd + 2;
  ws.mergeCells(detailStart - 1, 1, detailStart - 1, 10);
  const dh = ws.getCell(detailStart - 1, 1);
  dh.value = '复核明细（按事项）';
  dh.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  dh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.solid } };
  dh.alignment = { horizontal: 'left', vertical: 'middle' };
  const dHeader = ['班级', '学号', '类型', '复核事项', '归类类别', '原分值', '申请分值', '认定分值', '状态', '审核意见'];
  const dHeaderRow = ws.getRow(detailStart);
  dHeader.forEach((h, i) => {
    const c = dHeaderRow.getCell(i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.solid } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  if (!detailRows.length) {
    const er = ws.getRow(detailStart + 1);
    er.getCell(1).value = '本榜暂无已认定的复核事项';
  } else {
    detailRows.forEach((dr, idx) => {
      const row = ws.getRow(detailStart + 1 + idx);
      row.getCell(1).value = dr.className;
      row.getCell(2).value = dr.studentId;
      row.getCell(3).value = dr.type;
      row.getCell(4).value = dr.title;
      row.getCell(5).value = dr.category;
      row.getCell(6).value = dr.originalPoints; row.getCell(6).alignment = { horizontal: 'right' };
      row.getCell(7).value = dr.requestedPoints; row.getCell(7).alignment = { horizontal: 'right' };
      row.getCell(8).value = dr.reviewPoints; row.getCell(8).alignment = { horizontal: 'right' };
      row.getCell(9).value = dr.status;
      row.getCell(10).value = dr.comment;
    });
  }
  const detailEnd = detailStart + Math.max(1, detailRows.length);
  for (let r = detailStart; r <= detailEnd; r++) for (let c = 1; c <= dHeader.length; c++) {
    const cell = ws.getCell(r, c); if (!cell.fill || !cell.fill.fgColor) cell.fill = fillLight;
  }
  // 全表边框
  const lastRow = Math.max(sumEnd, detailEnd);
  const lastCol = Math.max(sumHeader.length, dHeader.length);
  for (let r = sumStart; r <= lastRow; r++) for (let c = 1; c <= lastCol; c++) {
    const cell = ws.getCell(r, c);
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }
  ws.getColumn(1).width = 16; ws.getColumn(2).width = 16;
  for (let i = 3; i <= 12; i++) ws.getColumn(i).width = 12;
  ws.getColumn(sumHeader.length).width = 50;

  const filename = `综测复核【${ROUND_CN[round]}】.xlsx`;
  return await secureSendWorkbook(req, res, wb, { pageName: `${ROUND_CN[round]}复核导出`, filename, logAction: 'export-review-stats', logDetail: `${ROUND_CN[round]}复核导出`, exportAction: 'export', recordCount: students.length, scope: '全年级' });
});

// ============================================================
// 管理员 API
// ============================================================
// 班级→专业映射（仅管理员）
app.get('/api/admin/classMajors', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  res.json({ classMajors: d.classMajors || {}, classes: d.config.class || d.config.classes || [] });
});
// 班级→专业映射（只读，供审核页按专业筛选；年级 + 管理员可读取，无需 admin）
app.get('/api/class-majors', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  res.json({ classMajors: d.classMajors || {} });
});
app.post('/api/admin/classMajors', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const mapping = (req.body && req.body.mapping) || {};
  if (typeof mapping !== 'object' || Array.isArray(mapping)) return res.status(400).json({ error: 'mapping 必须为对象 {className: major}' });
  // 规范化：每个值去尾空白，空字符串保留（允许显式清空）
  const clean = {};
  for (const k of Object.keys(mapping)) clean[k] = String(mapping[k] || '').trim();
  d.classMajors = clean;
  db.save();
  addLog(req.user, 'class-majors-update', `更新班级→专业映射（${Object.keys(clean).length} 个班级）`);
  res.json({ ok: true, classMajors: d.classMajors });
});

// 年级负责人分配配置（仅管理员）
// 返回当前全部配置：{ assignments: { "<班名>": { uncertified, round1, round2, round3 } } }
app.get('/api/admin/class-grade-assignments', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  res.json({ assignments: d.classGradeAssignments || {} });
});
// 更新配置：合并（per-class / per-type 级别合并，未提供的字段保留原值），并做校验
app.post('/api/admin/class-grade-assignments', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const incoming = (req.body && req.body.assignments) || {};
  if (typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'assignments 必须为对象 {className: {uncertified,round1,round2,round3}}' });
  const majors = d.classMajors || {};
  const grades = new Set(d.users.filter(u => u.role === 'grade').map(u => String(u.id)));
  d.classGradeAssignments = d.classGradeAssignments || {};
  const clean = {};
  for (const cls of Object.keys(incoming)) {
    if (!majors[cls]) return res.status(400).json({ error: '班级【' + cls + '】不存在于班级→专业映射中，无法分配负责人' });
    const src = incoming[cls] || {};
    const existing = d.classGradeAssignments[cls] || { uncertified: [], round1: [], round2: [], round3: [], certModify: [] };
    const ent = { uncertified: asgArr(existing.uncertified), round1: asgArr(existing.round1), round2: asgArr(existing.round2), round3: asgArr(existing.round3), certModify: asgArr(existing.certModify) };
    for (const t of GRADE_ASSIGN_TYPES) {
      if (src[t] === undefined) continue; // 未提供则保留原值
      const arr = asgArr(src[t]); // 兼容单值字符串 / 数组 / 空
      for (const id of arr) {
        if (!grades.has(String(id))) return res.status(400).json({ error: '班级【' + cls + '】的负责人值非法（必须为 role=grade 的用户，或留空交由管理员兜底）' });
      }
      ent[t] = arr;
    }
    clean[cls] = ent;
  }
  d.classGradeAssignments = Object.assign({}, d.classGradeAssignments, clean);
  db.save();
  addLog(req.user, 'class-grade-assignments', `更新年级负责人分配（${Object.keys(clean).length} 个班级）`);
  res.json({ ok: true, assignments: d.classGradeAssignments });
});

// ============================================================
// 全部用户（年级/管理员）
// 性能优化（2026-08-30）：/api/admin/users 30s 内存缓存；用户增删改/重置密码时 clearUsersCache() 失效
let usersCache = null; // { key, data, ts }
const USERS_CACHE_TTL = 30 * 1000;
function clearUsersCache() { usersCache = null; }

app.get('/api/admin/users', authRequired, requireRole('admin'), (req, res) => {
  const key = (req.query.role || 'all') + '|' + (req.query.className || 'all');
  if (usersCache && usersCache.key === key && Date.now() - usersCache.ts < USERS_CACHE_TTL) {
    return res.json(usersCache.data);
  }
  const d = db.load();
  const { role, className } = req.query;
  // 2026-09-01：不再全局剔除 admin——admin 端可筛选「管理员」角色（safeUser 已脱敏，无敏感字段外泄）
  let list = d.users.slice();
  if (role && role !== 'all') list = list.filter(u => u.role === role);
  if (className && className !== 'all') list = list.filter(u => u.className === className);
  // 班级列表：班级→专业映射（admin 维护的官方名单）+ 使用中出现的新班级
  const majors = d.classMajors || {};
  const preset = Object.keys(majors);
  const used = [...new Set(d.users.map(u => u.className).filter(Boolean))];
  const classes = [...new Set([...preset, ...used])].sort();
  const data = { users: list.map(u => safeUser(u, d)), classes };
  usersCache = { key, data, ts: Date.now() };
  res.json(data);
});

// 创建用户（班长/学生/管理员）
// 按角色生成默认初始密码：留空时由创建/重置流程调用
//   学生 = student + 学号；班长 = monitor + 账号；年级 = grade + 账号；admin = 环境变量 DEFAULT_ADMIN_PASSWORD
function defaultPasswordFor(role, username, studentId) {
  if (role === 'student') return 'student' + (username || studentId || '');
  if (role === 'monitor') return 'monitor' + (username || '');
  if (role === 'grade') return 'grade' + (username || '');
  if (role === 'admin') return process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@123456';
  return '123456';
}

app.post('/api/admin/users', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  let { username, password, name, role, className, studentId } = req.body;
  username = (username || '').toString().trim();
  name = (name || '').toString().trim();
  role = (role || '').toString().trim();
  studentId = (studentId || '').toString().trim();
  className = (className || '').toString().trim();
  if (!username || !name || !role) return res.status(400).json({ error: '请填写账号、姓名和角色' });
  if (!/^[A-Za-z0-9]+$/.test(username)) return res.status(400).json({ error: '账号只能包含英文字母和数字' });
  if (!['admin', 'grade', 'monitor', 'student'].includes(role)) return res.status(400).json({ error: '角色无效' });
  username = username.toLowerCase();
  // 学生账号默认等于学号（前端只读同步，此处兜底）
  if (role === 'student' && !username && studentId) username = studentId.toLowerCase();
  if (d.users.some(u => u.username === username)) return res.status(400).json({ error: '该账号已存在' });
  if (role === 'student' && !className) return res.status(400).json({ error: '学生必须填写班级' });
  if (req.user.role === 'grade' && role === 'admin') return res.status(403).json({ error: '年级无权创建管理员账号' });
  // 严格分班（2026-08-30）：年级仅可创建「学生」或「班长」，且班级须在自己管理范围内
  if (req.user.role === 'grade' && (role === 'grade' || role === 'admin')) return res.status(403).json({ error: '年级仅可创建「学生」或「班长」账号' });
  if (req.user.role === 'grade' && !assertGradeManagesClass(req, res, className)) return;
  // 初始密码：留空 → 按角色生成；填写 → 用填写值（2026-09-05 自定义密码须满足 ≥8 位非纯数字）
  if (password && !isStrongPwd(password)) return res.status(400).json({ error: '自定义初始' + WEAK_PWD_MSG });
  const finalPwd = password ? String(password) : defaultPasswordFor(role, username, studentId);
  const u = {
    id: db.genId('u'),
    username,
    password: db.hashPassword(finalPwd),
    name, role, className, studentId,
    mustChangePassword: true, // 首登强制改密
    createdAt: db.now(),
  };
  d.users.push(u);
  db.save();
  clearUsersCache(); // 用户列表缓存失效
  addLog(req.user, 'user-create', `创建账号 ${u.username}（${u.name}/${u.role}/${u.className}）`, { type: 'user', name: u.name, className: u.className, studentId: u.studentId });
  res.json({ ok: true, user: safeUser(u, d), defaultPassword: finalPwd });
});

// 重置密码（2026-09-05：目标为年级时同步重置二级审核密码=同一新密码并置 mustChangeSecondary，强制登录后设置新二级）
app.post('/api/admin/users/:id/reset-password', authRequired, requireRole('admin', 'monitor'), (req, res) => {
  const d = db.load();
  const u = d.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (req.user.role === 'grade' && u.role === 'admin') return res.status(403).json({ error: '年级无权重置管理员密码' });
  // 严格分班（2026-08-30）：年级只能重置自己管理范围内班级的账号密码
  if (req.user.role === 'grade' && !assertGradeManagesClass(req, res, u.className)) return;
  if (req.user.role === 'monitor') {
    if (u.role !== 'student') return res.status(403).json({ error: '班长只能重置本班学生密码' });
    if (u.className !== req.user.className) return res.status(403).json({ error: '只能重置本班学生密码' });
  }
  const custom = req.body.password ? String(req.body.password) : '';
  if (custom && !isStrongPwd(custom)) return res.status(400).json({ error: '自定义' + WEAK_PWD_MSG });
  const newPwd = custom || defaultPasswordFor(u.role, u.username, u.studentId);
  u.password = db.hashPassword(newPwd);
  u.mustChangePassword = true; // 重置后下次登录需修改密码
  let secNote = '';
  if (u.role === 'grade') {
    u.secondaryPassword = db.hashPassword(newPwd); // 初始二级密码与登录密码相同
    u.mustChangeSecondary = true; // 登录后强制设置新二级密码
    secNote = '；二级审核密码已同步重置（与登录密码相同，登录后需强制修改）';
  }
  db.save();
  clearUsersCache(); // 用户列表缓存失效
  addLog(req.user, 'user-reset-pwd', `重置账号 ${u.username}（${u.name}）密码${u.role === 'grade' ? '（含二级审核密码）' : ''}`, { type: 'user', name: u.name, className: u.className, studentId: u.studentId });
  res.json({ ok: true, newPassword: newPwd, note: secNote });
});

// ⚠️ 已移除 /api/admin/users/:id/show-password 接口。
// 原因：明文密码不应长期入库。学生/班/年级忘记密码一律走上方 /reset-password 流程，
//      重置后的新密码仅一次性返回，让管理员当面/私聊告知学生本人。
// 兼容旧代码：如果仍有人访问该接口，返回 410 Gone 提示已下线。

// 用户自己修改密码（清除 mustChangePassword 标志；2026-09-05 密码策略：≥8 位且非纯数字）
app.post('/api/me/change-password', authRequired, sensitiveLimiter, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!isStrongPwd(newPassword)) return res.status(400).json({ error: '新' + WEAK_PWD_MSG });
  if (!await db.verifyPassword(oldPassword || '', req.user.password)) return res.status(400).json({ error: '原密码错误' });
  const d = db.load();
  const u = d.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  u.password = db.hashPassword(newPassword);
  u.mustChangePassword = false;
  db.save();
  res.json({ ok: true });
});

// 修改账号信息（姓名/角色/班级/学号）
app.post('/api/admin/users/:id/update', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const u = d.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (req.user.role === 'grade' && u.role === 'admin') return res.status(403).json({ error: '年级无权修改管理员账号' });
  // 严格分班（2026-08-30）：年级只能修改自己管理范围内班级的账号
  if (!assertGradeManagesClass(req, res, u.className)) return;
  const { name, role, className, studentId, username } = req.body;
  // 修改登录账号（所有角色可改；学生账号仍应等于学号）
  if (username !== undefined) {
    let un = String(username).trim();
    if (!un) return res.status(400).json({ error: '账号不能为空' });
    if (!/^[A-Za-z0-9]+$/.test(un)) return res.status(400).json({ error: '账号只能包含英文字母和数字' });
    un = un.toLowerCase();
    if (d.users.some(x => x.username === un && x.id !== u.id)) return res.status(400).json({ error: '该账号已存在' });
    if (un !== u.username) {
      u.username = un;
      // 改登录名 → 清除该用户所有会话，强制重新登录
      d.sessions = (d.sessions || []).filter(s => s.userId !== u.id);
    }
  }
  // 年级端能改的目标角色限定：学生/班长（不能改成 grade / admin）
  if (role !== undefined && req.user.role === 'grade' && (role === 'grade' || role === 'admin')) {
    return res.status(403).json({ error: '年级端仅可修改账号为「学生」或「班长」' });
  }
  if (name !== undefined && name.trim()) u.name = name.trim();
  if (role !== undefined && ['admin', 'grade', 'monitor', 'student'].includes(role)) {
    if (req.user.role === 'grade' && role === 'admin') return res.status(403).json({ error: '年级无权将账号设为管理员' });
    u.role = role;
  }
  if (className !== undefined) u.className = (className || '').trim();
  // 严格分班（2026-08-30）：年级改班级时，目标班级也须在自己管理范围内（防跨班塞人）
  if (req.user.role === 'grade' && className !== undefined && !assertGradeManagesClass(req, res, u.className)) return;
  if (studentId !== undefined) u.studentId = (studentId || '').trim();
  // 4 项必填校验：student/monitor 全必填；grade/admin 仅姓名+角色必填
  if (!u.name) return res.status(400).json({ error: '姓名必填' });
  if (u.role === 'student') {
    if (!u.className) return res.status(400).json({ error: '学生必须填写班级' });
    if (!u.studentId) return res.status(400).json({ error: '学生必须填写学号' });
  }
  if (u.role === 'monitor') {
    if (!u.className) return res.status(400).json({ error: '班长必须填写班级' });
  }
  db.save();
  clearUsersCache(); // 用户列表缓存失效
  res.json({ ok: true, user: safeUser(u, d) });
});

// 导出账号凭证（仅管理员）：rows 含明文密码，仅来自创建/重置的一次性返回值，不落库
app.post('/api/admin/export-credential', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('账号凭证');
    ws.columns = [
      { header: '账号', key: 'username', width: 22 },
      { header: '姓名', key: 'name', width: 16 },
      { header: '角色', key: 'role', width: 12 },
      { header: '班级', key: 'className', width: 18 },
      { header: '初始密码', key: 'password', width: 24 },
    ];
    rows.forEach(r => ws.addRow({
      username: r.username || '', name: r.name || '', role: r.role || '',
      className: r.className || '', password: r.password || '',
    }));
    ws.getRow(1).font = { bold: true };
    // 安全导出：凭证含明文密码，必须二级密码 + 加密 + 水印
    return await secureSendWorkbook(req, res, wb, {
      pageName: '账号凭证导出', filename: 'credentials.xlsx',
      logAction: 'export-credential', logDetail: `导出账号凭证 ${rows.length} 条（含初始密码）`,
    });
  } catch (e) { res.status(500).json({ error: '导出失败：' + e.message }); }
});

// 删除账号（年级/管理员），删除该用户的 session
app.delete('/api/admin/users/:id', authRequired, requireRole('admin'), sensitiveLimiter, (req, res) => {
  const d = db.load();
  const idx = d.users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '用户不存在' });
  const target = d.users[idx];
  if (req.user.role === 'grade' && target.role === 'admin') return res.status(403).json({ error: '年级无权删除管理员账号' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能删除自己的账号' });
  d.users.splice(idx, 1);
  // 清理该用户相关 sessions
  d.sessions = (d.sessions || []).filter(s => s.userId !== target.id);
  // 账号已删除 → 级联清理其关联数据，避免孤儿记录：综测申请 / 复核材料提交 / 通知 / 旧版材料
  const uid = target.id;
  d.applications = (d.applications || []).filter(a => a.studentId !== uid);
  d.reviews = (d.reviews || []).filter(r => r.studentId !== uid);
  d.notifications = (d.notifications || []).filter(n => n.studentId !== uid);
  d.submissions = (d.submissions || []).filter(s => s.studentId !== uid);
  // 智育复核链同步清除（导入值 scores 保留，按学号独立于账号）
  if (target.studentId && d.zhiyuOverrides) delete d.zhiyuOverrides[target.studentId];
  db.save();
  clearUsersCache(); // 用户列表缓存失效
  res.json({ ok: true, cleared: { applications: d.applications.filter(a => a.studentId === uid).length, reviews: d.reviews.filter(r => r.studentId === uid).length } });
});

// 清除指定用户已提交的综测信息（仅 admin；用于测试复测）
// 保留账号本身，仅删除其：综测申请(applications) / 旧版单条材料(submissions) / 相关通知(notifications)
//   / 复核材料提交记录(reviews) 及其智育复核链(zhiyuOverrides)
// 不含磁盘附件文件，避免误删上传的 PDF/图片（记录删除，物理文件保留）
app.post('/api/admin/users/:id/clear-submissions', authRequired, requireRole('admin'), sensitiveLimiter, (req, res) => {
  const d = db.load();
  const u = d.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin') return res.status(403).json({ error: '不能清除管理员账号' });
  const targetId = u.id;
  const beforeApps = (d.applications || []).length;
  const beforeSubs = (d.submissions || []).length;
  const beforeNotis = (d.notifications || []).length;
  const beforeReviews = (d.reviews || []).length;
  d.applications = (d.applications || []).filter(a => a.studentId !== targetId);
  d.submissions = (d.submissions || []).filter(s => s.studentId !== targetId);
  d.notifications = (d.notifications || []).filter(n => n.studentId !== targetId);
  // 复核材料提交记录 + 智育复核链同步清除（复核记录已删，链值不再生效；智育导入值 scores 保留）
  d.reviews = (d.reviews || []).filter(r => r.studentId !== targetId);
  if (u.studentId && d.zhiyuOverrides) delete d.zhiyuOverrides[u.studentId];
  db.save();
  addLog(req.user, 'user-clear-submissions', `清除账号 ${u.username}（${u.name}）已提交的综测信息`, { type: 'user', name: u.name, className: u.className, studentId: u.studentId });
  res.json({
    ok: true,
    cleared: {
      applications: beforeApps - (d.applications || []).length,
      submissions: beforeSubs - (d.submissions || []).length,
      notifications: beforeNotis - (d.notifications || []).length,
      reviews: beforeReviews - (d.reviews || []).length,
    }
  });
});


// 全量数据备份（仅管理员；支持 JSON 与 Excel 两种格式）
//   /api/admin/backup          -> JSON（默认）
// 批量冻结/解冻账号（admin）：frozen=true 冻结（冻结期间不能登录、已有会话立即失效）；frozen=false 解冻
app.post('/api/admin/users/batch-freeze', authRequired, requireRole('admin'), sensitiveLimiter, (req, res) => {
  const d = db.load();
  const { ids, frozen } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '请选择要操作的账号' });
  const target = ids.map(String);
  let n = 0;
  d.users.forEach(u => {
    if (target.includes(u.id) && u.role !== 'admin') { // 不可冻结管理员账号
      u.frozen = !!frozen;
      n++;
      if (u.frozen) {
        // 冻结：清除该用户所有会话（立即踢出）
        d.sessions = (d.sessions || []).filter(s => s.userId !== u.id);
        for (const [tk, sess] of [...tokens.entries()]) { if (sess.userId === u.id) tokens.delete(tk); }
      }
    }
  });
  db.save();
  clearUsersCache(); // 用户列表缓存失效
  addLog(req.user, 'user-batch-freeze', `批量${frozen ? '冻结' : '解冻'} ${n} 个账号`, { type: 'user', name: (req.body.ids || []).length + ' 人' });
  res.json({ ok: true, frozen: !!frozen, count: n });
});

// 批量清除提交记录（仅 admin；测试阶段清理测试数据用）
// 语义与单用户 /api/admin/users/:id/clear-submissions 完全一致：
//   删 applications / submissions / notifications / reviews / zhiyuOverrides，保留账号、不删磁盘附件
// 需要二级审核密码验证（与导出/改判等敏感操作一致）；跳过 admin 账号
app.post('/api/admin/users/batch-clear-submissions', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const { ids, secondaryPassword } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '请选择要清除提交记录的账号' });
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) return res.status(403).json({ error: v.frozen ? `二级密码验证失败次数过多，已冻结，剩余 ${v.remain} 分钟` : '二级密码错误' });
  const d = db.load();
  const target = new Set(ids.map(String));
  const before = {
    applications: (d.applications || []).length,
    submissions: (d.submissions || []).length,
    notifications: (d.notifications || []).length,
    reviews: (d.reviews || []).length,
  };
  let count = 0;
  const skipped = [];
  d.users.forEach(u => {
    if (!target.has(u.id)) return;
    if (u.role === 'admin') { skipped.push(u.username); return; } // 不可清除管理员账号
    const tid = u.id;
    d.applications = (d.applications || []).filter(a => a.studentId !== tid);
    d.submissions = (d.submissions || []).filter(s => s.studentId !== tid);
    d.notifications = (d.notifications || []).filter(n => n.studentId !== tid);
    d.reviews = (d.reviews || []).filter(r => r.studentId !== tid);
    if (u.studentId && d.zhiyuOverrides) delete d.zhiyuOverrides[u.studentId];
    count++;
  });
  db.save();
  addLog(req.user, 'user-clear-submissions', `批量清除 ${count} 个账号的已提交综测信息${skipped.length ? '（跳过管理员：' + skipped.join('、') + '）' : ''}`, { type: 'user', name: count + ' 人', skipped });
  res.json({
    ok: true,
    count,
    skipped,
    cleared: {
      applications: before.applications - (d.applications || []).length,
      submissions: before.submissions - (d.submissions || []).length,
      notifications: before.notifications - (d.notifications || []).length,
      reviews: before.reviews - (d.reviews || []).length,
    }
  });
});

//   /api/admin/backup?format=xlsx -> Excel（多 sheet：users / applications / logs / config / ...）
app.get('/api/admin/backup', authRequired, requireRole('admin'), async (req, res) => {
  try { db.flushSync(); } catch (_) {}
  const fmt = String(req.query.format || 'json').toLowerCase();
  const fnameDate = new Date().toISOString().slice(0, 10);
  if (fmt === 'xlsx') {
    try {
      const ExcelJS = require('exceljs');
      const d = db.load();
      const wb = new ExcelJS.Workbook();
      wb.creator = 'zongce';
      wb.created = new Date();
      const used = {};
      Object.keys(d).forEach((k) => {
        // Excel sheet 名限制：≤31 字符、全局唯一
        let name = k.slice(0, 31);
        if (used[name]) {
          let i = 1;
          while (used[name] && i < 999) { name = (k.slice(0, 28) + '_' + i); i++; }
        }
        used[name] = true;
        const ws = wb.addWorksheet(name);
        const arr = Array.isArray(d[k]) ? d[k] : [d[k]];
        if (!arr.length || arr[0] == null) { ws.addRow(['（空）']); return; }
        const colSet = new Set();
        arr.forEach((item) => { if (item && typeof item === 'object') Object.keys(item).forEach((c) => colSet.add(c)); });
        const cols = Array.from(colSet);
        if (cols.length) {
          ws.columns = cols.map((c) => ({ header: c, key: c, width: 26 }));
          arr.forEach((item) => {
            const row = {};
            cols.forEach((c) => {
              const v = (item && typeof item === 'object') ? item[c] : item;
              if (v === null || v === undefined) row[c] = '';
              else if (typeof v === 'object') row[c] = JSON.stringify(v);
              else row[c] = v;
            });
            ws.addRow(row);
          });
          ws.getRow(1).font = { bold: true };
          ws.views = [{ state: 'frozen', ySplit: 1 }];
        } else {
          arr.forEach((item) => ws.addRow([JSON.stringify(item)]));
        }
      });
      const fname = `zongce_backup_${fnameDate}.xlsx`;
      return await secureSendWorkbook(req, res, wb, {
        pageName: '全量数据备份(Excel)', filename: fname,
        logAction: 'backup-export', logDetail: '全量数据备份 Excel 导出（含加密）',
      });
    } catch (e) {
      console.error('[backup xlsx] 失败:', e.message);
      res.status(500).json({ error: 'Excel 备份生成失败：' + e.message });
    }
    return;
  }
  // 默认 JSON
  const json = db.exportFullJson();
  const fname = `zongce_backup_${fnameDate}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(json);
});

// 总体统计（基于 applications 表）
app.get('/api/admin/stats', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const stu = d.users.filter(u => u.role === 'student');
  const apps = d.applications;
  const eff = (a) => {
    if (a.certifiedStatus === 'rejected' || a.uncertifiedStatus === 'rejected') return 'rejected';
    if (a.certifiedStatus === 'withdrawn' || a.uncertifiedStatus === 'withdrawn') return 'withdrawn';
    if (a.certifiedStatus === 'resubmit' || a.uncertifiedStatus === 'resubmit') return 'resubmit';
    if (a.certifiedStatus === 'pending' || a.uncertifiedStatus === 'pending') return 'pending';
    return 'approved';
  };
  const byStatus = {};
  apps.forEach(a => { const s = eff(a); byStatus[s] = (byStatus[s] || 0) + 1; });
  res.json({
    students: stu.length, monitors: d.users.filter(u => u.role === 'monitor').length,
    classes: [...new Set(stu.map(u => u.className))].length,
    applications: apps.length,
    approved: byStatus.approved || 0,
    pending: byStatus.pending || 0,
    rejected: byStatus.rejected || 0,
    resubmit: byStatus.resubmit || 0,
    withdrawn: byStatus.withdrawn || 0,
    objections: 0,
  });
});

// ============================================================
// 启动
// ============================================================
function getLanIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

// ============================================================
// 系统配置接口（公示开关、截止时间）
// ============================================================
// 性能优化（2026-08-30）：/api/config 30s 内存缓存；配置写端点调用 clearConfigCache() 失效
let configCache = null;
const CONFIG_CACHE_TTL = 30 * 1000;
function clearConfigCache() { configCache = null; }

app.get('/api/config', authRequired, (req, res) => {
  if (configCache && Date.now() - configCache.ts < CONFIG_CACHE_TTL) return res.json(configCache.data);
  const d = db.load();
  const data = {
    publicityEnabled: d.config.publicityEnabled !== false,
    gradeDeadline: d.config.gradeDeadline || '',
    monitorReviewDeadline: d.config.monitorReviewDeadline || '',
    submitOpenClasses: d.config.submitOpenClasses || [],
    reviewOpenClasses: d.config.reviewOpenClasses || [],
    reviewRounds: d.config.reviewRounds || { first: false, second: false, third: false },
    reviewRoundSequential: d.config.reviewRoundSequential !== false, // 默认开启「强制顺序开榜」
    reviewRoundDone: d.config.reviewRoundDone || { first: false, second: false, third: false },
    // 三榜复核截止时间（2026-09-10：到截止后学生不可 提交/撤回，年级/admin 不可退回；留空=不限制）
    firstReviewDeadline: d.config.firstReviewDeadline || '',
    secondReviewDeadline: d.config.secondReviewDeadline || '',
    thirdReviewDeadline: d.config.thirdReviewDeadline || '',
  };
  configCache = { data, ts: Date.now() };
  res.json(data);
});

// 年级开启/关闭某个复核榜次（可独立开关；开启下一榜是否受上一榜「复核完毕」限制由 reviewRoundSequential 决定）
app.post('/api/config/review-rounds', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const rr = d.config.reviewRounds || {};
  const done = d.config.reviewRoundDone || {};
  const seq = d.config.reviewRoundSequential !== false; // 默认开启
  // 强制顺序开榜：开启某榜前，上一榜须已标记「复核完毕」
  if (seq) {
    if (req.body.second === true && !done.first) return res.status(400).json({ error: '请先标记一榜复核完毕，再开启二榜' });
    if (req.body.third === true && !done.second) return res.status(400).json({ error: '请先标记二榜复核完毕，再开启三榜' });
  }
  for (const k of ['first', 'second', 'third']) {
    if (typeof req.body[k] === 'boolean') rr[k] = req.body[k];
  }
  if (typeof req.body.sequential === 'boolean') d.config.reviewRoundSequential = req.body.sequential;
  d.config.reviewRounds = rr;
  db.save();
  clearConfigCache(); // 配置缓存失效
  res.json({ ok: true, reviewRounds: rr, reviewRoundSequential: d.config.reviewRoundSequential, reviewRoundDone: done });
});

// 标记某榜「复核完毕」（年级/管理员；解除下一榜顺序开榜限制）。value=false 可取消标记。
app.post('/api/config/review-round-done', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const key = req.body.key;
  if (!['first', 'second', 'third'].includes(key)) return res.status(400).json({ error: '无效的榜次' });
  const rr = d.config.reviewRounds || {};
  const done = d.config.reviewRoundDone || {};
  if (req.body.value === false) {
    done[key] = false;
  } else {
    if (!rr[key]) return res.status(400).json({ error: '该榜尚未开启，无法标记复核完毕' });
    done[key] = true;
  }
  d.config.reviewRoundDone = done;
  db.save();
  clearConfigCache(); // 配置缓存失效
  res.json({ ok: true, reviewRoundDone: done });
});

// 修改公示开关（仅年级/管理员）
app.post('/api/config/publicity', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  d.config.publicityEnabled = req.body.enabled !== false;
  db.save();
  clearConfigCache(); // 配置缓存失效
  res.json({ ok: true, publicityEnabled: d.config.publicityEnabled });
});

// 修改截止时间（年级/管理员可设多个；班长只可设班长截止时间，不能晚于年级截止时间）
// 截止时间配置（2026-08-31 重构：去掉班长截止/退回截止，改为 学生提交截止 + 班级审批截止）
// 角色：年级/admin 可设两个时间；例外班级名单（submitOpenClasses/reviewOpenClasses）仅 admin 可设。
app.post('/api/config/deadlines', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const { gradeDeadline, monitorReviewDeadline, firstReviewDeadline, secondReviewDeadline, thirdReviewDeadline, submitOpenClasses, reviewOpenClasses } = req.body;
  const norm = (v) => {
    if (v === undefined || v === null || v === '') return '';
    const dt = new Date(v);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  };
  const g = norm(gradeDeadline);
  const mr = norm(monitorReviewDeadline);
  if (g === null || mr === null) return res.status(400).json({ error: '截止时间格式错误' });
  if (g !== null) d.config.gradeDeadline = g;
  if (mr !== null) d.config.monitorReviewDeadline = mr;
  // 三榜复核截止时间（保留）
  const r1 = norm(firstReviewDeadline); if (r1 !== null) d.config.firstReviewDeadline = r1;
  const r2 = norm(secondReviewDeadline); if (r2 !== null) d.config.secondReviewDeadline = r2;
  const r3 = norm(thirdReviewDeadline); if (r3 !== null) d.config.thirdReviewDeadline = r3;
  // 例外班级名单：仅 admin 可设（年级不可设例外）
  if (req.user.role === 'admin') {
    if (Array.isArray(submitOpenClasses)) d.config.submitOpenClasses = submitOpenClasses.map(String).filter(Boolean);
    if (Array.isArray(reviewOpenClasses)) d.config.reviewOpenClasses = reviewOpenClasses.map(String).filter(Boolean);
  }
  db.save();
  clearConfigCache(); // 配置缓存失效
  res.json({
    ok: true,
    gradeDeadline: d.config.gradeDeadline || '',
    monitorReviewDeadline: d.config.monitorReviewDeadline || '',
    submitOpenClasses: d.config.submitOpenClasses || [],
    reviewOpenClasses: d.config.reviewOpenClasses || [],
  });
});

// ============================================================
// 综测申请表（整份申请）API —— 按 2023 级纸质申请表流程
// 应用场景：学生一次提交一整份综测申请（含已认定项目清单+未认定项目清单+证明材料）
// 班长审核已认定部分；年级审核未认定部分 + 可改判已认定部分
// ============================================================

// 已认定项目固定所属项目（5 类 + 其他）
const CERT_PROJECTS = ['文明卫生', '社会服务', '集体活动', '创新能力及劳动素质', '社会实践（不含媒体类）', '其他'];
// 未认定项目类型（媒体类即属于此类）
const UNCERT_TYPES = ['社会实践（媒体类）', '活动/竞赛', '其他'];

// 校验 application 数据
function validateApplication(a) {
  if (!a.period) a.period = '';
  if (!Array.isArray(a.certifiedItems)) a.certifiedItems = [];
  if (!Array.isArray(a.uncertifiedItems)) a.uncertifiedItems = [];
  if (!Array.isArray(a.certifiedProofs)) a.certifiedProofs = [];
  if (!Array.isArray(a.uncertifiedProofs)) a.uncertifiedProofs = [];
  // 校验证明材料必传附件
  for (const p of [...a.certifiedProofs, ...a.uncertifiedProofs]) {
    if (!p.attachment || !p.attachment.url) return '证明材料必须上传附件';
  }
  // 已认定项目每行必填字段（编号/加减分）—— 空行视为被删除
  for (const it of a.certifiedItems) {
    if (!it.content) continue;
    if (!(it.code || '').toString().trim()) return `已认定项目「${it.content}」编号不能为空`;
    if (!(it.points && Number.isFinite(Number(it.points)))) return `已认定项目「${it.content}」加减分不能为空`;
  }
  // 未认定项目每行必填字段（名称/级别/时间/单位/加减分）
  for (const it of a.uncertifiedItems) {
    if (!it.name) continue;
    if (!(it.level || '').toString().trim()) return `未认定项目「${it.name}」奖项/报道级别不能为空`;
    if (!(it.date || '').toString().trim()) return `未认定项目「${it.name}」时间不能为空`;
    if (!(it.unit || '').toString().trim()) return `未认定项目「${it.name}」授予/报道单位不能为空`;
    if (!(it.points && Number.isFinite(Number(it.points)))) return `未认定项目「${it.name}」加减分不能为空`;
  }
  return null;
}

// 由 item 级状态聚合出整段状态（用于已认定/未认定部分的整体进度与流程推进）
// 重要：混态（有 approved + resubmit）不再返 'resubmit'，而是 'pending'。
//   段级 'resubmit' 这个状态只能由 override-certified/uncertified 显式设置，
//   那两个路由不走本函数（直接 a.xxxStatus = status），不受影响。
//   这样学生端补交 filter 看到 'resubmit' 段级时一定是显式段级改判（整段全补交），
//   看到 'pending' 段级时按 item.status='resubmit' 逐项过滤（混态时只列需补交的项）。
function sectionStatus(items) {
  if (!items || !items.length) return null;
  const has = (s) => items.some(it => it.status === s);
  if (has('pending')) return 'pending';
  if (has('resubmit')) return 'pending';   // 混态时返 'pending'，避免 filter 把已 approved 的项也列进补交
  if (items.every(it => it.status === 'rejected')) return 'rejected';
  return 'approved'; // 至少有一个 approved/overridden，视为本段审核完成
}

// —— 2026-09-08 同生防重（防"双活"重复计分）核心辅助 ——
// 段是否处于「活」状态：已创建且未被退回（与 /api/applications 创建拦截同口径：null / withdrawn 视为可新建或可复活）
const segActive = (s) => !!s && s !== 'withdrawn';
// 该生是否存在另一份（除 exceptId 外）含「活」段的申请（段级 pending/approved/rejected/resubmit/overridden 均算"活"）
function hasOtherActiveApp(d, studentId, exceptId) {
  return d.applications.some(a => a.id !== exceptId && a.studentId === studentId &&
    (segActive(a.certifiedStatus) || segActive(a.uncertifiedStatus)));
}

// 学生提交整份申请
app.post('/api/applications', authRequired, requireRole('student'), uploadFiles, (req, res) => {
  let body = {};
  body = parsePayload(req);
  if (body === null) return res.status(400).json({ error: '请求数据格式错误或数据过大（上限 1MB）' });
  // 截止校验（2026-08-31 重构：提交截止 + admin 例外班级放行）+ 软截止提示
  const dlChk = checkDeadline(req.user.className);
  if (dlChk.blocked) return res.status(400).json({ error: dlChk.message });
  const notInvolved = body.notInvolved === true;
  if (!notInvolved && (!body.certifiedItems?.length && !body.uncertifiedItems?.length)) {
    return res.status(400).json({ error: '请至少填写一项已认定或未认定项目，或勾选「不涉及加分」' });
  }
  // 联系电话必填（任何提交都要求，与"不涉及加分"互不冲突：声明本学期无加分也需留联系方式）
  if (!body.phone || !String(body.phone).trim()) {
    return res.status(400).json({ error: '联系电话为必填项，请填写本人联系电话' });
  }
  // 联系电话位数核验（11 位手机号，1 开头）
  if (!/^1[3-9]\d{9}$/.test(String(body.phone).trim())) {
    return res.status(400).json({ error: '联系电话格式不正确，请填写 11 位手机号' });
  }
  // 未认定项目每行字段必填校验（前端 doSubmit 已兜底，此处为防御性校验）
  if (!notInvolved && Array.isArray(body.uncertifiedItems)) {
    for (const it of body.uncertifiedItems) {
      if (!it.name) continue;
      if (!(it.level || '').toString().trim()) return res.status(400).json({ error: `未认定项目「${it.name}」奖项/报道级别不能为空` });
      if (!(it.date || '').toString().trim()) return res.status(400).json({ error: `未认定项目「${it.name}」时间不能为空` });
      if (!(it.unit || '').toString().trim()) return res.status(400).json({ error: `未认定项目「${it.name}」授予/报道单位不能为空` });
    }
  }
  // 已认定项目每行字段必填校验（目录校验：code+level 必须在 certCatalog；points 取目录值或自填 0-2）
  const d0 = db.load();
  const certCat = d0.certCatalog || [];
  const catByCode = {};
  certCat.forEach(c => { if (c.enabled !== false) catByCode[String(c.code).trim()] = c; });
  if (!notInvolved && Array.isArray(body.certifiedItems)) {
    for (const it of body.certifiedItems) {
      if (!it.code && !it.level) continue; // 空行跳过（前端只传 code/level/points，无 content）
      const code = (it.code || '').toString().trim();
      if (!code) return res.status(400).json({ error: '已认定项目序号不能为空' });
      const cat = catByCode[code];
      if (!cat) return res.status(400).json({ error: `序号 ${code} 不在已认定项目目录中，请选择有效序号` });
      const lvName = String(it.level || '').trim();
      const lv = cat.levels.find(l => String(l.level).trim() === lvName);
      if (!lv) return res.status(400).json({ error: `项目「${cat.name}」不存在等级「${lvName || '(空)'}」` });
      if (lv.points != null) {
        // 目录固定分值：以目录为准，禁止学生篡改
        it.points = lv.points;
      } else {
        // 目录未定分值：仅白名单项目（318/434/435）允许学生自填 0~2，其余由评定小组给定、拦截自填
        if (!SELF_FILL_CODES.has(code)) {
          return res.status(400).json({ error: `项目「${cat.name}」分值由评定小组给定，不支持学生自填` });
        }
        // 学生自填，0~2 且单项目不超 2 分
        const p = Number(it.points);
        if (!Number.isFinite(p) || p < 0 || p > 2) {
          return res.status(400).json({ error: `项目「${cat.name}」分值须在 0~2 之间（该等级未定分值，由学生填写）` });
        }
      }
    }
  }
  // 限制：已有进行中/已通过的申请，不能再次提交（任何段级状态既非 null 也非 withdrawn 均视为已有申请）
  const exists = d0.applications.find(a => a.studentId === req.user.id &&
    [a.certifiedStatus, a.uncertifiedStatus].some(s => s && s !== 'withdrawn'));
  if (exists) return res.status(400).json({ error: '您已有综测申请在审核中或已通过，需经班长/年级退回后才能重新提交' });
  // 解析附件：files 是按提交顺序的附件，每个证明材料按顺序从 files 中取一个
  const files = req.files || [];
  const d = db.load();
  // 文件顺序：先已认定项目附件、再未认定项目附件（与前端 doSubmit 的 fd.append 顺序一致）
  const certFileCount = notInvolved ? 0 : (body.certifiedItems || []).filter(it => it.code && it.level).length;
  const certFiles = files.slice(0, certFileCount);
  const uncFiles = files.slice(certFileCount);
  const takeCert = (i) => certFiles[i] ? { name: certFiles[i].originalname, url: '/uploads/' + certFiles[i].filename } : null;
  const takeUnc = (i) => uncFiles[i] ? { name: uncFiles[i].originalname, url: '/uploads/' + uncFiles[i].filename } : null;
  const a = {
    id: db.genId('a'), studentId: req.user.id, studentName: req.user.name,
    className: req.user.className, studentIdNo: req.user.studentId, phone: (body.phone || '').trim(),
    period: (body.period || '').trim(),
    notInvolved,
    certifiedItems: notInvolved ? [] : (body.certifiedItems || []).filter(it => it.code && it.level).map((it, i) => {
      const cat = catByCode[String(it.code || '').trim()];
      return {
        id: 'ci_' + i,
        project: cat ? cat.project : (it.project || '其他'),
        code: (it.code || '').trim(),
        level: String(it.level || '').trim(),
        // 内容 = 目录名称 + 等级（自动生成，如"中国国际大学生创新大赛（2026）院级金奖"）
        content: cat ? `${cat.name}${it.level || ''}` : (it.content || '').trim(),
        points: parseFloat(it.points) || 0,
        attachment: takeCert(i),
        status: 'pending', pointsFinal: parseFloat(it.points) || 0, reviewComment: '', resubmitNote: '',
      };
    }),
    uncertifiedItems: notInvolved ? [] : (body.uncertifiedItems || []).filter(it => it.name).map((it, i) => ({
      id: 'ui_' + i, type: it.type || '其他',
      name: (it.name || '').trim(), level: (it.level || '').trim(),
      date: (it.date || '').trim(), unit: (it.unit || '').trim(),
      points: parseFloat(it.points) || 0,
      attachment: takeUnc(i),
      status: 'pending', pointsFinal: parseFloat(it.points) || 0, reviewComment: '', resubmitNote: '',
    })),
    notes: (body.notes || '').toString().trim().slice(0, 500),
    certifiedProofs: notInvolved ? [] : (body.certifiedItems || []).filter(it => it.code && it.level).map((it, i) => {
      const cat = catByCode[String(it.code || '').trim()];
      return {
        code: (it.code || '').trim(),
        content: cat ? `${cat.name}${it.level || ''}` : (it.content || '').trim(),
        attachment: takeCert(i),
      };
    }).filter(p => p.attachment),
    uncertifiedProofs: notInvolved ? [] : (body.uncertifiedItems || []).filter(it => it.name).map((it, i) => ({
      name: (it.name || '').trim(), platform: (it.level || it.unit || '').trim(),
      attachment: takeUnc(i),
    })).filter(p => p.attachment),
    // 不涉及加分：仅进入待班长确认；否则两个部分按各自情况进入 pending
    certifiedStatus: notInvolved || body.certifiedItems?.length ? 'pending' : null,
    uncertifiedStatus: !notInvolved && body.uncertifiedItems?.length ? 'pending' : null,
    certifiedLog: [{ byRole: 'student', byName: req.user.name, action: notInvolved ? 'submit-noitems' : 'submit', comment: notInvolved ? '声明不涉及综测加分项目' : '提交已认定项目', time: db.now() }],
    uncertifiedLog: !notInvolved && body.uncertifiedItems?.length ? [{ byRole: 'student', byName: req.user.name, action: 'submit', comment: '提交未认定项目', time: db.now() }] : [],
    certifiedOverride: null, uncertifiedOverride: null,
    withdrawRequest: null,
    // 退回次数上限（2026-08-27）：情形1整表2次 / 情形2已认定1次 / 情形3未认定2次（发起即算）
    withdrawAllCount: 0, withdrawCertCount: 0, withdrawUncertCount: 0,
    objection: null, createdAt: db.now(), updatedAt: db.now(),
  };
  if (!notInvolved) {
    // 附件强制（后端兜底）：每个项目必须有证明材料附件
    for (const it of a.certifiedItems) {
      if (!it.attachment) return res.status(400).json({ error: `已认定项目「${it.content}」必须上传对应证明材料附件` });
    }
    for (const it of a.uncertifiedItems) {
      if (!it.attachment) return res.status(400).json({ error: `未认定项目「${it.name}」必须上传对应证明材料附件` });
    }
    const err = validateApplication(a);
    if (err) return res.status(400).json({ error: err });
  }
  d.applications.push(a);
  db.save();
  addLog(req.user, notInvolved ? 'app-submit-noitems' : 'app-submit', notInvolved ? '提交综测申请（不涉及加分）' : `提交综测申请（已认定${a.certifiedItems.length}项/未认定${a.uncertifiedItems.length}项）`, { type: 'application', name: a.id });
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  res.json({ ok: true, application: a, softDeadline: dlChk.soft ? dlChk.message : '' });
});

// 学生修改并重新提交（支持只修改一个部分；已退回/待补交/被驳回可修改）
app.post('/api/applications/:id/resubmit', authRequired, requireRole('student'), uploadFiles, (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id && x.studentId === req.user.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  // 截止校验：学生提交截止后任何修改都不允许（2026-08-31 软截止 + admin 例外班级放行）
  const dlChk = checkDeadline(req.user.className);
  if (dlChk.blocked) {
    return res.status(400).json({ error: '已超过学生提交截止时间，无法修改' });
  }
  // 整表已作废（学生自行退回情形1）：拒绝修改旧表，只能新建空白表
  if (a.certifiedStatus === 'withdrawn' && a.uncertifiedStatus === 'withdrawn') {
    return res.status(400).json({ error: '该申请已作废，不可修改，请重新提交新申请表' });
  }
  let body = {};
  body = parsePayload(req);
  if (body === null) return res.status(400).json({ error: '请求数据格式错误或数据过大（上限 1MB）' });
  const files = req.files || [];
  // rewrite 模式：学生申请退后被同意（情形2/3）→ 整段重写，可改/可删/可增，重写后段级 withdrawn→pending 重新进入审核流
  if (body.rewrite && ['certified', 'uncertified'].includes(body.rewrite.part)) {
    const part = body.rewrite.part;
    const submitted = body[part === 'certified' ? 'certifiedItems' : 'uncertifiedItems'] || [];
    if (!submitted.length) return res.status(400).json({ error: '请至少填写一项' });
    // 字段必填校验（与 /api/applications 一致）
    const catByCode2 = {};
    (d.certCatalog || []).forEach(c => { if (c.enabled !== false) catByCode2[String(c.code).trim()] = c; });
    if (part === 'certified') {
      for (const it of submitted) {
        if (!it.code && !it.level) continue; // 空行跳过（前端只传 code/level/points，无 content）
        const code = (it.code || '').toString().trim();
        if (!code) return res.status(400).json({ error: '已认定项目序号不能为空' });
        const cat = catByCode2[code];
        if (!cat) return res.status(400).json({ error: `序号 ${code} 不在已认定项目目录中，请选择有效序号` });
        const lvName = String(it.level || '').trim();
        const lv = cat.levels.find(l => String(l.level).trim() === lvName);
        if (!lv) return res.status(400).json({ error: `项目「${cat.name}」不存在等级「${lvName || '(空)'}」` });
        if (lv.points != null) it.points = lv.points;
        else {
          // 目录未定分值：仅白名单项目（318/434/435）允许学生自填 0~2，其余由评定小组给定、拦截自填
          if (!SELF_FILL_CODES.has(code)) {
            return res.status(400).json({ error: `项目「${cat.name}」分值由评定小组给定，不支持学生自填` });
          }
          const p = Number(it.points);
          if (!Number.isFinite(p) || p < 0 || p > 2) {
            return res.status(400).json({ error: `项目「${cat.name}」分值须在 0~2 之间（该等级未定分值，由学生填写）` });
          }
        }
      }
    } else {
      for (const it of submitted) {
        if (!it.name) continue;
        if (!(it.level || '').toString().trim()) return res.status(400).json({ error: `未认定项目「${it.name}」奖项/报道级别不能为空` });
        if (!(it.date || '').toString().trim()) return res.status(400).json({ error: `未认定项目「${it.name}」时间不能为空` });
        if (!(it.unit || '').toString().trim()) return res.status(400).json({ error: `未认定项目「${it.name}」授予/报道单位不能为空` });
      }
    }
    const partFiles = files;
    const newItems = submitted.map((it, i) => {
      const f = partFiles[i] || null;
      // 附件：优先新上传文件；否则保留前端回传的原附件（attachmentUrl/attachmentName），杜绝"重写后附件消失"
      let attachment = null;
      if (f) attachment = { name: f.originalname, url: '/uploads/' + f.filename };
      else if (it.attachmentUrl && it.attachmentName) attachment = { name: it.attachmentName, url: it.attachmentUrl };
      const base = { status: 'pending', pointsFinal: parseFloat(it.points) || 0, reviewComment: '', resubmitNote: '' };
      if (part === 'certified') {
        const cat2 = catByCode2[String(it.code || '').trim()];
        return { ...base, id: 'ci_' + i, project: cat2 ? cat2.project : (it.project || '其他'), code: (it.code || '').trim(), level: String(it.level || '').trim(), content: cat2 ? `${cat2.name}${it.level || ''}` : (it.content || '').trim(), points: parseFloat(it.points) || 0, attachment };
      }
      return { ...base, id: 'ui_' + i, type: it.type || '其他', name: (it.name || '').trim(), level: (it.level || '').trim(), date: (it.date || '').trim(), unit: (it.unit || '').trim(), points: parseFloat(it.points) || 0, attachment };
    });
    // 附件强制（后端兜底）：每行必须有证明材料（新上传或保留原附件）
    for (const it of newItems) {
      if (!it.attachment) {
        return res.status(400).json({ error: `${part === 'certified' ? '已认定' : '未认定'}项目「${part === 'certified' ? it.content : it.name}」必须上传证明材料附件（或保留原附件）` });
      }
    }
    const t = db.now();
    const partLabel = part === 'certified' ? '已认定' : '未认定';
    const itemsField = part === 'certified' ? 'certifiedItems' : 'uncertifiedItems';
    const statusField = part === 'certified' ? 'certifiedStatus' : 'uncertifiedStatus';
    const logField = part === 'certified' ? 'certifiedLog' : 'uncertifiedLog';
    const wrField = part === 'certified' ? 'withdrawRequest' : 'withdrawRequestUncert';
    // 2026-09-08 防双活（根因修复①a）：重写/复活被退回段置 pending 前，若该生已有另一份在途/已通过申请则拒绝。
    // 场景：申请退已认定被同意 → 旧表 certifiedStatus=withdrawn → 学生新建新表 → 又在旧表上 rewrite 复活 → 双活双计。
    if (a[statusField] === 'withdrawn' && hasOtherActiveApp(d, req.user.id, a.id)) {
      return res.status(400).json({ error: '您已有一份在途或已通过的综测申请，不能在已退回的旧申请表上重写提交（会造成重复计分）。请登录查看并使用您的最新申请。' });
    }
    a[itemsField] = newItems;
    a[statusField] = 'pending';
    a[logField].push({ byRole: 'student', byName: req.user.name, action: 'rewrite', comment: `重写${partLabel}段（共${newItems.length}项），重写后重新进入待审`, time: t });
    // 清空对应的 withdrawRequest 防止 stale 干扰后续判定
    if (a[wrField]) a[wrField] = null;
    a.updatedAt = t;
    // 同步 proofs
    if (part === 'certified') {
      a.certifiedProofs = newItems.filter(it => it.attachment).map(it => ({ code: it.code, content: it.content, attachment: it.attachment }));
    } else {
      a.uncertifiedProofs = newItems.filter(it => it.attachment).map(it => ({ name: it.name, platform: it.level || it.unit || '', attachment: it.attachment }));
    }
    if (typeof body.notes === 'string') a.notes = body.notes.trim().slice(0, 500);
    const err = validateApplication(a);
    if (err) return res.status(400).json({ error: err });
    db.save();
    addLog(req.user, 'app-resubmit-rewrite', `重写${partLabel}段 ${a.id}（共${newItems.length}项）`);
    addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
    return res.json({ ok: true, application: a });
  }
  let fileIdx = 0;
  const consumeFile = () => {
    if (fileIdx >= files.length) return null;
    return { name: files[fileIdx].originalname, url: '/uploads/' + files[fileIdx].filename };
  };
  const editable = (s) => ['resubmit', 'rejected', 'withdrawn'].includes(s);
  // 仅更新被退回/被驳回（且当前段允许修改）的具体项，其余 item 保持原审核结论
  let updatedCount = 0;
  const updateItems = (items, submitted, secField) => {
    if (!Array.isArray(submitted) || !Array.isArray(items)) return;
    for (const sub of submitted) {
      const item = items.find(x => x.id === sub.id);
      if (!item) continue;
      // 只有「被要求补充(resubmit)」或「所在段处于可改状态」的项才允许学生修改
      if (item.status !== 'resubmit' && !editable(a[secField])) continue;
      if (item.project !== undefined && sub.project !== undefined) item.project = sub.project;
      if (sub.content !== undefined) item.content = (sub.content || '').toString().trim();
      if (sub.code !== undefined) item.code = (sub.code || '').toString().trim();
      if (sub.points !== undefined) item.points = parseFloat(sub.points) || 0;
      if (sub.name !== undefined) item.name = (sub.name || '').toString().trim();
      if (sub.type !== undefined) item.type = sub.type || '其他';
      if (sub.level !== undefined) item.level = (sub.level || '').toString().trim();
      if (sub.date !== undefined) item.date = (sub.date || '').toString().trim();
      if (sub.unit !== undefined) item.unit = (sub.unit || '').toString().trim();
      // 附件：优先新上传文件；否则保留前端回传的原附件（attachmentUrl/attachmentName）；否则保留 item 原有附件
      if (sub.attachmentFileName) {
        const f = consumeFile();
        if (f) item.attachment = { name: sub.attachmentFileName, url: f.url };
      } else if (sub.attachmentUrl && sub.attachmentName) {
        item.attachment = { name: sub.attachmentName, url: sub.attachmentUrl };
      }
      // 附件强制（后端兜底）：被补交的项目必须有证明材料
      if (!item.attachment) {
        throw new Error((secField === 'certifiedStatus' ? '已认定' : '未认定') + '项目「' + (item.content || item.name || '') + '」必须上传证明材料附件（或保留原附件）');
      }
      // 补交后回到待审
      item.status = 'pending';
      item.resubmitNote = '';
      item.reviewComment = '';
      updatedCount++;
    }
  };
  // 2026-09-08 防双活：记录原段状态，用于识别「已退回段经普通补交被复活」的场景（根因：周郑 a1 即此路径）
  const prevCertStatus = a.certifiedStatus;
  const prevUncStatus = a.uncertifiedStatus;
  try {
    if (Array.isArray(body.certifiedItems)) {
      updateItems(a.certifiedItems, body.certifiedItems, 'certifiedStatus');
      a.certifiedStatus = sectionStatus(a.certifiedItems);
      // 2026-09-08 防双活（根因修复①b）：已退回段本次补交后复活为在途，而同生已有另一份在途/已通过申请 → 拒绝
      if (prevCertStatus === 'withdrawn' && segActive(a.certifiedStatus) && hasOtherActiveApp(d, req.user.id, a.id)) {
        throw new Error('您已有一份在途或已通过的综测申请，不能在已退回的旧申请表上补交复活（会造成重复计分）。请登录查看并使用您的最新申请。');
      }
      a.certifiedLog.push({ byRole: 'student', byName: req.user.name, action: 'resubmit', comment: '已补交/修改已认定部分被退回项目', time: db.now() });
    }
    if (Array.isArray(body.uncertifiedItems)) {
      updateItems(a.uncertifiedItems, body.uncertifiedItems, 'uncertifiedStatus');
      a.uncertifiedStatus = sectionStatus(a.uncertifiedItems);
      // 2026-09-08 防双活（根因修复①b，未认定段同理）
      if (prevUncStatus === 'withdrawn' && segActive(a.uncertifiedStatus) && hasOtherActiveApp(d, req.user.id, a.id)) {
        throw new Error('您已有一份在途或已通过的综测申请，不能在已退回的旧申请表上补交复活（会造成重复计分）。请登录查看并使用您的最新申请。');
      }
      a.uncertifiedLog.push({ byRole: 'student', byName: req.user.name, action: 'resubmit', comment: '已补交/修改未认定部分被退回项目', time: db.now() });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message || '补交内容校验失败' });
  }
  if (updatedCount === 0) return res.status(400).json({ error: '当前没有可补交/修改的项目' });
  if (typeof body.notes === 'string') a.notes = body.notes.trim().slice(0, 500);
  a.updatedAt = db.now();
  const err = validateApplication(a);
  if (err) return res.status(400).json({ error: err });
  db.save();
  addLog(req.user, 'app-resubmit', `重新提交综测申请 ${a.id}`);
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  res.json({ ok: true, application: a, softDeadline: dlChk.soft ? dlChk.message : '' });
});

// 学生的申请列表
app.get('/api/my/applications', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const list = d.applications.filter(a => a.studentId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ applications: list });
});

// 申请详情（学生/班长/年级/管理员均可）
app.get('/api/applications/:id', authRequired, (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  // 权限：学生本人 / 班长（必须本班）/ 年级管理员 / 系统管理员
  const u = req.user;
  if (u.role === 'student' && a.studentId !== u.id) return res.status(403).json({ error: '无权查看' });
  if (u.role === 'monitor' && a.className !== u.className) return res.status(403).json({ error: '无权查看其他班级' });
  // 2026-09-05：admin/grade 附带逐段修改权限标记（浅拷贝，避免污染 store 对象）
  if (u.role === 'admin' || u.role === 'grade') {
    res.json({ application: Object.assign({}, a, { _my: myModifyFlags(u, a) }) });
    return;
  }
  res.json({ application: a });
});

// 确认「不涉及加分」声明（2026-09-06 修复：notInvolved 申请无已认定项目，无法走逐项审核 review-certified）
// 班长（本班 + 班级审批截止闸门）/ 年级 / 管理员 可确认；确认后 certifiedStatus: pending → approved，整单完结留痕
app.post('/api/applications/:id/confirm-noitems', authRequired, requireRole('monitor', 'grade', 'admin'), sensitiveLimiter, (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (!a.notInvolved) return res.status(400).json({ error: '该申请不是「不涉及加分」声明，请走逐项审核' });
  if (req.user.role === 'monitor') {
    if (a.className !== req.user.className) return res.status(403).json({ error: '只能审核本班申请' });
    const cfg0 = d.config || {};
    const mr = cfg0.monitorReviewDeadline ? new Date(cfg0.monitorReviewDeadline).getTime() : 0;
    if (mr && Date.now() > mr) {
      const open = (cfg0.reviewOpenClasses || []).map(String);
      if (!open.includes(String(a.className))) {
        return res.status(403).json({ error: '已超过班级审批截止时间，无法审批（如需延期请联系管理员）' });
      }
    }
  }
  if (a.certifiedStatus !== 'pending') return res.status(400).json({ error: '该声明当前不可确认（状态已变更）' });
  a.certifiedStatus = 'approved';
  a.certifiedLog.push({ byRole: req.user.role, byName: req.user.name, action: 'confirm-noitems', comment: '确认「不涉及综测加分项目」声明', time: db.now() });
  a.updatedAt = db.now();
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id + ' (confirm-noitems)');
  res.json({ ok: true, application: a });
});

// 班长审核已认定部分
app.post('/api/applications/:id/review-certified', authRequired, requireRole('monitor', 'grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (req.user.role === 'monitor' && a.className !== req.user.className) return res.status(403).json({ error: '只能审核本班申请' });
  // 班级审批截止（2026-08-31）：仅拦班长；admin 配置的 reviewOpenClasses 例外班级可继续审批；年级/admin 不受限
  if (req.user.role === 'monitor') {
    const cfg0 = d.config || {};
    const mr = cfg0.monitorReviewDeadline ? new Date(cfg0.monitorReviewDeadline).getTime() : 0;
    if (mr && Date.now() > mr) {
      const open = (cfg0.reviewOpenClasses || []).map(String);
      if (!open.includes(String(a.className))) {
        return res.status(403).json({ error: '已超过班级审批截止时间，无法审批（如需延期请联系管理员）' });
      }
    }
  }
  if (!a.certifiedItems || !a.certifiedItems.length) return res.status(400).json({ error: '该申请无已认定项目' });
  if (a.certifiedStatus !== 'pending' && a.certifiedStatus !== 'resubmit') return res.status(400).json({ error: '已认定部分当前不可审核' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: '请选择要处理的项目' });
  const actionSet = new Set(['approve', 'reject', 'resubmit', 'override']);
  const resubmitItems = [];
  // 2026-09-08 防重复计分（根因修复②）：批量 approve/override 前校验「已认定项目编号」唯一性并原子拦截。
  // 同编号不得在本申请内重复出已通过项，也不得与该生另一份在途申请中的已通过项重复（周郑 428 双计即此场景）。
  const APPROVED_ST = ['approved', 'overridden'];
  const pendingApprove = [];
  for (const it of items) {
    if (it.action !== 'approve' && it.action !== 'override') continue;
    const item = a.certifiedItems.find(x => x.id === it.id);
    if (!item || !['pending', 'resubmit'].includes(item.status)) continue;
    pendingApprove.push(item);
  }
  const dupItem = pendingApprove.find(item => {
    const code = (item.code || '').toString().trim();
    if (!code) return false;
    // 2026-09-09 业务修正（已认定 code=435 论文 类目）：论文按数量计分（每篇一份），
    // 同 code 多档位不算重复申报。雷喆 9-7 申请 ci_0(SCI一作 pts=2) + ci_1(三作 pts=0.2) 同 code=435
    // 但分属不同档位 → 两篇不同论文各算一份，业务上合理。仅放行此目录项，其它类目（421/428 等）保持原防线。
    if (code === '435') return false;
    const sameCode = (x) => x && x.code != null && String(x.code).toString().trim() === code;
    const inSelfApproved = a.certifiedItems.some(x => sameCode(x) && APPROVED_ST.includes(x.status));
    const inOtherActiveApp = d.applications.some(b => b.id !== a.id && b.studentId === a.studentId && segActive(b.certifiedStatus) &&
      (b.certifiedItems || []).some(x => sameCode(x) && APPROVED_ST.includes(x.status)));
    const batchCount = pendingApprove.filter(x2 => sameCode(x2)).length; // 本批内同码重复
    return batchCount > 1 || inSelfApproved || inOtherActiveApp;
  });
  if (dupItem) {
    const code = (dupItem.code || '').toString().trim();
    const catN = ((d.certCatalog || []).find(c => String(c.code).trim() === code) || {}).name || code;
    return res.status(400).json({ error: `「${catN}」（编号 ${code}）疑似重复申报：${a.studentName || '该生'} 已有相同项目的已通过记录（本申请其他项或另一份在途申请）。请先退回/撤销旧记录再审核，避免重复计分。` });
  }
  for (const it of items) {
    const item = a.certifiedItems.find(x => x.id === it.id);
    if (!item || !actionSet.has(it.action)) continue;
    // 防御：跳过已审项（approved/rejected/overridden/withdrawn），只对 pending/resubmit 项生效；
    // 避免前端误送导致历史结论被覆盖（如补交部分 item 后整段被 batch review 误改）
    if (!['pending', 'resubmit'].includes(item.status)) continue;
    item.reviewComment = (it.comment || '').toString().slice(0, 300);
    item.reviewBy = (req.user.role === 'monitor' ? '班长' : '年级') + '·' + req.user.name;
    if (it.action === 'approve') { item.status = 'approved'; item.pointsFinal = Number(item.pointsFinal ?? item.points) || 0; item.resubmitNote = ''; }
    else if (it.action === 'reject') { item.status = 'rejected'; item.pointsFinal = 0; item.resubmitNote = ''; }
    else if (it.action === 'resubmit') { item.status = 'resubmit'; item.resubmitNote = (it.comment || '请补充相关材料'); }
    else if (it.action === 'override') { item.status = 'overridden'; item.pointsFinal = Number(it.points) || 0; item.resubmitNote = ''; }
    if (it.action === 'resubmit') resubmitItems.push(item);
  }
  a.certifiedStatus = sectionStatus(a.certifiedItems);
  a.certifiedLog.push({ byRole: req.user.role, byName: req.user.name, action: 'review-items', comment: `批量审核已认定项目（共 ${items.length} 项操作）`, time: db.now() });
  a.updatedAt = db.now();
  if (resubmitItems.length) {
    d.notifications.push({
      id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
      content: `您的综测申请「已认定部分」有 ${resubmitItems.length} 项被要求补充材料，请登录系统补交。`,
      fromRole: req.user.role, fromName: req.user.name, type: 'resubmit', read: false, createdAt: db.now(),
    });
  }
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  res.json({ ok: true, application: a });
});

// 年级审核未认定部分
app.post('/api/applications/:id/review-uncertified', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (!assertGradeCanReview(req, res, a.className, 'uncertified')) return;
  if (!a.uncertifiedItems || !a.uncertifiedItems.length) return res.status(400).json({ error: '该申请无未认定项目' });
  if (a.uncertifiedStatus !== 'pending' && a.uncertifiedStatus !== 'resubmit') return res.status(400).json({ error: '未认定部分当前不可审核' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: '请选择要处理的项目' });
  const actionSet = new Set(['approve', 'reject', 'resubmit', 'override']);
  const resubmitItems = [];
  let textChanged = 0; // 2026-09-06：名称/级别文字修正计数（未认定负责人/管理员可改，随审核落库）
  for (const it of items) {
    const item = a.uncertifiedItems.find(x => x.id === it.id);
    if (!item || !actionSet.has(it.action)) continue;
    // 防御：跳过已审项（approved/rejected/overridden/withdrawn），只对 pending/resubmit 项生效
    if (!['pending', 'resubmit'].includes(item.status)) continue;
    // 文字修正：name（活动/竞赛名称，≤100 字）/ level（奖项/报道级别，≤50 字），非空才落库，原值为空时也允许补填
    if (it.name !== undefined && String(it.name).trim()) {
      const nn = String(it.name).trim().slice(0, 100);
      if (nn !== item.name) { item.name = nn; textChanged++; }
    }
    if (it.level !== undefined && String(it.level).trim()) {
      const ll = String(it.level).trim().slice(0, 50);
      if (ll !== item.level) { item.level = ll; textChanged++; }
    }
    // 归类：仅「认定通过/改分」计分项需归类（2026-09-09b：驳回/补交不计分 → 免归类、不改 gradedCategory）：
    //   媒体类默认归社会实践报告，审核方可在有效类目内改（2026-09-09 放开）；非媒体类必须提供有效归类
    if (it.action === 'approve' || it.action === 'override') {
      if (item.type === '社会实践（媒体类）') {
        const cat = it.category;
        item.gradedCategory = (cat && Object.prototype.hasOwnProperty.call(BASE_SCORES, cat)) ? cat : '社会实践报告';
      } else {
        const cat = it.category;
        if (!cat || !Object.prototype.hasOwnProperty.call(BASE_SCORES, cat)) {
          return res.status(400).json({ error: `非媒体类未认定项目「${item.type || item.name || '未命名'}」选择认定通过/改分时必须选择归类项` });
        }
        item.gradedCategory = cat;
      }
    }
    item.reviewComment = (it.comment || '').toString().slice(0, 300);
    item.reviewBy = '年级·' + req.user.name;
    if (it.action === 'approve') { item.status = 'approved'; item.pointsFinal = Number(item.pointsFinal ?? item.points) || 0; item.resubmitNote = ''; }
    else if (it.action === 'reject') { item.status = 'rejected'; item.pointsFinal = 0; item.resubmitNote = ''; }
    else if (it.action === 'resubmit') { item.status = 'resubmit'; item.resubmitNote = (it.comment || '请补充相关材料'); }
    else if (it.action === 'override') { item.status = 'overridden'; item.pointsFinal = Number(it.points) || 0; item.resubmitNote = ''; }
    if (it.action === 'resubmit') resubmitItems.push(item);
  }
  a.uncertifiedStatus = sectionStatus(a.uncertifiedItems);
  a.uncertifiedLog.push({ byRole: 'grade', byName: req.user.name, action: 'review-items', comment: `批量审核未认定项目（共 ${items.length} 项操作${textChanged ? `，含 ${textChanged} 处名称/级别文字修正` : ''}）`, time: db.now() });
  a.updatedAt = db.now();
  if (resubmitItems.length) {
    d.notifications.push({
      id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
      content: `您的综测申请「未认定部分」有 ${resubmitItems.length} 项被要求补充材料，请登录系统补交。`,
      fromRole: 'grade', fromName: req.user.name, type: 'resubmit', read: false, createdAt: db.now(),
    });
  }
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  res.json({ ok: true, application: a });
});

// 年级改判已认定部分（仅年级/管理员）
const STATUS_CN = { pending: '待审核', approved: '已通过', rejected: '已驳回', resubmit: '待补交', withdrawn: '已退回' };
app.post('/api/applications/:id/override-certified', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  // 严格分班（2026-08-30）：年级只能改判自己管理范围内的班级
  if (!assertGradeManagesClass(req, res, a.className)) return;
  if (!a.certifiedItems || !a.certifiedItems.length) return res.status(400).json({ error: '该申请无已认定项目' });
  const { status, comment } = req.body;
  if (!['pending', 'approved', 'rejected', 'resubmit'].includes(status)) return res.status(400).json({ error: '无效的状态' });
  if (status === a.certifiedStatus) return res.status(400).json({ error: '新状态与当前状态相同' });
  if (!comment || comment.trim().length < 3) return res.status(400).json({ error: '改判必须填写理由（至少3字）' });
  // 2026-09-08 防双活（根因修复①c）：把已退回段改判回在途/通过前，若该生已有另一份在途/已通过申请则拒绝
  if (a.certifiedStatus === 'withdrawn' && hasOtherActiveApp(d, a.studentId, a.id)) {
    return res.status(400).json({ error: `该生 ${a.studentName || ''} 已有一份在途或已通过的综测申请，不能把此已退回的申请改判回「${STATUS_CN[status] || status}」（会造成重复计分），请先处理其最新申请。` });
  }
  // 整段改判（段级）：只改 certifiedStatus，保留各 item 的逐项审核状态与 pointsFinal
  // 不再连带覆写 item.status / item.pointsFinal，避免丢失班长已审分值；
  // 补交/重审由段级状态驱动（前端 resubmit 过滤在 certifiedStatus==='resubmit' 时列出全部已认定项）
  a.certifiedStatus = status;
  a.certifiedOverride = { byName: req.user.name, comment: comment.trim(), time: db.now() };
  a.certifiedLog.push({ byRole: 'grade', byName: req.user.name, action: 'override', comment: `改判为「${STATUS_CN[status] || status}」：${comment.trim()}`, time: db.now() });
  a.updatedAt = db.now();
  if (status === 'rejected' || status === 'resubmit') {
    d.notifications.push({
      id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
      content: `您的综测申请「已认定部分」被年级改判为「${status}」：${comment.trim()}`,
      fromRole: 'grade', fromName: req.user.name, type: status, read: false, createdAt: db.now(),
    });
  }
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  // 审计：改判（段级）含前后状态
  logAudit(req, 'override', { type: '已认定段', scope: a.className || '' }, {
    before: { status: a.certifiedStatus },
    after: { status },
    reason: (comment || '').trim().slice(0, 200),
  }, 'success');
  res.json({ ok: true, application: a });
});

// 学生退回/申请退回 状态判定
// 「已审核」= 审核人已对该部分做过处理（含 通过/驳回/改判/要求补交）；「未审核」= 未填/待审
const REVIEWED_SET = ['approved', 'rejected', 'overridden', 'resubmit'];
const isReviewed = (s) => REVIEWED_SET.includes(s);
const isUnreviewed = (s) => !s || s === 'pending';

// 学生退回入口（情形1）：两端均未审核 → 自行退回整张表重填，不需审批
app.post('/api/applications/:id/withdraw', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id && x.studentId === req.user.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (!(isUnreviewed(a.certifiedStatus) && isUnreviewed(a.uncertifiedStatus))) {
    return res.status(400).json({ error: '当前不符合「两端均未审核」的自行退回条件（需班长和年级都未审核），请联系班长/年级处理' });
  }
  // 截止校验（2026-08-31 重构：退回并入学生提交截止，admin 例外班级放行）
  const dlChk = checkDeadline(req.user.className);
  if (dlChk.blocked) {
    return res.status(400).json({ error: '已超过学生提交截止时间，无法发起退回' });
  }
  // 整表退回次数上限（2次）
  if ((a.withdrawAllCount || 0) >= 2) {
    return res.status(400).json({ error: '已超过整表退回次数上限（2次），无法再次退回' });
  }
  const reason = ((req.body && req.body.reason) || '').toString().trim();
  if (reason.length < 3) return res.status(400).json({ error: '请填写退回理由（至少3字）' });
  const t = db.now();
  a.withdrawAllCount = (a.withdrawAllCount || 0) + 1;
  if (a.certifiedStatus) {
    a.certifiedStatus = 'withdrawn';
    a.certifiedLog.push({ byRole: 'student', byName: req.user.name, action: 'withdraw-all', comment: `学生自行退回整表重填（已认定部分）；理由：${reason}`, time: t });
  }
  if (a.uncertifiedStatus) {
    a.uncertifiedStatus = 'withdrawn';
    a.uncertifiedLog.push({ byRole: 'student', byName: req.user.name, action: 'withdraw-all', comment: `学生自行退回整表重填（未认定部分）；理由：${reason}`, time: t });
  }
  a.updatedAt = t;
  d.notifications.push({
    id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
    content: `您的综测申请已退回，可修改后重新提交。理由：${reason}`,
    fromRole: 'system', fromName: '系统', type: 'withdraw', read: false, createdAt: t,
  });
  db.save();
  addLog(req.user, 'app-withdraw-all', `学生自行退回整表 ${a.id}（班长/年级均未审核）；理由：${reason}`);
  res.json({ ok: true, application: a });
});

// 学生申请退回已认定部分（情形2）：已认定已审核 + 未认定未审核 → 需班长同意
app.post('/api/applications/:id/withdraw-certified', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id && x.studentId === req.user.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (!(isReviewed(a.certifiedStatus) && isUnreviewed(a.uncertifiedStatus))) {
    return res.status(400).json({ error: '当前不符合「已认定已审核、未认定未审核」的退回条件' });
  }
  const dlChk2 = checkDeadline(req.user.className);
  if (dlChk2.blocked) {
    return res.status(400).json({ error: '已超过学生提交截止时间，无法发起退回申请' });
  }
  if (a.withdrawRequest && a.withdrawRequest.status === 'pending') {
    return res.status(400).json({ error: '已有待处理的退回请求，请等待班长同意' });
  }
  // 已认定退回次数上限（1次，发起即算，即使被拒绝也消耗）
  if ((a.withdrawCertCount || 0) >= 1) {
    return res.status(400).json({ error: '已超过已认定退回次数上限（1次），无法再次申请退回' });
  }
  const reason = ((req.body && req.body.reason) || '').toString().trim();
  if (reason.length < 3) return res.status(400).json({ error: '请填写退回理由（至少3字）' });
  const t = db.now();
  a.withdrawCertCount = (a.withdrawCertCount || 0) + 1;
  a.withdrawRequest = { status: 'pending', byStudent: req.user.name, reason, time: t, part: 'certified' };
  a.certifiedLog.push({ byRole: 'student', byName: req.user.name, action: 'withdraw-req-cert', comment: `申请退回已认定部分；理由：${reason}`, time: t });
  d.notifications.push({
    id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
    content: `学生 ${a.studentName} 申请退回已认定部分，请处理`,
    fromRole: 'student', fromName: req.user.name, type: 'withdraw', read: false,
    toMonitor: a.className, createdAt: t,
  });
  a.updatedAt = t;
  db.save();
  addLog(req.user, 'app-withdraw-req-cert', `学生申请退回已认定部分 ${a.id}；理由：${reason}`);
  res.json({ ok: true, application: a });
});

// 学生申请退回未认定部分（情形3）：已认定未审核 + 未认定已审核 → 需年级/管理员同意
app.post('/api/applications/:id/withdraw-uncertified', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id && x.studentId === req.user.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (!(isUnreviewed(a.certifiedStatus) && isReviewed(a.uncertifiedStatus))) {
    return res.status(400).json({ error: '当前不符合「已认定未审核、未认定已审核」的退回条件' });
  }
  const dlChk3 = checkDeadline(req.user.className);
  if (dlChk3.blocked) {
    return res.status(400).json({ error: '已超过学生提交截止时间，无法发起退回申请' });
  }
  if (a.withdrawRequestUncert && a.withdrawRequestUncert.status === 'pending') {
    return res.status(400).json({ error: '已有待处理的退回请求，请等待年级同意' });
  }
  // 未认定退回次数上限（2次，发起即算，即使被拒绝也消耗）
  if ((a.withdrawUncertCount || 0) >= 2) {
    return res.status(400).json({ error: '已超过未认定退回次数上限（2次），无法再次申请退回' });
  }
  const reason = ((req.body && req.body.reason) || '').toString().trim();
  if (reason.length < 3) return res.status(400).json({ error: '请填写退回理由（至少3字）' });
  const t = db.now();
  a.withdrawUncertCount = (a.withdrawUncertCount || 0) + 1;
  a.withdrawRequestUncert = { status: 'pending', byStudent: req.user.name, reason, time: t, part: 'uncertified' };
  a.uncertifiedLog.push({ byRole: 'student', byName: req.user.name, action: 'withdraw-req-uncert', comment: `申请退回未认定部分；理由：${reason}`, time: t });
  d.notifications.push({
    id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
    content: `学生 ${a.studentName} 申请退回未认定部分，请处理`,
    fromRole: 'student', fromName: req.user.name, type: 'withdraw', read: false, createdAt: t,
  });
  a.updatedAt = t;
  db.save();
  addLog(req.user, 'app-withdraw-req-uncert', `学生申请退回未认定部分 ${a.id}；理由：${reason}`);
  res.json({ ok: true, application: a });
});

// 班长/年级/管理员 处理退回请求（同意 → 对应部分退回学生；拒绝 → 维持原状）
// part: 'certified'（已认定，班长/年级/admin 可处理）| 'uncertified'（未认定，仅年级/admin 可处理）
app.post('/api/applications/:id/handle-withdraw', authRequired, requireRole('monitor', 'grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  // 严格分班（2026-08-30）：年级只能处理自己管理范围内的班级
  if (!assertGradeManagesClass(req, res, a.className)) return;
  const part = (req.body && req.body.part) || 'certified';
  if (part !== 'certified' && part !== 'uncertified') return res.status(400).json({ error: '无效的退回部分' });
  // 未认定部分退回请求仅年级/管理员可处理（班长无未认定审核权）
  if (part === 'uncertified' && req.user.role === 'monitor') {
    return res.status(403).json({ error: '未认定部分退回请求仅年级/管理员可处理' });
  }
  if (req.user.role === 'monitor' && a.className !== req.user.className) return res.status(403).json({ error: '只能处理本班申请' });
  const wr = part === 'uncertified' ? a.withdrawRequestUncert : a.withdrawRequest;
  if (!wr || wr.status !== 'pending') return res.status(400).json({ error: '没有待处理的退回请求' });
  const { agree, comment } = req.body;
  const t = db.now();
  const statusField = part === 'uncertified' ? 'uncertifiedStatus' : 'certifiedStatus';
  const logArr = part === 'uncertified' ? a.uncertifiedLog : a.certifiedLog;
  const partLabel = part === 'uncertified' ? '未认定部分' : '已认定部分';
  if (agree) {
    a[statusField] = 'withdrawn';
    wr.status = 'approved';
    wr.replyBy = req.user.name;
    wr.replyComment = comment || '';
    wr.replyTime = t;
    logArr.push({ byRole: req.user.role, byName: req.user.name, action: 'withdraw-ok', comment: `同意学生退回${partLabel}`, time: t });
    d.notifications.push({
      id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
      content: `您的退回申请已被同意，可修改后重新提交${comment ? '（' + comment + '）' : ''}`,
      fromRole: req.user.role, fromName: req.user.name, type: 'withdraw-ok', read: false, createdAt: t,
    });
  } else {
    wr.status = 'rejected';
    wr.replyBy = req.user.name;
    wr.replyComment = comment || '不同意退回';
    wr.replyTime = t;
    logArr.push({ byRole: req.user.role, byName: req.user.name, action: 'withdraw-reject', comment: `不同意退回${partLabel}：` + (comment || '无'), time: t });
    d.notifications.push({
      id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
      content: `您的退回申请被驳回${comment ? '：' + comment : '，维持原结果'}`,
      fromRole: req.user.role, fromName: req.user.name, type: 'withdraw-reject', read: false, createdAt: t,
    });
  }
  a.updatedAt = t;
  db.save();
  addLog(req.user, 'app-handle-withdraw', `处理退回申请 ${a.id} part=${part} agree=${agree}${comment ? ' 意见：' + comment : ''}`);
  res.json({ ok: true, application: a });
});

// 班长/年级主动退回（纠错或「不涉及加分」误提交时使用）：将对应部分退回给学生修改
app.post('/api/applications/:id/force-withdraw-certified', authRequired, requireRole('monitor', 'grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  if (req.user.role === 'monitor' && a.className !== req.user.className) return res.status(403).json({ error: '只能处理本班申请' });
  if (!['pending', 'approved', 'rejected', 'resubmit'].includes(a.certifiedStatus)) {
    return res.status(400).json({ error: '当前状态不允许退回' });
  }
  const { comment } = req.body;
  if (!comment || comment.trim().length < 3) return res.status(400).json({ error: '请填写退回理由（至少3字）' });
  a.certifiedStatus = 'withdrawn';
  a.certifiedLog.push({ byRole: req.user.role, byName: req.user.name, action: 'force-withdraw', comment: `${req.user.role === 'monitor' ? '班长' : '年级'}主动退回：${comment.trim()}`, time: db.now() });
  a.updatedAt = db.now();
  d.notifications.push({
    id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
    content: `您的综测申请「已认定部分」被${req.user.role === 'monitor' ? '班长' : '年级'}退回，请修改后重新提交。理由：${comment.trim()}`,
    fromRole: req.user.role, fromName: req.user.name, type: 'withdraw', read: false, createdAt: db.now(),
  });
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  res.json({ ok: true, application: a });
});

app.post('/api/applications/:id/force-withdraw-uncertified', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  // 严格分班（2026-08-30）：年级只能退回自己管理范围内的班级
  if (!assertGradeManagesClass(req, res, a.className)) return;
  if (!['pending', 'approved', 'rejected', 'resubmit'].includes(a.uncertifiedStatus)) {
    return res.status(400).json({ error: '当前状态不允许退回' });
  }
  const { comment } = req.body;
  if (!comment || comment.trim().length < 3) return res.status(400).json({ error: '请填写退回理由（至少3字）' });
  a.uncertifiedStatus = 'withdrawn';
  a.uncertifiedLog.push({ byRole: 'grade', byName: req.user.name, action: 'force-withdraw', comment: `年级主动退回：${comment.trim()}`, time: db.now() });
  a.updatedAt = db.now();
  d.notifications.push({
    id: db.genId('n'), studentId: a.studentId, applicationId: a.id,
    content: `您的综测申请「未认定部分」被年级退回，请修改后重新提交。理由：${comment.trim()}`,
    fromRole: 'grade', fromName: req.user.name, type: 'withdraw', read: false, createdAt: db.now(),
  });
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id);
  res.json({ ok: true, application: a });
});

// ============================================================
// 二级审核密码
// ============================================================
// 修改二级审核密码（初始为 默认二级密码；每人独立）。
// 若仍使用默认初始密码，允许免"当前密码"直接改（强制改密流程）；否则必须校验当前密码。新密码至少 6 位。
// 设置/修改二级审核密码（2026-09-05：放开 admin + grade；新密码 ≥8 位且非纯数字）
app.post('/api/me/secondary-password', authRequired, requireRole('admin', 'grade'), sensitiveLimiter, async (req, res) => {
  const { current, next } = req.body || {};
  if (!next) return res.status(400).json({ error: '请填写新二级密码' });
  if (!isStrongPwd(next)) return res.status(400).json({ error: '新二级' + WEAK_PWD_MSG });
  const u = req.user;
  // 免「当前密码」情形：①首次设置（尚无二级密码）②重置后强制修改（mustChangeSecondary）③admin 仍为旧默认值 默认二级密码
  const isDefault = !!(u.secondaryPassword && await db.verifyPassword(DEFAULT_SECONDARY_PASSWORD, u.secondaryPassword));
  const isFirstSet = !u.secondaryPassword;
  if (!isDefault && !isFirstSet && !u.mustChangeSecondary) {
    if (!current) return res.status(400).json({ error: '请填写当前二级密码' });
    if (!await db.verifyPassword(current, u.secondaryPassword)) return res.status(401).json({ error: '当前二级密码错误' });
  }
  u.secondaryPassword = db.hashPassword(next);
  u.mustChangeSecondary = false;
  db.save();
  addLog(u, 'secpwd-change', (isFirstSet ? '首次设置二级审核密码' : isDefault ? '首次强制修改二级审核密码（原为默认初始值）' : '修改二级审核密码'));
  res.json({ ok: true, mustChangeSecondary: false });
});

// 2026-08-17 B'-16：仅校验二级密码正确性，不改任何数据。供复核"修改已审项"前置验证用。
// 2026-09-05：放开 admin + grade（年级改已认定项目等敏感动作的前置校验）。
app.post('/api/me/verify-secondary', authRequired, requireRole('admin', 'grade'), sensitiveLimiter, async (req, res) => {
  const { secondaryPassword } = req.body || {};
  if (!secondaryPassword) return res.status(400).json({ error: '请输入二级审核密码' });
  if (!req.user.secondaryPassword) return res.status(400).json({ error: '当前账号未配置二级审核密码' });
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return v.frozen ? res.status(403).json({ error: `二级审核密码连续错误次数过多，已冻结 ${v.remain} 分钟` }) : res.status(401).json({ error: '二级审核密码错误' });
  }
  res.json({ ok: true });
});

// 已认定/未认定追改（2026-09-05 按段授权重构）：
//   - admin：可改任意班级的已认定 + 未认定段（不受截止闸门限制）
//   - grade：仅可改【未认定段】且须为该班 uncertified 桶负责人（无时间闸门）；
//           仅可改【已认定段】且须为该班 certModify 桶负责人，且未过班级审批截止（过截止仅 admin 可改，延期班除外）
//   - 任意角色提交均须携带 ≥5 字修改原因（reason）
app.post('/api/applications/:id/grade-modify', authRequired, requireRole('admin', 'grade'), sensitiveLimiter, async (req, res) => {
  const d = db.load();
  const a = d.applications.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '申请不存在' });
  const { secondaryPassword, certifiedItems, uncertifiedItems, reason } = req.body || {};
  if (!secondaryPassword) return res.status(400).json({ error: '请输入二级审核密码' });
  const reasonTxt = String(reason || '').trim();
  if (reasonTxt.length < 5) return res.status(400).json({ error: '请填写修改原因（至少 5 个字）' });
  // 逐段授权
  const wantCert = Array.isArray(certifiedItems) && certifiedItems.length > 0;
  const wantUncert = Array.isArray(uncertifiedItems) && uncertifiedItems.length > 0;
  if (wantCert && req.user.role === 'grade') {
    if (!assertGradeCanReview(req, res, a.className, 'certModify')) return;
    if (certSectionLocked(a.className, d)) {
      return res.status(403).json({ error: '已超过班级审批截止时间，该班已认定项目仅系统管理员可修改（如需延期请联系管理员）' });
    }
  }
  if (wantUncert && req.user.role === 'grade') {
    if (!assertGradeCanReview(req, res, a.className, 'uncertified')) return;
  }
  if (req.user.role === 'grade' && !req.user.secondaryPassword) {
    return res.status(403).json({ error: '您尚未设置二级审核密码，请先在「修改密码」中设置后再操作' });
  }
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return v.frozen ? res.status(403).json({ error: '二级审核密码连续错误次数过多，已冻结 30 分钟' }) : res.status(401).json({ error: '二级审核密码错误' });
  }
  // apply：cert/uncert 共用；allowText=true 时（仅未认定段）额外允许修正 name/level（≤100/≤50，非空落库），返回文字修正处数
  const apply = (items, submitted, allowText) => {
    let tc = 0;
    if (!Array.isArray(submitted) || !Array.isArray(items)) return tc;
    for (const sub of submitted) {
      const item = items.find(x => x.id === sub.id);
      if (!item) continue;
      if (sub.status && ['approved', 'rejected', 'overridden'].includes(sub.status)) item.status = sub.status;
      if (sub.points !== undefined) item.pointsFinal = Number(sub.points) || 0;
      if (sub.comment !== undefined) item.reviewComment = (sub.comment || '').toString().slice(0, 300);
      if (allowText) {
        if (sub.name !== undefined && String(sub.name).trim()) {
          const nn = String(sub.name).trim().slice(0, 100);
          if (nn !== item.name) { item.name = nn; tc++; }
        }
        if (sub.level !== undefined && String(sub.level).trim()) {
          const ll = String(sub.level).trim().slice(0, 50);
          if (ll !== item.level) { item.level = ll; tc++; }
        }
      }
      item.reviewBy = '年级·' + req.user.name;
    }
    return tc;
  };
  let tcCert = 0, tcUncert = 0;
  if (wantCert && a.certifiedItems && a.certifiedItems.length) {
    tcCert = apply(a.certifiedItems, certifiedItems, false);
    a.certifiedStatus = sectionStatus(a.certifiedItems);
    a.certifiedLog.push({ byRole: req.user.role === 'admin' ? 'admin' : 'grade', byName: req.user.name, action: 'grade-modify', comment: `二级密码验证后修改已认定项目，原因：${reasonTxt}`, time: db.now() });
  }
  if (wantUncert && a.uncertifiedItems && a.uncertifiedItems.length) {
    tcUncert = apply(a.uncertifiedItems, uncertifiedItems, true);
    a.uncertifiedStatus = sectionStatus(a.uncertifiedItems);
    a.uncertifiedLog.push({ byRole: req.user.role === 'admin' ? 'admin' : 'grade', byName: req.user.name, action: 'grade-modify', comment: `二级密码验证后修改未认定项目，原因：${reasonTxt}${tcUncert ? `（含 ${tcUncert} 处名称/级别文字修正）` : ''}`, time: db.now() });
  }
  if (!wantCert && !wantUncert) return res.status(400).json({ error: '没有需要修改的项目' });
  a.updatedAt = db.now();
  db.save();
  addLog(req.user, 'app-action', '综测申请操作 ' + a.id + ' (grade-modify)');
  // 审计：改判（逐项修改）
  logAudit(req, 'override', { type: '已审核项目逐项修改', scope: a.className || '' }, {
    changedCert: wantCert ? certifiedItems.length : 0,
    changedUncert: wantUncert ? uncertifiedItems.length : 0,
    textChanged: tcCert + tcUncert,
    reason: reasonTxt,
  }, 'success');
  res.json({ ok: true, application: a });
});

// ==================== 智育/教师评价 导入落库（阶段二）====================
// 上传 xlsx，写入 d.scores[学号][field]
// field: 'zhiyu'（智育成绩，全量：学号 + 智育成绩列） | 'teacher'（教师评价分，名单制）
// 2026-09-09 教师评价分名单制改造（业务拍板）：
//   - 名单只列有特殊分值的学生（其余学生读取时统一按 TEACHER_BASE_SCORE=1.5 基准，见 getTeacherScore）
//   - 名单列：学号 或 姓名（可加「班级」列消歧）+ 「教师评价分」/「加分」列
//   - 姓名全库唯一才命中；未找到 → 姓名未匹配报告；重名无班级消歧 → 重名歧义报告（提示补学号/班级）
//   - 学号优先于姓名；每次上传 = 全量替换当前教师名单（先清旧 teacher 值再写本次名单）
// 智育导入逻辑保持原样不动（学号必填全量覆盖单值）
app.post('/api/admin/scores/import', authRequired, requireRole('admin'), officeUpload.array('files', 1), async (req, res) => {
  const field = String((req.body || {}).field || '').trim();
  if (!['zhiyu', 'teacher'].includes(field)) {
    return res.status(400).json({ error: '请指定导入类型（field=zhiyu 智育成绩 / field=teacher 教师评价分）' });
  }
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '请上传成绩文件（.xlsx）' });
  const label = field === 'zhiyu' ? '智育成绩' : '教师评价分';
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(files[0].path);
    const ws = wb.worksheets[0];
    const hdr = ws.getRow(1);
    const colMap = {};
    hdr.eachCell((cell, col) => { const h = String(cell.value || '').trim(); if (h) colMap[h] = col; });
    // 列号统一取数字（colMap 值），禁止把表头文本当列号传给 getCell
    const colOf = (exact, incl) => {
      if (exact && colMap[exact] != null) return colMap[exact];
      const k = Object.keys(colMap).find(x => incl(x));
      return k != null ? colMap[k] : null;
    };
    const sidCol = colOf('学号', k => k.includes('学号'));
    const nameCol = colOf('姓名', k => k.includes('姓名'));
    const clsCol = colOf(null, k => k.includes('班级'));
    const valCol = colOf(label, k => k.includes(field === 'zhiyu' ? '智育' : '教师') || k.includes('加分'));
    if (!valCol) return res.status(400).json({ error: `文件需包含「${label}」列` });
    if (field === 'zhiyu' && !sidCol) return res.status(400).json({ error: '智育成绩文件需包含「学号」列' });
    if (field === 'teacher' && !sidCol && !nameCol) return res.status(400).json({ error: '教师评价分名单需包含「学号」或「姓名」列' });
    const d = db.load();
    d.scores = d.scores || {};
    let imported = 0, matched = 0;
    // 教师名单检索索引（姓名可重名 → 数组）
    let stuBySid = null, stuByName = null;
    if (field === 'teacher') {
      stuBySid = new Map();
      stuByName = new Map();
      for (const u of d.users) {
        if (u.role !== 'student' || !u.id) continue;
        if (u.studentId) stuBySid.set(String(u.studentId).trim(), u);
        const nm = (u.name || '').trim();
        if (!nm) continue;
        if (!stuByName.has(nm)) stuByName.set(nm, []);
        stuByName.get(nm).push(u);
      }
      // 名单制 = 全量替换：清空旧 teacher 值（zhiyu 保留），本次名单为当前权威覆盖集
      for (const k of Object.keys(d.scores)) delete d.scores[k].teacher;
    }
    const sidSet = new Set(d.users.filter(u => u.role === 'student' && u.studentId).map(u => u.studentId));
    const unmatchedNames = [];   // 姓名未匹配到任何学生
    const ambiguousNames = [];   // 重名未消歧项：[{name,value,cls,candidates:[{sid,name,className,currentTeacher}]}]，前端用于内联补传卡片
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      const v = row.getCell(valCol).value;
      const num = Number(v);
      if (!Number.isFinite(num)) return;
      if (field === 'zhiyu') {
        const sid = String(row.getCell(sidCol).value || '').trim();
        if (!sid) return;
        d.scores[sid] = d.scores[sid] || {};
        d.scores[sid][field] = num;
        imported++;
        if (sidSet.has(sid)) matched++;
        return;
      }
      // 教师名单：学号优先 → 无学号按姓名（重名时班级列消歧）
      let hit = null;
      const sidRaw = sidCol ? String(row.getCell(sidCol).value || '').trim() : '';
      if (sidRaw) hit = stuBySid.get(sidRaw) || null;
      if (!hit && nameCol) {
        const nm = String(row.getCell(nameCol).value || '').trim();
        if (nm) {
          const cands = stuByName.get(nm) || [];
          if (cands.length === 1) hit = cands[0];
          else if (cands.length === 0) { unmatchedNames.push(nm); return; }
          else {
            const cls = clsCol ? String(row.getCell(clsCol).value || '').trim() : '';
            const inCls = cls ? cands.filter(u => (u.className || '').includes(cls) || cls.includes(u.className || '')) : [];
            if (inCls.length === 1) hit = inCls[0];
            else { ambiguousNames.push({ name: nm, value: num, cls: cls || '', candidates: cands.map(u => ({ sid: u.studentId || '', name: u.name || '', className: u.className || '', currentTeacher: (d.scores[u.studentId] && d.scores[u.studentId].teacher != null) ? Number(d.scores[u.studentId].teacher) : null })) }); return; }
          }
        }
      }
      if (!hit) return;
      d.scores[hit.studentId] = d.scores[hit.studentId] || {};
      d.scores[hit.studentId][field] = num;
      imported++; matched++;
    });
    if (!imported && !unmatchedNames.length && !ambiguousNames.length) {
      return res.status(400).json({ error: '文件中没有可导入的有效数据（学号/姓名 + 分值）' });
    }
    db.save();
    addLog(req.user, 'scores-import', `导入${label}：共 ${imported} 条，匹配到系统学生 ${matched} 条${unmatchedNames.length ? `，姓名未找到 ${unmatchedNames.length} 条` : ''}${ambiguousNames.length ? `，重名歧义 ${ambiguousNames.length} 条（待消歧：${ambiguousNames.slice(0, 5).map(a => a.name + '×' + a.candidates.length).join('、')}${ambiguousNames.length > 5 ? '等' : ''}）` : ''}`);
    // 审计（维度一/二）：导入智育/教师评价
    logAudit(req, field === 'zhiyu' ? 'import_zhiyu' : 'import_teacher', {
      type: field === 'zhiyu' ? '智育成绩' : '教师评价分',
      fileName: files[0].originalname || '',
      recordCount: imported,
    }, { matched, unmatchedNames: unmatchedNames.length, ambiguousNames: ambiguousNames.length }, 'success');
    try { require('fs').unlinkSync(files[0].path); } catch (e) {}
    res.json({ ok: true, field, label, 导入条数: imported, 匹配学生数: matched, 姓名未匹配: unmatchedNames, 重名歧义: ambiguousNames });
  } catch (e) {
    try { require('fs').unlinkSync(files[0].path); } catch (err) {}
    res.status(400).json({ error: `${label}文件解析失败：` + (e.message || e) });
  }
});

// 重名歧义追加补传（2026-09-09 内联补传卡片配套端点）
// ⚠ 关键差异：与 import 的"先清全库 teacher 再写名单"不同——本端点**只追加**消歧项，不动其他学生的 teacher 值。
// 接受 {resolutions:[{name,value,disambiguator:{sid?} 或 cls?}]}，唯一命中候选时写入 d.scores[sid].teacher，
// 仍歧义/无候选/参数非法入 failed 报告，**不抛错**以便前端一次性看到所有结果。
app.post('/api/admin/scores/resolve-ambiguous', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const resolutions = Array.isArray((req.body || {}).resolutions) ? req.body.resolutions : [];
    if (!resolutions.length) return res.status(400).json({ error: '请提供 resolutions 列表' });
    const d = db.load();
    d.scores = d.scores || {};
    const stuByName = new Map();
    for (const u of d.users) {
      if (u.role !== 'student' || !u.id) continue;
      const nm = (u.name || '').trim();
      if (!nm) continue;
      if (!stuByName.has(nm)) stuByName.set(nm, []);
      stuByName.get(nm).push(u);
    }
    let success = 0;
    const failed = [];
    for (const r of resolutions) {
      const name = String(r.name || '').trim();
      const value = Number(r.value);
      if (!name || !Number.isFinite(value)) { failed.push({ name, value, reason: 'name/value 非法' }); continue; }
      const cands = stuByName.get(name) || [];
      if (!cands.length) { failed.push({ name, value, reason: '系统无此姓名' }); continue; }
      const dis = r.disambiguator || {};
      let hit = null;
      if (dis.sid) {
        hit = cands.find(u => String(u.studentId || '').trim() === String(dis.sid).trim()) || null;
        if (!hit) { failed.push({ name, value, reason: '学号不在该姓名的候选中' }); continue; }
      } else if (dis.cls) {
        const inCls = cands.filter(u => (u.className || '').includes(dis.cls) || dis.cls.includes(u.className || ''));
        if (inCls.length === 1) hit = inCls[0];
        else if (inCls.length > 1) { failed.push({ name, value, reason: '班级在候选中仍歧义' }); continue; }
        else { failed.push({ name, value, reason: '班级不在候选中' }); continue; }
      } else if (cands.length === 1) {
        hit = cands[0];
      } else {
        failed.push({ name, value, reason: '需提供 disambiguator.sid 或 disambiguator.cls' });
        continue;
      }
      d.scores[hit.studentId] = d.scores[hit.studentId] || {};
      d.scores[hit.studentId].teacher = value;
      success++;
    }
    if (success) db.save();
    addLog(req.user, 'scores-resolve-ambiguous', `重名消歧追加：成功 ${success} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`);
    logAudit(req, 'resolve_teacher_ambiguous', { type: '教师评价分', mode: '重名消歧追加' }, { success, failed: failed.length }, success ? 'success' : 'partial');
    res.json({ ok: true, 补传成功: success, 补传失败: failed });
  } catch (e) {
    res.status(400).json({ error: '重名消歧补传失败：' + (e.message || e) });
  }
});

// 查看已导入的分值概况（admin）
app.get('/api/admin/scores/summary', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const entries = Object.entries(d.scores || {});
  const withZhiyu = entries.filter(([, v]) => v && v.zhiyu != null).length;
  const withTeacher = entries.filter(([, v]) => v && v.teacher != null).length;
  const studentCount = d.users.filter(u => u.role === 'student' && u.studentId).length;
  // 2026-09-09 名单制：教师评价恒可用（名单覆盖 + 基准分兜底），teacherReady 供前端不再按"导入>0"拦截
  res.json({ 学生总数: studentCount, 已导入智育: withZhiyu, 已导入教师评价: withTeacher, teacherReady: true, 教师评价名单: withTeacher, 教师评价基准分: TEACHER_BASE_SCORE, 智育复核链条数: Object.keys(d.zhiyuOverrides || {}).length });
});

// 清除已导入的智育成绩 / 教师评价分（admin，需二级审核密码；连带清智育复核链，避免悬空）
app.post('/api/admin/scores/clear', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const { secondaryPassword } = req.body || {};
  if (!secondaryPassword) return res.status(400).json({ error: '请输入二级审核密码' });
  if (!req.user.secondaryPassword) return res.status(400).json({ error: '当前账号未配置二级审核密码' });
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return v.frozen ? res.status(403).json({ error: `二级审核密码连续错误次数过多，已冻结 ${v.remain} 分钟` }) : res.status(401).json({ error: '二级审核密码错误' });
  }
  const d = db.load();
  const clearedScores = Object.keys(d.scores || {}).length;
  const clearedZhiyuOverrides = Object.keys(d.zhiyuOverrides || {}).length;
  d.scores = {};
  d.zhiyuOverrides = {};
  db.save();
  addLog(req.user, 'scores-clear', `清除已导入的智育/教师评价数据（scores ${clearedScores} 条，智育复核链 ${clearedZhiyuOverrides} 条）`);
  res.json({ ok: true, clearedScores, clearedZhiyuOverrides });
});

// ==================== 智育成绩计算（admin）====================
// 2026-08-27 新增：上传成绩表 + 必修课学分表，按大三上必修课计算智育成绩
// 2026-08-31 整学年化（用户拍板）：固定整学年，学分表收"大三上+大三下"两行，成绩表第一列=学期
//   （2025-2026-1=大三上 / 2025-2026-2=大三下），两学期合并加权计算；旧单学期文件自动兼容
// 规则（用户确认 2026-08-27 + 2026-08-31）：
//   - 只取成绩表"导出"sheet；筛选 是否必修=必修 且 是否重修=正常
//   - 学分表取"大三上"+"大三下"两行（按学期双键存储）；临床医学+临床医学（5+3一体化）共用一份必修课清单
//   - 成绩表学期列：优先按表头（学年学期/学期/开课学期/学年）识别，找不到取第 1 列；无法识别归入"上"（兼容旧表）
//   - 课程名标准化：去《》/（）/( )/空格；保留①②；麻醉学"技能学实验②"="机能学实验②"
//   - 去重按 课程+学期（跨学期同名课两学期都计入）；总评成绩：数字直接用；缓考→跳过（学分不计）；旷考→0分（学分计入）；优95/良85/中75/及格60/不及格40/通过60
//   - 学分：优先成绩表学分，缺失/0 用学分表补
//   - 智育 = Σ(成绩×学分) × 0.68 / Σ学分（整学年合并加权，0.68 固定）；无记录课程缺失不计
app.post('/api/admin/zhiscores/calculate', authRequired, requireRole('admin'), officeUpload.array('files', 2), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length !== 2) return res.status(400).json({ error: '请上传两份文件：学生成绩表 + 课程学分表' });
    const ExcelJS = require('exceljs');
    const fs = require('fs');

    const scoreBook = new ExcelJS.Workbook();
    await scoreBook.xlsx.readFile(files[0].path);
    const creditBook = new ExcelJS.Workbook();
    await creditBook.xlsx.readFile(files[1].path);

    // ---------- 1. 解析学分表（大三上 + 大三下）----------
    // 结构：每行 [专业(合并), 学期, 课程1, 学分1, 课程2, 学分2, ...]；学期列取"大三上/大三下"
    const normName = (s) => String(s || '').replace(/[《》（）()（）]/g, '').replace(/\s+/g, '').trim();
    // 学期归一化：大三上/…-1 → '上'；大三下/…-2 → '下'；无法识别返回原串
    const semKey = (t) => {
      const s = String(t == null ? '' : t).trim();
      if (s.includes('上') || /-1\s*$/.test(s)) return '上';
      if (s.includes('下') || /-2\s*$/.test(s)) return '下';
      return s;
    };
    // 学分表"技能学实验②" = 成绩表"机能学实验②"（麻醉学，用户确认视为同一门）
    const creditAlias = { '技能学实验②': '机能学实验②' };
    const creditsByProf = {}; // { 学分表专业名: { 学期key('上'|'下'): { 标准化课程名: 学分 } } }
    const creditTerms = []; // 学分表实际读到的学期（去重、保序）
    let creditSheet = null;
    for (const ws of creditBook.worksheets) {
      if (ws.rowCount > 1) { creditSheet = ws; break; }
    }
    if (!creditSheet) return res.status(400).json({ error: '课程学分表解析失败：未找到数据工作表' });
    let curProf = '';
    creditSheet.eachRow((row, rn) => {
      const vals = row.values; // 1-based
      if (rn === 1 && (vals[1] === '专业' || vals[2] === '学期')) return; // 表头（若有）
      const profRaw = vals[1] != null ? String(vals[1]).trim() : '';
      const termRaw = vals[2] != null ? String(vals[2]).trim() : '';
      if (profRaw) curProf = profRaw;
      const term = semKey(termRaw);
      if (term !== '上' && term !== '下') return; // 只收上下学期行
      if (!curProf) return;
      if (!creditTerms.includes(term)) creditTerms.push(term);
      creditsByProf[curProf] = creditsByProf[curProf] || {};
      creditsByProf[curProf][term] = creditsByProf[curProf][term] || {};
      for (let i = 3; i + 1 <= vals.length; i += 2) {
        const cname = vals[i];
        const ccred = vals[i + 1];
        if (cname == null || String(cname).trim() === '') continue;
        let nm = normName(cname);
        if (creditAlias[nm]) nm = creditAlias[nm];
        creditsByProf[curProf][term][nm] = parseFloat(ccred) || 0;
      }
    });
    // 专业映射：成绩表专业 → 学分表专业（临床医学+5+3 共用）
    const profToCredit = {};
    for (const p in creditsByProf) {
      if (p.includes('临床医学')) {
        profToCredit['临床医学'] = p;
        profToCredit['临床医学(5加3一体化)'] = p;
      } else {
        profToCredit[p] = p;
      }
    }
    // 按 (专业, 学期) 取必修课清单
    const creditList = (scoreProf, term) => {
      const p = profToCredit[scoreProf];
      return p ? (creditsByProf[p][term] || null) : null;
    };

    // ---------- 2. 解析成绩表（"导出"sheet）----------
    // 表头行定位列
    const scoreSheet = scoreBook.getWorksheet('导出') || scoreBook.worksheets[0];
    const headerRow = scoreSheet.getRow(1);
    const colIdx = {};
    headerRow.eachCell((cell, col) => {
      const h = String(cell.value || '').trim();
      if (h) colIdx[h] = col;
    });
    const need = ['学号', '姓名', '专业', '课程名称', '学分', '是否必修', '是否重修', '总评成绩'];
    for (const h of need) {
      if (!colIdx[h]) return res.status(400).json({ error: `成绩表缺少列「${h}」（表头第1行须包含）` });
    }
    // 学期列定位：优先按表头名识别，找不到则取第 1 列（教务导出格式：2025-2026-1=大三上 / 2025-2026-2=大三下）
    let termCol = null;
    for (const h of ['学年学期', '学期', '开课学期', '学年']) {
      if (colIdx[h]) { termCol = colIdx[h]; break; }
    }
    if (termCol == null) termCol = 1;
    // 取该行学期 key；无法识别（如旧表无学期列）→ 默认归入 '上'（兼容旧文件：整表视为单学期池）
    const rowTerm = (row) => {
      const k = semKey(row.getCell(termCol).value);
      return (k === '上' || k === '下') ? k : '上';
    };
    // 等级→分数
    const GRADE = { '优': 95, '良': 85, '中': 75, '及格': 60, '不及格': 40, '通过': 60 };

    const students = {}; // 学号 → 聚合
    const warnings = [];
    const seenCourse = {}; // 学号→{ 学期key: Set(课程) } 用于缺课检测（按课程+学期区分，防跨学期同名课被去重丢弃）
    scoreSheet.eachRow((row, rn) => {
      if (rn === 1) return;
      const get = (h) => row.getCell(colIdx[h]).value;
      const prof = String(get('专业') || '').trim();
      const sid = String(get('学号') || '').trim();
      const sname = String(get('姓名') || '').trim();
      const course = String(get('课程名称') || '').trim();
      const bixiu = String(get('是否必修') || '').trim();
      const chongxiu = String(get('是否重修') || '').trim();
      if (!sid || !course) return;
      // 只保留 必修 + 正常
      if (bixiu !== '必修' || chongxiu !== '正常') return;
      const term = rowTerm(row);
      const clist = creditList(prof, term);
      const nm = normName(course);
      const crd = clist && clist[nm];
      if (!crd) {
        // 不是该专业该学期必修课（如选修/其他学期课程）→ 忽略
        return;
      }
      if (!students[sid]) {
        students[sid] = { 专业: prof, 姓名: sname, 学号: sid, items: [], skip: [], missing: [], marks: [] };
        seenCourse[sid] = {};
      }
      const st = students[sid];
      seenCourse[sid][term] = seenCourse[sid][term] || new Set();
      if (seenCourse[sid][term].has(nm)) return; // 同课同学期重复行去重（重修记录已被过滤）
      seenCourse[sid][term].add(nm);
      // 学分：优先成绩表，缺失/0 用学分表补
      const rawC = parseFloat(get('学分'));
      const credit = (rawC && rawC > 0) ? rawC : crd;
      // 总评成绩解析
      const zpRaw = get('总评成绩');
      const zp = String(zpRaw == null ? '' : zpRaw).trim();
      if (zp === '' || zp === '缓考') {
        st.skip.push({ course, reason: zp === '缓考' ? '缓考' : '无成绩' });
        return;
      }
      let score = null, mark = '';
      if (/^\d+(\.\d+)?$/.test(zp)) {
        score = parseFloat(zp);
      } else if (GRADE[zp] !== undefined) {
        score = GRADE[zp]; mark = zp;
      } else if (zp === '旷考') {
        score = 0; mark = '旷考';
      } else {
        warnings.push({ 学号: sid, 姓名: sname, 课程: course, 问题: `总评成绩无法解析：「${zp}」，该课未计入` });
        st.skip.push({ course, reason: '无法解析' });
        return;
      }
      st.items.push({ course, nm, credit, score, mark, term });
      if (mark) st.marks.push(`${course}(${mark}→${score})`);
    });

    // ---------- 3. 汇总每个学生智育成绩（整学年：两学期合并加权） ----------
    const results = [];
    const missingWarn = [];
    for (const sid in students) {
      const st = students[sid];
      // 缺课检测：按学期分别比对（学分表清单 - 该学期已有记录；skip 课也算"有记录"）
      const has = seenCourse[sid];
      for (const term of ['上', '下']) {
        const clist = creditList(st.专业, term);
        for (const cname in (clist || {})) {
          if (!(has[term] || new Set()).has(cname)) {
            st.missing.push(`[${term}]${cname}`);
            missingWarn.push({ 学号: sid, 姓名: st.姓名, 专业: st.专业, 学期: term, 课程: cname, 问题: '学分表必修课无成绩记录（未计入）' });
          }
        }
      }
      // 整学年合并加权：智育 = Σ(成绩×学分)×0.68 / Σ学分（两学期合并成一个池子）
      const weighted = st.items.reduce((s, it) => s + it.score * it.credit, 0);
      const totalCredit = st.items.reduce((s, it) => s + it.credit, 0);
      const zhiyu = totalCredit > 0 ? (weighted * 0.68) / totalCredit : 0;
      // 计算过程：按学期分段展示 → 合并加权公式
      const byTerm = { 上: [], 下: [] };
      st.items.forEach(it => { byTerm[it.term] = byTerm[it.term] || []; byTerm[it.term].push(it); });
      const termParts = ['上', '下'].filter(t => byTerm[t] && byTerm[t].length).map(t => {
        const w = byTerm[t].reduce((s, it) => s + it.score * it.credit, 0);
        const c = byTerm[t].reduce((s, it) => s + it.credit, 0);
        return `${t}(${byTerm[t].length}门):${byTerm[t].map(it => `${fmtNum(it.score)}*${fmtNum(it.credit)}`).join('+')}=${fmtNum(w)}/${fmtNum(c)}`;
      });
      const process = totalCredit > 0
        ? `${termParts.join(' ；')} → (${fmtNum(weighted)})*0.68/${fmtNum(totalCredit)} = ${fmtNum(zhiyu)}`
        : '无有效成绩';
      results.push({
        专业: st.专业, 姓名: st.姓名, 学号: st.学号,
        智育成绩: Number(zhiyu.toFixed(4)),
        计算过程: process,
        缺课: st.missing, 缓考或空: st.skip.map(s => s.course), 标记: st.marks,
      });
    }
    // 排序：专业 → 学号
    const profOrder = ['临床医学', '临床医学(5加3一体化)', '麻醉学', '医学检验技术', '医学影像技术', '医学影像学'];
    results.sort((a, b) => {
      const pa = profOrder.indexOf(a.专业), pb = profOrder.indexOf(b.专业);
      if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return String(a.学号).localeCompare(String(b.学号));
    });

    // 清理临时文件
    files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });

    res.json({
      ok: true,
      总数: results.length,
      缺课记录: missingWarn.length,
      学期: creditTerms, // 学分表实际读到的学期（'上'/'下'）
      results,
      warnings: [...warnings, ...missingWarn],
      学分表专业: Object.keys(creditsByProf),
    });
  } catch (e) {
    console.error('[zhiscores] 计算失败:', e.message);
    (req.files || []).forEach(f => { try { require('fs').unlinkSync(f.path); } catch (err) {} });
    res.status(500).json({ error: '智育成绩计算失败：' + (e.message || e) });
  }
});

// 智育成绩导出 xlsx
app.post('/api/admin/zhiscores/export', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  try {
    const { rows, meta } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: '缺少计算结果' });
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('智育成绩');
    ws.addRow(['专业', '姓名', '学号', '智育成绩', '计算过程', '缺课', '缓考/空', '标记']);
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow([
        r.专业 || '', r.姓名 || '', r.学号 || '',
        r.智育成绩 != null ? Number(r.智育成绩) : '',
        r.计算过程 || '',
        (r.缺课 || []).join('、'),
        (r.缓考或空 || []).join('、'),
        (r.标记 || []).join('；'),
      ]);
    }
    ws.columns.forEach(c => c.width = 22);
    return await secureSendWorkbook(req, res, wb, {
      pageName: '智育成绩导出', filename: 'zhiscores.xlsx',
      logAction: 'export-zhiscores', logDetail: `智育成绩导出（${rows.length} 行）`,
      exportAction: 'export', recordCount: rows.length, scope: '全年级',
    });
  } catch (e) {
    console.error('[zhiscores] 导出失败:', e.message);
    res.status(500).json({ error: '导出失败：' + (e.message || e) });
  }
});

// ==================== 已认定项目目录（certCatalog）====================
// 2026-08-30：学生端"已认定项目"改为从目录选择（输入序号→选等级→自动带出名称与分值）。
// admin 可在线增删改条目（序号/名称/类别/等级/分值/启用）。登录用户可读启用条目。
// 结构：[{ id, code, name, project, levels:[{level, points|null}], note, enabled }]
app.get('/api/cert-catalog', authRequired, (req, res) => {
  const d = db.load();
  const list = (d.certCatalog || []).filter(c => c.enabled !== false);
  res.json({ items: list });
});

// admin 目录 CRUD
app.get('/api/admin/cert-catalog', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  res.json({ items: d.certCatalog || [] });
});

app.post('/api/admin/cert-catalog', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const { code, name, project, levels, note, enabled } = req.body || {};
  if (!String(code || '').trim()) return res.status(400).json({ error: '序号不能为空' });
  if (!String(name || '').trim()) return res.status(400).json({ error: '项目名称不能为空' });
  if (!String(project || '').trim()) return res.status(400).json({ error: '所属类别不能为空' });
  if (!Array.isArray(levels) || !levels.length) return res.status(400).json({ error: '至少配置一个等级' });
  for (const lv of levels) {
    if (!String(lv.level || '').trim()) return res.status(400).json({ error: '等级名称不能为空' });
    if (lv.points != null && !(Number.isFinite(Number(lv.points)) && Number(lv.points) >= -5 && Number(lv.points) <= 5)) {
      return res.status(400).json({ error: `等级「${lv.level}」分值须在 -5 ~ 5 之间` });
    }
  }
  const code2 = String(code).trim();
  if ((d.certCatalog || []).some(c => c.code === code2)) {
    return res.status(400).json({ error: `序号 ${code2} 已存在，请直接修改或换序号` });
  }
  const item = {
    id: db.genId('cc'),
    code: code2,
    name: String(name).trim(),
    project: String(project).trim(),
    levels: levels.map(l => ({ level: String(l.level).trim(), points: l.points == null || l.points === '' ? null : Number(l.points) })),
    note: String(note || '').trim(),
    enabled: enabled !== false,
    updatedAt: db.now(),
  };
  d.certCatalog = d.certCatalog || [];
  d.certCatalog.push(item);
  db.save();
  addLog(req.user, 'cert-catalog', `新增已认定项目目录条目 ${code2} ${item.name}`);
  res.json({ ok: true, item });
});

app.put('/api/admin/cert-catalog/:id', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  let item = (d.certCatalog || []).find(c => c.id === req.params.id);
  // 兜底：旧数据可能缺 id，按 code 匹配（防止编辑静默变成新增）
  if (!item && req.body && req.body.code != null) {
    item = (d.certCatalog || []).find(c => String(c.code).trim() === String(req.body.code).trim());
  }
  if (!item) return res.status(404).json({ error: '条目不存在' });
  const { code, name, project, levels, note, enabled } = req.body || {};
  const code2 = code != null ? String(code).trim() : item.code;
  if (!code2) return res.status(400).json({ error: '序号不能为空' });
  if ((d.certCatalog || []).some(c => c.id !== item.id && c.code === code2)) {
    return res.status(400).json({ error: `序号 ${code2} 已被其他条目占用` });
  }
  if (name != null && !String(name).trim()) return res.status(400).json({ error: '项目名称不能为空' });
  if (project != null && !String(project).trim()) return res.status(400).json({ error: '所属类别不能为空' });
  if (levels != null) {
    if (!Array.isArray(levels) || !levels.length) return res.status(400).json({ error: '至少配置一个等级' });
    for (const lv of levels) {
      if (!String(lv.level || '').trim()) return res.status(400).json({ error: '等级名称不能为空' });
      if (lv.points != null && !(Number.isFinite(Number(lv.points)) && Number(lv.points) >= -5 && Number(lv.points) <= 5)) {
        return res.status(400).json({ error: `等级「${lv.level}」分值须在 -5 ~ 5 之间` });
      }
    }
    item.levels = levels.map(l => ({ level: String(l.level).trim(), points: l.points == null || l.points === '' ? null : Number(l.points) }));
  }
  if (code != null) item.code = code2;
  if (name != null) item.name = String(name).trim();
  if (project != null) item.project = String(project).trim();
  if (note != null) item.note = String(note).trim();
  if (enabled !== undefined) item.enabled = enabled !== false;
  item.updatedAt = db.now();
  db.save();
  addLog(req.user, 'cert-catalog', `修改已认定项目目录条目 ${item.code} ${item.name}`);
  res.json({ ok: true, item });
});

app.delete('/api/admin/cert-catalog/:id', authRequired, requireRole('admin'), sensitiveLimiter, (req, res) => {
  const d = db.load();
  const idx = (d.certCatalog || []).findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '条目不存在' });
  const [removed] = d.certCatalog.splice(idx, 1);
  db.save();
  addLog(req.user, 'cert-catalog', `删除已认定项目目录条目 ${removed.code} ${removed.name}`);
  res.json({ ok: true });
});

// ==================== 证明材料 zip 打包下载（admin，2026-08-31）====================
// 支持按 班级(mode=class, scope=班级全名) / 专业(mode=major, scope=专业名) / 整个年级(mode=year) 打包。
// archiver 流式生成，不整包进内存；文件名固定 materials.zip（ASCII，避免中文头问题）。
app.post('/api/admin/export-material-zip', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const { mode = 'year', scope = '', secondaryPassword } = req.body || {};
  if (!secondaryPassword) return res.status(400).json({ error: '请输入二级审核密码' });
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return v.frozen
      ? res.status(403).json({ error: `二级审核密码连续错误次数过多，已冻结 ${v.remain} 分钟` })
      : res.status(401).json({ error: '二级审核密码错误' });
  }
  const d = db.load();
  let list = d.applications || [];
  if (mode === 'class') list = list.filter(a => a.className === scope);
  else if (mode === 'major') list = list.filter(a => String(a.className || '').replace(/\d+班$/, '') === scope);
  if (!list.length) return res.status(400).json({ error: `该${mode === 'class' ? '班级' : mode === 'major' ? '专业' : '范围'}没有已提交的申请材料` });
  // 收集附件（学生目录：班级/姓名_学号/序号_文件名，防重名）
  const entries = [];
  for (const a of list) {
    const dir = `${a.className || '未分班'}/${a.studentName || '未知'}_${a.studentId || ''}`;
    let i = 0;
    const push = (p) => {
      if (!p || !p.attachment || !p.attachment.url) return;
      const fp = path.join(__dirname, p.attachment.url);
      if (!fs.existsSync(fp)) return;
      entries.push({ fp, name: `${dir}/${++i}_${String(p.attachment.name || path.basename(fp)).replace(/[\/\\:*?"<>|]/g, '_')}` });
    };
    (a.certifiedProofs || []).forEach(push);
    (a.uncertifiedProofs || []).forEach(push);
  }
  if (!entries.length) return res.status(400).json({ error: '该范围暂无证明材料附件' });
  const modeLabel = mode === 'class' ? '班级' : mode === 'major' ? '专业' : '年级';
  const scopeLabel = (scope || (mode === 'year' ? '全部' : ''));
  const ts = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace(/[T:]/g, '');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="materials.zip"`);
  const archive = archiver('zip', { zlib: { level: 1 } }); // level 1 快速；材料多为图片/PDF，深压缩收益低
  archive.on('error', (err) => { console.error('[zip] 打包失败:', err.message); res.destroy(); });
  archive.pipe(res);
  entries.forEach(e => archive.file(e.fp, { name: e.name }));
  archive.finalize();
  addLog(req.user, 'export-material-zip', `打包下载证明材料（${modeLabel}「${scopeLabel}」，${entries.length} 个附件，${list.length} 份申请）`);
});

// ============================================================
// 综测全程备案导出（2026-08-31）
// 按范围（全年级/按专业/按班级/按个人）导出每位学生：
//   1 份 Word 全程备案文档 + 证明材料按阶段分类归档（zip）
// 权限：仅 admin，需二级审核密码；>50 人走异步任务（24h 下载链接）
// ============================================================
const EXPORT_DIR = path.join(__dirname, 'export-jobs');   // 异步任务产物目录（本地 fallback 模式）
const EXPORT_SYNC_LIMIT = 50;                             // ≤50 人同步流式返回；>50 异步任务（仅本地 fallback 模式）
const EXPORT_JOB_TTL = 24 * 3600 * 1000;                  // 本地模式：产物/下载链接 24h 有效
const EXPORT_TASK_TIMEOUT = 60 * 60 * 1000;               // 单任务 60 分钟超时，超时自动失败（用户方案 R2 分批下载）
const EXPORT_QUEUE_MAX = 3;                               // 异步任务排队上限（超过返回 409）
const R2_EXPORT_TTL = 7 * 24 * 3600 * 1000;               // R2 上的导出文件保留 7 天，到期自动清理（按对象 LastModified）
const EXPORT_JOBS = new Map();                            // jobId -> job 描述
const EXPORT_QUEUE = [];                                  // 异步任务 FIFO 队列（同时仅 1 个生成中）
let EXPORT_RUNNING = false;                               // 是否正在生成异步任务
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
// 启动时清空本地历史产物：内存任务表（EXPORT_JOBS）重启即失效，磁盘遗留文件无法再下载，
// 且 TTL 清扫器只认内存任务 → 不清空将产生永不清除的孤儿文件
try {
  for (const f of fs.readdirSync(EXPORT_DIR)) {
    try { fs.unlinkSync(path.join(EXPORT_DIR, f)); } catch (_) {}
  }
} catch (_) {}
// R2 模式：启动时清理已过期（>7 天）的导出文件（按对象 LastModified 判断，与内存任务表无关）
if (r2.R2_ENABLED) { setImmediate(() => { cleanupExpiredR2Exports().catch(() => {}); }); }
// 定期扫描：任务超时兜底 + 清理过期任务记录（每 30 分钟一次）+ R2 过期文件清理（每 6 小时）
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of EXPORT_JOBS) {
    // 任务超时兜底（循环内亦有逐学生检查；此处兜住卡死场景）
    if (job.status === 'running' && job.startedAt && now - job.startedAt > EXPORT_TASK_TIMEOUT) {
      job.status = 'failed';
      job.error = '任务超时（60 分钟），已自动终止';
      job.cancelled = true; // 让生成循环尽早退出
    }
    const ttl = job.mode === 'r2' ? R2_EXPORT_TTL : EXPORT_JOB_TTL; // R2 任务记录保留 7 天（可再生成下载链接）
    if (now - job.createdAt > ttl) {
      if (job.mode !== 'r2' && job.file && fs.existsSync(job.file)) { try { fs.unlinkSync(job.file); } catch (_) {} }
      EXPORT_JOBS.delete(id);
    }
  }
  // 清理队列中已过期/已取消的任务
  for (let i = EXPORT_QUEUE.length - 1; i >= 0; i--) {
    if (!EXPORT_JOBS.has(EXPORT_QUEUE[i].job.id)) EXPORT_QUEUE.splice(i, 1);
  }
}, 30 * 60 * 1000).unref();
// R2 过期文件清理（每 6 小时）：删除 exports/ 前缀下 LastModified 超 7 天的对象
setInterval(() => { cleanupExpiredR2Exports().catch(() => {}); }, 6 * 3600 * 1000).unref();
async function cleanupExpiredR2Exports() {
  if (!r2.R2_ENABLED) return;
  const objs = await r2.listObjects('exports/');
  const cutoff = Date.now() - R2_EXPORT_TTL;
  let n = 0;
  for (const o of objs) {
    if (o.lastModified && o.lastModified < cutoff) {
      try { await r2.deleteObject(o.key); n++; } catch (_) {}
    }
  }
  if (n) console.log(`[R2 清理] 已删除 ${n} 个过期导出文件`);
}

// 异步任务调度器：同时仅 1 个生成中，其余 FIFO 排队等待（最多 EXPORT_QUEUE_MAX 个）
function runNextExportTask() {
  if (EXPORT_RUNNING || !EXPORT_QUEUE.length) return;
  const task = EXPORT_QUEUE.shift();
  EXPORT_RUNNING = true;
  const { job, d, ids, exporter, reqUser } = task;
  job.status = 'running';
  job.startedAt = Date.now();
  setImmediate(async () => {
    try {
      if (job.mode === 'r2') await runR2ExportTask(job, d, ids, exporter, reqUser);
      else await runLocalExportTask(job, d, ids, exporter, reqUser);
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      addLog(reqUser, 'export-full-profile', `全程备案导出失败（${job.scopeLabel}）：${e.message}`);
    } finally {
      EXPORT_RUNNING = false;
      runNextExportTask(); // 启动下一个排队任务
    }
  });
}

// 按班级分组（保持学生列表原始顺序；无班级学生归入「未分班」）
function groupStudentsByClass(d, ids) {
  const groups = new Map();
  for (const id of ids) {
    const stu = d.users.find(u => u.id === id);
    const cn = stu && stu.className ? stu.className : '未分班';
    if (!groups.has(cn)) groups.set(cn, []);
    groups.get(cn).push(id);
  }
  return [...groups.entries()];
}

// 本地 fallback 任务：整任务一个 zip 落盘 export-jobs/（未配置 R2 凭证时使用）
async function runLocalExportTask(job, d, ids, exporter, reqUser) {
  const tmpFile = path.join(EXPORT_DIR, job.id + '.zip');
  const out = fs.createWriteStream(tmpFile);
  const archive = archiver('zip', { zlib: { level: 1 } });
  let fail = null;
  archive.on('error', (err) => { fail = err; });
  out.on('error', (err) => { fail = err; });
  archive.pipe(out);
  for (let i = 0; i < ids.length; i++) {
    if (fail || job.cancelled) break;
    if (Date.now() - job.startedAt > EXPORT_TASK_TIMEOUT) { fail = new Error('任务超时（60 分钟），已自动终止'); break; }
    const stu = d.users.find(u => u.id === ids[i]);
    if (stu) await appendStudentToArchive(archive, d, stu, exporter, archivePrefixFor(d, stu, job.params.scope));
    job.done = i + 1;
    job.current = stu ? (stu.name || '') : '';
  }
  if (job.cancelled) {
    // 用户取消：丢弃半成品并清理磁盘文件
    try { archive.abort(); } catch (_) {}
    try { out.destroy(); } catch (_) {}
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    job.status = 'cancelled';
    job.error = '用户取消';
    addLog(reqUser, 'export-full-profile', `全程备案导出任务已取消（${job.scopeLabel}）`);
    return;
  }
  await archive.finalize();
  await new Promise((resolve) => out.on('close', resolve));
  if (fail) throw fail;
  job.status = 'done';
  job.file = tmpFile;
  try { job.size = fs.statSync(tmpFile).size; } catch (_) {}
  try {
    const nd = db.load();
    nd.notifications.push({
      id: db.genId('n'), studentId: reqUser.id, submissionId: null,
      content: `综测全程备案导出已完成：${job.scopeLabel}（${ids.length}人），24 小时内请在数据导出页下载`,
      fromRole: 'admin', fromName: '系统', type: 'system', read: false, createdAt: db.now(),
    });
    db.save();
  } catch (_) {}
  addLog(reqUser, 'export-full-profile', `全程备案导出完成（${job.scopeLabel}，${ids.length}人）`);
}

// R2 任务：按班级分组，每班一个 zip 流式直传 R2（不落盘），完成后按班级生成预签名下载链接
async function runR2ExportTask(job, d, ids, exporter, reqUser) {
  const groups = groupStudentsByClass(d, ids);
  job.totalClasses = groups.length;
  job.processedClasses = 0;
  job.currentClass = '';
  job.classDownloads = [];
  job.failedClasses = [];
  const uploadedKeys = [];
  for (const [className, stuIds] of groups) {
    if (job.cancelled) break;
    if (Date.now() - job.startedAt > EXPORT_TASK_TIMEOUT) {
      job.error = '任务超时（60 分钟），已自动终止';
      job.cancelled = true;
      break;
    }
    job.currentClass = className;
    console.error('[R2-任务] 班级开始「' + className + '」 学生数=' + stuIds.length);
    const safeCls = sanitizeName(className);
    const key = `exports/${job.id}/${safeCls}.zip`;
    const archive = archiver('zip', { zlib: { level: 1 } });
    let zipErr = null;
    archive.on('error', (e) => { zipErr = e; });
    try {
      // 先向流中写入本班所有学生（Word + 阶段附件，学生文件夹平铺），再 finalize 上传
      for (const id of stuIds) {
        if (job.cancelled || zipErr) break;
        const stu = d.users.find(u => u.id === id);
        if (stu) await appendStudentToArchive(archive, d, stu, exporter, '');
        job.done++;
        job.current = stu ? (stu.name || '') : '';
      }
      if (job.cancelled || zipErr) { if (zipErr) throw zipErr; break; }
      // archiver 实例是自定义流（instanceof stream.Readable === false），lib-storage 的 getChunk
      // 用 instanceof Readable 做类型判断会抛 "Body Data is unsupported format"。
      // 必须经原生 PassThrough 承接后再上传。
      console.error('[R2-任务] 学生append完成 done=' + job.done + '，开始上传');
      // ⚠️ 顺序铁律：必须先启动 Upload 消费 passthrough，再 finalize。
      // 若先 finalize，passthrough 无消费者，zip 数据超过 highWaterMark(16KB) 后
      // archiver 等待 drain 事件永远等不到 → finalize() 挂死（生产 44 人真实附件复现）。
      const passthrough = new PassThrough();
      archive.pipe(passthrough);
      const uploadPromise = r2.uploadStream(key, passthrough, 'application/zip', 'attachment'); // 构造即开始消费，不 await
      await archive.finalize();
      console.error('[R2-任务] finalize() resolve，等待上传完成');
      await uploadPromise;
      console.error('[R2-任务] uploadStream resolve，班级完成');
      if (zipErr) throw zipErr;
      const size = archive.pointer();
      job.classDownloads.push({ className, count: stuIds.length, size, key });
      uploadedKeys.push(key);
      job.processedClasses++;
    } catch (e) {
      try { archive.abort(); } catch (_) {}
      job.failedClasses.push({ className, error: e.message });
      job.processedClasses++;
      console.error(`[备案导出] 班级「${className}」上传失败:`, e.message);
    }
  }
  if (job.cancelled) {
    job.status = 'cancelled';
    job.error = job.error || '用户取消';
    // 清理已上传到 R2 的半成品（尽力而为）
    for (const k of uploadedKeys) { try { await r2.deleteObject(k); } catch (_) {} }
    addLog(reqUser, 'export-full-profile', `全程备案导出任务已取消（${job.scopeLabel}${job.failedClasses.length ? '，已清理 ' + uploadedKeys.length + ' 个班级文件' : ''}）`);
    return;
  }
  if (job.error) { job.status = 'failed'; return; } // 超时自动失败
  job.status = job.failedClasses.length ? 'partial_completed' : 'done';
  job.size = job.classDownloads.reduce((s, c) => s + (c.size || 0), 0);
  try {
    const nd = db.load();
    nd.notifications.push({
      id: db.genId('n'), studentId: reqUser.id, submissionId: null,
      content: `综测全程备案导出已完成：${job.scopeLabel}（${ids.length}人，${job.classDownloads.length}/${job.totalClasses} 个班级${job.failedClasses.length ? '，部分班级失败' : ''}），请在数据导出页按班级下载`,
      fromRole: 'admin', fromName: '系统', type: 'system', read: false, createdAt: db.now(),
    });
    db.save();
  } catch (_) {}
  addLog(reqUser, 'export-full-profile', `全程备案导出完成（${job.scopeLabel}，${ids.length}人，${job.classDownloads.length}/${job.totalClasses} 班级成功${job.failedClasses.length ? '，失败：' + job.failedClasses.map(f => f.className).join('、') : ''}）`);
}

// 附件阶段分类目录（用户确认：证明文件按阶段归档）
const STAGE_DIRS = [
  ['cert', '01_已认定项目证明材料'],
  ['uncert', '02_未认定项目证明材料'],
  ['first', '03_一榜复核材料'],
  ['second', '04_二榜复核材料'],
  ['third', '05_三榜复核材料'],
];
const ITEM_STATUS_CN = { pending: '待审核', approved: '已通过', rejected: '已驳回', resubmit: '待补交', overridden: '已改判', withdrawn: '已退回' };
const REVIEW_STATUS_CN = { pending: '待审核', approved: '已通过', rejected: '已驳回', partial: '部分通过', withdrawn: '已退回' };
const KIND_CN = { add: 'A类·新增', objection: 'B类·异议' };
const WORD_FONT = { eastAsia: '宋体', ascii: 'Times New Roman', hAnsi: 'Times New Roman' };
const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
};

function sanitizeName(s) { return String(s || '').replace(/[\/\\:*?"<>|\r\n]/g, '_').trim() || '未知'; }
function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19); }

// ---- 学生范围解析（复用 classMajors 专业映射，避免正则推导误伤 (5+3) 班名）----
function getStudentIdsByScope(d, scope, params = {}) {
  if (scope === 'all') return d.users.filter(u => u.role === 'student').map(u => u.id);
  if (scope === 'profession') {
    const cls = new Set(Object.entries(d.classMajors || {}).filter(([, m]) => m === params.profession).map(([c]) => c));
    return d.users.filter(u => u.role === 'student' && cls.has(u.className)).map(u => u.id);
  }
  if (scope === 'class') return d.users.filter(u => u.role === 'student' && u.className === params.className).map(u => u.id);
  if (scope === 'student') {
    const u = d.users.find(x => x.role === 'student' && (x.studentId === params.studentId || x.id === params.studentId));
    return u ? [u.id] : [];
  }
  return [];
}
function describeScope(d, params) {
  switch (params.scope) {
    case 'all': return '全年级';
    case 'profession': return '专业「' + (params.profession || '') + '」';
    case 'class': return '班级「' + (params.className || '') + '」';
    case 'student': return '学生「' + (params.studentId || params.studentName || '') + '」';
    default: return String(params.scope || '');
  }
}

// ---- 附件按阶段收集（已认定/未认定/一榜/二榜/三榜复核材料）----
function collectStageFiles(d, stu) {
  const out = { cert: [], uncert: [], first: [], second: [], third: [] };
  const myApps = d.applications.filter(a => a.studentId === stu.id);
  let ci = 0;
  for (const a of myApps) {
    for (const p of (a.certifiedProofs || [])) {
      if (!p || !p.attachment || !p.attachment.url) continue;
      const fp = path.join(__dirname, p.attachment.url);
      if (!fs.existsSync(fp)) continue;
      ci++;
      const base = sanitizeName(p.attachment.name || path.basename(fp));
      const title = sanitizeName(p.content || p.code || '');
      out.cert.push({ fp, name: `${ci}${title ? '_' + title : ''}_${base}` });
    }
    let ui = 0;
    for (const p of (a.uncertifiedProofs || [])) {
      if (!p || !p.attachment || !p.attachment.url) continue;
      const fp = path.join(__dirname, p.attachment.url);
      if (!fs.existsSync(fp)) continue;
      ui++;
      const base = sanitizeName(p.attachment.name || path.basename(fp));
      const title = sanitizeName(p.name || '');
      out.uncert.push({ fp, name: `${ui}${title ? '_' + title : ''}_${base}` });
    }
  }
  for (const round of ['first', 'second', 'third']) {
    const rs = (d.reviews || []).filter(r => r.studentId === stu.id && r.round === round);
    let ri = 0;
    for (const r of rs) {
      for (const it of (r.items || [])) {
        if (!it || !it.proof || !it.proof.url) continue;
        const fp = path.join(__dirname, it.proof.url);
        if (!fs.existsSync(fp)) continue;
        ri++;
        const base = sanitizeName(it.proof.name || path.basename(fp));
        const title = sanitizeName(it.title || '');
        out[round].push({ fp, name: `${ri}${title ? '_' + title : ''}_${base}` });
      }
    }
  }
  return out;
}

// ---- 收集某学生完整档案数据 ----
function collectStudentArchive(d, stu) {
  const classMajors = d.classMajors || {};
  const apps = d.applications.filter(a => a.studentId === stu.id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const reviews = (d.reviews || []).filter(r => r.studentId === stu.id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const deyu = getFinalDeyu(d, stu, null);                 // 德育终值（含全部复核调整，口径同榜单）
  const zhiyu = getFinalZhiyu(d, stu.studentId, null);     // 智育终值（含智育复核链）
  const teacher = getTeacherScore(d, stu.studentId);
  const sc = (d.scores && d.scores[stu.studentId]) || {};
  const hasZhiyu = sc.zhiyu != null || ((d.zhiyuOverrides || {})[stu.studentId] || []).length > 0;
  return {
    stu, major: classMajors[stu.className] || '',
    apps, reviews,
    score: {
      deyu, zhiyu, sports: SPORTS_SCORE, teacher,
      hasZhiyu, hasTeacher: sc.teacher != null,
      total: roundTo4(deyu + zhiyu + SPORTS_SCORE + teacher),
    },
    attachments: collectStageFiles(d, stu),
  };
}

// ---- Word 文档生成（docx）----
function wText(text, opts = {}) {
  return new TextRun({ text: String(text ?? ''), font: WORD_FONT, size: opts.size || 21, bold: !!opts.bold, color: opts.color, italics: !!opts.italics });
}
function wPara(text, opts = {}) {
  return new Paragraph({
    children: Array.isArray(text) ? text : [wText(text, opts)],
    spacing: { after: opts.after != null ? opts.after : 60, before: opts.before || 0 },
    alignment: opts.align,
  });
}
function wHeading(text, level = 1) {
  const size = level === 1 ? 26 : level === 2 ? 24 : 22;
  return new Paragraph({ children: [wText(text, { size, bold: true })], spacing: { before: level === 1 ? 220 : 140, after: 100 }, keepNext: true });
}
function wCell(text, opts = {}) {
  const children = Array.isArray(text) ? text : [wPara(String(text ?? ''), { size: opts.size || 18, bold: !!opts.bold })];
  return new TableCell({
    children,
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill } : undefined,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}
function wRow(cells) { return new TableRow({ children: cells }); }
function wTable(headers, rows, colWidths) {
  const head = wRow(headers.map((h, i) => wCell(h, { bold: true, fill: 'D9E2F3', width: colWidths ? colWidths[i] : undefined })));
  const body = rows.map(r => wRow(r.map((c, i) => wCell(c, { width: colWidths ? colWidths[i] : undefined }))));
  return new Table({ rows: [head, ...body], width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS });
}

async function buildArchiveDocx(data, exporter) {
  const { stu, major, apps, reviews, score } = data;
  const children = [];
  children.push(new Paragraph({ children: [wText('综合素质测评全程备案', { size: 36, bold: true })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }));
  children.push(wPara(`学号：${stu.studentId || ''}　姓名：${stu.name || ''}　班级：${stu.className || ''}　专业：${major || ''}`, { align: AlignmentType.CENTER, size: 20, after: 120 }));
  children.push(wPara(`导出时间：${bjNow()}　导出人：${exporter.name || ''}（${exporter.role || ''}）　用途：综合素质测评全程存档核对`, { size: 18, color: '666666', after: 160 }));

  // 一、基本信息
  children.push(wHeading('一、学生基本信息', 1));
  children.push(wTable(['姓名', '学号', '班级', '专业', '联系电话'],
    [[stu.name || '', stu.studentId || '', stu.className || '', major || '', stu.phone || '']],
    [20, 22, 20, 20, 18]));

  // 二、综测总分汇总
  children.push(wHeading('二、综测总分汇总', 1));
  children.push(wTable(['德育总分（含复核调整）', '智育成绩', '体育成绩', '教师评价', '综测总分'],
    [[fmtNum(score.deyu), score.hasZhiyu ? fmtNum(score.zhiyu) : '未导入', fmtNum(score.sports), score.hasTeacher ? fmtNum(score.teacher) : '未导入', fmtNum(score.total)]],
    [24, 17, 15, 15, 15]));
  children.push(wPara('说明：德育总分 = 10 个类目（基准分 + 认定加分）封顶后求和，含全部榜次复核调整，与综测榜单口径一致；智育/教师评价为系统导入值，未导入显示"未导入"；体育成绩固定 5 分。', { size: 18, color: '666666' }));

  // 三、综测申请与审核记录
  children.push(wHeading('三、综测申请与审核记录', 1));
  if (!apps.length) {
    children.push(wPara('该学生本学年未提交综测申请（无申请记录）。', { size: 20, color: '999999' }));
  } else {
    apps.forEach((a, ai) => {
      children.push(wHeading(`3.${ai + 1} 申请　提交时间：${a.createdAt || ''}${a.period ? '　学年：' + a.period : ''}　已认定段：${ITEM_STATUS_CN[a.certifiedStatus] || '—'}　未认定段：${ITEM_STATUS_CN[a.uncertifiedStatus] || '—'}`, 2));
      // 已认定明细
      children.push(wHeading('已认定项目明细', 3));
      const certRows = (a.certifiedItems || []).map(it => [
        it.content || it.code || '', it.level || '', fmtNum(it.points),
        ITEM_STATUS_CN[it.status] || it.status || '',
        fmtNum(it.pointsFinal != null ? it.pointsFinal : it.points),
        it.reviewComment || it.resubmitNote || '']);
      if (certRows.length) children.push(wTable(['项目（目录名+等级）', '等级', '申请分值', '审核状态', '认定分值', '审核意见'], certRows, [26, 10, 10, 10, 10, 18]));
      else children.push(wPara('（无已认定项目）', { size: 18, color: '999999' }));
      // 未认定明细
      children.push(wHeading('未认定项目明细', 3));
      const uncertRows = (a.uncertifiedItems || []).map(it => [
        it.name || '', (it.level || it.unit || ''), fmtNum(it.points),
        ITEM_STATUS_CN[it.status] || it.status || '',
        fmtNum(it.pointsFinal != null ? it.pointsFinal : it.points),
        it.reviewComment || it.resubmitNote || '']);
      if (uncertRows.length) children.push(wTable(['项目名称', '级别/单位', '申请分值', '审核状态', '认定分值', '审核意见'], uncertRows, [24, 12, 10, 10, 10, 18]));
      else children.push(wPara('（无未认定项目）', { size: 18, color: '999999' }));
      // 审核流程记录
      children.push(wHeading('审核流程记录', 3));
      const logs = [...(a.certifiedLog || []), ...(a.uncertifiedLog || [])]
        .sort((x, y) => String(x.time || '').localeCompare(String(y.time || '')));
      const logRows = logs.map(l => [l.time || '', { student: '学生', monitor: '班长', grade: '年级', admin: '管理员' }[l.byRole] || l.byRole || '', l.byName || '', l.action || '', l.comment || '']);
      if (logRows.length) children.push(wTable(['时间', '角色', '操作人', '动作', '说明'], logRows, [18, 8, 10, 12, 30]));
      else children.push(wPara('（无流程记录）', { size: 18, color: '999999' }));
      // 退回 / 改判记录
      const extra = [];
      if (a.withdrawRequest) extra.push(`退回申请：${a.withdrawRequest.reason || ''}（${a.withdrawRequest.status || ''}）`);
      if (a.certifiedOverride) extra.push(`已认定段改判：${a.certifiedOverride.status || ''}（${a.certifiedOverride.reason || ''}）`);
      if (a.uncertifiedOverride) extra.push(`未认定段改判：${a.uncertifiedOverride.status || ''}（${a.uncertifiedOverride.reason || ''}）`);
      if (extra.length) {
        children.push(wHeading('退回 / 改判记录', 3));
        extra.forEach(e => children.push(wPara(e, { size: 18 })));
      }
    });
  }

  // 四、综测复核记录
  children.push(wHeading('四、综测复核记录', 1));
  for (const round of REVIEW_ROUNDS) {
    const rs = reviews.filter(r => r.round === round);
    children.push(wHeading(`${ROUND_CN[round]}复核`, 2));
    if (!rs.length) { children.push(wPara('未提交该榜复核申请。', { size: 18, color: '999999' })); continue; }
    for (const r of rs) {
      children.push(wPara(`提交时间：${r.createdAt || ''}　类型：${(r.types && r.types.length) ? r.types.map(t => KIND_CN[t] || t).join('、') : ''}　状态：${REVIEW_STATUS_CN[r.status] || r.status}${r.concludedAt ? '　结论时间：' + r.concludedAt : ''}`, { size: 18 }));
      const rows = (r.items || []).map(it => [
        KIND_CN[it.kind] || it.kind || '', it.title || '',
        it.kind === 'add' ? fmtNum(it.requestedPoints || 0) : fmtNum(it.requestedPoints != null ? it.requestedPoints : 0),
        REVIEW_STATUS_CN[it.reviewStatus] || it.reviewStatus || '',
        it.reviewStatus === 'approved' ? fmtNum(it.reviewPoints != null ? it.reviewPoints : 0) : '—',
        it.reviewComment || it.reviewNote || '']);
      if (rows.length) children.push(wTable(['类型', '复核事项', '申请分值', '审核结果', '结论分值', '审核意见'], rows, [12, 24, 10, 10, 10, 16]));
      if (r.notes) children.push(wPara('备注：' + r.notes, { size: 18, color: '666666' }));
    }
  }

  // 五、证明材料清单
  children.push(wHeading('五、证明材料清单（附件已按阶段归档至本文件夹对应子目录）', 1));
  const anyFile = Object.values(data.attachments).some(v => v.length);
  if (!anyFile) {
    children.push(wPara('该学生无任何证明材料附件。', { size: 18, color: '999999' }));
  } else {
    for (const [key, dir] of STAGE_DIRS) {
      const files = data.attachments[key] || [];
      if (!files.length) continue;
      children.push(wHeading(dir, 3));
      files.forEach((f, i) => children.push(wPara(`${i + 1}. ${f.name}`, { size: 18 })));
    }
  }
  children.push(wPara('', { after: 40 }));
  children.push(wPara('本备案文件由综测系统自动生成，内容与系统当前数据一致，仅供存档核对使用。', { size: 18, color: '999999', align: AlignmentType.CENTER }));

  const doc = new Document({
    creator: exporter.name || 'admin',
    title: '综测全程备案_' + (stu.studentId || ''),
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

// 把某学生写入 archive（Word + 分阶段附件）；供同步/异步共用
// 归档前缀：全年级 → 专业/班级/；按专业 → 班级/；按班级/按个人 → ''（学生文件夹平铺）
function archivePrefixFor(d, stu, scope) {
  if (scope === 'all') {
    const major = sanitizeName((d.classMajors || {})[stu.className] || '未分专业');
    const cls = sanitizeName(stu.className || '未分班');
    return `${major}/${cls}/`;
  }
  if (scope === 'profession') {
    return `${sanitizeName(stu.className || '未分班')}/`;
  }
  return '';
}

async function appendStudentToArchive(archive, d, stu, exporter, prefix = '') {
  const data = collectStudentArchive(d, stu);
  const folder = `${sanitizeName(stu.studentId || stu.username)}_${sanitizeName(stu.name || '未知')}`;
  const base = prefix + folder;
  const docxBuf = await buildArchiveDocx(data, exporter);
  archive.append(docxBuf, { name: `${base}/${folder}_综测全程备案.docx` });
  for (const [key, dir] of STAGE_DIRS) {
    for (const f of (data.attachments[key] || [])) {
      archive.file(f.fp, { name: `${base}/${dir}/${f.name}` });
    }
  }
}

// ① 选项：专业列表 / 班级列表 / 学生搜索（学号·姓名模糊）
app.get('/api/export/full-profile/options', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const classMajors = d.classMajors || {};
  const professions = [...new Set(Object.values(classMajors).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  const classes = [...new Set(Object.keys(classMajors).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  const q = String(req.query.q || '').trim().toLowerCase();
  let students = [];
  if (q) {
    students = d.users.filter(u => u.role === 'student' &&
      (String(u.studentId || '').toLowerCase().includes(q) || String(u.name || '').toLowerCase().includes(q)))
      .slice(0, 20)
      .map(u => ({ id: u.id, studentId: u.studentId, name: u.name, className: u.className }));
  }
  res.json({ professions, classes, students });
});

// ② 预估人数（与导出同源，保证 count 与最终导出一致）
app.post('/api/export/full-profile/count', authRequired, requireRole('admin'), sensitiveLimiter, (req, res) => {
  const { scope, profession, className, studentId } = req.body || {};
  if (!['all', 'profession', 'class', 'student'].includes(scope)) return res.status(400).json({ error: '未知导出范围' });
  const d = db.load();
  const ids = getStudentIdsByScope(d, scope, { profession, className, studentId });
  res.json({ count: ids.length });
});

// ③ 开始导出（≤50 同步流式返回 zip；>50 异步任务返回 jobId）
app.post('/api/export/full-profile/start', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const { scope, profession, className, studentId, secondaryPassword } = req.body || {};
  if (!secondaryPassword) return res.status(400).json({ error: '请输入二级审核密码' });
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return v.frozen
      ? res.status(403).json({ error: `二级审核密码连续错误次数过多，已冻结 ${v.remain} 分钟` })
      : res.status(401).json({ error: '二级审核密码错误' });
  }
  if (!['all', 'profession', 'class', 'student'].includes(scope)) return res.status(400).json({ error: '未知导出范围' });
  const d = db.load();
  const ids = getStudentIdsByScope(d, scope, { profession, className, studentId });
  if (!ids.length) return res.status(400).json({ error: '该范围没有学生，请检查选择' });
  const params = { scope, profession, className, studentId };
  const scopeLabel = describeScope(d, params);
  const exporter = { name: req.user.name, role: req.user.role };

  if (ids.length <= EXPORT_SYNC_LIMIT && !r2.R2_ENABLED) {
    // ---- 同步：流式返回 zip（仅本地 fallback 模式）----
    addLog(req.user, 'export-full-profile', `全程备案导出（${scopeLabel}，${ids.length}人，同步）`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`综测备案_${scopeLabel}_${ids.length}人.zip`)}`);
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err) => { console.error('[备案导出] zip 错误:', err.message); res.destroy(); });
    archive.pipe(res);
    try {
      for (const id of ids) {
        const stu = d.users.find(u => u.id === id);
        if (stu) await appendStudentToArchive(archive, d, stu, exporter, archivePrefixFor(d, stu, scope));
      }
      await archive.finalize();
    } catch (e) {
      console.error('[备案导出] 同步生成失败:', e.message);
      res.destroy();
    }
    return;
  }

  // ---- 异步：提交任务（同时仅 1 个生成中，其余 FIFO 排队等待，最多 EXPORT_QUEUE_MAX 个）----
  if (EXPORT_RUNNING && EXPORT_QUEUE.length >= EXPORT_QUEUE_MAX) {
    return res.status(409).json({ error: `导出任务排队已满（最多 ${EXPORT_QUEUE_MAX} 个），请等待当前任务完成或取消后再试` });
  }
  const jobId = db.genId('ej');
  const queued = EXPORT_RUNNING;
  const job = {
    id: jobId, ownerId: req.user.id, mode: r2.R2_ENABLED ? 'r2' : 'local',
    status: queued ? 'queued' : 'running', total: ids.length, done: 0, current: '',
    scopeLabel, params, file: null, size: 0, error: null, createdAt: Date.now(), startedAt: null, cancelled: false,
    totalClasses: 0, processedClasses: 0, currentClass: '', classDownloads: [], failedClasses: [],
  };
  EXPORT_JOBS.set(jobId, job);
  addLog(req.user, 'export-full-profile', `全程备案导出任务提交（${scopeLabel}，${ids.length}人，${job.mode === 'r2' ? 'R2 按班级分批' : '本地'}，异步 job=${jobId}${queued ? '，排队等待' : ''}）`);
  res.json({ ok: true, async: true, jobId, total: ids.length, scopeLabel, queued, mode: job.mode });
  EXPORT_QUEUE.push({ job, d, ids, exporter, reqUser: req.user });
  runNextExportTask();
});

// ④ 轮询异步任务状态
app.get('/api/export/full-profile/status', authRequired, requireRole('admin'), (req, res) => {
  const job = EXPORT_JOBS.get(String(req.query.jobId || ''));
  if (!job || job.ownerId !== req.user.id) return res.status(404).json({ error: '任务不存在' });
  res.json({
    id: job.id, jobId: job.id, status: job.status, total: job.total, done: job.done, current: job.current,
    scopeLabel: job.scopeLabel, error: job.error || null, size: job.size || 0, mode: job.mode,
    processedClasses: job.processedClasses || 0, totalClasses: job.totalClasses || 0,
    currentClass: job.currentClass || '',
    classDownloads: (job.classDownloads || []).map(c => ({ className: c.className, count: c.count, size: c.size })),
    failedClasses: (job.failedClasses || []).map(f => ({ className: f.className, error: f.error })),
  });
});

// ⑤ 下载（R2 模式：按班级动态生成 24h 预签名 URL 并 302；本地模式：流式返回 zip 文件）
app.get('/api/export/full-profile/download', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const job = EXPORT_JOBS.get(String(req.query.jobId || ''));
  if (!job || job.ownerId !== req.user.id) return res.status(404).json({ error: '任务不存在' });
  if (job.mode === 'r2') {
    const className = String(req.query.className || '');
    const meta = (job.classDownloads || []).find(m => m.className === className);
    if (!meta) return res.status(400).json({ error: '该班级不在本任务或未导出成功' });
    try {
      const url = await r2.generatePresignedUrl(meta.key, 24 * 3600);
      return res.redirect(url); // 302 到 R2 预签名地址（每次生成都是新的，永不过期）
    } catch (e) {
      return res.status(500).json({ error: '生成下载链接失败：' + e.message });
    }
  }
  if (job.status !== 'done' || !job.file || !fs.existsSync(job.file)) return res.status(400).json({ error: '文件未就绪或已过期' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`综测备案_${job.scopeLabel}_${job.total}人.zip`)}`);
  fs.createReadStream(job.file).pipe(res);
});

// ⑥ 取消异步任务（排队中直接移除；生成中标记取消，循环在下一学生处中止并清理）
app.delete('/api/export/full-profile/job/:jobId', authRequired, requireRole('admin'), (req, res) => {
  const job = EXPORT_JOBS.get(String(req.params.jobId || ''));
  if (!job || job.ownerId !== req.user.id) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'done' || job.status === 'partial_completed') return res.status(400).json({ error: '任务已完成，无法取消' });
  if (job.status === 'failed' || job.status === 'cancelled') return res.status(400).json({ error: '任务已结束' });
  if (job.status === 'queued') {
    const idx = EXPORT_QUEUE.findIndex(t => t.job.id === job.id);
    if (idx >= 0) EXPORT_QUEUE.splice(idx, 1);
    job.status = 'cancelled';
    job.error = '用户取消';
    return res.json({ ok: true, status: 'cancelled' });
  }
  job.cancelled = true; // running：生成循环检查到后中止并清理
  res.json({ ok: true, status: 'cancelling' });
});

// ⑦ 历史任务列表（当前 admin 有效期内任务，R2 任务保留 7 天可再生成下载链接，本地 24h）
app.get('/api/export/full-profile/jobs', authRequired, requireRole('admin'), (req, res) => {
  const now = Date.now();
  const list = [];
  for (const job of EXPORT_JOBS.values()) {
    if (job.ownerId !== req.user.id) continue;
    const ttl = job.mode === 'r2' ? R2_EXPORT_TTL : EXPORT_JOB_TTL;
    if (now - job.createdAt > ttl) continue;
    let size = job.size || 0;
    if (job.mode !== 'r2' && job.status === 'done' && job.file && fs.existsSync(job.file)) {
      try { size = fs.statSync(job.file).size; } catch (_) {}
    }
    list.push({
      jobId: job.id, scopeLabel: job.scopeLabel, total: job.total, status: job.status,
      error: job.error || null, createdAt: job.createdAt, size, mode: job.mode,
      classes: job.mode === 'r2' ? (job.classDownloads || []).map(c => ({ className: c.className, count: c.count, size: c.size })) : undefined,
      failedClasses: (job.failedClasses || []).map(f => f.className),
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ jobs: list });
});

// 班长/年级获取班级/全部申请列表
app.get('/api/applications', authRequired, requireRole('monitor', 'grade', 'admin'), (req, res) => {
  const d = db.load();
  const { status, certStatus, uncertStatus, className, q, major, type, from, to, page, pageSize } = req.query;
  let list = [...d.applications];
  if (req.user.role === 'monitor') list = list.filter(a => a.className === req.user.className);
  // 2026-09-05：grade 默认仍只看未认定审核桶班级（保持 gradeAuditApp 工作台语义）；
  // 带 includeMod=1（总览/修改页）时扩大到 未认定桶 ∪ 已认定修改桶，保证「已认定修改负责人」能看到其负责班的已认定申请
  const gradeIncludeMod = req.user.role === 'grade' && String(req.query.includeMod) === '1';
  if (req.user.role === 'grade') {
    const ua = gradeIncludeMod ? unionClassesForGrade(req.user) : allowedClassesForGrade(req.user, 'uncertified');
    if (ua) list = list.filter(a => ua.has(String(a.className)));
  }
  // 权限过滤后的全量班级（供前端下拉，不受后续筛选影响）
  const classes = [...new Set(list.map(a => a.className).filter(Boolean))].sort();
  // 2026-09-01：专业列表从 classMajors 静态配置推（admin 全量 / 年级管理范围 / 班长本班），无申请时也可选
  const cmMeta = d.classMajors || {};
  let majorScope;
  if (req.user.role === 'monitor') {
    majorScope = [req.user.className].filter(Boolean);
  } else if (req.user.role === 'grade') {
    const ua = gradeIncludeMod ? unionClassesForGrade(req.user) : allowedClassesForGrade(req.user, 'uncertified');
    majorScope = ua ? [...ua] : Object.keys(cmMeta);
  } else {
    majorScope = Object.keys(cmMeta); // admin（或其它兜底）
  }
  const majors = [...new Set(majorScope.map(c => cmMeta[c]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  // 未认定 待审/已审 计数（供前端 tabs，权限后全量）
  const uncertCounts = {
    pending: list.filter(a => a.uncertifiedStatus === 'pending').length,
    history: list.filter(a => a.uncertifiedStatus && a.uncertifiedStatus !== 'pending').length,
  };
  if (className && className !== 'all') list = list.filter(a => a.className === className);
  // 服务端过滤：姓名/学号模糊 + 专业（专业经班级→专业映射推导；前端查询栏可走服务端，与客户端过滤并存）
  if (q && String(q).trim()) {
    const k = String(q).trim().toLowerCase();
    list = list.filter(a => ((a.studentName || '') + ' ' + (a.studentIdNo || '')).toLowerCase().includes(k));
  }
  if (major && major !== 'all') {
    const cm = d.classMajors || {};
    list = list.filter(a => (cm[a.className] || '').trim() === String(major).trim());
  }
  if (certStatus && certStatus !== 'all') list = list.filter(a => a.certifiedStatus === certStatus);
  if (uncertStatus && uncertStatus !== 'all') {
    if (uncertStatus === 'history') list = list.filter(a => a.uncertifiedStatus && a.uncertifiedStatus !== 'pending');
    else list = list.filter(a => a.uncertifiedStatus === uncertStatus);
  }
  if (status === 'pending') list = list.filter(a => a.certifiedStatus === 'pending' || a.uncertifiedStatus === 'pending');
  // type 快捷过滤：certified=已认定部分有内容 / uncertified=未认定部分有内容 / all=全部
  if (type === 'certified') list = list.filter(a => a.certifiedItems && a.certifiedItems.length > 0);
  else if (type === 'uncertified') list = list.filter(a => a.uncertifiedItems && a.uncertifiedItems.length > 0);
  // 提交时间范围（createdAt ISO 字符串比较，兼容前端 date input）
  if (from) list = list.filter(a => (a.createdAt || '') >= String(from) + 'T00:00:00.000Z');
  if (to) list = list.filter(a => (a.createdAt || '') <= String(to) + 'T23:59:59.999Z');
  list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  // 服务端分页：仅当请求带 page 参数时启用（未带则返回全量，兼容旧调用）
  const total = list.length;
  let data = list, pg = 1, ps = 50, totalPages = 1;
  if (page !== undefined) {
    pg = Math.max(1, parseInt(page, 10) || 1);
    ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
    totalPages = Math.max(1, Math.ceil(total / ps));
    data = list.slice((pg - 1) * ps, pg * ps);
  }
  // 2026-09-05：admin/grade 行附带逐段修改权限标记（浅拷贝，避免污染 store 对象）
  if (req.user.role === 'admin' || req.user.role === 'grade') {
    data = data.map(a => Object.assign({}, a, { _my: myModifyFlags(req.user, a) }));
  }
  res.json({ applications: data, data, total, page: pg, pageSize: ps, totalPages, classes, majors, uncertCounts });
});

// ============================================================
// 文件下载接口（鉴权 + 设置 Content-Disposition 让浏览器以原中文文件名下载）
// 前端用法：GET /api/download?url=/uploads/xxx.bin&filename=哆啦A梦.png
// ============================================================
app.get('/api/download', authRequired, downloadGate, (req, res) => {
  const url = (req.query.url || '').toString();
  const filename = (req.query.filename || 'download').toString();
  if (!url.startsWith('/uploads/')) return res.status(400).json({ error: '无效路径' });
  // 安全：禁止 .. 和 绝对路径
  if (url.includes('..') || url.includes('\\')) return res.status(400).json({ error: '非法路径' });
  // 权限（2026-08-30 P1 修复）：附件归属校验，防越权下载他人证明材料
  if (!assertAttachmentAccess(req, res, url)) return;
  const fp = path.join(__dirname, url);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  const ext = path.extname(fp).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  // 用 RFC 5987 编码中文文件名，同时给一个 ASCII fallback
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').slice(0, 80) || 'download';
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  fs.createReadStream(fp).pipe(res);
});

// 文件在线预览接口（鉴权 + inline，浏览器内联显示图片/PDF；其它类型回退为下载）
// 前端用法：GET /api/preview?url=/uploads/xxx.png
app.get('/api/preview', authRequired, downloadGate, (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url.startsWith('/uploads/')) return res.status(400).json({ error: '无效路径' });
  if (url.includes('..') || url.includes('\\')) return res.status(400).json({ error: '非法路径' });
  // 权限（2026-08-30 P1 修复）：附件归属校验，防越权预览他人证明材料
  if (!assertAttachmentAccess(req, res, url)) return;
  const fp = path.join(__dirname, url);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  const ext = path.extname(fp).toLowerCase();
  const mime = {
    '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp',
    '.pdf':'application/pdf',
    '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls':'application/vnd.ms-excel', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt':'application/vnd.ms-powerpoint', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  const filename = path.basename(fp);
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').slice(0, 80) || 'file';
  const inlineExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];
  const disp = inlineExts.includes(ext) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disp}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  fs.createReadStream(fp).pipe(res);
});

// 申请涉及的固定选项（前端渲染下拉）
app.get('/api/applications-meta', authRequired, (req, res) => {
  res.json({ certifiedProjects: CERT_PROJECTS, uncertifiedTypes: UNCERT_TYPES });
});

// ============================================================
// 操作日志：统一记录，支持年级按班级/学生导出
// ============================================================
function addLog(user, action, detail, target = {}) {
  const d = db.load();
  d.logs.push({
    id: db.genId('lg'), time: db.now(),
    role: user.role, byName: user.name, byId: user.id,
    className: user.className || target.className || '',
    studentId: user.studentId || target.studentId || '',
    action, detail: String(detail || '').slice(0, 300),
    targetType: target.type || '', targetName: target.name || '',
    // 安全增强（2026-08-30）：来源 IP / 设备 UA / 关联对象 before-after
    ip: user._ip || target.ip || '',
    ua: (user._ua || '').slice(0, 120),
    before: target.before !== undefined ? JSON.stringify(target.before).slice(0, 300) : '',
    after: target.after !== undefined ? JSON.stringify(target.after).slice(0, 300) : '',
  });
  if (d.logs.length > 50000) d.logs.splice(0, d.logs.length - 50000); // 防无限增长
  db.save();
}

// ==================== 安全导出公共逻辑（2026-08-30）====================
// ①二级密码校验（敏感导出必须） ②Excel 页眉/页脚水印 ③Excel 打开密码（OOXML 真加密）④审计日志
// opts: { pageName, requirePwd=true, filename(完整文件名), logAction, logDetail, cellNote=true }
async function secureSendWorkbook(req, res, wb, opts = {}) {
  req._auditStart = req._auditStart || Date.now();
  if (opts.requirePwd !== false) {
    const pwd = String((req.body || {}).secondaryPassword || '');
    if (!pwd) return res.status(400).json({ error: '敏感数据导出需输入二级审核密码' });
    const v = await verifySecPwd(req, pwd);
    if (!v.ok) {
      return v.frozen
        ? res.status(403).json({ error: `二级审核密码连续错误次数过多，已冻结导出 ${v.remain} 分钟` })
        : res.status(401).json({ error: '二级审核密码错误' });
    }
  }
  // 页眉水印（操作人/时间/页面/IP）
  const now = new Date();
  const f = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${f(now.getMonth() + 1)}-${f(now.getDate())} ${f(now.getHours())}:${f(now.getMinutes())}:${f(now.getSeconds())}`;
  const wm = `内部资料 严禁外传 | 操作人：${req.user.name}(${req.user.username}) | 时间：${ts} | 页面：${opts.pageName || '数据导出'} | IP：${req.user._ip || '-'}`;
  wb.eachSheet((ws) => {
    try {
      ws.headerFooter = ws.headerFooter || {};
      ws.headerFooter.oddHeader = `&C&8${wm}`;
      ws.headerFooter.oddFooter = `&C&8第 &P 页 / 共 &N 页`;
    } catch (e) {}
  });
  // Excel 打开密码（真加密）
  const pwd = String((req.body || {}).secondaryPassword || '');
  let out = await wb.xlsx.writeBuffer();
  if (opts.encrypt !== false && pwd) {
    out = Buffer.from(await officeCrypto.encrypt(out, { password: pwd }));
  }
  // 审计日志（维度一/二：MD5 + 文件名 + 条数 + 高频/凌晨告警）
  const md5 = crypto.createHash('md5').update(out).digest('hex');
  const exportAction = opts.exportAction || 'export';
  const alertInfo = auditExportAlerts(req, exportAction, { type: opts.pageName || '' }, {});
  logAudit(req, exportAction, {
    type: opts.pageName || '数据导出',
    scope: opts.scope || '',
    recordCount: opts.recordCount || 0,
    fileMd5: md5,
    fileName: opts.filename || '',
  }, { highRisk: alertInfo.highRisk, reason: alertInfo.reason });
  // 兼容旧 addLog（原有审计入口保留）
  addLog(req.user, opts.logAction || 'export', opts.logDetail || `${opts.pageName || '数据'}导出（含加密水印）`, {
    type: 'export', name: opts.pageName || '', ip: req.user._ip || '', ua: req.user._ua || '',
  });
  const filename = opts.filename || 'export.xlsx';
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').slice(0, 80) || 'export.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(out);
}

// 前端安全信息（水印内容用：IP / UA / 服务端时间）
app.get('/api/me/security', authRequired, (req, res) => {
  res.json({ ip: req.user._ip || '', ua: (req.user._ua || '').slice(0, 200), time: new Date().toISOString() });
});

// ==================== 操作日志增强（维度一 + 维度二，2026-08-30）====================
// 统一审计日志：写入独立 audit_logs 表（追加写、保留 365 天、与应用数据隔离）
function logAudit(req, action, target = {}, detail = {}, result = 'success') {
  const u = req.user || {};
  db.audit({
    actor: {
      userId: u.studentId || u.username || '',
      userName: u.name || '',
      role: u.role || '',
      ip: u._ip || '',
      userAgent: (u._ua || '').slice(0, 300),
      sessionId: u._token || '',
    },
    action, target, detail, result,
    duration: Date.now() - (req._auditStart || Date.now()),
    highRisk: detail.highRisk || 0,
  });
}

// 告警推送（企业微信 webhook；ZONGCE_ALERT_WEBHOOK 在 /etc/zongce/zongce.env）
const ALERT_WEBHOOK = process.env.ZONGCE_ALERT_WEBHOOK || '';
// 2026-09-06：运行类告警（闸门满员/排队超时等运维事件，与「安全告警」共用 webhook，前缀区分）
function sendOpsAlert(msg) {
  if (!ALERT_WEBHOOK) return;
  fetch(ALERT_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: '[综测系统·运行告警] ' + msg } }),
  }).catch(() => {});
}
function sendAlert(msg) {
  if (!ALERT_WEBHOOK) return;
  fetch(ALERT_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: '[综测系统·安全告警] ' + msg } }),
  }).catch(() => {});
}

// ---- 告警规则状态（内存态） ----
const secPwdFailMap = new Map(); // userId -> { count, frozenUntil }
const copyCountMap = new Map();  // userId -> { count, windowStart }

// 二级密码验证（统一入口）：成功/失败审计 + 连续失败≥3 冻结 30 分钟
async function verifySecPwd(req, pwd) {
  const u = req.user || {};
  const st = secPwdFailMap.get(u.id) || { count: 0, frozenUntil: 0 };
  if (st.frozenUntil && st.frozenUntil > Date.now()) {
    logAudit(req, 'pwd_verify_failure', { type: '二级审核密码' }, { error: '账号已冻结（连续失败≥3次）', highRisk: 1 }, 'failure');
    return { ok: false, frozen: true, remain: Math.ceil((st.frozenUntil - Date.now()) / 60000) };
  }
  const ok = !!(u.secondaryPassword && await db.verifyPassword(pwd, u.secondaryPassword));
  if (ok) {
    st.count = 0; st.frozenUntil = 0;
    secPwdFailMap.set(u.id, st);
    logAudit(req, 'pwd_verify_success', { type: '二级审核密码' }, {}, 'success');
    return { ok: true };
  }
  st.count += 1;
  if (st.count >= 3) {
    st.frozenUntil = Date.now() + 30 * 60 * 1000;
    st.count = 0;
    const remain = Math.ceil((st.frozenUntil - Date.now()) / 60000);
    sendAlert(`${u.name}(${u.username || u.id}) 连续 3 次输错二级审核密码，已冻结导出功能 30 分钟（IP: ${u._ip}）`);
    logAudit(req, 'pwd_verify_failure', { type: '二级审核密码' }, { error: '连续失败≥3次，账号冻结30分钟', highRisk: 1 }, 'failure');
    secPwdFailMap.set(u.id, st);
    return { ok: false, frozen: true, remain };
  }
  logAudit(req, 'pwd_verify_failure', { type: '二级审核密码' }, { error: '密码错误', failCount: st.count }, 'failure');
  secPwdFailMap.set(u.id, st);
  return { ok: false, frozen: false, remain: 0 };
}

// 告警规则：高频导出（1h≥5）+ 凌晨敏感操作（0-6点）；返回 { highRisk, reason }，不重复记日志
function auditExportAlerts(req, action, target, detail) {
  const u = req.user || {};
  const hour = new Date().getHours();
  const out = { highRisk: 0, reason: '' };
  if (hour >= 0 && hour < 6) {
    out.highRisk = 1;
    out.reason = '凌晨敏感操作(0-6点)';
  }
  // 高频导出：1 小时内同人导出 ≥5 次
  const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const cnt = db.auditCount(u.id, ['export', 'export_announce'], oneHourAgo);
  if (cnt >= 5) {
    out.highRisk = 1;
    out.reason = (out.reason ? out.reason + '；' : '') + `1小时内导出${cnt}次`;
    sendAlert(`${u.name}(${u.username || u.id}) 1 小时内导出 ${cnt} 次，疑似高频数据外泄（IP: ${u._ip}）`);
  }
  return out;
}

// 前端事件上报（查看公示页 / 复制文本 / 打印）
app.post('/api/audit/event', authRequired, (req, res) => {  const { action, page, content, scope } = req.body || {};
  if (!['view_announce', 'copy_text', 'print_page'].includes(action)) return res.status(400).json({ error: '未知事件' });
  const u = req.user || {};
  const target = { type: page || '' };
  if (scope) target.scope = scope;
  let detail = {};
  let highRisk = 0;
  if (action === 'copy_text') {
    detail.copyContent = String(content || '').slice(0, 50);
    // 批量复制告警：1 分钟内 ≥10 次
    const now = Date.now();
    const c = copyCountMap.get(u.id) || { count: 0, windowStart: now };
    if (now - c.windowStart > 60000) { c.count = 0; c.windowStart = now; }
    c.count += 1;
    copyCountMap.set(u.id, c);
    if (c.count >= 10) { highRisk = 1; sendAlert(`${u.name} 1 分钟内连续复制 ${c.count} 次，疑似批量拷贝数据（IP: ${u._ip}）`); }
  }
  logAudit(req, action, target, detail, 'success');
  res.json({ ok: true });
});

// 审计日志查询（admin；筛选 + 分页 + MD5 追溯 + 高风险标记）
app.get('/api/admin/audit-logs', authRequired, requireRole('admin'), (req, res) => {
  const { action, ip, userId, from, to, scope, highRisk, md5, page = 1, pageSize = 50 } = req.query;
  const r = db.queryAudit({
    action: action || '', ip: ip || '', userId: userId || '',
    from: from || '', to: to || '', scope: scope || '', highRisk: highRisk || '',
    md5: md5 || '', page: Number(page) || 1, pageSize: Math.min(Number(pageSize) || 50, 200),
  });
  res.json(r);
});

// 日志列表/导出（年级/管理员；可选班级/学生/时间/操作类型）
app.get('/api/logs', authRequired, requireRole('admin'), (req, res) => {
  const d = db.load();
  const { className, studentName, action, role, from, to, format, page, pageSize } = req.query;
  let list = [...d.logs].reverse();
  if (className && className !== 'all') list = list.filter(l => l.className === className);
  if (studentName && studentName.trim()) list = list.filter(l => (l.byName || '').includes(studentName.trim()) || (l.targetName || '').includes(studentName.trim()));
  if (action && action !== 'all') list = list.filter(l => l.action === action);
  if (role && role !== 'all') list = list.filter(l => l.role === role);
  if (from) list = list.filter(l => l.time >= from);
  if (to) list = list.filter(l => l.time <= to);
  const total = list.length;
  const MAX = 50000; // 最多保留/导出 5 万条
  if (format === 'csv') {
    const slice = list.slice(0, MAX);
    const esc = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const header = '时间,操作人,角色,班级,学号,操作类型,详情,目标类型,目标名称';
    const rows = slice.map(l => [l.time, l.byName, l.role, l.className, l.studentId, l.action, l.detail, l.targetType, l.targetName].map(esc).join(','));
    const csv = '\uFEFF' + [header, ...rows].join('\r\n');
    const fname = `操作日志_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    return res.send(csv);
  }
  const ps = Math.min(500, Math.max(1, parseInt(pageSize) || 100));
  const pg = Math.max(1, parseInt(page) || 1);
  const start = (pg - 1) * ps;
  const pageList = list.slice(start, start + ps);
  res.json({ logs: pageList, total, page: pg, pageSize: ps });
});

// ============================================================
// 综测复核（替代原「公示与异议」）—— 三榜：first/second/third
// 流程：学生每榜各自提交复核申请（一榜/二榜/三榜），年级认定/驳回；班长只读
// ============================================================
const REVIEW_PROJECTS = ['政治思想', '道德修养', '遵纪守法', '诚实守信', '学习态度', '文明卫生', '社会服务', '集体活动', '创新能力及劳动素质', '社会实践报告'];
const REVIEW_ROUNDS = ['first', 'second', 'third'];
const ROUND_CN = { first: '一榜', second: '二榜', third: '三榜' };

// 学生在某榜已有提交则不能重复提交
function studentHasActiveReview(d, studentId, round) {
  return d.reviews.find(r => r.studentId === studentId && r.round === round && !['withdrawn'].includes(r.status));
}

// 某生某榜累计被「退回作废」的份数（2026-09-09：整份退回上限依据，REVIEW_WITHDRAW_LIMIT=2）
function reviewWithdrawnCount(d, studentId, round) {
  return (d.reviews || []).filter(r => r.studentId === studentId && r.round === round && r.status === 'withdrawn').length;
}
const REVIEW_WITHDRAW_LIMIT = 2; // 同生同榜累计退回上限（作废重建最多 2 轮；学生主动撤回同计）

// 某榜复核是否已过截止时间（2026-09-10：到截止后学生不可 提交/撤回，年级/admin 不可退回；留空=不限制）
function reviewDeadlinePassed(d, round) {
  const key = ({ first: 'firstReviewDeadline', second: 'secondReviewDeadline', third: 'thirdReviewDeadline' })[round];
  const dl = key ? (d.config[key] || '') : '';
  if (!dl) return false;
  const t = new Date(dl).getTime();
  return !Number.isNaN(t) && Date.now() >= t;
}

// 撤销某复核事项写入的智育复核链记录（按 reviewId+itemId 精确匹配）。
// 2026-09-10 起链记录均带 reviewId/itemId 溯源字段；更早存量无字段无法精确反查——
//   生产现网智育链为空（无已认定 C 类），无孤儿存量风险；未来若现存量孤儿记录，由 admin「清除复核记录」
//   （round 维度清理，removeReviewZhiyuOverride 按 round 兜底）收口。
// 返回是否实际移除了记录（供日志/审计）。
function removeReviewZhiyuOverride(d, review, item) {
  const sid = review && review.studentIdNo;
  const arr = sid && (d.zhiyuOverrides || {})[sid];
  if (!arr || !arr.length) return false;
  const kept = arr.filter(ov => !(ov.reviewId === review.id && ov.itemId === item.id));
  if (kept.length === arr.length) return false;
  if (kept.length) d.zhiyuOverrides[sid] = kept; else delete d.zhiyuOverrides[sid];
  return true;
}

// 原始综测申请是否已具备复核资格（2026-09-10 放宽：任一段 approved 即可，空段忽略）
//   背景：此前要求「已认定 + 未认定两段同时 approved」，把 88 位「已认定通过 + 未认定驳回」
//   学生挡在复核门外——前端已放宽（views.js isAnyApproved），但后端 applicationApproved 未同步，
//   导致前端放行、提交时仍被 400「请先完成并通过原始综测申请后再申请复核」拒绝。
//   安全性：B 类异议由 source-items 内层按 item.status 过滤（须 approved/overridden），
//   C 类智育复核不依赖 application 状态，A 类新增完全独立，故 application 至少一段 approved 即放行。
function applicationApproved(a) {
  if (!a) return false;
  const secs = [a.certifiedStatus, a.uncertifiedStatus].filter(s => s !== null && s !== undefined && s !== '');
  if (!secs.length) return false;
  return secs.some(s => s === 'approved');
}

// ==================== 阶段一：智育/教师评价/体育 数据层（2026-08-30）====================
// 体育成绩固定常量（不落库；如需调整改此常量）
const SPORTS_SCORE = 5;

// 智育终值 = 导入的智育分 + ≤ maxRound 的智育复核链末值
// maxRound: 'none' | 'first' | 'second' | 'third'（null = 全部）
function getFinalZhiyu(d, studentId, maxRound) {
  const sc = (d.scores && d.scores[studentId]) || {};
  let current = Number(sc.zhiyu) || 0;
  const overrides = (d.zhiyuOverrides && d.zhiyuOverrides[studentId]) || [];
  if (maxRound === 'none') return current;
  const maxIdx = maxRound == null ? 99 : REVIEW_ROUNDS.indexOf(maxRound);
  for (const ov of overrides) {
    const idx = REVIEW_ROUNDS.indexOf(ov.round);
    if (idx >= 0 && idx <= maxIdx) current = Number(ov.points) || 0;
  }
  return current;
}

// 教师评价分（仅三榜公示版使用；名单覆盖 + 基准分，无复核）
// 2026-09-09 名单制改造：scores[学号].teacher 有值（名单内，含显式 0）→ 用该值；
//   未在名单中 → 统一返回 TEACHER_BASE_SCORE（1.5）。导出 y3/y4 与三榜复核快照均经此函数，口径一致。
function getTeacherScore(d, studentId) {
  const sc = (d.scores && d.scores[studentId]) || {};
  if (sc.teacher == null) return TEACHER_BASE_SCORE;
  const v = Number(sc.teacher);
  return Number.isFinite(v) ? roundTo4(v) : TEACHER_BASE_SCORE;
}

// 德育终值：某学生截至 maxRound 的德育总分（10 类目封顶后之和，含复核调整）
// 与 snapshot-stats 里 row.total 的计算口径完全一致（抽取复用，避免两处漂移）
function getFinalDeyu(d, stu, maxRound) {
  const myApps = d.applications.filter(a => a.studentId === stu.id);
  // 2026-09-08 修复（加减分汇总）：排除「段级已退回」的申请（与 grade-stats L1224 / 公示四榜 L1481 同口径）
  const certItems = myApps.filter(a => a.certifiedStatus !== 'withdrawn')
    .flatMap(a => (a.certifiedItems || []).filter(it => it.status === 'approved' || it.status === 'overridden'));
  const uncertItems = myApps.filter(a => a.uncertifiedStatus !== 'withdrawn')
    .flatMap(a => (a.uncertifiedItems || []).filter(it => it.status === 'approved' || it.status === 'overridden'));
  const eff = buildReviewChain(d, stu.id, maxRound);
  const ovKey = (aId, kind, iId) => `${aId}|${kind}|${iId}`;
  const appIdOf = (arr, it) => (myApps.find(a => Array.isArray(a[arr]) && a[arr].includes(it)) || {}).id;
  const finalPtsOf = (arr, kind, it) => {
    const chain = eff.overrides[ovKey(appIdOf(arr, it), kind, it.id)] || [];
    return chain.length ? chain[chain.length - 1].points : _effPts(it);
  };
  const addByCol = {};
  Object.keys(BASE_SCORES).forEach(k => { addByCol[k] = 0; });
  certItems.forEach(it => { const col = classifyCertProject(it.project); if (col in addByCol) addByCol[col] += finalPtsOf('certifiedItems', 'cert', it); });
  uncertItems.forEach(it => { const col = classifyUncertItem(it); if (col && col in addByCol) addByCol[col] += finalPtsOf('uncertifiedItems', 'uncert', it); });
  eff.adds.forEach(ad => { if (ad.project in addByCol) addByCol[ad.project] += ad.points; });

  let total = 0;
  Object.keys(BASE_SCORES).forEach(k => {
    const base = BASE_SCORES[k] || 0;
    const rawAdd = addByCol[k] || 0;
    const cap = CAP_SCORES[k];
    total += (cap != null) ? Math.min(base + rawAdd, cap) : (base + rawAdd);
  });
  return roundTo4(total);
}

// 复核轮次 → 其"被复核的榜单"所对应的 maxRound
//   一榜复核(first)  → 德育一榜 y1（无复核）
//   二榜复核(second) → 综测二榜 y2 公示版（含一榜复核）
//   三榜复核(third)  → 综测三榜 y3 公示版（含一、二榜复核）
const ROUND_TARGET_MAXROUND = { first: 'none', second: 'first', third: 'second' };

// 榜单快照（数据衔接核心）：返回该生在指定复核轮次所看到的"被复核榜单"完整分值
// round: 'first' | 'second' | 'third'
//   first : { deyu, zhiyu:null, tiyu:null,   teacher:null, total: deyu }
//   second: { deyu, zhiyu,      tiyu:5,      teacher:null, total: deyu+zhiyu+5 }
//   third : { deyu, zhiyu,      tiyu:5,      teacher,      total: deyu+zhiyu+5+teacher }
function getRoundSnapshot(d, studentId, round) {
  const stu = d.users.find(u => u.id === studentId);
  if (!stu) return null;
  const maxRound = ROUND_TARGET_MAXROUND[round];
  if (maxRound == null) return null;
  const deyu = getFinalDeyu(d, stu, maxRound);
  if (round === 'first') {
    return { deyu, zhiyu: null, tiyu: null, teacher: null, total: roundTo4(deyu) };
  }
  const zhiyu = roundTo4(getFinalZhiyu(d, stu.studentId, maxRound));
  const teacher = round === 'third' ? roundTo4(getTeacherScore(d, stu.studentId)) : null;
  const total = roundTo4(deyu + zhiyu + SPORTS_SCORE + (teacher || 0));
  return { deyu, zhiyu, tiyu: SPORTS_SCORE, teacher, total };
}

// 查找学生已通过的申请项（用于 B 类异议引用）。返回 { item, title, category }
function findApprovedItem(d, studentId, appId, itemId, kind) {
  const a = d.applications.find(x => x.id === appId && x.studentId === studentId);
  if (!a) return null;
  const arr = kind === 'cert' ? a.certifiedItems : a.uncertifiedItems;
  const it = (arr || []).find(x => x.id === itemId);
  if (!it) return null;
  if (!['approved', 'overridden'].includes(it.status)) return null;
  const title = kind === 'cert' ? (it.content || it.code || '未填项目') : uncDisplay(it);
  const category = kind === 'cert' ? classifyCertProject(it.project) : classifyUncertItem(it);
  return { item: it, title, category };
}

// 复核项归类：A 类用审核方指定的 project；B 类用源项推导的类别
function reviewItemCategory(it) {
  if (it.kind === 'objection') return it.sourceCategory || classifyCertProject(it.project);
  return it.project;
}

// 汇总某学生所有「已结论复核」中对最终分的影响（供导出合并；计算期，不动主数据）
// overrides: `${appId}|${kind}|${itemId}` -> { points, round }（B 类异议覆盖；含 round 便于多榜链式导出）
// adds: [{ project, title, points, round }]（A 类新增；含 round 便于多榜链式导出）
// maxRound: null = 取所有 approved 复核（默认，与原行为一致）
//           'none' = 不取任何复核（仅原始已认定，等价于「年级审核完」状态）
//           'first' | 'second' | 'third' = 只取 ≤ 该 round 的已认定 approved 复核
function buildReviewEffects(d, studentId, maxRound = null) {
  const reviews = (d.reviews || []).filter(r => r.studentId === studentId && r.concludedAt);
  const overrides = {};
  const adds = [];
  if (maxRound === 'none') return { overrides, adds };
  const maxIdx = maxRound == null ? 99 : REVIEW_ROUNDS.indexOf(maxRound);
  for (const r of reviews) {
    const idx = REVIEW_ROUNDS.indexOf(r.round);
    if (idx < 0 || idx > maxIdx) continue;
    for (const it of r.items) {
      if (it.reviewStatus !== 'approved') continue;
      if (it.kind === 'objection') {
        overrides[`${it.sourceApplicationId}|${it.sourceKind}|${it.sourceItemId}`] = { points: it.reviewPoints, round: r.round };
      } else if (it.project) {
        adds.push({ project: it.project, title: it.title, points: it.reviewPoints, round: r.round });
      }
    }
  }
  return { overrides, adds };
}

// 完整多榜链版本（4 表导出/全程备案/学生端公示快照共用）：返回每个被异议项的完整修改链（按 round 顺序）
// overrides: key -> [{ points, round }]（按 round 顺序 1→2→3）
// adds: [{ project, title, points, round }]（与 buildReviewEffects 同）
// maxRound: 'none'=不取任何复核；null=取全部（与 buildReviewEffects 默认一致）；'first'|'second'|'third'=截至该轮
function buildReviewChain(d, studentId, maxRound) {
  const reviews = (d.reviews || []).filter(r => r.studentId === studentId && r.concludedAt);
  if (maxRound === 'none') return { overrides: {}, adds: [] };
  // 2026-09-10 上线前修复：null 此前落入 REVIEW_ROUNDS.indexOf(null)=-1 → 全部复核被跳过 → 全程备案 getFinalDeyu(null) 的
  //   德育终值不含任何复核调整，与公示 y4（截至 third）口径不一致。现与 buildReviewEffects 对齐：null=maxIdx 99 取全部。
  const maxIdx = maxRound == null ? 99 : REVIEW_ROUNDS.indexOf(maxRound);
  const overrides = {};
  const adds = [];
  for (const r of reviews) {
    const idx = REVIEW_ROUNDS.indexOf(r.round);
    if (idx < 0 || idx > maxIdx) continue;
    for (const it of r.items) {
      if (it.reviewStatus !== 'approved') continue;
      if (it.kind === 'objection') {
        const k = `${it.sourceApplicationId}|${it.sourceKind}|${it.sourceItemId}`;
        if (!overrides[k]) overrides[k] = [];
        overrides[k].push({ points: it.reviewPoints, round: r.round });
      } else if (it.project) {
        adds.push({ project: it.project, title: it.title, points: it.reviewPoints, round: r.round });
      }
    }
  }
  return { overrides, adds };
}

// 提交复核申请（multipart：基本字段 + 复核项 + 证明附件）
app.post('/api/reviews', authRequired, requireRole('student'), uploadFiles, (req, res) => {
  let body = {};
  body = parsePayload(req);
  if (body === null) return res.status(400).json({ error: '请求数据格式错误或数据过大（上限 1MB）' });
  const { round, major, type, types, applicationId, items, notes } = body;
  if (!REVIEW_ROUNDS.includes(round)) return res.status(400).json({ error: '复核榜单无效' });
  const d = db.load();
  const rr = d.config.reviewRounds || {};
  if (!rr[round]) return res.status(400).json({ error: `${ROUND_CN[round]}复核暂未开放，请等待年级开启` });
  // 截止时间（2026-09-10）：到截止后学生不可再提交（留空=不限制）
  if (reviewDeadlinePassed(d, round)) {
    return res.status(400).json({ error: `${ROUND_CN[round]}复核已超过提交截止时间，无法提交（如需补交请联系管理员）` });
  }
  // 累计撤回/退回上限（2026-09-10）：同生同榜 ≥2 次后仅 admin 可清除恢复再提交
  if (reviewWithdrawnCount(d, req.user.id, round) >= REVIEW_WITHDRAW_LIMIT) {
    return res.status(400).json({ error: `您的${ROUND_CN[round]}复核累计撤回/退回已达 ${REVIEW_WITHDRAW_LIMIT} 次上限，无法再次提交；如需提交请联系管理员清除记录` });
  }
  // 串行开榜：开二榜需先关一榜；开三榜需先关二榜
  if (round === 'second' && rr.first) return res.status(400).json({ error: '请先关闭一榜复核，再开启二榜' });
  if (round === 'third' && rr.second) return res.status(400).json({ error: '请先关闭二榜复核，再开启三榜' });
  // 原始申请必须已整体通过
  const app = d.applications.find(a => a.id === applicationId && a.studentId === req.user.id);
  if (!app || !applicationApproved(app)) {
    return res.status(400).json({ error: '请先完成并通过原始综测申请后再申请复核' });
  }
  // 复核锁定改为按榜次判定：依赖下方 studentHasActiveReview（同榜次不重复提交）
  // 与串行开榜约束（2300/2301），不再用全局 app.reviewLocked 拦截，避免一榜提交后二榜永久锁死
  if (studentHasActiveReview(d, req.user.id, round)) {
    return res.status(400).json({ error: `您已提交${ROUND_CN[round]}复核申请，请等待年级审核` });
  }
  // 兼容旧版 type 单值与新版 types 数组（A/B 可同时勾选，items 中每项自带 kind）
  const typeSet = Array.isArray(types) ? new Set(types) : (type ? new Set([type]) : new Set());
  if (!typeSet.size || ![...typeSet].every(x => ['add', 'objection'].includes(x))) {
    return res.status(400).json({ error: '请选择复核类型（新增/异议）' });
  }
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '请至少填写一项复核事项' });

  const files = req.files || [];
  let fileIdx = 0;
  const consumeFile = () => {
    if (fileIdx >= files.length) return null;
    const f = files[fileIdx++];
    return f ? { name: f.originalname, url: '/uploads/' + f.filename } : null;
  };

  let cleanItems = [];
  let inferredType = null; // 顶层 type 兼容字段：单选时存 add/objection；混合时存 'mixed'
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const itemKind = it.kind || (typeSet.has('add') && !typeSet.has('objection') ? 'add' : typeSet.has('objection') ? 'objection' : null);
    if (itemKind === 'add') {
      // 2026-09-10 上线前鲁棒性加固：A 类新增同样强制证明材料（附件铁律：新建/补交/重写每行必有证明材料——前端已强制，后端补齐防构造请求绕过）
      if (!it.proofFile) return res.status(400).json({ error: `新增项「${String(it.name || it.title || '').trim() || ('第' + (i + 1) + '项')}」必须上传证明材料` });
      const f = consumeFile();
      if (!f) return res.status(400).json({ error: 'A类新增缺少证明材料文件，请重新上传' });
      // 2026-09-10 上线前鲁棒性加固：德育单项申请分安全界（防 Infinity/手滑/恶意超大值；0 分项会被下方 filter 剔除）
      const aReq = parseFloat(it.points);
      if (!Number.isFinite(aReq) || Math.abs(aReq) > 20) return res.status(400).json({ error: '新增项申请加分须在 -20 ~ 20 之间' });
      cleanItems.push({
        id: 'ri_' + i, kind: 'add',
        title: (it.name || it.title || '').trim(),
        uncertType: (it.type || '其他'),
        level: (it.level || '').trim(),
        date: (it.date || '').trim(),
        unit: (it.unit || '').trim(),
        project: null,
        originalPoints: 0,
        requestedPoints: parseFloat(it.points) || 0,
        proof: f ? { name: (it.proofFileName || f.name), url: f.url, desc: (it.proofDesc || '').trim() } : null,
        reviewPoints: null, reviewComment: '', reviewStatus: 'pending',
        rejectReason: '', rejectProof: null, reviewProof: null,
      });
    } else if (itemKind === 'objection') {
      if (it.target === 'zhiyu') {
        // C 类：智育成绩复核（仅二榜/三榜开放；针对对应公示版的智育分）
        if (round === 'first') return res.status(400).json({ error: '一榜复核针对德育一榜，不含智育成绩，不能提交智育复核' });
        const sid = req.user.studentId;
        const sc = (d.scores && d.scores[sid]) || {};
        const hasZhiyu = sc.zhiyu != null || ((d.zhiyuOverrides || {})[sid] || []).length > 0;
        if (!hasZhiyu) return res.status(400).json({ error: '当前无智育成绩记录，无法提出智育复核' });
        const curZhiyu = roundTo4(getFinalZhiyu(d, sid, ROUND_TARGET_MAXROUND[round]));
        const ap = parseFloat(it.applyPoints);
        // 2026-09-10 上线前：智育复核申请分值上限由 100 调整为 68（与综测智育成绩口径一致）
        if (!Number.isFinite(ap) || ap < 0 || ap > 68) return res.status(400).json({ error: '智育复核申请分值须在 0~68 之间' });
        if (!it.proofFile) return res.status(400).json({ error: 'C类智育复核须上传本学年必修课教务系统成绩截图' });
        // 2026-09-10 上线前鲁棒性加固：同上——文件实体缺失同样拦截
        const f = consumeFile();
        if (!f) return res.status(400).json({ error: 'C类智育复核缺少成绩截图文件，请重新上传' });
        cleanItems.push({
          id: 'ri_' + i, kind: 'objection', target: 'zhiyu',
          title: '智育成绩复核',
          sourceApplicationId: null, sourceItemId: null, sourceKind: null,
          sourceCategory: null, project: null,
          originalPoints: curZhiyu, originalZhiyu: curZhiyu,
          requestedPoints: ap, applyPoints: ap,
          objectionReason: (it.objectionReason || '').trim(),
          proof: f ? { name: (it.proofFileName || f.name), url: f.url, desc: (it.proofDesc || '').trim() } : null,
          reviewPoints: null, reviewComment: '', reviewStatus: 'pending',
          rejectReason: '', rejectProof: null, reviewProof: null,
        });
      } else {
        const src = findApprovedItem(d, req.user.id, it.sourceApplicationId, it.sourceItemId, it.sourceKind);
        if (!src) return res.status(400).json({ error: `异议项来源项目无效或未通过审核：${it.sourceItemId}` });
        // 2026-09-10 上线前：B类异议须上传补充材料（证明材料）才能提交（附件铁律：新建/补交/重写每行必有证明材料）
        if (!it.proofFile) return res.status(400).json({ error: 'B类异议须上传补充材料（证明材料）才能提交' });
        // 2026-09-10 上线前鲁棒性加固：文件实体缺失（构造 proofFile:true 但文件耗尽/为空）同样拦截，避免"声明有证明实则无附件"落库
        const f = consumeFile();
        if (!f) return res.status(400).json({ error: 'B类异议缺少证明材料文件，请重新上传' });
        // 2026-09-10 上线前鲁棒性加固：德育异议申请修改分安全界（防 Infinity/手滑/恶意超大值污染展示与统计）
        const bReq = parseFloat(it.requestedPoints);
        if (!Number.isFinite(bReq) || Math.abs(bReq) > 20) return res.status(400).json({ error: 'B类异议申请修改分值须在 -20 ~ 20 之间' });
        cleanItems.push({
          id: 'ri_' + i, kind: 'objection', target: 'deyu',
          sourceApplicationId: it.sourceApplicationId,
          sourceItemId: it.sourceItemId,
          sourceKind: it.sourceKind,
          sourceCategory: src.category || null,
          title: src.title,
          project: src.category || null,
          originalPoints: _effPts(src.item),
          requestedPoints: parseFloat(it.requestedPoints) || 0,
          objectionReason: (it.objectionReason || '').trim(),
          proof: f ? { name: (it.proofFileName || f.name), url: f.url, desc: (it.proofDesc || '').trim() } : null,
          reviewPoints: null, reviewComment: '', reviewStatus: 'pending',
          rejectReason: '', rejectProof: null, reviewProof: null,
        });
      }
    } else {
      return res.status(400).json({ error: `复核项 #${i + 1} 类别无效（应为 add 或 objection）` });
    }
  }
  cleanItems = cleanItems.filter(it => it.kind === 'objection' || (it.title && it.requestedPoints));
  if (!cleanItems.length) return res.status(400).json({ error: '请至少填写一项有效的复核事项' });
  inferredType = typeSet.size === 1 ? [...typeSet][0] : 'mixed';

  const r = {
    id: db.genId('r'), studentId: req.user.id, studentName: req.user.name,
    className: req.user.className, studentIdNo: req.user.studentId, phone: req.user.phone || '',
    major: (major || '').trim(),
    round, type: inferredType, types: [...typeSet], applicationId,
    items: cleanItems,
    notes: (notes || '').toString().trim().slice(0, 500),
    status: 'pending', // pending/partial/approved/rejected
    concludedAt: null,
    logs: [{ byRole: 'student', byName: req.user.name, action: 'submit', comment: `提交${ROUND_CN[round]}复核申请（${inferredType === 'add' ? '仅新增' : inferredType === 'objection' ? '仅异议' : '新增+异议混合'}，${cleanItems.length}项）`, time: db.now() }],
    createdAt: db.now(), updatedAt: db.now(),
  };
  d.reviews.push(r);
  app.reviewLocked = true; // 锁定原始申请，复核期间不可修改
  db.save();
  addLog(req.user, 'review-submit', '提交' + ROUND_CN[round] + '复核申请（' + inferredType + '，' + cleanItems.length + '项）');
  res.json({ ok: true, review: r });
});

// 学生获取自己的复核列表
app.get('/api/my/reviews', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const list = d.reviews.filter(r => r.studentId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ reviews: list });
});

// 学生提交 B 类（异议）/C 类（智育复核）时可引用的数据（已通过项目 + 对应榜单快照）
// ?round=first|second|third：B 类德育项目分值显示该榜公示版链末值（一榜=原始值），并附 snapshot（该生该榜完整分值）
app.get('/api/review/source-items', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const round = req.query.round && REVIEW_ROUNDS.includes(req.query.round) ? req.query.round : null;
  const apps = d.applications.filter(a => a.studentId === req.user.id && applicationApproved(a));
  // 指定 round 时：德育项目分值取「该榜被复核的榜单」的复核链末值（数据衔接：二榜复核看 y2公示版、三榜复核看 y3公示版）
  const chainEff = round ? buildReviewChain(d, req.user.id, ROUND_TARGET_MAXROUND[round]) : null;
  const effKey = (aId, kind, iId) => `${aId}|${kind}|${iId}`;
  const finalPtsOf = (aId, kind, it) => {
    if (!chainEff) return _effPts(it);
    const chain = chainEff.overrides[effKey(aId, kind, it.id)] || [];
    return chain.length ? chain[chain.length - 1].points : _effPts(it);
  };
  const cert = [], uncert = [];
  for (const a of apps) {
    for (const it of (a.certifiedItems || [])) {
      if (!['approved', 'overridden'].includes(it.status)) continue;
      cert.push({
        applicationId: a.id, itemId: it.id, kind: 'cert',
        title: (it.content || it.code || '未填项目'), project: it.project,
        category: classifyCertProject(it.project), points: finalPtsOf(a.id, 'cert', it),
      });
    }
    for (const it of (a.uncertifiedItems || [])) {
      if (!['approved', 'overridden'].includes(it.status)) continue;
      uncert.push({
        applicationId: a.id, itemId: it.id, kind: 'uncert',
        title: uncDisplay(it), project: it.type,
        category: classifyUncertItem(it), points: finalPtsOf(a.id, 'uncert', it),
      });
    }
  }
  const snapshot = round ? getRoundSnapshot(d, req.user.id, round) : null;
  res.json({ certified: cert, uncertified: uncert, round, snapshot });
});

// 复核详情（学生/班长/年级/管理员）
app.get('/api/reviews/:id', authRequired, (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  const u = req.user;
  if (u.role === 'student' && r.studentId !== u.id) return res.status(403).json({ error: '无权查看' });
  if (u.role === 'monitor' && r.className !== u.className) return res.status(403).json({ error: '无权查看其他班级' });
  if (u.role === 'grade' && !assertGradeCanReview(req, res, r.className, ROUND_TO_KEY[r.round] || ('round' + r.round))) return;
  res.json({ review: r });
});

// 2026-09-10：复核审核界面——查看该复核对应学生的综测申请（已认定/未认定）情况
//   复用综测申请总览的详情展示（前端 _appDetailHtml 渲染）；权限与 GET /api/reviews/:id 完全一致
//   返回该生全部申请（按提交时间倒序），供审核人对照复核事项与原始申请依据
app.get('/api/reviews/:id/student-applications', authRequired, (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  const u = req.user;
  if (u.role === 'student' && r.studentId !== u.id) return res.status(403).json({ error: '无权查看' });
  if (u.role === 'monitor' && r.className !== u.className) return res.status(403).json({ error: '无权查看其他班级' });
  if (u.role === 'grade' && !assertGradeCanReview(req, res, r.className, ROUND_TO_KEY[r.round] || ('round' + r.round))) return;
  const list = (d.applications || [])
    .filter(a => a.studentId === r.studentId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ applications: list, studentName: r.studentName, studentIdNo: r.studentIdNo, className: r.className });
});

// 年级/管理员审核某项复核（认定/驳回）
app.post('/api/reviews/:id/review-item', authRequired, requireRole('grade', 'admin'), uploadFiles, (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  if (!assertGradeCanReview(req, res, r.className, ROUND_TO_KEY[r.round] || ('round' + r.round))) return;
  let body = {};
  body = parsePayload(req);
  if (body === null) return res.status(400).json({ error: '请求数据格式错误或数据过大（上限 1MB）' });
  const { itemId, action, reviewPoints, reviewComment, rejectReason, rejectProofName, project } = body;
  const item = r.items.find(it => it.id === itemId);
  if (!item) return res.status(404).json({ error: '复核事项不存在' });
  // 2026-09-10 需求#5C：智育成绩复核（C类）仅 admin 可审核（年级不可认定/驳回智育）
  // 2026-09-10 上线前：智育 C 类同时允许年级/admin 审核（之前仅 admin 可审——上线前放开）
  if (item.target === 'zhiyu' && req.user.role !== 'admin' && req.user.role !== 'grade') {
    return res.status(403).json({ error: '智育复核（C类）仅年级/管理员可审核' });
  }
  if (!['approve', 'reject', 'resubmit'].includes(action)) return res.status(400).json({ error: '无效的审核操作' });
  // 2026-09-10 上线前鲁棒性加固（复核状态机护栏）——合法组合：
  //   pending/resubmit → approve|reject|resubmit（正常审核流）
  //   rejected → approve（改判回流：admin「处理已审事项」弹窗的「重新认定」通道）
  //   approved → reject/resubmit（撤销认定：admin 弹窗「驳回/要求补交」改判通道）
  //   违规组合 400：approved 再 approve（重复认定无意义）、rejected 再 reject/resubmit（重复操作）。
  //   核心目的：防 C 类智育项链污染与孤儿分——getFinalZhiyu 直读 zhiyuOverrides 无状态过滤，
  //   若「已认定(写链)后被驳回/要求补交」不撤销链记录，会出现"事项已驳回但智育分仍按链生效"。
  const prevStatus = item.reviewStatus;
  if (action === 'approve') {
    if (prevStatus === 'approved') return res.status(400).json({ error: '该事项已认定，重复认定无意义；如需改分请用「✏ 直接修改」保存覆盖（需二级密码）' });
  } else if (prevStatus === 'rejected') {
    return res.status(400).json({ error: '该事项已驳回，请勿重复操作；如需重新审核请先点「重新认定」' });
  }

  const files = req.files || [];
  let attachFile = null;
  if (files[0]) attachFile = { name: rejectProofName || files[0].originalname, url: '/uploads/' + files[0].filename };

  if (action === 'approve') {
    // 2026-09-10 上线前鲁棒性加固：isNaN() 不拦截 Infinity（parseFloat('Infinity') 恒通过），统一 Number.isFinite + 显式空值拦截
    const rv = parseFloat(reviewPoints);
    if (reviewPoints === undefined || reviewPoints === null || String(reviewPoints).trim() === '' || !Number.isFinite(rv)) {
      return res.status(400).json({ error: '请填写有效的认定分值' });
    }
    // 2026-09-10 上线前修复：智育（C 类）认定分值同样限 0~68（学生申请与 admin 直改均已限，唯审核认定环节此前漏限，误填会污染 zhiyuOverrides 链）
    if (item.target === 'zhiyu') {
      if (rv < 0 || rv > 68) return res.status(400).json({ error: '智育复核（C类）认定分值须在 0~68 之间' });
    } else if (Math.abs(rv) > 20) {
      // 德育异议/新增单项认定分安全界：德育单类目上限 ≤4、基准 0~3，±20 远超任何正常单项
      // （防 Infinity / 手滑超大值 / 恶意构造污染加减分统计与公示快照）
      return res.status(400).json({ error: '德育单项认定分值须在 -20 ~ 20 之间' });
    }
    // A 类（新增）必须由审核方归类到 10 个类别之一
    if (item.kind === 'add') {
      if (!REVIEW_PROJECTS.includes(project)) return res.status(400).json({ error: '请为该新增项选择归属类别（10 类之一）' });
      item.project = project;
    }
    item.reviewStatus = 'approved';
    item.reviewPoints = rv;
    item.reviewComment = (reviewComment || '').toString().trim().slice(0, 500);
    if (attachFile) item.reviewProof = attachFile;
    item.rejectReason = '';
    item.rejectProof = null;
    // C 类（智育异议）审核通过 → 写入智育复核链（与 B 类德育链同构，供 getFinalZhiyu 按轮次取值）
    // 2026-09-10 上线前鲁棒性加固：链记录补充 reviewId/itemId 溯源字段（未来按来源件精确清理/审计；存量无字段不受影响）
    if (item.target === 'zhiyu') {
      const sid = r.studentIdNo;
      if (!sid) return res.status(400).json({ error: '无法定位该生学号，智育复核认定失败' });
      d.zhiyuOverrides = d.zhiyuOverrides || {};
      d.zhiyuOverrides[sid] = d.zhiyuOverrides[sid] || [];
      // 2026-09-10 上线前鲁棒性加固：先清同来源（本 review+本 item）旧链记录再写入——
      //   防改判回流（rejected→approve）或历史残留导致同 review 双记录（getFinalZhiyu 取末条，双记录必有一旧一新的冗余分档）
      const _kept = d.zhiyuOverrides[sid].filter(ov => !(ov.reviewId === r.id && ov.itemId === item.id));
      d.zhiyuOverrides[sid] = _kept;
      d.zhiyuOverrides[sid].push({
        reviewId: r.id, itemId: item.id,
        round: r.round, points: rv,
        reason: (reviewComment || '').toString().trim().slice(0, 500),
        approvedBy: req.user.name, timestamp: db.now(),
      });
    }
  } else if (action === 'reject') {
    if (!(rejectReason || '').toString().trim()) return res.status(400).json({ error: '请填写驳回原因' });
    // 2026-09-10 上线前鲁棒性加固：已认定（approved）项被驳回 = 撤销认定 → 同步撤销其智育链记录（防孤儿分）
    if (prevStatus === 'approved' && item.target === 'zhiyu') removeReviewZhiyuOverride(d, r, item);
    item.reviewStatus = 'rejected';
    item.rejectReason = (rejectReason || '').toString().trim().slice(0, 1000);
    if (attachFile) item.rejectProof = attachFile;
    item.reviewPoints = 0;
    item.reviewComment = '';
    item.reviewProof = null;
  } else {
    // 要求补交：标记该事项需补充材料并通知学生
    // 2026-09-10 上线前鲁棒性加固：已认定（approved）项被要求补交 = 撤销认定 → 同步撤销智育链记录
    if (prevStatus === 'approved' && item.target === 'zhiyu') removeReviewZhiyuOverride(d, r, item);
    item.reviewStatus = 'resubmit';
    item.rejectReason = (rejectReason || '').toString().trim().slice(0, 1000);
    d.notifications.push({
      id: db.genId('n'), studentId: r.studentId, reviewId: r.id,
      content: `您在${ROUND_CN[r.round]}复核中的事项「${item.title}」被要求补充材料，请登录系统补交。`,
      fromRole: req.user.role, fromName: req.user.name, type: 'review-resubmit', read: false, createdAt: db.now(),
    });
  }
  item.reviewTime = db.now();
  item.reviewer = req.user.name;
  // 审计（维度一/二）：复核审核通过/驳回（含前后分值）
  logAudit(req, action === 'approve' ? 'review_approve' : action === 'reject' ? 'review_reject' : 'review_resubmit', {
    type: item.target === 'zhiyu' ? '智育复核' : '德育复核',
    scope: r.className || '',
  }, {
    before: { points: item.originalPoints },
    after: action === 'approve' ? { points: item.reviewPoints } : undefined,
    error: action === 'reject' ? (item.rejectReason || '').slice(0, 200) : undefined,
  }, action === 'approve' ? 'success' : 'success');
  // 更新 review 总状态
  const allApproved = r.items.every(it => it.reviewStatus === 'approved');
  const allRejected = r.items.every(it => it.reviewStatus === 'rejected');
  // 2026-09-10 上线前大修（公示不体现二榜复核）：混合结局（部分认定+部分驳回，无待审/待补交）此前永不写
  //   concludedAt → buildReviewChain/buildReviewEffects 只看 r.concludedAt，整条复核（含已认定项）被三/四榜公示丢弃。
  //   结论判定改为「无任何 pending/resubmit 项即终审」：partial 混合结论也写 concludedAt，approved 项正常计入。
  const anyPending = r.items.some(it => it.reviewStatus === 'pending' || it.reviewStatus === 'resubmit');
  const anyReviewed = r.items.some(it => it.reviewStatus !== 'pending' && it.reviewStatus !== 'resubmit');
  r.status = allApproved ? 'approved' : allRejected ? 'rejected' : (anyReviewed ? 'partial' : 'pending');
  // 结论落定（无待审/待补交即终审——通过/驳回/混合都算；补交后需再次审核）
  if (!anyPending) r.concludedAt = db.now();
  const commentMap = { approve: `认定 ${item.title} +${item.reviewPoints}`, reject: `驳回 ${item.title}：${item.rejectReason}`, resubmit: `要求补交 ${item.title}` };
  r.logs.push({ byRole: 'grade', byName: req.user.name, action, itemId, comment: commentMap[action], time: db.now() });
  r.updatedAt = db.now();
  db.save();
  addLog(req.user, 'review-item', (commentMap[action] || action));
  res.json({ ok: true, review: r });
});

// 学生补交复核材料（仅限被要求补交 reviewStatus==='resubmit' 的事项）
app.post('/api/reviews/:id/resubmit-item', authRequired, requireRole('student'), uploadFiles, (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id && x.studentId === req.user.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  let body = {};
  body = parsePayload(req);
  if (body === null) return res.status(400).json({ error: '请求数据格式错误或数据过大（上限 1MB）' });
  const { itemId, objectionReason, proofDesc } = body;
  const item = r.items.find(it => it.id === itemId);
  if (!item) return res.status(404).json({ error: '复核事项不存在' });
  if (item.reviewStatus !== 'resubmit') return res.status(400).json({ error: '该事项当前无需补交' });
  const files = req.files || [];
  // 2026-09-10 上线前鲁棒性加固：补交必须携带新的证明材料（附件铁律——此前无文件也放行置回 pending，等于绕过"要求补交"）
  if (!files[0]) return res.status(400).json({ error: '补交必须上传新的证明材料' });
  {
    const f = { name: files[0].originalname, url: '/uploads/' + files[0].filename };
    item.proof = { name: f.name, url: f.url, desc: (proofDesc || '').trim() };
  }
  if (item.kind === 'objection' && objectionReason) item.objectionReason = objectionReason.toString().trim();
  item.reviewStatus = 'pending';
  item.reviewTime = db.now();
  r.logs.push({ byRole: 'student', byName: req.user.name, action: 'resubmit-item', itemId, comment: `补交材料：${item.title}`, time: db.now() });
  r.updatedAt = db.now();
  db.save();
  res.json({ ok: true, review: r });
});

// 年级/管理员整份退回复核申请（2026-09-09：仅未审核 pending 可退；退回=作废，学生可重新提交全新复核）
// 限制：原因必填 / 榜次开启中 / 同生同榜累计退回 ≤ REVIEW_WITHDRAW_LIMIT / monitor 无权
app.post('/api/reviews/:id/withdraw', authRequired, requireRole('grade', 'admin'), (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  if (!assertGradeCanReview(req, res, r.className, ROUND_TO_KEY[r.round] || ('round' + r.round))) return;
  // 关榜后禁退（与提交复核同一开关 reviewRounds[round]，关闭即作废通道关闭）
  const rr = d.config.reviewRounds || {};
  if (!rr[r.round]) return res.status(400).json({ error: `${ROUND_CN[r.round]}复核已关闭，不能再退回复核申请` });
  // 截止后禁退（2026-09-10：到截止后学生侧通道全关，异常走 admin「清除复核申请」）
  if (reviewDeadlinePassed(d, r.round)) {
    return res.status(400).json({ error: `${ROUND_CN[r.round]}复核已超过截止时间，不能再退回（如需处理请联系管理员清除）` });
  }
  if (r.status !== 'pending') return res.status(400).json({ error: '仅未审核的复核申请可以退回' });
  const reason = String(((req.body || {}).reason) || ((req.body || {}).withdrawReason) || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写退回原因' });
  if (reviewWithdrawnCount(d, r.studentId, r.round) >= REVIEW_WITHDRAW_LIMIT) {
    return res.status(400).json({ error: `该生${ROUND_CN[r.round]}复核已被退回 ${REVIEW_WITHDRAW_LIMIT} 次，不能再次退回（上限 ${REVIEW_WITHDRAW_LIMIT} 次）` });
  }
  const ts = db.now();
  r.status = 'withdrawn'; // 作废终态：学生端只读；studentHasActiveReview 豁免 → 可重新提交
  r.withdrawnReason = reason.slice(0, 1000);
  r.withdrawnBy = req.user.name;
  r.withdrawnByRole = req.user.role;
  r.withdrawnAt = ts;
  r.logs.push({ byRole: req.user.role, byName: req.user.name, action: 'withdraw', comment: `退回整份复核：${reason.slice(0, 300)}`, time: ts });
  r.updatedAt = ts;
  d.notifications.push({
    id: db.genId('n'), studentId: r.studentId, reviewId: r.id,
    content: `您在${ROUND_CN[r.round]}复核中的申请被退回（作废），如需复核请重新提交。退回原因：${reason.slice(0, 300)}`,
    fromRole: req.user.role, fromName: req.user.name, type: 'review-withdrawn', read: false, createdAt: ts,
  });
  db.save();
  addLog(req.user, 'review-withdraw', `退回${ROUND_CN[r.round]}复核：${r.studentName}（${reason.slice(0, 200)}）`);
  logAudit(req, 'review_withdraw', { type: ROUND_CN[r.round] + '复核退回', scope: r.className || '' }, { highRisk: 1 });
  res.json({ ok: true, review: r });
});

// 学生主动撤回自己的复核申请（2026-09-10：仅本人 + 未审核 pending + 榜次开启 + 未过截止）
// 撤回=作废（status='withdrawn'），与被年级退回共享 REVIEW_WITHDRAW_LIMIT=2 上限（同计 reviewWithdrawnCount）
app.post('/api/reviews/:id/self-withdraw', authRequired, requireRole('student'), (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  if (r.studentId !== req.user.id) return res.status(403).json({ error: '只能撤回自己的复核申请' });
  const rr = d.config.reviewRounds || {};
  if (!rr[r.round]) return res.status(400).json({ error: `${ROUND_CN[r.round]}复核已关闭，不能再撤回` });
  if (reviewDeadlinePassed(d, r.round)) {
    return res.status(400).json({ error: `${ROUND_CN[r.round]}复核已超过截止时间，不能再撤回（如需处理请联系管理员）` });
  }
  if (r.status !== 'pending') return res.status(400).json({ error: '仅未审核的复核申请可以撤回' });
  const reason = String((req.body || {}).reason || '').trim();
  const ts = db.now();
  r.status = 'withdrawn'; // 作废终态：只读；studentHasActiveReview 豁免 → 未超限时可重新提交
  r.withdrawnReason = reason ? `学生主动撤回：${reason.slice(0, 1000)}` : '学生主动撤回';
  r.withdrawnBy = req.user.name;
  r.withdrawnByRole = 'student';
  r.withdrawnAt = ts;
  r.logs.push({ byRole: 'student', byName: req.user.name, action: 'self-withdraw', comment: reason ? `学生主动撤回：${reason.slice(0, 300)}` : '学生主动撤回', time: ts });
  r.updatedAt = ts;
  db.save();
  addLog(req.user, 'review-self-withdraw', `学生撤回${ROUND_CN[r.round]}复核：${r.studentName}（${reason.slice(0, 200) || '无原因'}）`);
  res.json({ ok: true, review: r });
});

// 管理员清除某生某榜次复核记录（2026-09-10：学生累计撤回/退回达 2 次上限或已过截止后的唯一恢复通道）
// 语义：硬删该生该榜全部复核记录（含历史 withdrawn），计数归零 → 学生可重新提交；需二级密码 + 高危审计
app.post('/api/admin/reviews/clear', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const d = db.load();
  const { studentId, round, secondaryPassword } = req.body || {};
  if (!studentId) return res.status(400).json({ error: '缺少学生' });
  if (!['first', 'second', 'third', 'all'].includes(round)) return res.status(400).json({ error: '无效的榜次' });
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return res.status(v.frozen ? 423 : 401).json({ error: v.frozen ? `二级审核密码错误次数过多，已冻结，请 ${v.remain} 分钟后再试` : v.err || '二级审核密码错误' });
  }
  const target = d.users.find(u => u.id === studentId);
  const removed = (d.reviews || []).filter(r => r.studentId === studentId && (round === 'all' || r.round === round));
  if (!removed.length) return res.status(404).json({ error: '该学生没有可清除的复核记录' });
  const ids = new Set(removed.map(r => r.id));
  d.reviews = (d.reviews || []).filter(r => !ids.has(r.id));
  // 2026-09-10 上线前鲁棒性加固：同步清理该生该（些）榜次的智育复核链记录——
  //   zhiyuOverrides 是独立于 reviews 的旁路链（getFinalZhiyu 直接消费、无生命周期过滤），若不清：
  //   被删份里已 approved 的 C 类认定会残留成「孤儿分」，学生重提不含 C 项的新复核后分数仍被旧链篡改。
  //   round='all' 清全部；按 round 匹配对存量（无 reviewId 字段）与新增（带 reviewId）记录同样精确。
  const zArr = target && target.studentId && (d.zhiyuOverrides || {})[target.studentId];
  if (zArr && zArr.length) {
    const beforeLen = zArr.length;
    d.zhiyuOverrides[target.studentId] = round === 'all'
      ? []
      : zArr.filter(ov => ov.round !== round);
    if (d.zhiyuOverrides[target.studentId].length !== beforeLen) {
      addLog(req.user, 'review-clear-zhiyu', `清除${ROUND_CN[round] || '全部'}复核时同步清理智育复核链记录：${target.name || studentId}（移除 ${beforeLen - d.zhiyuOverrides[target.studentId].length} 条）`);
    }
    if (!d.zhiyuOverrides[target.studentId].length) delete d.zhiyuOverrides[target.studentId];
  }
  db.save();
  addLog(req.user, 'review-clear', `管理员清除复核记录：${target ? target.name + '（' + target.username + '）' : studentId} ${round === 'all' ? '全部榜次' : ROUND_CN[round]} 共 ${removed.length} 份`);
  logAudit(req, 'review_clear', { type: '清除复核记录', scope: round === 'all' ? '全部榜次' : ROUND_CN[round] + '复核', name: target ? target.name : studentId }, { highRisk: 1 });
  res.json({ ok: true, cleared: removed.length, round });
});

// 2026-09-10 需求#3：admin 直接修改「已认定」复核事项（覆盖生效，不重新进入待审；二级密码；记日志；不通知学生）
// 可改字段：A类新增=名称/归属类别/认定分值；B类德育异议=认定分值（类别跟随原项目、名称不可改，避免影响原始申请）；
// C类智育走智育数据源/复核链，不支持直接改值。
app.post('/api/admin/reviews/:id/edit-item', authRequired, requireRole('admin'), sensitiveLimiter, async (req, res) => {
  const d = db.load();
  const r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '复核不存在' });
  // 2026-09-10 上线前修复：作废（withdrawn）份只读，禁止直改（与前端隐藏按钮对齐，防绕过）
  if (r.status === 'withdrawn') return res.status(400).json({ error: '该复核已退回/撤回作废（只读），如需修改请先清除该生记录后重新提交' });
  const { itemId, secondaryPassword } = req.body || {};
  const item = (r.items || []).find(it => it.id === itemId);
  if (!item) return res.status(404).json({ error: '复核事项不存在' });
  // 2026-09-10 上线前：智育（C类）放行 approved|rejected 状态——驳回后 admin 也可改分（其他类型保持仅 approved）
  if (item.target === 'zhiyu') {
    if (!['approved', 'rejected'].includes(item.reviewStatus)) return res.status(400).json({ error: '智育复核（C类）仅已认定/已驳回项可修改（待审/待补交请走审核操作）' });
  } else if (item.reviewStatus !== 'approved') {
    return res.status(400).json({ error: '仅「已认定」的复核事项可修改（待审/驳回/补交项请走审核操作）' });
  }
  const v = await verifySecPwd(req, secondaryPassword);
  if (!v.ok) {
    return res.status(v.frozen ? 423 : 401).json({ error: v.frozen ? `二级审核密码错误次数过多，已冻结，请 ${v.remain} 分钟后再试` : v.err || '二级审核密码错误' });
  }
  const body2 = req.body || {};
  const { category, points, name } = body2;
  const beforeName = item.title || '';
  const beforeCat = item.project || (item.kind === 'objection' ? (item.sourceCategory || null) : null) || null;
  const beforePts = item.reviewPoints;
  const msgs = [];
  if (item.kind === 'add') {
    // A类：名称/类别/分值均可改
    if (name !== undefined) {
      const nn = String(name).trim();
      if (!nn) return res.status(400).json({ error: '项目名称不能为空' });
      if (nn !== beforeName) { item.title = nn.slice(0, 200); msgs.push(`名称「${beforeName}」→「${nn}」`); }
    }
    if (category !== undefined && category !== null && category !== '') {
      if (!REVIEW_PROJECTS.includes(category)) return res.status(400).json({ error: '归属类别无效（须为 10 类之一）' });
      if (category !== item.project) { item.project = category; msgs.push(`类别「${beforeCat}」→「${category}」`); }
    }
  } else {
    // B类（德育异议）：类别跟随原项目；名称仅 A 类可改
    if (category !== undefined && category !== null && category !== '' && category !== item.project && category !== (item.sourceCategory || null)) {
      return res.status(400).json({ error: '异议项（B类）归属类别跟随原项目，不可修改' });
    }
    if (name !== undefined && String(name).trim() !== beforeName) {
      return res.status(400).json({ error: '仅 A 类新增项目可修改项目名称' });
    }
  }
  if (points !== undefined && points !== null && points !== '') {
    const p = parseFloat(points);
    if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: '认定分值格式错误' });
    // 2026-09-10 上线前：智育 C 类认定分值上限 0~68（与申请分保持一致）
    if (item.target === 'zhiyu') {
      if (p > 68) return res.status(400).json({ error: '智育复核（C类）认定分值须在 0~68 之间' });
    } else if (p > 20) {
      // 2026-09-10 上线前鲁棒性加固：德育单项安全界（单类目 CAP ≤4，>20 必为手滑/恶意超大值）
      return res.status(400).json({ error: '德育单项认定分值须在 0 ~ 20 之间' });
    }
    if (Number(beforePts) !== p) { item.reviewPoints = p; msgs.push(`分值 ${beforePts} → ${p}`); }
  }
  if (!msgs.length) return res.status(400).json({ error: '未检测到任何修改（名称/类别/分值均与现值相同）' });
  item.editedAt = db.now();
  item.editedBy = req.user.name;
  // 2026-09-10 上线前：智育 C 类改分同步更新 d.zhiyuOverrides 链（否则 getFinalZhiyu 仍按旧值取，公示导出与导回分不一致）
  // 2026-09-10 上线前修复：此前仅更新已存在链记录——被驳回的智育项（reject 时从不写链）改分会被静默丢弃，admin「看似改成功实则不生效」；
  //   现改为：有链记录→更新该 round 末条；无链记录→新增（改判认定），保证 getFinalZhiyu/公示/导出/备案采用新值
  if (item.target === 'zhiyu' && Number(item.reviewPoints) !== Number(beforePts)) {
    const sid = r.studentIdNo;
    if (sid) {
      d.zhiyuOverrides = d.zhiyuOverrides || {};
      const arr = (d.zhiyuOverrides[sid] = d.zhiyuOverrides[sid] || []);
      // 取该 round 最后一条（getFinalZhiyu 按数组序取末值 → 尾部倒查，避免同 round 多记录时改到旧条目）
      let ov = null;
      for (let k = arr.length - 1; k >= 0; k--) { if (arr[k].round === r.round) { ov = arr[k]; break; } }
      if (ov) {
        ov.points = item.reviewPoints;
        ov.reason = (item.reviewComment || '').toString().trim().slice(0, 500);
        ov.editedBy = req.user.name;
        ov.editedAt = db.now();
        // 2026-09-10 上线前鲁棒性加固：存量链记录补溯源字段（便于未来按来源复核件精确清理/审计）
        if (ov.reviewId == null) { ov.reviewId = r.id; ov.itemId = item.id; }
        msgs.push('（同步更新智育复核链 zhiyuOverrides）');
      } else {
        arr.push({
          reviewId: r.id, itemId: item.id,
          round: r.round, points: item.reviewPoints,
          reason: (item.reviewComment || item.rejectReason || '').toString().trim().slice(0, 500),
          approvedBy: req.user.name, editedBy: req.user.name, editedAt: db.now(), timestamp: db.now(),
        });
        msgs.push('（写入智育复核链 zhiyuOverrides：驳回改判认定）');
      }
    }
    // 被驳回的智育项经改分 → 语义即改判认定：状态转 approved（行级「+认定分」与整份聚合口径自洽，明细不再显示「驳回」）
    if (item.reviewStatus === 'rejected') {
      item.reviewStatus = 'approved';
      item.reviewComment = (item.reviewComment || item.rejectReason || '').toString().trim().slice(0, 500);
      item.rejectReason = '';
      item.rejectProof = null;
      msgs.push('（状态：驳回 → 已认定）');
    }
  }
  // 2026-09-10 上线前修复：改判后重算整份状态/结论时间（与 review-item 审核口径一致），避免年级列表「全部驳回」与明细「已认定」错位
  {
    const _allA = r.items.every(t => t.reviewStatus === 'approved');
    const _allR = r.items.every(t => t.reviewStatus === 'rejected');
    const _anyP = r.items.some(t => t.reviewStatus === 'pending' || t.reviewStatus === 'resubmit');
    const _anyV = r.items.some(t => t.reviewStatus !== 'pending' && t.reviewStatus !== 'resubmit');
    r.status = _allA ? 'approved' : _allR ? 'rejected' : (_anyV ? 'partial' : 'pending');
    if (!_anyP) r.concludedAt = r.concludedAt || db.now();
  }
  r.logs.push({ byRole: 'admin', byName: req.user.name, action: 'edit-item', itemId, comment: `修改已认定事项：${msgs.join('；')}`, time: db.now() });
  r.updatedAt = db.now();
  db.save();
  addLog(req.user, 'review-edit', `修改已认定复核事项：${r.studentName || r.studentIdNo} ${ROUND_CN[r.round]}复核 ${msgs.join('；')}`);
  logAudit(req, 'review_edit', { type: '德育复核', scope: r.className || '', name: r.studentName || r.studentIdNo }, {
    before: { name: beforeName, category: beforeCat, points: beforePts },
    after: { name: item.title, category: item.project || (item.kind === 'objection' ? (item.sourceCategory || null) : null) || null, points: item.reviewPoints },
    highRisk: 1,
  });
  res.json({ ok: true, changed: msgs, review: r });
});

// 班长/年级/管理员获取复核列表（按班级/榜次筛选）
app.get('/api/reviews', authRequired, requireRole('monitor', 'grade', 'admin'), (req, res) => {
  const d = db.load();
  const { round, status, className, q, major, page, pageSize } = req.query;
  let list = [...d.reviews];
  if (req.user.role === 'monitor') list = list.filter(r => r.className === req.user.className);
  if (req.user.role === 'grade') {
    const scopes = allowedReviewScopes(req.user);
    if (scopes) {
      const reqRound = (round && round !== 'all') ? String(round) : null;
      list = list.filter(r => {
        // 2026-08-20：round=all 时也按 (className, round) 精确匹配，grade 不再看到未被分配榜次的复核
        if (reqRound) return scopes.some(s => s.className === r.className && s.round === reqRound);
        return scopes.some(s => s.className === r.className && s.round === r.round);
      });
    }
  }
  // 权限过滤后的全量班级/专业（供前端下拉）+ 各榜次计数（供前端 tabs，不受筛选影响）
  const classes = [...new Set(list.map(r => r.className).filter(Boolean))].sort();
  const majors = [...new Set(list.map(r => (r.major || '').trim()).filter(Boolean))].sort();
  const roundCounts = { first: 0, second: 0, third: 0, all: list.length };
  for (const r of list) if (roundCounts[r.round] !== undefined) roundCounts[r.round]++;
  if (className && className !== 'all') list = list.filter(r => r.className === className);
  // 服务端过滤：姓名/学号模糊 + 专业（前端查询栏可走服务端，与客户端过滤并存）
  if (q && String(q).trim()) {
    const k = String(q).trim().toLowerCase();
    list = list.filter(r => ((r.studentName || '') + ' ' + (r.studentIdNo || '')).toLowerCase().includes(k));
  }
  if (major && major !== 'all') list = list.filter(r => (r.major || '').trim() === String(major).trim());
  if (round && round !== 'all') list = list.filter(r => r.round === round);
  if (status && status !== 'all') list = list.filter(r => r.status === status);
  // 2026-09-10 健壮性：历史/备案基线记录可能缺 studentName/studentIdNo/className → 从用户表补全（防 undefined 展示）
  const umap9 = new Map(d.users.map(u => [u.id, u]));
  list.forEach(r => {
    const u9 = umap9.get(r.studentId);
    if (u9) {
      if (!r.studentName) r.studentName = u9.name || '';
      if (!r.studentIdNo) r.studentIdNo = u9.studentId || '';
      if (!r.className) r.className = u9.className || '';
      if (!r.major && u9.major) r.major = u9.major;
    }
  });
  list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  // 服务端分页：仅当请求带 page 参数时启用（未带则返回全量，兼容旧调用）
  const total = list.length;
  let data = list, pg = 1, ps = 50, totalPages = 1;
  if (page !== undefined) {
    pg = Math.max(1, parseInt(page, 10) || 1);
    ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
    totalPages = Math.max(1, Math.ceil(total / ps));
    data = list.slice((pg - 1) * ps, pg * ps);
  }
  res.json({ reviews: data, data, total, page: pg, pageSize: ps, totalPages, classes, majors, roundCounts });
});

app.get('/api/reviews-meta', (req, res) => {
  res.json({ projects: REVIEW_PROJECTS, rounds: REVIEW_ROUNDS, roundCn: ROUND_CN });
});

// ============================================================
// 全局错误处理中间件（必须注册在所有路由之后，Express 4 才会调用它）
// ============================================================
// 全局错误处理中间件（必须注册在所有路由之后，Express 4 才会调用它）
// 把 MulterError 等异常转换为友好的 JSON 响应，避免出现 HTML "Internal Server Error"
// ============================================================
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.name === 'MulterError') {
    // Multer 错误是用户可理解的（文件数/大小/类型），直接回显
    return res.status(err.status || 400).json({ error: '上传失败：' + err.message + '（请检查文件数/大小/类型）' });
  }
  // 其它内部错误：只记录堆栈，不向客户端回显内部细节（避免泄露 SQL/路径等信息）
  console.error('[server] 未处理错误:', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  res.status(err && err.status || 500).json({ error: '服务器内部错误，请稍后重试' });
});

// 2026-09-01 H4：启动自检——listen 前主动 load() 一次。
// 若 ZONGCE_MASTER_KEY 缺失/错误，decryptPII 会抛错（fail-fast），进程直接拒绝启动，
// 避免「缺密钥进程跑起来 → 首请求 500 → 一旦 persist 全库 PII 静默清零」的最坏情况。
db.load();
app.listen(PORT, HOST, () => {
  const lan = getLanIP();
  console.log('==================================================');
  console.log('  综合素质测评审批系统 已启动');
  console.log('--------------------------------------------------');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  局域网访问: http://${lan}:${PORT}  (同网段设备可访问)`);
  console.log(`  ⚙️  并发闸门容量：上传/复核 ${uploadGate.limit || 256} 并发 · 下载 ${downloadGate.limit || 15} 并发`);
  console.log('--------------------------------------------------');
  console.log('  ⚠️  默认 admin 密码以部署时的首次启动日志为准（打印一次，请立即保管）');
  console.log('  忘记密码请使用「重置密码」功能，让系统生成新密码并当面告知学生');
  console.log('==================================================');
});

module.exports = app;
