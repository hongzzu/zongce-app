// 存量数据补丁（2026-09-10 上线前）：给「已终审（items 全为 approved/rejected）但缺 concludedAt」的复核记录补结论时间。
// 运行要求：systemctl stop zongce-app 后，以注入 ZONGCE_MASTER_KEY 的独立进程执行（勿在服务运行时跑）。
// 用法：set -a && source /etc/zongce/zongce.env && set +a && node backfill-review-concluded.js
const path = require('path');
const db = require(path.join(__dirname, 'db.js'));

const KEY = process.env.ZONGCE_MASTER_KEY || '';
if (!/^[A-Za-z0-9]{64}$/.test(KEY)) {
  console.error('FATAL: ZONGCE_MASTER_KEY 未注入或长度≠64（当前长度 ' + KEY.length + '）。禁止写库（防 PII 清零）。');
  process.exit(1);
}

const d = db.load();
const reviews = d.reviews || [];
let patched = 0;
const now = db.now ? db.now() : new Date().toISOString();

for (const r of reviews) {
  if (r.status === 'withdrawn') continue;            // 已作废：永不结论，不计入导出
  if (r.concludedAt) continue;                        // 已有结论
  const items = r.items || [];
  if (!items.length) continue;                        // 空记录不处理
  const anyPending = items.some(it => it.reviewStatus === 'pending' || it.reviewStatus === 'resubmit');
  if (anyPending) continue;                           // 还有待审/待补交 → 未终审，跳过
  // 已终审（全部 approved/rejected）且缺结论时间 → 补齐
  const ts = r.updatedAt || r.createdAt || now;
  r.concludedAt = ts;
  r.logs = r.logs || [];
  r.logs.push({
    byRole: 'system', byName: '系统', action: 'backfill-concluded',
    comment: `存量补丁：混合终审（无待审/待补交）补记结论时间 ${ts}（此前 partial 不写 concludedAt 导致复核结果未计入公示导出）`,
    time: now,
  });
  patched++;
  console.log('  PATCH ' + r.id + ' status=' + r.status + ' items=' + items.map(i => i.reviewStatus).join(',') + ' → concludedAt=' + ts);
}

console.log('待补丁记录数: ' + patched);
if (patched > 0) {
  db.save();
  console.log('db.save() 完成 ✓');
} else {
  console.log('无变更，不写库。');
}
