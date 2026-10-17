// 默认二级审核密码（可由环境变量 DEFAULT_SECONDARY_PASSWORD 覆盖）
// 生产部署请务必修改，勿使用默认值。
const DEFAULT_SECONDARY_PASSWORD = process.env.DEFAULT_SECONDARY_PASSWORD || 'ChangeMe@0000';

// ============================================================
// 数据层：SQLite 存储（better-sqlite3，WAL + 事务 + 防抖保存）
// ------------------------------------------------------------
// 对外接口与旧版 JSON 实现完全一致：
//   load()  返回内存对象（单例），server.js 直接对其增删改
//   save()  持久化到 SQLite
// 因此 server.js 无需任何改动即可获得：
//   - 并发安全（WAL + 写锁串行化，避免覆盖丢数据）
//   - 原子写（事务提交，崩溃不损坏）
//   - 崩溃恢复（WAL 日志）
//   - 稳定内存（load 只发生一次，不每次把全量文件读进内存）
// ============================================================
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fastq = require('fastq');   // 写队列：串行化落盘（并发=1），避免突发写互相叠加

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');   // 旧文件，仅用于首次迁移
const DB_FILE = path.join(DATA_DIR, 'zongce.db');      // SQLite 数据库
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// PII 加密：idCard + application/review 内的 phone 字段
// 算法：AES-256-GCM（认证加密，防篡改）
// 格式：'enc:v1:<iv-hex>:<tag-hex>:<ct-base64>'
// 主密钥：环境变量 ZONGCE_MASTER_KEY（hex/base64 均可，长度=32字节）
//        缺失时启动失败，避免密钥漂移导致历史数据全毁
// ============================================================
const PII_PREFIX = 'enc:v1:';
function getMasterKey() {
  const raw = process.env.ZONGCE_MASTER_KEY;
  if (!raw) {
    throw new Error('[db] 严重：未设置环境变量 ZONGCE_MASTER_KEY，禁止启动。请生成 32 字节随机密钥并写入 server systemd 的 EnvironmentFile（权限 600）。');
  }
  // 兼容 hex（64字符）或 base64（44字符带 padding），也兼容直接 UTF-8 字符串（32字节）
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else if (raw.length === 44 && /^[A-Za-z0-9+/=]+$/.test(raw)) key = Buffer.from(raw, 'base64');
  else key = crypto.createHash('sha256').update(raw, 'utf8').digest();
  if (key.length !== 32) throw new Error('[db] ZONGCE_MASTER_KEY 解码后不是 32 字节');
  return key;
}
function encryptPII(plain) {
  if (plain === undefined || plain === null || plain === '') return plain;
  if (typeof plain === 'string' && plain.startsWith(PII_PREFIX)) return plain; // 已是密文
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PII_PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + ct.toString('base64');
}
function decryptPII(enc) {
  if (enc === undefined || enc === null || enc === '') return enc;
  if (typeof enc !== 'string' || !enc.startsWith(PII_PREFIX)) {
    // 历史明文：原样返回（兼容尚未迁移的旧值），外层在 load() 时会一次性回填
    return enc;
  }
  try {
    const key = getMasterKey();
    const parts = enc.slice(PII_PREFIX.length).split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ct = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // 2026-09-01 H4：区分「密钥缺失」（getMasterKey 抛出的 [db] 前缀错误）与「数据损坏/密钥错误」。
    // 密钥缺失必须 fail-fast（直接抛出、拒绝启动），否则解密返空串后 persist 会把全库 PII 静默清零。
    if (String((e && e.message) || e).includes('[db]')) throw e;
    console.error('[db] PII 解密失败（密钥错误或数据被篡改）：', e.message);
    return '';
  }
}
// 需要加密的字段路径定义
const USER_PII_FIELDS = ['idCard'];
const APPLICATION_PII_FIELDS = ['phone'];
const REVIEW_PII_FIELDS = ['phone'];
function encryptObjPII(obj, fields) {
  for (const f of fields) {
    if (obj[f] !== undefined && obj[f] !== '') obj[f] = encryptPII(obj[f]);
  }
}
function decryptObjPII(obj, fields) {
  for (const f of fields) {
    if (obj[f] !== undefined && obj[f] !== '') obj[f] = decryptPII(obj[f]);
  }
}

const sql = new Database(DB_FILE);
sql.pragma('journal_mode = WAL');      // 写前日志：并发读 + 崩溃恢复
sql.pragma('synchronous = NORMAL');    // 性能与安全的平衡（WAL 下足够安全）
sql.pragma('busy_timeout = 5000');     // 写锁等待 5s，避免 SQLITE_BUSY
sql.pragma('wal_autocheckpoint = 256'); // 每约 256 页(~1MB)自动 checkpoint，保持主库较新、WAL 不过大
sql.pragma('cache_size = -20000');      // 页缓存≈20MB（负值=KB）；提升读写吞吐。单例连接建立时执行一次，库已存在也生效
sql.exec('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT)');

// ============================================================
// 独立审计日志表（2026-08-30 安全增强）：与业务 store KV 隔离
// 只追加（Append-Only），不允许修改/删除历史日志；保留 365 天
// ============================================================
sql.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  duration INTEGER,
  result TEXT,
  detail TEXT,
  highRisk INTEGER DEFAULT 0
)`);
sql.exec('CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(timestamp)');
sql.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)');

// 追加一条审计日志（入参为普通对象，内部序列化；失败不抛错避免影响业务）
function audit(record) {
  try {
    sql.prepare(`INSERT INTO audit_logs (id, timestamp, actor, action, target, duration, result, detail, highRisk)
      VALUES (@id, @timestamp, @actor, @action, @target, @duration, @result, @detail, @highRisk)`).run({
      id: (record && record.id) || genId('log'),
      timestamp: (record && record.timestamp) || new Date().toISOString(),
      actor: JSON.stringify((record && record.actor) || {}),
      action: (record && record.action) || '',
      target: JSON.stringify((record && record.target) || {}),
      duration: (record && record.duration != null) ? Math.round(record.duration) : null,
      result: (record && record.result) || 'success',
      detail: JSON.stringify((record && record.detail) || {}),
      highRisk: (record && record.highRisk) ? 1 : 0,
    });
    // 保留 365 天
    sql.prepare(`DELETE FROM audit_logs WHERE timestamp < datetime('now', '-365 days')`).run();
  } catch (e) {
    console.error('[db.audit] 写入失败:', e.message);
  }
}

// 周期性强制 checkpoint（每 30 分钟），保证备份一致性、防止 WAL 无限增长
setInterval(() => {
  try { sql.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* 忽略瞬时错误 */ }
}, 30 * 60 * 1000).unref();

const ARRAY_KEYS = ['users', 'submissions', 'announcements', 'notifications', 'applications', 'reviews', 'logs', 'sessions'];
const OBJ_KEYS = ['config', 'seq', 'classMajors', 'classGradeAssignments', 'certCatalog', 'scores', 'zhiyuOverrides'];
const ALL_KEYS = [...ARRAY_KEYS, ...OBJ_KEYS];

// ---------- 密码哈希（scrypt + 随机盐） ----------
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pwd), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
// 2026-09-01 H1：改为异步 scrypt（libuv 线程池执行），避免 60 并发登录时 scryptSync 阻塞主线程。
// 永不 reject——任何异常都 resolve(false)，调用方无需额外 try/catch 也不会挂起请求。
function verifyPassword(pwd, stored) {
  return new Promise((resolve) => {
    if (!stored || !stored.includes(':')) return resolve(false);
    const [salt, hash] = stored.split(':');
    crypto.scrypt(String(pwd), salt, 64, (err, derivedKey) => {
      if (err) return resolve(false);
      try {
        resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derivedKey)));
      } catch (e) { resolve(false); }
    });
  });
}

// ---------- 工具 ----------
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function now() { return new Date().toISOString(); }

// ---------- 种子数据 ----------
function seedData() {
  const users = [
    // 年级管理员（首次部署或重置数据库时的初始密码）
    { id: 'u_admin', username: 'admin', password: hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@123456'), name: '年级管理员', role: 'admin', className: '', studentId: '' },
    // 班长
    { id: 'u_mon1', username: 'monitor2301', password: hashPassword('123456'), name: '王班长', role: 'monitor', className: '临床2301班', studentId: '202300000101' },
    { id: 'u_mon2', username: 'monitor2302', password: hashPassword('123456'), name: '李班长', role: 'monitor', className: '临床2302班', studentId: '202300000102' },
    { id: 'u_mon3', username: 'monitor2303', password: hashPassword('123456'), name: '张班长', role: 'monitor', className: '临床2303班', studentId: '202300000103' },
    // 学生（临床2301班）
    { id: 'u_s1', username: '202300000001', password: hashPassword('123456'), name: '张同学', role: 'student', className: '临床2301班', studentId: '202300000001' },
    { id: 'u_s2', username: '202300000002', password: hashPassword('123456'), name: '赵小明', role: 'student', className: '临床2301班', studentId: '202300000002' },
    { id: 'u_s3', username: '202300000003', password: hashPassword('123456'), name: '孙丽丽', role: 'student', className: '临床2301班', studentId: '202300000003' },
    { id: 'u_s4', username: '202300000004', password: hashPassword('123456'), name: '周大伟', role: 'student', className: '临床2301班', studentId: '202300000004' },
    // 学生（临床2302班）
    { id: 'u_s5', username: '202300000005', password: hashPassword('123456'), name: '吴小芳', role: 'student', className: '临床2302班', studentId: '202300000005' },
    { id: 'u_s6', username: '202300000006', password: hashPassword('123456'), name: '郑志强', role: 'student', className: '临床2302班', studentId: '202300000006' },
    // 学生（临床2303班）
    { id: 'u_s7', username: '202300000007', password: hashPassword('123456'), name: '冯文静', role: 'student', className: '临床2303班', studentId: '202300000007' },
    { id: 'u_s8', username: '202300000008', password: hashPassword('123456'), name: '蒋明宇', role: 'student', className: '临床2303班', studentId: '202300000008' },
  ];

  const submissions = [
    { id: 's1', studentId: 'u_s1', studentName: '张同学', className: '临床2301班', category: 'certified', type: '学科竞赛', title: '全国大学生英语竞赛C类二等奖', points: 3, description: '国家级竞赛二等奖，附获奖证书扫描件。', attachments: [], status: 'pending', currentAuditor: 'monitor', auditLog: [{ byRole: 'student', byName: '张同学', action: 'submit', comment: '提交材料', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's2', studentId: 'u_s1', studentName: '张同学', className: '临床2301班', category: 'certified', type: '志愿服务', title: '某高校暑期三下乡志愿服务(40小时)', points: 2, description: '已认定的志愿服务时长证明。', attachments: [], status: 'approved', currentAuditor: 'grade', auditLog: [{ byRole: 'student', byName: '张同学', action: 'submit', comment: '提交材料', time: now() }, { byRole: 'monitor', byName: '王班长', action: 'approve', comment: '材料属实，通过', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's3', studentId: 'u_s2', studentName: '赵小明', className: '临床2301班', category: 'certified', type: '文体活动', title: '校运动会男子100米第三名', points: 1, description: '校级文体活动获奖。', attachments: [], status: 'resubmit', currentAuditor: 'student', auditLog: [{ byRole: 'student', byName: '赵小明', action: 'submit', comment: '提交材料', time: now() }, { byRole: 'monitor', byName: '王班长', action: 'resubmit', comment: '请补充获奖证书照片', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's4', studentId: 'u_s3', studentName: '孙丽丽', className: '临床2301班', category: 'certified', type: '社会工作', title: '学院学生会办公室副部长', points: 2, description: '任职证明已盖章。', attachments: [], status: 'approved', currentAuditor: 'grade', auditLog: [{ byRole: 'student', byName: '孙丽丽', action: 'submit', comment: '提交材料', time: now() }, { byRole: 'monitor', byName: '王班长', action: 'approve', comment: '通过', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's5', studentId: 'u_s4', studentName: '周大伟', className: '临床2301班', category: 'certified', type: '学科竞赛', title: '互联网+创新创业大赛省赛铜奖', points: 2.5, description: '省赛铜奖，证书已认定。', attachments: [], status: 'rejected', currentAuditor: 'student', auditLog: [{ byRole: 'student', byName: '周大伟', action: 'submit', comment: '提交材料', time: now() }, { byRole: 'monitor', byName: '王班长', action: 'reject', comment: '奖项未在认定名单内，请核实', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's6', studentId: 'u_s5', studentName: '吴小芳', className: '临床2302班', category: 'uncertified', type: '学术科研', title: '参与省级大创项目结项', points: 3, description: '大创项目结项证明，请年级认定加分。', attachments: [], status: 'pending', currentAuditor: 'grade', auditLog: [{ byRole: 'student', byName: '吴小芳', action: 'submit', comment: '提交材料', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's7', studentId: 'u_s6', studentName: '郑志强', className: '临床2302班', category: 'uncertified', type: '其他', title: '无偿献血证书(2次)', points: 1, description: '献血证扫描件，请年级认定。', attachments: [], status: 'approved', currentAuditor: 'grade', auditLog: [{ byRole: 'student', byName: '郑志强', action: 'submit', comment: '提交材料', time: now() }, { byRole: 'grade', byName: '年级管理员', action: 'approve', comment: '认定通过，按细则加分', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
    { id: 's8', studentId: 'u_s7', studentName: '冯文静', className: '临床2303班', category: 'uncertified', type: '学科竞赛', title: '校级实验技能大赛二等奖', points: 2, description: '校级比赛获奖，需年级认定。', attachments: [], status: 'pending', currentAuditor: 'grade', auditLog: [{ byRole: 'student', byName: '冯文静', action: 'submit', comment: '提交材料', time: now() }], gradeOverride: null, objection: null, createdAt: now(), updatedAt: now() },
  ];

  const announcements = [
    { id: 'a1', title: '2025-2026学年综合素质测评加分公示（第一批）', content: '现对已通过审核的加分材料进行公示，公示期7天。如有异议，请在公示期内提出。', startAt: now(), endAt: new Date(Date.now() + 7 * 86400000).toISOString(), status: 'active', createdBy: '年级管理员', createdAt: now() },
  ];

  const notifications = [
    { id: 'n1', studentId: 'u_s2', submissionId: 's3', content: '您的材料「校运动会男子100米第三名」被要求补交：请补充获奖证书照片。', fromRole: 'monitor', fromName: '王班长', type: 'resubmit', read: false, createdAt: now() },
    { id: 'n2', studentId: 'u_s4', submissionId: 's5', content: '您的材料「互联网+创新创业大赛省赛铜奖」被驳回：奖项未在认定名单内，请核实。', fromRole: 'monitor', fromName: '王班长', type: 'reject', read: false, createdAt: now() },
  ];

  const config = {
    categories: [
      { id: 'academic', name: '学术科研', defaultPoints: 3 },
      { id: 'competition', name: '学科竞赛', defaultPoints: 2 },
      { id: 'sports', name: '文体活动', defaultPoints: 1 },
      { id: 'volunteer', name: '志愿服务', defaultPoints: 1 },
      { id: 'social', name: '社会工作', defaultPoints: 2 },
      { id: 'other', name: '其他', defaultPoints: 1 },
    ],
    publicityEnabled: true,
    monitorDeadline: '',
    gradeDeadline: '',
    reviewRounds: { first: false, second: false, third: false },
    classes: [
      '临床医学1班', '临床医学2班', '临床医学3班', '临床医学4班', '临床医学5班',
      '临床医学6班', '临床医学7班', '临床医学8班', '临床医学9班', '临床医学10班',
      '临床医学11班', '临床医学12班', '临床医学13班', '临床医学14班', '临床医学15班',
      '临床医学16班', '临床医学17班', '临床医学18班',
      '临床医学（5+3一体化）1班', '临床医学（5+3一体化）2班', '临床医学（5+3一体化）3班', '临床医学（5+3一体化）4班',
      '医学影像学1班', '麻醉学1班', '医学检验技术1班', '医学检验技术2班', '医学影像技术1班',
    ],
  };

  return { users, submissions, announcements, notifications, applications: [], reviews: [], logs: [], sessions: [], config, seq: { userId: 100 } };
}

// ---------- store 读写 ----------
function loadFromStore() {
  const obj = {};
  const rows = sql.prepare('SELECT key, value FROM store').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  for (const k of ALL_KEYS) {
    obj[k] = map[k] !== undefined ? JSON.parse(map[k]) : (ARRAY_KEYS.includes(k) ? [] : {});
  }
  return obj;
}

function persist(obj) {
  // 持久化时把 PII 字段加密后写盘；保存原始（明文）到另一个副本用于 decrypt
  const plain = obj; // 内存里始终是明文（避免任何代码改动）
  const stored = JSON.parse(JSON.stringify(plain)); // 深拷贝一份做加密
  for (const u of (stored.users || [])) encryptObjPII(u, USER_PII_FIELDS);
  for (const a of (stored.applications || [])) encryptObjPII(a, APPLICATION_PII_FIELDS);
  for (const r of (stored.reviews || [])) encryptObjPII(r, REVIEW_PII_FIELDS);
  const tx = sql.transaction(() => {
    const stmt = sql.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
    for (const k of ALL_KEYS) {
      const v = stored[k];
      const fallback = ARRAY_KEYS.includes(k) ? [] : {};
      stmt.run(k, JSON.stringify(v !== undefined ? v : fallback));
    }
  });
  tx();
}

function migrateFromJson() {
  if (!fs.existsSync(DATA_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    persist(data);
    fs.renameSync(DATA_FILE, DATA_FILE + '.migrated.' + Date.now());
    console.log('[db] 已从 data.json 迁移到 SQLite');
    return true;
  } catch (e) {
    console.error('[db] 迁移 data.json 失败:', e.message);
    return false;
  }
}

// ---------- 字段兼容补齐 ----------
// 班级→专业默认值（按当前 config.classes 列表约定）
// 2026-08-17 B'-15：固化到代码，避免 admin 每次部署手动填。已有数据不动；admin UI 仍可改。
const DEFAULT_CLASS_MAJORS = {
  '临床医学1班': '临床医学',
  '临床医学2班': '临床医学',
  '临床医学3班': '临床医学',
  '临床医学4班': '临床医学',
  '临床医学5班': '临床医学',
  '临床医学6班': '临床医学',
  '临床医学7班': '临床医学',
  '临床医学8班': '临床医学',
  '临床医学9班': '临床医学',
  '临床医学10班': '临床医学',
  '临床医学11班': '临床医学',
  '临床医学12班': '临床医学',
  '临床医学13班': '临床医学',
  '临床医学14班': '临床医学',
  '临床医学15班': '临床医学',
  '临床医学16班': '临床医学',
  '临床医学17班': '临床医学',
  '临床医学18班': '临床医学',
  '临床医学（5+3一体化）1班': '临床医学（5+3一体化）',
  '临床医学（5+3一体化）2班': '临床医学（5+3一体化）',
  '临床医学（5+3一体化）3班': '临床医学（5+3一体化）',
  '临床医学（5+3一体化）4班': '临床医学（5+3一体化）',
  '医学影像学1班': '医学影像学',
  '麻醉学1班': '麻醉学',
  '医学检验技术1班': '医学检验技术',
  '医学检验技术2班': '医学检验技术',
  '医学影像技术1班': '医学影像技术',
};

function normalize(o) {
  o.applications = o.applications || [];
  o.reviews = o.reviews || [];
  o.logs = o.logs || [];
  o.sessions = o.sessions || [];
  o.notifications = o.notifications || [];
  o.config = o.config || {};
  o.classMajors = o.classMajors || {};
  // 年级负责人分配：{ "<班名>": { uncertified:"userId", round1:"userId", round2:"userId", round3:"userId" } }
  // 未配置/空串表示由 admin 兜底审核。存 userId（比 username 稳定，用户名可改）。
  o.classGradeAssignments = o.classGradeAssignments || {};
  // 已认定项目目录（2026-08-30）：[{ code, name, project, levels:[{level,points}], note, enabled }]
  o.certCatalog = o.certCatalog || [];
  // 导入的固定分值（2026-08-30 阶段一）：学号 → { zhiyu, teacher }
  //   zhiyu   = admin 导入的智育成绩（仅存最新值；复核修改不写这里）
  //   teacher = admin 导入的教师评价分（仅三榜公示版使用）
  o.scores = o.scores || {};
  // 智育复核链（C 类复核专用，2026-08-30 阶段一）：学号 → [{ round, points, reason, approvedBy, timestamp }]
  //   链式追加（原始智育 → 二榜认定 → 三榜认定）；取值时取 ≤ 目标轮次的最后一条
  o.zhiyuOverrides = o.zhiyuOverrides || {};
  // 兜底：表为空（如新装/迁移/重置 sqlite）时按 DEFAULT_CLASS_MAJORS 自动填充；
  // 已有数据不动；admin UI 仍可修改。
  if (Object.keys(o.classMajors).length === 0 && Array.isArray(o.config.classes)) {
    for (const cls of o.config.classes) {
      if (DEFAULT_CLASS_MAJORS[cls]) o.classMajors[cls] = DEFAULT_CLASS_MAJORS[cls];
    }
  }
  o.config.publicityEnabled = o.config.publicityEnabled !== false;
  o.config.monitorDeadline = o.config.monitorDeadline || '';
  o.config.gradeDeadline = o.config.gradeDeadline || '';
  o.config.reviewRounds = o.config.reviewRounds || { first: false, second: false, third: false };
  if (!Array.isArray(o.config.classes) || !o.config.classes.length) {
    o.config.classes = [
      '临床医学1班', '临床医学2班', '临床医学3班', '临床医学4班', '临床医学5班',
      '临床医学6班', '临床医学7班', '临床医学8班', '临床医学9班', '临床医学10班',
      '临床医学11班', '临床医学12班', '临床医学13班', '临床医学14班', '临床医学15班',
      '临床医学16班', '临床医学17班', '临床医学18班',
      '临床医学（5+3一体化）1班', '临床医学（5+3一体化）2班', '临床医学（5+3一体化）3班', '临床医学（5+3一体化）4班',
      '医学影像学1班', '麻醉学1班', '医学检验技术1班', '医学检验技术2班', '医学影像技术1班',
    ];
  }
  let secDirty = false;
  o.users.forEach(u => {
    if (u.mustChangePassword === undefined) u.mustChangePassword = false;
    if (u.idCard === undefined) u.idCard = '';
    if (u.major === undefined) u.major = '';
    // 二级审核密码：admin 专有（初始 默认二级密码；可经 /api/me/secondary-password 修改）
    // 2026-09-05：grade 同样拥有二级审核密码（由 admin 重置时下发 / 自助设置），保留其字段；仅清空 student/monitor 的残留
    if (u.role === 'admin') {
      if (u.secondaryPassword === undefined) { u.secondaryPassword = hashPassword(DEFAULT_SECONDARY_PASSWORD); secDirty = true; }
    } else if (u.role === 'student' || u.role === 'monitor') {
      if (u.secondaryPassword !== undefined) { u.secondaryPassword = undefined; secDirty = true; }
    }
  });
  if (secDirty) { try { persist(o); } catch (e) { console.error('[db] 二级密码迁移失败:', e.message); } }
  // 申请 item 级字段兼容：为每个 item 补齐 id/status/pointsFinal/reviewComment/resubmitNote
  // 历史已审核通过的申请，其 items 继承所在段的结论（approved/rejected），避免聚合退化成 pending
  o.applications.forEach(a => {
    const derive = (sec) => sec === 'approved' ? 'approved' : sec === 'rejected' ? 'rejected' : 'pending';
    const fix = (arr, sec) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((it, idx) => {
        if (it.id === undefined) it.id = 'ci_' + a.id + '_' + idx;
        if (it.status === undefined) it.status = derive(sec);
        if (it.pointsFinal === undefined) it.pointsFinal = (it.status === 'approved' || it.status === 'overridden') ? (Number(it.points) || 0) : 0;
        if (it.reviewComment === undefined) it.reviewComment = '';
        if (it.resubmitNote === undefined) it.resubmitNote = '';
      });
    };
    fix(a.certifiedItems, a.certifiedStatus);
    fix(a.uncertifiedItems, a.uncertifiedStatus);
  });
  return o;
}

// ---------- 加载 / 保存 ----------
let mem = null;
function load() {
  // 2026-09-01 H4 强化：无论库内是否有 PII 密文，都强制校验主密钥——缺失即抛错拒绝启动。
  // （仅靠 decryptPII 的 fail-fast 只覆盖「库里有密文」的场景；空 PII 库缺密钥也会裸奔，将来导入 PII 就埋雷）
  getMasterKey();
  if (mem) return mem;
  const count = sql.prepare('SELECT COUNT(*) AS c FROM store').get().c;
  if (count === 0) {
    if (!migrateFromJson()) {
      mem = seedData();
      // PII 字段保持明文，persist() 时会加密写盘
      persist(mem);
      console.log('[db] 已初始化种子数据 (SQLite)');
    } else {
      mem = loadFromStore();
    }
  } else {
    mem = loadFromStore();
  }
  // 一次性迁移：扫描原始 SQLite 数据，发现遗留明文 PII（无 enc:v1: 前缀）
  // 与遗留 plainPassword 字段，统一在回写磁盘时清除/加密
  let plaintextPII = 0, plaintextPwd = 0;
  for (const u of (mem.users || [])) {
    if (u.idCard && !String(u.idCard).startsWith(PII_PREFIX)) plaintextPII++;
    if (u.plainPassword) plaintextPwd++;
  }
  for (const a of (mem.applications || [])) {
    if (a.phone && !String(a.phone).startsWith(PII_PREFIX)) plaintextPII++;
  }
  for (const r of (mem.reviews || [])) {
    if (r.phone && !String(r.phone).startsWith(PII_PREFIX)) plaintextPII++;
  }
  // 从磁盘读出的 PII 字段是密文形式，统一解密回明文交给业务层
  for (const u of (mem.users || [])) {
    decryptObjPII(u, USER_PII_FIELDS);
    // 移除历史遗留的明文密码字段（安保升级后不再持久化）
    if (u.plainPassword) { delete u.plainPassword; }
  }
  for (const a of (mem.applications || [])) decryptObjPII(a, APPLICATION_PII_FIELDS);
  for (const r of (mem.reviews || [])) decryptObjPII(r, REVIEW_PII_FIELDS);
  if (plaintextPII > 0 || plaintextPwd > 0) {
    persist(mem);
    console.log('[db] 历史数据迁移完成：PII 字段加密', plaintextPII, '条，清除明文密码', plaintextPwd, '条');
  }
  normalize(mem);
  return mem;
}

// ============================================================
// 写队列：串行化落盘（并发=1），250ms 聚合窗口合并突发写
// ------------------------------------------------------------
// - save()：仅标记 dirty 并入队计数，立即返回（不阻塞请求处理线程）
// - 单个 worker 串行处理：窗口内所有 save 合并为一次 persist（事务原子写）
// - flushSync()：紧急写盘路径，绕过队列直接落盘（SIGTERM / 一次性迁移用）
// - pendingSaves / lastWriteMs 供阶段四监控队列深度与单次落盘耗时
// ============================================================
let saveTimer = null;       // 250ms 聚合窗口的定时器句柄
let writeQueued = false;    // 是否已有任务进入队列（防止重复排程）
let dirty = false;          // 内存态是否相对磁盘有改动
let pendingSaves = 0;       // 自上次落盘以来累计的 save() 调用次数（队列深度近似）
let lastWriteMs = 0;        // 最近一次 persist 耗时（ms）
let lastError = null;       // 最近一次落盘错误

// 实际写盘 worker（并发=1，保证任一时刻只有一个 persist 在运行）
const writeWorker = (task, cb) => {
  if (!dirty) return cb(null);                 // 已被 flushSync 或上一次写入覆盖，跳过空写
  const t0 = Date.now();
  try {
    persist(mem);
    dirty = false;
    pendingSaves = 0;
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error('[db] 写队列落盘失败，下次 save 重试:', e.message);
  }
  lastWriteMs = Date.now() - t0;
  cb(null);
};
const writeQueue = fastq(writeWorker, 1);

function save() {
  dirty = true;
  pendingSaves++;
  if (writeQueued) return;     // 已有聚合任务在排队，等待它被处理时一并落盘
  writeQueued = true;
  // 250ms 聚合窗口：窗口内所有 save 合并为一次 persist，降低高并发磁盘压力
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeQueued = false;
    writeQueue.push('flush', () => {});
  }, 250);
}
function flushNow() {
  // 立即触发一次落盘（仍经队列串行化；dirty 为 false 时 worker 自动跳过）
  writeQueue.push('flush', () => {});
}
function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeQueued = false;
  // 始终强制落盘（绕过队列，用于 SIGTERM、测试与一次性迁移）
  if (mem) {
    const t0 = Date.now();
    try { persist(mem); dirty = false; pendingSaves = 0; lastError = null; }
    catch (e) { console.error('[db] 强制保存失败:', e.message); }
    lastWriteMs = Date.now() - t0;
  }
}
// 暴露写队列运行指标（阶段四 /api/admin/status 使用）
function stats() {
  return { queuedWrites: pendingSaves, lastWriteMs, dirty, lastError };
}
// 进程退出前确保落盘（systemd 停止服务时发送 SIGTERM）
process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });
process.on('beforeExit', flushSync);

function ensureUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- 查询辅助 ----------
function getUserByUsername(username) {
  return load().users.find(u => u.username === String(username).toLowerCase());
}
function getUserById(id) {
  return load().users.find(u => u.id === id);
}
function getSubmissionsByStudent(studentId) {
  return load().submissions.filter(s => s.studentId === studentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function getSubmissionById(id) {
  return load().submissions.find(s => s.id === id);
}
function getClassStudents(className) {
  return load().users.filter(u => u.className === className && u.role === 'student');
}
function getMonitorOfClass(className) {
  return load().users.find(u => u.className === className && u.role === 'monitor');
}

function exportFullJson() {
  // 全量数据导出（用于备份下载）。内存中始终是明文（PII 已解密），直接序列化即为可恢复完整数据。
  return JSON.stringify(load(), null, 2);
}

// 统计某用户在指定时间段内指定 action 的审计日志条数（告警规则用）
function auditCount(userId, actions, sinceIso) {
  try {
    const marks = actions.map(() => '?').join(',');
    const row = sql.prepare(`SELECT COUNT(*) AS c FROM audit_logs
      WHERE actor LIKE ? AND action IN (${marks}) AND timestamp >= ?`)
      .get(`%"userId":"${String(userId).replace(/"/g, '')}"%`, ...actions, sinceIso);
    return row ? row.c : 0;
  } catch (e) { return 0; }
}

// 审计日志查询（分页 + 筛选；仅 admin）
function queryAudit({ action, ip, userId, from, to, scope, highRisk, md5, page = 1, pageSize = 50 }) {
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (ip) { where.push('actor LIKE ?'); params.push(`%"ip":"${String(ip).replace(/"/g, '')}%`); }
  if (userId) { where.push('actor LIKE ?'); params.push(`%"userId":"${String(userId).replace(/"/g, '')}%`); }
  if (scope) { where.push('target LIKE ?'); params.push(`%"scope":"${String(scope).replace(/"/g, '')}%`); }
  if (md5) { where.push('target LIKE ?'); params.push(`%"fileMd5":"${String(md5).replace(/"/g, '')}%`); }
  if (from) { where.push('timestamp >= ?'); params.push(from); }
  if (to) { where.push('timestamp <= ?'); params.push(to); }
  if (highRisk === '1') { where.push('highRisk = 1'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = sql.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...params).c;
  const list = sql.prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize).map(r => ({
      id: r.id, timestamp: r.timestamp,
      actor: JSON.parse(r.actor || '{}'),
      action: r.action,
      target: JSON.parse(r.target || '{}'),
      duration: r.duration, result: r.result,
      detail: JSON.parse(r.detail || '{}'),
      highRisk: !!r.highRisk,
    }));
  return { total, list, page, pageSize };
}

module.exports = {
  load, save, ensureUploads, flushSync, flushNow, stats, exportFullJson,
  audit, auditCount, queryAudit, // 独立审计日志（audit_logs 表，追加写）
  hashPassword, verifyPassword,
  encryptPII, decryptPII,
  genId, now,
  getUserByUsername, getUserById,
  getSubmissionsByStudent, getSubmissionById,
  getClassStudents, getMonitorOfClass,
  DATA_DIR, DATA_FILE, UPLOAD_DIR, DB_FILE,
};
