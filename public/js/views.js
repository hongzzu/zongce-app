// ============ 视图层：四角色工作台 ============
/* 共享组件 */
// 已认定项目有效分值：审核后取 pointsFinal（改分/驳回后的值），未审核或历史数据回退到 points
// 浮点精度：统一 toFixed(4) 后再 parseFloat（用户确认：小数后 4 位四舍五入）
function effPts(it) {
  if (!it) return 0;
  const v = it.pointsFinal != null && it.pointsFinal !== '' ? it.pointsFinal : it.points;
  return Number(Number(v || 0).toFixed(4)) || 0;
}
// 与 server.js fmtNum 一致：去尾零显示（如 2.0→"2", 0.4→"0.4", 0→"0"）
function fmtNum(n) {
  return String(Number((Number(n) || 0).toFixed(4)));
}
// 2026-09-06 学生自填分值白名单（与 server.js SELF_FILL_CODES 一致）：仅这三个 code 的"未定分值"等级允许学生自填 0~2，
// 其余未定分值项目由评定小组给定分值、学生端不可自填（318=院级各类团体/434=专利/435=论文）
const SELF_FILL_CODES = new Set(['318', '434', '435']);

/* ================= 学生端 ================= */
const StudentViews = {

  announcements: async () => {
    const { announcements } = await API.announcements();
    if (!announcements.length) return `<div class="card"><div class="empty">暂无公示</div></div>`;
    return announcements.map(a => `
      <div class="card">
        <div class="card-title">📢 ${FMT.esc(a.title)}
          <span class="tag ${a.status === 'active' ? 'tag-active' : 'tag-ended'}">${a.status === 'active' ? '公示中' : '已结束'}</span>
        </div>
        <div class="sub-meta">
          <span>公示时间：${FMT.time(a.startAt)} 至 ${FMT.time(a.endAt)}</span>
          <span>发起人：${FMT.esc(a.createdBy)}</span>
        </div>
        ${a.content ? `<div class="sub-desc">${FMT.esc(a.content)}</div>` : ''}
        <button class="btn btn-primary btn-sm" onclick="StudentViews.annDetail('${a.id}')">查看公示材料 ${a.status === 'active' ? '& 提出异议' : ''}</button>
      </div>`).join('');
  },

  annDetail: async (id) => {
    const { announcement, items } = await API.announcementDetail(id);
    const active = announcement.status === 'active';
    let h = `<div class="card">
      <div class="card-title">📢 ${FMT.esc(announcement.title)}
        <span class="tag ${active ? 'tag-active' : 'tag-ended'}">${active ? '公示中' : '已结束'}</span>
      </div>
      <div class="sub-meta">公示期：${FMT.time(announcement.startAt)} 至 ${FMT.time(announcement.endAt)}</div>`;
    if (!items.length) { h += '<div class="empty">暂无已通过材料</div>'; }
    h += `<div class="table-wrap"><table class="tbl"><thead><tr>
      <th>姓名</th><th>班级</th><th>类型</th><th>材料</th><th style="text-align:right">分值</th>${active ? '<th>操作</th>' : ''}
      </tr></thead><tbody>`;
    items.forEach(it => {
      h += `<tr><td>${FMT.esc(it.studentName)}</td><td>${FMT.esc(it.className)}</td><td>${FMT.esc(it.type)}</td>
        <td>${FMT.esc(it.title)}${it.objection ? `<br><span class="tag tag-obj">有异议</span>` : ''}</td>
        <td class="num-cell">${effPts(it)}</td>`;
      if (active) {
        h += `<td>${it.objection ? '<span class="muted">已提出异议</span>' : `<button class="btn btn-warning btn-sm" onclick="StudentViews.raiseObj('${announcement.id}','${it.id}','${FMT.esc(it.studentName)}-${FMT.esc(it.title)}')">提出异议</button>`}</td>`;
      }
      h += `</tr>`;
    });
    h += '</tbody></table></div></div>';
    App.setContent(h);
  },

  raiseObj: (annId, subId, label) => {
    openModal(`<div class="modal-head"><h3>对材料提出异议</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>目标材料</label><div class="muted">${FMT.esc(label)}</div></div>
        <div class="form-item"><label>异议理由（至少5个字）</label><textarea id="obj-reason" placeholder="请说明该材料不符合加分条件的具体理由"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="StudentViews.doRaise('${annId}','${subId}')">提交异议</button></div>`);
  },

  doRaise: async (annId, subId) => {
    const reason = document.getElementById('obj-reason').value.trim();
    if (reason.length < 5) return toast('请填写具体理由（至少5个字）', 'err');
    try {
      await API.raiseObjection(annId, { submissionId: subId, reason });
      closeModal(); toast('异议已提交，等待年级处理'); App.goto('announcements');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 通知视图（学生 / 班长 共用）迁移至 AppViews.notifications
};

/* ================= 班长端 ================= */
const MonitorViews = {

  // 班长端「班级总览」：整合 班级学生 + 班级统计（参考年级端统计看板可读性）
  overview: async () => {
    const st = await API.monitorStats();
    const total = st.studentCount;
    const submitted = st.submittedCount;
    const rate = total ? (submitted / total * 100).toFixed(1) : 0;
    const bs = st.byStatus || {};
    const approved = bs.approved || 0, pending = bs.pending || 0, resubmit = bs.resubmit || 0;
    const rejected = bs.rejected || 0, withdrawn = bs.withdrawn || 0;
    const notSubmitted = total - submitted;
    // 待跟进 = 退回 + 补交 + 待审（需班长介入）
    const todo = withdrawn + resubmit + pending;

    // 4 张语义化指标卡
    const cards = `<div class="grid grid-4 stat-cards">
      <div class="stat-card c-blue"><div class="sc-label">班级人数</div><div class="sc-num">${total}</div><div class="sc-sub">${FMT.esc(st.className)}</div></div>
      <div class="stat-card c-green"><div class="sc-label">已提交</div><div class="sc-num">${submitted}</div><div class="sc-sub">提交率 ${rate}%</div></div>
      <div class="stat-card c-orange"><div class="sc-label">已认定总分</div><div class="sc-num">${st.totalPoints}</div><div class="sc-sub">通过分值合计</div></div>
      <div class="stat-card c-red"><div class="sc-label">待跟进</div><div class="sc-num">${todo}</div><div class="sc-sub">退回 + 补交 + 待审</div></div>
    </div>`;

    // 状态分布堆叠进度条
    const totalApps = approved + pending + resubmit + rejected + withdrawn;
    const segs = [
      { label: '通过', color: '#22c55e', n: approved },
      { label: '退回', color: '#f59e0b', n: withdrawn },
      { label: '待审', color: '#ef4444', n: pending },
      { label: '补交', color: '#f97316', n: resubmit },
      { label: '驳回', color: '#b91c1c', n: rejected },
    ];
    const barSegs = segs.filter(s => s.n > 0).map(s => {
      const pct = totalApps ? (s.n / totalApps * 100) : 0;
      return `<div class="stack-seg" style="width:${pct}%;background:${s.color}" title="${s.label} ${s.n}（${pct.toFixed(1)}%）"></div>`;
    }).join('') || '<div class="stack-seg" style="width:100%;background:#e5e8ef"></div>';
    const legend = segs.map(s => `<span class="stack-legend"><span class="dot" style="background:${s.color}"></span>${s.label} ${s.n}</span>`).join('');
    const statusCard = `<div class="card mt16"><div class="card-title">本班申请状态分布</div>
      <div class="stack-bar">${barSegs}</div>
      <div class="stack-legend-row">${legend}</div>
      <div class="muted mt8">共 ${totalApps} 份申请；退回占比 ${totalApps ? (withdrawn / totalApps * 100).toFixed(1) : '0.0'}%。退回占比偏高说明材料质量较差，建议主动督促。</div>
    </div>`;

    // 学生表：提交状态异常提醒 + 操作（重置密码 / 通知）
    const statusMap = {
      none: { cls: 'anom-warn', txt: '⏳ 未提交' },
      withdrawn: { cls: 'anom-warn', txt: '⚠️ 已退回需修改' },
      resubmit: { cls: 'anom-warn', txt: '⚠️ 待补交' },
      pending: { cls: 'anom-info', txt: '⏳ 待审核' },
      rejected: { cls: 'anom-warn', txt: '⚠️ 已驳回' },
      approved: { cls: 'anom-ok', txt: '✅ 已通过' },
    };
    const rows = (st.students || []).map(u => {
      const sm = statusMap[u.status] || statusMap.none;
      const anom = `<span class="anom ${sm.cls}">${sm.txt}</span>`;
      const ops = `<button class="btn btn-ghost btn-sm" onclick="MonitorViews.resetPwd('${u.id}','${FMT.esc(u.name)}')">🔑 重置密码</button>
        <button class="btn btn-ghost btn-sm" onclick="MonitorViews.notify('${u.id}','${FMT.esc(u.name)}')">📨 通知</button>`;
      return `<tr><td>${FMT.esc(u.studentId)}</td><td>${FMT.esc(u.name)}</td>
        <td>${u.submissionCount}</td><td><b>${u.approvedPoints}</b></td><td>${anom}</td><td>${ops}</td></tr>`;
    }).join('');
    const classCard = `<div class="card mt16"><div class="card-title">本班学生（${st.students.length} 人）</div>
      ${notSubmitted > 0 ? `<div class="row mt8 mb8" style="gap:10px;align-items:center"><span class="anom anom-warn">⏳ ${notSubmitted} 人未提交</span>
        <button class="btn btn-warning btn-sm" onclick="MonitorViews.urgeSelf()">📢 一键催办未提交同学</button></div>` : ''}
      <div class="table-wrap"><table class="tbl"><thead><tr><th>学号</th><th>姓名</th><th>提交条数</th><th>通过分值</th><th>提交状态</th><th>操作</th></tr></thead><tbody>
        ${rows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">暂无学生</td></tr>'}
      </tbody></table></div>
    </div>`;

    return cards + statusCard + classCard;
  },

  // 班长一键催办本班未提交同学
  urgeSelf: async () => {
    try {
      const r = await API.post('/api/urge/class', {});
      toast(`已向本班 ${r.urged} 名未提交同学发送催办通知`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 班长重置本班学生密码（默认密码由后端按角色规则生成：学生=student+学号，重置后该学生登录需修改）
  resetPwd: async (id, name) => {
    if (!confirm(`确定要重置「${name}」的密码吗？将按角色规则生成默认密码（学生=student+学号），该学生下次登录需修改密码。`)) return;
    try {
      const r = await API.resetPassword(id, {});
      // 用持久模态展示新密码（toast 太短不便告知学生），含复制按钮
      openModal(`<div class="modal-head"><h3>密码已重置（${FMT.esc(name)}）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
        <div class="modal-body">
          <div class="muted mb8">请将以下默认密码告知学生本人，登录后系统会强制要求修改。</div>
          <div class="form-item"><label>新密码</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input id="np-input" value="${FMT.esc(r.newPassword || '')}" readonly style="font-family:Consolas,monospace;flex:1">
              <button class="btn btn-primary" onclick="(async()=>{try{await navigator.clipboard.writeText(document.getElementById('np-input').value);toast('已复制','ok')}catch(e){toast('复制失败，请手动选中复制','err')}})()">复制</button>
            </div>
          </div>
        </div>
        <div class="modal-foot"><button class="btn btn-primary" onclick="closeModal()">我已知晓</button></div>`);
    } catch (e) { toast(e.message, 'err'); }
  },

  notify: (stuId, name) => {
    openModal(`<div class="modal-head"><h3>通知 ${FMT.esc(name)}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-item"><label>通知内容（如：请补交XX材料）</label>
        <textarea id="nt-content" placeholder="例：请于本周五前补交获奖证书扫描件"></textarea></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="MonitorViews.doNotify('${stuId}')">发送</button></div>`);
  },

  doNotify: async (stuId) => {
    const content = document.getElementById('nt-content').value.trim();
    if (content.length < 3) return toast('请填写通知内容', 'err');
    try { await API.notifyStudent(stuId, { content }); closeModal(); toast('已发送通知'); }
    catch (e) { toast(e.message, 'err'); }
  },
};

/* ================= 年级端 ================= */
const GradeViews = {


  annManage: async () => {
    const { announcements } = await API.announcements();
    let h = `<div class="card"><div class="card-title">📢 发起新公示</div>
      <div class="grid grid-2">
        <div class="form-item"><label>公示标题</label><input id="a-title" placeholder="如：2025-2026学年综测加分材料公示（第二批）"></div>
        <div class="form-item"><label>公示天数（1-30，默认7）</label><input id="a-days" type="number" min="1" max="30" value="7"></div>
      </div>
      <div class="form-item"><label>公示说明</label><textarea id="a-content" placeholder="公示对象为当前所有已通过审核的材料，公示期内学生可提出异议"></textarea></div>
      <button class="btn btn-primary" onclick="GradeViews.doCreateAnn()">发起公示</button></div>`;
    h += `<div class="card"><div class="card-title">公示记录</div>`;
    if (!announcements.length) h += '<div class="empty">暂无公示记录</div>';
    announcements.forEach(a => {
      const active = a.status === 'active';
      h += `<div class="sub-card"><div class="sub-card-head">
          <span class="sub-title">${FMT.esc(a.title)}</span>
          <span class="tag ${active ? 'tag-active' : 'tag-ended'}">${active ? '公示中' : '已结束'}</span>
        </div>
        <div class="sub-meta"><span>${FMT.time(a.startAt)} 至 ${FMT.time(a.endAt)}</span><span>发起人：${FMT.esc(a.createdBy)}</span></div>
        ${active ? `<button class="btn btn-danger btn-sm mt8" onclick="GradeViews.doEndAnn('${a.id}')">结束公示</button>` : ''}
      </div>`;
    });
    return h + '</div>';
  },

  doCreateAnn: async () => {
    const title = document.getElementById('a-title').value.trim();
    const days = document.getElementById('a-days').value;
    const content = document.getElementById('a-content').value.trim();
    if (!title) return toast('请填写公示标题', 'err');
    try { await API.createAnnouncement({ title, content, days }); toast('公示已发起'); App.goto('gradeAnn'); }
    catch (e) { toast(e.message, 'err'); }
  },

  doEndAnn: async (id) => {
    if (!confirm('确定结束该公示？结束后学生将无法再提出异议。')) return;
    try { await API.endAnnouncement(id); toast('公示已结束'); App.goto('gradeAnn'); }
    catch (e) { toast(e.message, 'err'); }
  },

  objections: async () => {
    const { objections } = await API.objections();
    const pending = objections.filter(o => o.objection.status === 'pending');
    const done = objections.filter(o => o.objection.status !== 'pending');
    let h = `<div class="card"><div class="card-title">待处理异议（${pending.length}）</div>`;
    if (!pending.length) h += '<div class="empty">暂无待处理异议 🎉</div>';
    pending.forEach(o => {
      h += `<div class="sub-card"><div class="sub-card-head"><span class="sub-title">${FMT.esc(o.submission.title)}</span>
        <span class="tag tag-obj">待处理</span></div>
        <div class="sub-meta"><span>材料人：${FMT.esc(o.submission.studentName)}（${FMT.esc(o.submission.className)}）</span><span>分值 ${effPts(o.submission)}</span></div>
        <div class="sub-desc">💬 异议人 ${FMT.esc(o.objection.raisedBy)}：${FMT.esc(o.objection.content)}</div>
        <div class="sub-actions">
          <button class="btn btn-success btn-sm" onclick="GradeViews.handleObj('${o.objection.id}', true)">✓ 异议成立（材料退回）</button>
          <button class="btn btn-danger btn-sm" onclick="GradeViews.handleObj('${o.objection.id}', false)">✕ 异议不成立</button>
        </div></div>`;
    });
    h += '</div><div class="card"><div class="card-title">已处理异议（${done.length}）</div>';
    if (!done.length) h += '<div class="empty">暂无</div>';
    done.forEach(o => {
      h += `<div class="sub-card"><div class="sub-card-head"><span class="sub-title">${FMT.esc(o.submission.title)}</span>
        <span class="tag tag-ended">已处理</span></div>
        <div class="sub-desc">💬 异议：${FMT.esc(o.objection.content)}</div>
        <div class="sub-desc muted">✅ 处理结果：${FMT.esc(o.objection.reply)}（${FMT.esc(o.objection.replyBy)}）</div></div>`;
    });
    return h + '</div>';
  },

  handleObj: (oid, agree) => {
    openModal(`<div class="modal-head"><h3>${agree ? '异议成立' : '异议不成立'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-item"><label>处理意见（必填）</label>
        <textarea id="oj-reply" placeholder="${agree ? '说明核实结果，材料将退回待审核并通知学生' : '说明不成立理由'}"></textarea></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="GradeViews.doHandle('${oid}', ${agree})">确认处理</button></div>`);
  },

  doHandle: async (oid, agree) => {
    const reply = document.getElementById('oj-reply').value.trim();
    if (reply.length < 3) return toast('请填写处理意见', 'err');
    try { await API.handleObjection(oid, { agree, reply }); closeModal(); toast('已处理'); App.goto('gradeObj'); }
    catch (e) { toast(e.message, 'err'); }
  },

  // 导出：德育分项详细数据（页面：4 区结构 = 数据源配置 / 榜单导出 / 复核明细 / 系统管理[折叠]）
  exportGradeStatsPage: async (mode = 'class') => {
    window._exportMode = mode;
    // 拉取维度数据 + 导入概况 + 开放榜次（并行）
    const [d, summary, cfg] = await Promise.all([
      API.get('/api/grade/stats'),
      API.get('/api/admin/scores/summary').catch(() => ({ 学生总数: 0, 已导入智育: 0, 已导入教师评价: 0, 智育复核链条数: 0 })),
      API.get('/api/config'),
    ]);
    window._scoresSummary = summary;
    window._exportConfig = cfg;
    // 班级自然排序：临床医学（纯）1-18班 → 临床医学(5加3一体化) → 其余专业按中文；同专业按班号数字
    const cmpClass = (a, b) => {
      const pa = String(a).replace(/\d+班$/, '');
      const pb = String(b).replace(/\d+班$/, '');
      if (pa === pb) {
        const ma = String(a).match(/(\d+)班$/);
        const mb = String(b).match(/(\d+)班$/);
        if (ma && mb) return Number(ma[1]) - Number(mb[1]);
        return String(a).localeCompare(b, 'zh-CN');
      }
      const pri = (p) => {
        if (p === '临床医学') return 0;
        if (p.includes('临床医学')) return 1;
        return 2;
      };
      const pi = pri(pa), pj = pri(pb);
      if (pi !== pj) return pi - pj;
      return pa.localeCompare(pb, 'zh-CN');
    };
    const classes = Object.keys(d.byClass).sort(cmpClass);
    if (!classes.length) return `<div class="card"><div class="empty">暂无班级数据</div></div>`;
    const majors = [...new Set(classes.map(c => c.replace(/\d+班$/, '')))].sort(cmpClass);
    window._exportClasses = classes;
    window._exportMajors = majors;
    const totalStudents = classes.reduce((s, c) => s + (d.byClass[c].studentCount || 0), 0);

    const tabs = `<div class="filter-bar">
      <button class="btn btn-sm ${mode === 'class' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeExport','class')">📚 按班级</button>
      <button class="btn btn-sm ${mode === 'major' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeExport','major')">🎓 按专业</button>
      <button class="btn btn-sm ${mode === 'year' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeExport','year')">🏛️ 按年级</button>
    </div>`;

    let formHtml = '';
    if (mode === 'class') {
      formHtml = `<div class="form-row" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div class="form-item" style="flex:1;min-width:240px"><label>选择班级</label>
          <select id="ex-class" style="width:100%;padding:6px">
            ${classes.map(c => `<option value="${FMT.esc(c)}">${FMT.esc(c)}（${d.byClass[c].studentCount} 人）</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" onclick="GradeViews.doExportGradeStats('class')">📊 导出 Excel</button>
      </div>`;
    } else if (mode === 'major') {
      if (!majors.length) return tabs + `<div class="card mt16"><div class="empty">暂无专业数据</div></div>`;
      const majorInfo = majors.map(m => {
        const cls = classes.filter(c => c.replace(/\d+班$/, '') === m);
        const cnt = cls.reduce((s, c) => s + (d.byClass[c].studentCount || 0), 0);
        return { name: m, cls: cls.length, cnt };
      });
      formHtml = `<div class="form-row" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div class="form-item" style="flex:1;min-width:240px"><label>选择专业</label>
          <select id="ex-major" style="width:100%;padding:6px">
            ${majorInfo.map(m => `<option value="${FMT.esc(m.name)}">${FMT.esc(m.name)}（${m.cls} 个班，共 ${m.cnt} 人）</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" onclick="GradeViews.doExportGradeStats('major')">📊 导出 Excel</button>
      </div>
      <div class="muted mt8">说明：专业从现有班名推断（去掉末尾"X班"前缀即专业名）。如某专业暂无班级数据，将不会出现在下拉中。</div>`;
    } else {
      formHtml = `<div class="form-row" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div class="form-item" style="flex:1;min-width:240px"><label>导出范围</label>
          <div style="padding:8px 10px;background:var(--gray-bg);border-radius:6px">
            全部年级（共 <b>${classes.length}</b> 个班，<b>${totalStudents}</b> 名学生）
          </div>
        </div>
        <button class="btn btn-primary" onclick="GradeViews.doExportGradeStats('year')">📊 导出全部 Excel</button>
      </div>
      <div class="muted mt8">说明：按年级导出 = 一次性导出全部班级（不分专业、不分年级），所有学生按"班级+学号"排序在一个 Excel 内。</div>`;
    }

    // 状态栏 + 颜色图例
    const statusBarHtml = `<div class="card" style="background:linear-gradient(90deg,var(--info-bg,#eef5ff),#fff);border-left:4px solid var(--primary,#1f6feb)">
      <div class="row" style="gap:18px;flex-wrap:wrap;align-items:center;justify-content:space-between">
        <div id="zs-status-bar" style="font-size:13px"></div>
        <div class="row" style="gap:6px;font-size:12px;flex-wrap:wrap">
          <span class="tag" style="background:#e8f0fe;color:#1f6feb">🟦 德育一榜（蓝）</span>
          <span class="tag" style="background:#fff3d6;color:#ad6800">🟨 综测二榜（黄）</span>
          <span class="tag" style="background:#d6f5d6;color:#137333">🟩 综测三榜（绿）</span>
          <span class="tag" style="background:#f3e8fd;color:#7b1fa2">🟪 综测四榜（紫）</span>
        </div>
      </div>
    </div>`;

    // 数据源配置（admin 全功能；非 admin 自动隐藏导入操作）
    const isAdmin = App.user && App.user.role === 'admin';
    const dataSourceHtml = isAdmin ? `<div class="sub-card" style="margin-bottom:12px">
      <div class="sub-desc" style="color:var(--primary-dark);font-weight:600;margin-bottom:4px">📦 数据源配置（智育 / 教师评价）</div>
      <div class="muted mb8" style="font-size:12px">先导入<b>智育成绩</b>（综测二榜公示版起使用）；<b>教师评价分</b>采用<b>名单制</b>（2026-09-09）：只需上传有<b>特殊分值</b>的学生名单（列含「姓名」或「学号」+「教师评价分/加分」，可加「班级」列消歧），<b>未在名单中的学生自动按基准分 1.5 计</b>。名单每次上传全量替换。</div>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
        <div class="form-item" style="flex:1;min-width:240px;margin:0"><label style="font-size:12px">智育成绩文件</label><input type="file" id="zs-import-zhiyu" accept=".xlsx" style="width:100%"></div>
        <button class="btn btn-primary" onclick="GradeViews.doImportScores('zhiyu')">⬆ 导入智育成绩</button>
      </div>
      <div class="row mt8" style="gap:10px;flex-wrap:wrap;align-items:end">
        <div class="form-item" style="flex:1;min-width:240px;margin:0"><label style="font-size:12px">教师评价名单文件（未列学生默认 1.5 分）</label><input type="file" id="zs-import-teacher" accept=".xlsx" style="width:100%"></div>
        <button class="btn btn-primary" onclick="GradeViews.doImportScores('teacher')">⬆ 导入教师评价分</button>
      </div>
      <div id="zs-scores-summary" class="muted mt8" style="font-size:12px">📊 导入概况：学生总数 <b>${summary.学生总数 || 0}</b> ｜ 已导入智育 <b>${summary.已导入智育 || 0}</b> 人 ｜ 教师评价名单 <b>${summary.教师评价名单 ?? summary.已导入教师评价 ?? 0}</b> 人（未列默认 <b>${summary.教师评价基准分 ?? 1.5}</b> 分）｜ 智育复核链 <b>${summary.智育复核链条数 || 0}</b> 条</div>
      <div id="zs-ambiguous-card" class="mt8"></div>
      <div class="row mt8" style="gap:8px;align-items:center">
        <button class="btn btn-danger btn-sm" onclick="GradeViews.doClearScores()">🧹 清除现有导入数据（需二级密码）</button>
        <span class="muted" style="font-size:12px">清空已导入的智育成绩与教师评价分（连带清智育复核链），公示版将回到"未导入"状态</span>
      </div>
    </div>` : '';

    // 综测榜单导出（按流程顺序垂直排列，标注阶段标签 + 可用状态）
    const hasZhiyu = (summary.已导入智育 || 0) > 0;
    // 2026-09-09 名单制：教师评价恒可用（名单覆盖特殊分 + 未列学生默认 1.5 基准），不再要求"已导入>0"
    const disY2p = !hasZhiyu;
    const disY3p = !hasZhiyu;
    const disY4p = !hasZhiyu;
    const stateBadge = (ok, need) => ok ? `<span class="tag tag-active">✅ 可用</span>` : `<span class="tag tag-pending" title="前置数据：${need}">⚠ ${need}</span>`;
    const exportRow = (step, label, sub, fnName, fnArg, stateOk, need, color) => `<div class="sub-card" style="margin-bottom:8px;padding:10px 14px">
      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between">
        <div>
          <div><span class="tag" style="background:${color.bg};color:${color.fg}">阶段 ${step}</span> <b>${label}</b> <span class="muted" style="font-size:12px">${sub}</span></div>
          <div class="muted mt4" style="font-size:12px">前置：${need || '无'}</div>
        </div>
        <div class="row" style="gap:8px;align-items:center">
          ${stateBadge(stateOk, need || '无')}
          <button class="btn btn-primary" ${stateOk ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'} onclick="${stateOk ? `GradeViews.${fnName}('${fnArg}')` : `toast('前置数据未就绪：${need}','err')`}">📊 导出</button>
        </div>
      </div>
    </div>`;
    const COLORS = {
      y1: { bg: '#e8f0fe', fg: '#1f6feb' },
      y2: { bg: '#fff3d6', fg: '#ad6800' },
      y3: { bg: '#d6f5d6', fg: '#137333' },
      y4: { bg: '#f3e8fd', fg: '#7b1fa2' },
    };
    const exportListHtml = `<div class="sub-card" style="margin-bottom:12px">
      <div class="sub-desc" style="color:var(--primary-dark);font-weight:600;margin-bottom:4px">📋 综测榜单导出（按流程顺序）</div>
      <div class="muted mb8" style="font-size:12px">导出按"德育一榜 → 综测二榜 → 综测三榜 → 综测四榜"流程顺序依次排列；公示版需先在【📦 数据源配置】导入对应分值方可启用。</div>
      ${exportRow('1', '综测一榜（德育一榜·14 列）', '班级/学号/10类目/德育总分/加减分说明', 'doExportSnapshot', 'y1', true, '无', COLORS.y1)}
      ${exportRow('2', '综测二榜（14 列 + 一榜复核）', '同上 14 列，含一榜复核结果', 'doExportSnapshot', 'y2', true, '无', COLORS.y2)}
      ${exportRow('3', '综测二榜公示版（17 列）', '14列 + 智育 + 体育5 + 综测总分', 'doExportSnapshotPublic', 'y2', !disY2p, '智育成绩已导入', COLORS.y2)}
      ${exportRow('4', '综测三榜（17 列·含智育+体育）', '14列 + 智育 + 体育5 + 综测总分', 'doExportSnapshot', 'y3', true, '无', COLORS.y3)}
      ${exportRow('5', '综测三榜公示版（18 列）', '14列 + 智育 + 体育5 + 教师评价 + 综测总分', 'doExportSnapshotPublic', 'y3', !disY3p, '智育成绩', COLORS.y3)}
      ${exportRow('7', '综测四榜公示版（18 列）', '14列 + 智育 + 体育5 + 教师评价 + 综测总分', 'doExportSnapshotPublic', 'y4', !disY4p, '智育成绩', COLORS.y4)}
    </div>`;

    // 复核明细导出
    const reviewExportHtml = `<div class="sub-card" style="margin-bottom:12px">
      <div class="sub-desc" style="color:var(--primary-dark);font-weight:600;margin-bottom:4px">🧾 复核明细导出（按榜次，工作表背景色按榜次区分）</div>
      <div class="muted mb8" style="font-size:12px">导出全年级所有学生：已认定复核项计入对应 10 类目增减，未申请复核的学生汇总区留空；明细区逐条列出复核事项。被多榜多次修改的项目以"完整多榜链"展示：<code>原 X → 〔一榜认定〕Y → 〔二榜认定〕Z → 〔三榜认定〕W</code>。</div>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="GradeViews.doExportReviewStats('first')">🟦 一榜复核导出（蓝）</button>
        <button class="btn btn-primary" onclick="GradeViews.doExportReviewStats('second')">🟨 二榜复核导出（黄）</button>
        <button class="btn btn-primary" onclick="GradeViews.doExportReviewStats('third')">🟩 三榜复核导出（绿）</button>
      </div>
    </div>`;

    // DOM 插入后渲染顶部状态栏（return 后调用方插入到 DOM，setTimeout 80ms 后 #zs-status-bar 已存在）
    setTimeout(() => GradeViews._renderExportStatusBar(summary, cfg), 80);
    // 证明材料 zip 打包（2026-08-31，仅 admin）：班级/专业/整个年级 三粒度
    const materialZipHtml = isAdmin ? `<div class="sub-card" style="margin-bottom:12px">
      <div class="sub-desc" style="color:var(--primary-dark);font-weight:600;margin-bottom:4px">📦 证明材料打包下载（zip）</div>
      <div class="muted mb8" style="font-size:12px">把所选范围所有学生提交的<b>证明材料附件</b>打包为一个 zip（归档结构：班级/姓名_学号/序号_文件名），适合批量存档。需二级审核密码。</div>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
        <div class="form-item" style="flex:1;min-width:180px;margin:0"><label style="font-size:12px">范围</label>
          <select id="mz-mode" onchange="GradeViews._mzScopeSync()" style="width:100%;padding:6px">
            <option value="class">按班级</option>
            <option value="major">按专业</option>
            <option value="year">整个年级</option>
          </select></div>
        <div class="form-item" style="flex:1;min-width:220px;margin:0" id="mz-scope-wrap"><label style="font-size:12px">班级</label>
          <select id="mz-scope" style="width:100%;padding:6px">${classes.map(c => `<option value="${FMT.esc(c)}">${FMT.esc(c)}</option>`).join('')}</select></div>
        <button class="btn btn-primary" onclick="GradeViews.doExportMaterialZip()">📦 打包下载</button>
      </div>
      <div class="muted mt8" style="font-size:12px">提示：打包为流式生成，附件多时需等待数十秒；若当前文件较大，建议按班级分批打包。</div>
    </div>` : '';
    const fullProfileHtml = isAdmin ? `<div class="sub-card" style="margin-bottom:12px">
      <div class="sub-desc" style="color:var(--primary-dark);font-weight:600;margin-bottom:4px">📦 综测全程备案导出（Word + 附件按阶段归档）</div>
      <div class="muted mb8" style="font-size:12px">按范围导出每位学生的综测全过程：1 份 Word 全程备案文档（基本信息 / 已认定 / 未认定 / 复核记录 / 总分汇总）+ 证明材料按阶段分类归档（已认定 / 未认定 / 一榜 / 二榜 / 三榜复核材料）。需二级审核密码；后台按班级分批生成 zip 并上传云端存储，完成后按班级逐个下载（7 天内有效，过期可重新生成链接）。同时仅 1 个任务运行，其余自动排队（最多 3 个）。</div>
      <div id="fp-form-area">
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
          <div class="form-item" style="flex:1;min-width:150px;margin:0"><label style="font-size:12px">导出范围</label>
            <select id="fp-scope" onchange="GradeViews._fpScopeSync()" style="width:100%;padding:6px">
              <option value="all">全年级</option>
              <option value="profession">按专业</option>
              <option value="class">按班级</option>
              <option value="student">按个人</option>
            </select></div>
          <div class="form-item" style="flex:1;min-width:180px;margin:0;display:none" id="fp-prof-wrap"><label style="font-size:12px">选择专业</label>
            <select id="fp-prof" onchange="GradeViews._fpCount()" style="width:100%;padding:6px"></select></div>
          <div class="form-item" style="flex:1;min-width:180px;margin:0;display:none" id="fp-class-wrap"><label style="font-size:12px">选择班级</label>
            <select id="fp-class" onchange="GradeViews._fpCount()" style="width:100%;padding:6px"></select></div>
          <div class="form-item" style="flex:1.4;min-width:230px;margin:0;display:none" id="fp-stu-wrap"><label style="font-size:12px">搜索学生（学号 / 姓名）</label>
            <div class="row" style="gap:6px;align-items:center">
              <input id="fp-stu-q" style="flex:1;padding:6px" placeholder="输入学号或姓名" onkeydown="if(event.key==='Enter')GradeViews._fpSearch()" />
              <button class="btn" onclick="GradeViews._fpSearch()">搜索</button>
            </div>
            <div id="fp-stu-list" style="max-height:130px;overflow:auto;margin-top:6px"></div></div>
          <button class="btn btn-primary" onclick="GradeViews.doExportFullProfile()">📦 确认导出</button>
        </div>
        <div class="muted mt8" style="font-size:12px" id="fp-summary">已选范围：—</div>
      </div>
      <div id="fp-progress" style="margin-top:8px"></div>
      <div id="fp-history"></div>
    </div>` : '';
    setTimeout(() => { if (isAdmin) GradeViews._fpLoadOptions(); }, 120); // DOM 挂载后预载专业/班级选项
    return `<div class="card"><div class="card-title">数据导出【${mode === 'class' ? '班级名' : mode === 'major' ? '专业名' : '全部年级'}】<span class="sub">Excel · 按截图格式</span></div>
      ${tabs}
      ${formHtml}
      <div class="divider" style="margin:18px 0"></div>
      ${statusBarHtml}
      <div class="mt16">${dataSourceHtml}${exportListHtml}${reviewExportHtml}${materialZipHtml}${fullProfileHtml}</div>
    </div>`;
  },

  // 渲染顶部状态栏文本
  _renderExportStatusBar: (summary, cfg) => {
    const el = document.getElementById('zs-status-bar');
    if (!el) return;
    const rr = (cfg && cfg.reviewRounds) || {};
    const done = (cfg && cfg.reviewRoundDone) || {};
    const openRounds = ['first', 'second', 'third'].filter(k => rr[k]).map(k => ({ first: '一榜', second: '二榜', third: '三榜' })[k]).join('+') || '暂无';
    const zhiyu = summary.已导入智育 || 0;
    const teacher = summary.教师评价名单 ?? summary.已导入教师评价 ?? 0;
    const base = summary.教师评价基准分 ?? 1.5;
    const total = summary.学生总数 || 0;
    const zhiyuChain = summary.智育复核链条数 || 0;
    // 阶段判定（2026-09-09 名单制：教师评价恒可用，不再作为待导入前置）
    let phase = '德育一榜审核中（待导入智育）';
    if (rr.first && !rr.second && !rr.third) phase = zhiyu > 0 ? '一榜复核中（已含智育数据预览）' : '一榜复核中';
    else if (rr.second && !rr.third) phase = zhiyu > 0 ? '二榜复核中（含智育，二榜公示版可生成）' : '二榜复核中（待导入智育）';
    else if (rr.third) {
      if (zhiyu > 0) phase = '三榜复核中（智育就绪，三/四榜公示版可生成）';
      else phase = '三榜复核中（待导入智育）';
    }
    if (!rr.first && !rr.second && !rr.third) phase = '当前未开放任何复核榜次';
    const doneStr = ['first', 'second', 'third'].filter(k => done[k]).map(k => ({ first: '一榜', second: '二榜', third: '三榜' })[k]).join('+');
    el.innerHTML = `📍 <b>当前阶段：${phase}</b> ｜ 开放榜次：<b>${openRounds}</b>${doneStr ? ' ｜ 复核完毕：' + doneStr : ''} ｜ 数据：智育 <b>${zhiyu}</b>/${total} · 教师名单 <b>${teacher}</b> 人（未列默认 ${base}）· 智育复核链 <b>${zhiyuChain}</b> 条`;
  },

  // ===== 安全导出：二级密码弹窗（2026-08-30）=====
  _exportPwdCache: null,
  _exportPwdResolve: null,
  getExportPwd: () => new Promise((resolve) => {
    if (GradeViews._exportPwdCache) return resolve(GradeViews._exportPwdCache);
    GradeViews._exportPwdResolve = resolve;
    openModal(`<div class="modal-head"><h3>🔒 敏感数据导出</h3><button class="modal-close" onclick="GradeViews._cancelExportPwd()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8" style="background:var(--warning-bg);padding:10px 14px;border-radius:8px;line-height:1.6">本次导出的 Excel 文件将<b>加密</b>（需二级密码打开）、携带<b>页眉水印</b>（操作人/时间/IP），并记录审计日志。请输入您的二级审核密码：</div>
        <div class="form-item"><label>二级审核密码</label><input id="ep-pwd" type="password" placeholder="请输入二级审核密码" autocomplete="off"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="GradeViews._cancelExportPwd()">取消</button>
        <button class="btn btn-primary" onclick="GradeViews._confirmExportPwd()">确认导出</button></div>`);
    setTimeout(() => { const el = document.getElementById('ep-pwd'); if (el) el.focus(); }, 120);
  }),
  _confirmExportPwd: () => {
    const p = document.getElementById('ep-pwd')?.value.trim() || '';
    if (!p) return toast('请输入二级审核密码', 'err');
    GradeViews._exportPwdCache = p;
    closeModal();
    if (GradeViews._exportPwdResolve) { GradeViews._exportPwdResolve(p); GradeViews._exportPwdResolve = null; }
  },
  _cancelExportPwd: () => {
    closeModal();
    if (GradeViews._exportPwdResolve) { GradeViews._exportPwdResolve(''); GradeViews._exportPwdResolve = null; }
  },

  doExportGradeStats: async (mode = 'class') => {
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    let body, label;
    if (mode === 'class') {
      const sel = document.getElementById('ex-class');
      if (!sel || !sel.value) return toast('请选择班级', 'err');
      body = { mode, className: sel.value }; label = sel.value;
    } else if (mode === 'major') {
      const sel = document.getElementById('ex-major');
      if (!sel || !sel.value) return toast('请选择专业', 'err');
      body = { mode, major: sel.value }; label = sel.value;
    } else {
      body = { mode }; label = '全部年级';
    }
    body.secondaryPassword = pwd;
    try {
      toast('正在生成 Excel...');
      const blob = await API.postBlob('/api/export/grade-stats', body);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `德育【${label}】分项详细数据.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('已下载');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 打包下载：范围切换时同步班级/专业下拉（2026-08-31）
  _mzScopeSync: () => {
    const mode = document.getElementById('mz-mode')?.value || 'class';
    const wrap = document.getElementById('mz-scope-wrap');
    if (wrap) wrap.querySelector('label').textContent = mode === 'class' ? '班级' : '专业';
    const sel = document.getElementById('mz-scope');
    if (!sel) return;
    const cur = sel.value;
    const opts = mode === 'class' ? window._exportClasses : window._exportMajors;
    sel.innerHTML = (opts || []).map(o => `<option value="${FMT.esc(o)}">${FMT.esc(o)}</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  },

  // 证明材料 zip 打包下载（admin，2026-08-31）
  doExportMaterialZip: async () => {
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    const mode = document.getElementById('mz-mode')?.value || 'year';
    const scope = document.getElementById('mz-scope')?.value || '';
    if (mode !== 'year' && !scope) return toast('请选择班级/专业', 'err');
    try {
      toast('正在打包证明材料（附件较多时需等待数十秒）...');
      const blob = await API.postBlob('/api/admin/export-material-zip', { mode, scope, secondaryPassword: pwd });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'materials.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('已下载材料打包 zip');
    } catch (e) { toast(e.message, 'err'); }
  },

  // ===== 综测全程备案导出（2026-08-31，admin）=====
  _fpOpts: null,
  _fpSelectedStudent: null,
  _fpTimer: null,
  _fpJobState: null,   // { jobId, params, scopeLabel, total }
  _fpPollStart: 0,     // 轮询开始时间戳（ETA 粗估基准）

  // 进入页面时由 exportGradeStatsPage 调用，预载专业/班级选项
  async _fpLoadOptions() {
    try {
      const d = await API.get('/api/export/full-profile/options');
      GradeViews._fpOpts = d || {};
      const prof = document.getElementById('fp-prof');
      const cls = document.getElementById('fp-class');
      if (prof) prof.innerHTML = (GradeViews._fpOpts.professions || []).map(o => `<option value="${FMT.esc(o)}">${FMT.esc(o)}</option>`).join('');
      if (cls) cls.innerHTML = (GradeViews._fpOpts.classes || []).map(o => `<option value="${FMT.esc(o)}">${FMT.esc(o)}</option>`).join('');
    } catch (_) {}
    GradeViews._fpRefreshHistory();
  },
  // 范围切换 → 动态显示对应选择器 + 刷新人数摘要
  _fpScopeSync: () => {
    const scope = document.getElementById('fp-scope')?.value || 'all';
    const set = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
    set('fp-prof-wrap', scope === 'profession');
    set('fp-class-wrap', scope === 'class');
    set('fp-stu-wrap', scope === 'student');
    GradeViews._fpCount();
  },
  // 学生搜索（学号/姓名模糊）
  async _fpSearch() {
    const q = document.getElementById('fp-stu-q')?.value?.trim();
    const list = document.getElementById('fp-stu-list');
    GradeViews._fpSelectedStudent = null;
    if (!q) { if (list) list.innerHTML = '<div class="muted" style="font-size:12px">请输入学号或姓名</div>'; return; }
    try {
      const d = await API.get('/api/export/full-profile/options?q=' + encodeURIComponent(q));
      const stus = (d && d.students) || [];
      if (list) {
        if (!stus.length) list.innerHTML = '<div class="muted" style="font-size:12px">未找到学生</div>';
        else list.innerHTML = stus.map(s => `<div style="padding:5px 8px;cursor:pointer;border-radius:6px;border:1px solid #e0e0e0;margin-bottom:4px" onclick="GradeViews._fpPick('${s.id}','${FMT.esc(s.studentId || '')}','${FMT.esc(s.name || '')}')">${FMT.esc(s.studentId || '')} · ${FMT.esc(s.name || '')}（${FMT.esc(s.className || '')}）</div>`).join('');
      }
    } catch (e) { if (list) list.innerHTML = `<div class="muted" style="font-size:12px">${FMT.esc(e.message)}</div>`; }
  },
  _fpPick(id, sid, name) {
    GradeViews._fpSelectedStudent = { id, studentId: sid, name };
    const list = document.getElementById('fp-stu-list');
    if (list) list.innerHTML = `<div style="padding:5px 8px;background:#e8f1fb;border-radius:6px;font-size:12px">已选：${FMT.esc(sid)} · ${FMT.esc(name)} <a style="cursor:pointer;color:#1a6bc4" onclick="GradeViews._fpClearPick()">取消</a></div>`;
    GradeViews._fpCount();
  },
  _fpClearPick() {
    GradeViews._fpSelectedStudent = null;
    GradeViews._fpSearch();
  },
  // 预估人数（与导出同源）
  async _fpCount() {
    const scope = document.getElementById('fp-scope')?.value || 'all';
    const params = GradeViews._fpParams(scope);
    const summary = document.getElementById('fp-summary');
    if (params === null) { if (summary) summary.textContent = '已选范围：—'; return; }
    try {
      const d = await API.post('/api/export/full-profile/count', params);
      const n = (d && d.count) || 0;
      if (summary) summary.textContent = `已选范围：${GradeViews._fpLabel(scope, params)}（共 ${n} 人）` + (n > 50 ? '。超过 50 人将转为后台任务，完成后 24 小时内可下载。' : '');
    } catch (e) { if (summary) summary.textContent = `已选范围：—（${FMT.esc(e.message)}）`; }
  },
  _fpParams(scope) {
    if (scope === 'all') return { scope };
    if (scope === 'profession') {
      const v = document.getElementById('fp-prof')?.value;
      return v ? { scope, profession: v } : null;
    }
    if (scope === 'class') {
      const v = document.getElementById('fp-class')?.value;
      return v ? { scope, className: v } : null;
    }
    if (scope === 'student') {
      return GradeViews._fpSelectedStudent ? { scope, studentId: GradeViews._fpSelectedStudent.studentId } : null;
    }
    return { scope };
  },
  _fpLabel(scope, params) {
    if (scope === 'all') return '全年级';
    if (scope === 'profession') return `专业「${params.profession}」`;
    if (scope === 'class') return `班级「${params.className}」`;
    return `学生「${params.studentId}」`;
  },
  // 确认导出：一次 postBlob，按响应类型区分 同步 zip / 异步 json
  async doExportFullProfile() {
    const scope = document.getElementById('fp-scope')?.value || 'all';
    const params = GradeViews._fpParams(scope);
    if (params === null) return toast('请先完成范围选择（按个人需先搜索并选中学生）', 'err');
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    params.secondaryPassword = pwd;
    const box = document.getElementById('fp-progress');
    const formArea = document.getElementById('fp-form-area');
    try {
      toast('正在提交导出任务...');
      const blob = await API.postBlob('/api/export/full-profile/start', params);
      if (blob && blob.type && blob.type.includes('json')) {
        const j = JSON.parse(await blob.text());
        if (j && j.async) {
          // 异步：隐藏表单区 → 进度视图
          if (formArea) formArea.style.display = 'none';
          GradeViews._fpJobState = { jobId: j.jobId, params: { scope, profession: params.profession, className: params.className, studentId: params.studentId }, scopeLabel: j.scopeLabel || '', total: j.total || 0 };
          GradeViews._fpRenderProgress({ status: j.queued ? 'queued' : 'running', done: 0, total: j.total || 0, scopeLabel: j.scopeLabel || '', current: '' });
          GradeViews._fpPoll(j.jobId);
        } else {
          if (formArea) formArea.style.display = '';
          if (box) box.innerHTML = '';
          toast((j && j.error) || '导出失败', 'err');
        }
        return;
      }
      // 同步：zip 直接下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '综测备案.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (box) box.innerHTML = '';
      toast('已下载综测备案 zip');
      GradeViews._fpRefreshHistory();
    } catch (e) {
      if (formArea) formArea.style.display = '';
      if (box) box.innerHTML = '';
      toast(e.message, 'err');
    }
  },
  // 异步任务轮询（3s，按最终指令）
  _fpPoll(jobId) {
    if (GradeViews._fpTimer) clearInterval(GradeViews._fpTimer);
    GradeViews._fpPollStart = Date.now();
    GradeViews._fpTimer = setInterval(async () => {
      try {
        const j = await API.get('/api/export/full-profile/status?jobId=' + jobId);
        if (!j) return;
        const st = GradeViews._fpJobState;
        if (st) { st.jobId = jobId; st.total = j.total || st.total; }
        if (j.status === 'done' || j.status === 'partial_completed' || j.status === 'failed' || j.status === 'cancelled') {
          clearInterval(GradeViews._fpTimer);
          GradeViews._fpTimer = null;
          GradeViews._fpRenderProgress(j);
          GradeViews._fpRefreshHistory();
          return;
        }
        GradeViews._fpRenderProgress(j);
      } catch (_) {}
    }, 3000);
  },
  // 进度视图渲染（进度条 + 当前学生 + ETA；终态：完成/失败/取消）
  _fpRenderProgress(j) {
    const box = document.getElementById('fp-progress');
    if (!box) return;
    const st = GradeViews._fpJobState;
    if (j.status === 'queued') {
      box.innerHTML = `<div style="background:#fff8e6;border:1px solid #f0d48a;border-radius:8px;padding:12px 14px;font-size:13px">
        <div>⏳ <b>排队等待中</b>：已有导出任务在生成，您提交的任务将自动开始。</div>
        <div class="muted" style="margin-top:4px">范围：${FMT.esc(st ? st.scopeLabel : (j.scopeLabel || ''))}</div>
        <div style="margin-top:8px"><button class="btn" onclick="GradeViews._fpCancel()">✕ 取消任务</button></div></div>`;
      return;
    }
    if (j.status === 'done' || j.status === 'partial_completed') {
      if (j.mode === 'r2') {
        // R2 模式：按班级下载列表
        const warn = j.status === 'partial_completed'
          ? `<div style="color:#c0392b;font-weight:600;margin-top:6px">⚠️ 部分班级失败：${FMT.esc((j.failedClasses || []).map(f => f.className).join('、') || '未知')} 上传失败，其余班级可正常下载。</div>`
          : '';
        box.innerHTML = `<div style="background:${j.status === 'partial_completed' ? '#fff8e6;border:1px solid #f0d48a' : '#eaf6ec;border:1px solid #bfe3c6'};border-radius:8px;padding:12px 14px;font-size:13px">
        <div style="font-weight:600;color:#1e7a34">✅ 导出完成（${j.total || 0} 人 / ${j.totalClasses || 0} 个班级）</div>
        ${warn}
        <div class="muted" style="margin-top:4px">按班级逐个下载（每个班级一个 zip，7 天内有效，过期可重新生成链接）。</div>
        ${GradeViews._fpClassTable(j)}
        <div style="margin-top:8px"><button class="btn btn-ghost" onclick="GradeViews._fpResetForm()">返回</button></div></div>`;
      } else {
        box.innerHTML = `<div style="background:#eaf6ec;border:1px solid #bfe3c6;border-radius:8px;padding:12px 14px;font-size:13px">
        <div style="font-weight:600;color:#1e7a34">✅ 导出完成（${j.total || 0} 人${j.size ? '，文件 ' + GradeViews._fmtSize(j.size) : ''}）</div>
        <div class="muted" style="margin-top:4px">24 小时内可下载，过期自动清理。</div>
        <div style="margin-top:8px">
          <button class="btn btn-primary" onclick="GradeViews._fpDownload('${j.jobId || j.id || ''}')">⬇ 下载 zip</button>
          <button class="btn btn-ghost" onclick="GradeViews._fpResetForm()">返回</button>
        </div></div>`;
      }
      return;
    }
    if (j.status === 'failed') {
      box.innerHTML = `<div style="background:#fdecea;border:1px solid #f5c6c0;border-radius:8px;padding:12px 14px;font-size:13px">
        <div style="font-weight:600;color:#c0392b">❌ 导出失败</div>
        <div class="muted" style="margin-top:4px">失败原因：${FMT.esc(j.error || '未知错误')}</div>
        <div style="margin-top:8px">
          <button class="btn btn-primary" onclick="GradeViews._fpRetry()">🔄 重试</button>
          <button class="btn btn-ghost" onclick="GradeViews._fpResetForm()">返回</button>
        </div></div>`;
      return;
    }
    if (j.status === 'cancelled') {
      box.innerHTML = `<div class="muted" style="font-size:13px">✕ 任务已取消。</div>
        <div style="margin-top:8px"><button class="btn btn-ghost" onclick="GradeViews._fpResetForm()">返回</button></div>`;
      return;
    }
    // running：进度条 + 班级进度 + 当前学生 + ETA
    const pct = j.totalClasses ? Math.round((j.processedClasses || 0) / j.totalClasses * 100) : (j.total ? Math.round(j.done / j.total * 100) : 0);
    const eta = GradeViews._fpEta(j);
    const clsLine = j.totalClasses ? `<div class="muted mt4" style="font-size:12px">班级进度：${j.processedClasses || 0}/${j.totalClasses}${j.currentClass ? '（' + FMT.esc(j.currentClass) + '）' : ''}；学生：${j.done || 0}/${j.total || 0}${j.current ? '，当前：' + FMT.esc(j.current) : ''}${eta ? '，预计剩余：' + eta : ''}</div>` : '';
    box.innerHTML = `<div class="row" style="gap:8px;align-items:center">
        <div style="flex:1;background:#e0e7ef;border-radius:8px;height:14px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:var(--primary,#1a6bc4);border-radius:8px;transition:width .6s"></div></div>
        <span style="font-size:12px;min-width:38px">${pct}%</span></div>
      ${clsLine}
      <div style="margin-top:8px"><button class="btn" onclick="GradeViews._fpCancel()">✕ 取消任务</button></div>`;
  },
  // 班级下载列表表格（R2 模式完成态/历史展开共用）
  _fpClassTable(j) {
    const cls = j.classDownloads || [];
    if (!cls.length) return '<div class="muted" style="font-size:12px;margin-top:4px">（无已生成的班级文件）</div>';
    const rows = cls.map(c => `<tr>
      <td style="padding:4px 8px;font-size:12px">${FMT.esc(c.className)}</td>
      <td style="padding:4px 8px;font-size:12px">${c.count || 0}人</td>
      <td style="padding:4px 8px;font-size:12px">${GradeViews._fmtSize(c.size)}</td>
      <td style="padding:4px 8px;font-size:12px"><button class="btn btn-primary" style="padding:2px 10px;font-size:12px" onclick="GradeViews._fpDownload('${j.jobId || j.id || ''}','${FMT.esc(c.className)}')">⬇ 下载</button></td></tr>`).join('');
    return `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e0e0e0;border-radius:6px;margin-top:6px">
      <tr style="background:#f0f3f6"><th style="padding:4px 8px;font-size:12px;text-align:left">班级</th><th style="padding:4px 8px;font-size:12px;text-align:left">人数</th><th style="padding:4px 8px;font-size:12px;text-align:left">大小</th><th style="padding:4px 8px;font-size:12px;text-align:left">操作</th></tr>${rows}</table>`;
  },
  // 预计剩余时间（已用时间 × 剩余比例 粗估）
  _fpEta(j) {
    if (!GradeViews._fpPollStart || !j.done || !j.total) return '';
    const elapsed = (Date.now() - GradeViews._fpPollStart) / 1000;
    const remain = elapsed / j.done * (j.total - j.done);
    if (!isFinite(remain) || remain < 0) return '';
    if (remain < 60) return '约 ' + Math.max(1, Math.round(remain)) + ' 秒';
    return '约 ' + Math.max(1, Math.round(remain / 60)) + ' 分钟';
  },
  // 取消当前任务（进度视图内）
  async _fpCancel() {
    const st = GradeViews._fpJobState;
    if (!st) return;
    if (!confirm('确定取消该导出任务吗？已生成的部分不会保留。')) return;
    try {
      await API.del('/api/export/full-profile/job/' + st.jobId);
      const box = document.getElementById('fp-progress');
      if (box) box.innerHTML = `<div class="muted" style="font-size:12px">⏳ 正在取消任务...</div>`;
      GradeViews._fpRefreshHistory();
    } catch (e) {
      toast(e.message || '取消失败', 'err');
    }
  },
  // 从历史记录取消某个排队/生成中的任务
  async _fpCancelById(jobId) {
    if (!confirm('确定取消该导出任务吗？已生成的部分不会保留。')) return;
    try {
      await API.del('/api/export/full-profile/job/' + jobId);
      toast('已取消', 'ok');
      GradeViews._fpRefreshHistory();
      const st = GradeViews._fpJobState;
      if (st && st.jobId === jobId) GradeViews._fpRenderProgress({ status: 'cancelled', jobId });
    } catch (e) {
      toast(e.message || '取消失败', 'err');
    }
  },
  // 失败重试：用相同参数重新发起导出
  async _fpRetry() {
    const st = GradeViews._fpJobState;
    if (!st) return;
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    const params = { ...st.params, secondaryPassword: pwd };
    const box = document.getElementById('fp-progress');
    try {
      toast('正在重新提交导出任务...');
      const blob = await API.postBlob('/api/export/full-profile/start', params);
      if (blob && blob.type && blob.type.includes('json')) {
        const j = JSON.parse(await blob.text());
        if (j && j.async) {
          GradeViews._fpJobState = { jobId: j.jobId, params: { ...st.params }, scopeLabel: j.scopeLabel || st.scopeLabel, total: j.total || st.total };
          GradeViews._fpRenderProgress({ status: j.queued ? 'queued' : 'running', done: 0, total: j.total || 0, scopeLabel: j.scopeLabel || '', current: '' });
          GradeViews._fpPoll(j.jobId);
          return;
        }
      }
      // 兜底：返回的是 zip（范围人数变化导致同步）则直接下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '综测备案.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      GradeViews._fpResetForm();
      toast('已下载综测备案 zip');
    } catch (e) {
      toast(e.message, 'err');
    }
  },
  // 返回表单视图（停止轮询、恢复表单区）
  _fpResetForm() {
    if (GradeViews._fpTimer) { clearInterval(GradeViews._fpTimer); GradeViews._fpTimer = null; }
    GradeViews._fpJobState = null;
    GradeViews._fpPollStart = 0;
    const formArea = document.getElementById('fp-form-area');
    if (formArea) formArea.style.display = '';
    const box = document.getElementById('fp-progress');
    if (box) box.innerHTML = '';
    GradeViews._fpRefreshHistory();
  },
  _fpDownload(jobId, className) {
    const url = '/api/export/full-profile/download?jobId=' + jobId + (className ? '&className=' + encodeURIComponent(className) : '');
    // ⚠️ 禁止加 a.download=''：该属性使请求变为 CORS 模式（带 Origin 头），302 跳到
    // 跨域 R2 后因 R2 无 Access-Control-Allow-Origin 头被浏览器拦截，表现为
    // "无法下载 - 没有文件"。用普通导航（无 download 属性）跟随 302 按 Content-Disposition 下载。
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  },
  // 文件大小人性化显示
  _fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  },
  // 历史下载记录：当前 admin 有效期内所有任务（本地 24h / R2 7 天，含状态/大小/班级列表）
  async _fpRefreshHistory() {
    const el = document.getElementById('fp-history');
    if (!el) return;
    let d;
    try { d = await API.get('/api/export/full-profile/jobs'); } catch (_) { return; }
    const jobs = (d && d.jobs) || [];
    if (!jobs.length) { el.innerHTML = ''; return; }
    const stCn = { queued: '⏳ 排队中', running: '⏳ 生成中', done: '✅ 可下载', failed: '❌ 失败', cancelled: '✕ 已取消', partial_completed: '⚠️ 部分成功' };
    const rows = jobs.map(j => {
      const t = new Date(j.createdAt);
      const pad = (x) => String(x).padStart(2, '0');
      const timeStr = pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
      let act = '';
      if (j.mode === 'r2' && (j.status === 'done' || j.status === 'partial_completed')) {
        act = `<button class="btn btn-primary" style="padding:2px 8px;font-size:12px" onclick="GradeViews._fpShowHistoryClasses('${j.jobId}')">📦 班级列表</button>`;
      } else if (j.status === 'done') {
        act = `<button class="btn btn-primary" style="padding:2px 8px;font-size:12px" onclick="GradeViews._fpDownload('${j.jobId}')">下载</button>`;
      } else if (j.status === 'queued' || j.status === 'running') {
        act = `<button class="btn" style="padding:2px 8px;font-size:12px" onclick="GradeViews._fpCancelById('${j.jobId}')">取消</button>`;
      }
      const clsNote = j.mode === 'r2' && (j.classes || []).length ? `<span class="muted">（${(j.classes || []).length} 个班级）</span>` : '';
      return `<tr>
        <td style="padding:5px 8px;font-size:12px">综测备案_${FMT.esc(j.scopeLabel || '')}_${j.total || 0}人 ${clsNote}</td>
        <td style="padding:5px 8px;font-size:12px">${timeStr}</td>
        <td style="padding:5px 8px;font-size:12px">${GradeViews._fmtSize(j.size)}</td>
        <td style="padding:5px 8px;font-size:12px">${stCn[j.status] || j.status}</td>
        <td style="padding:5px 8px;font-size:12px">${act}</td></tr>`;
    }).join('');
    el.innerHTML = `<div style="font-size:12px;font-weight:600;margin-top:14px;margin-bottom:4px">📋 最近导出任务（本地 24h / R2 7 天内有效）</div>
      <table style="width:100%;border-collapse:collapse;background:#fafbfc;border:1px solid #e0e0e0;border-radius:6px">
        <tr style="background:#f0f3f6"><th style="padding:5px 8px;font-size:12px;text-align:left">文件名</th><th style="padding:5px 8px;font-size:12px;text-align:left">生成时间</th><th style="padding:5px 8px;font-size:12px;text-align:left">大小</th><th style="padding:5px 8px;font-size:12px;text-align:left">状态</th><th style="padding:5px 8px;font-size:12px;text-align:left">操作</th></tr>
        ${rows}</table><div id="fp-history-classes"></div>`;
  },
  // 历史记录中展开某任务的班级下载列表
  async _fpShowHistoryClasses(jobId) {
    const box = document.getElementById('fp-history-classes');
    if (!box) return;
    let j;
    try { j = await API.get('/api/export/full-profile/status?jobId=' + jobId); } catch (_) { toast('获取任务详情失败', 'err'); return; }
    if (!j || !(j.classDownloads || []).length) { box.innerHTML = '<div class="muted" style="font-size:12px;margin-top:6px">无可用班级文件</div>'; return; }
    box.innerHTML = `<div style="font-size:12px;font-weight:600;margin-top:8px">📦 ${FMT.esc(j.scopeLabel || '')} 班级下载列表（7 天内可下载）</div>` + GradeViews._fpClassTable(j);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  doExportReviewStats: async (round) => {
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    try {
      toast('正在生成复核 Excel...');
      const blob = await API.postBlob('/api/export/review-stats', { round, secondaryPassword: pwd });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cn = AppViews.ROUNDS.find(x => x.key === round)?.cn || round;
      a.download = `综测复核【${cn}】.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('已下载');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 综测 4 表快照导出：按当前 mode/className/major 维度导出单个 snapshot
  // snapshot: 'y1' 德育一榜（无复核） | 'y2' 综测二榜（截至一榜） | 'y3' 综测三榜（截至二榜） | 'y4' 综测四榜（截至三榜）
  doExportSnapshot: async (snapshot) => {
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    // 复用 doExportGradeStats 的入参构造逻辑：按 mode 取 className/major
    const activeMode = window._exportMode || 'class';
    let body, label;
    if (activeMode === 'class') {
      const sel = document.getElementById('ex-class');
      if (!sel || !sel.value) return toast('请选择班级', 'err');
      body = { snapshot, mode: 'class', className: sel.value }; label = sel.value;
    } else if (activeMode === 'major') {
      const sel = document.getElementById('ex-major');
      if (!sel || !sel.value) return toast('请选择专业', 'err');
      body = { snapshot, mode: 'major', major: sel.value }; label = sel.value;
    } else {
      body = { snapshot, mode: 'year' }; label = '全部年级';
    }
    body.secondaryPassword = pwd;
    const SNAP_NAMES = { y1: '德育一榜', y2: '综测二榜', y3: '综测三榜', y4: '综测四榜' };
    const sn = SNAP_NAMES[snapshot] || snapshot;
    try {
      toast(`正在生成 ${sn}...`);
      const blob = await API.postBlob('/api/export/snapshot-stats', body);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `综测【${label}】${sn}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`${sn}已下载`);
    } catch (e) { toast(e.message, 'err'); }
  },

  // 综测公示版导出：snapshot y2/y3/y4（从库读取智育/教师评价，含智育复核链；不再上传文件）
  doExportSnapshotPublic: async (snapshot = 'y2') => {
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    // 前置数据校验（与页面按钮 disabled 逻辑保持一致，兜底）
    const s = window._scoresSummary || {};
    const zhiyu = s.已导入智育 || 0;
    // 2026-09-09 名单制：教师评价恒可用（名单覆盖 + 未列默认 1.5），不再要求已导入>0
    if ((snapshot === 'y2' || snapshot === 'y3' || snapshot === 'y4') && zhiyu === 0) return toast('请先在【📦 数据源配置】导入智育成绩', 'err');
    const activeMode = window._exportMode || 'class';
    const payload = { snapshot, public: true, secondaryPassword: pwd };
    let label;
    if (activeMode === 'class') {
      const sel = document.getElementById('ex-class');
      if (!sel || !sel.value) return toast('请选择班级', 'err');
      payload.mode = 'class'; payload.className = sel.value; label = sel.value;
    } else if (activeMode === 'major') {
      const sel = document.getElementById('ex-major');
      if (!sel || !sel.value) return toast('请选择专业', 'err');
      payload.mode = 'major'; payload.major = sel.value; label = sel.value;
    } else {
      payload.mode = 'year'; label = '全部年级';
    }
    const SNAP_NAMES = { y2: '综测二榜', y3: '综测三榜', y4: '综测四榜' };
    const sn = SNAP_NAMES[snapshot] || snapshot;
    try {
      toast(`正在生成${sn}公示版...`);
      const blob = await API.postBlob('/api/export/snapshot-stats', payload);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `综测【${label}】${sn}·公示版.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`${sn}公示版已下载`);
    } catch (e) { toast(e.message, 'err'); }
  },

  // 导入智育成绩 / 教师评价分（落库 scores，供公示版与 C 类复核使用）
  doImportScores: async (field) => {
    const inputId = field === 'zhiyu' ? 'zs-import-zhiyu' : 'zs-import-teacher';
    const file = document.getElementById(inputId)?.files[0];
    if (!file) return toast(field === 'zhiyu' ? '请先选择智育成绩文件（.xlsx）' : '请先选择教师评价分文件（.xlsx）', 'err');
    const fd = new FormData();
    fd.append('field', field);
    fd.append('files', file, 'scores.xlsx');
    try {
      toast('正在导入...');
      const d = await API.upload('/api/admin/scores/import', fd);
      if (field === 'teacher') {
        const miss = (d.姓名未匹配 || []).slice(0, 8).join('、') + ((d.姓名未匹配 || []).length > 8 ? `…等 ${d.姓名未匹配.length} 人` : '');
        toast(`✅ 教师评价名单已生效 ${d.导入条数} 人（未列学生默认 1.5 分）${miss ? `｜未找到姓名：${miss}` : ''}`);
        // 2026-09-09 方案 B：重名歧义升级为内联补传卡片（不自动 goto，留住卡片让用户处理）
        if (Array.isArray(d.重名歧义) && d.重名歧义.length) {
          GradeViews._renderAmbiguousCard(d.重名歧义);
        } else {
          setTimeout(() => App.goto('gradeExport', window._exportMode || 'class'), 500);
        }
      } else {
        toast(`✅ ${d.label}导入成功：共 ${d.导入条数} 条，匹配到系统学生 ${d.匹配学生数} 条`);
        setTimeout(() => App.goto('gradeExport', window._exportMode || 'class'), 500);
      }
    } catch (e) { toast(e.message, 'err'); }
  },

  // 2026-09-09 方案 B：重名歧义内联补传卡片（admin 端教师评价名单导入后）
  // list: [{name, value, cls, candidates:[{sid,name,className,currentTeacher}]}]
  // ⚠ 与 import 的"先清全库 teacher 再写名单"不同：resolve 只追加这几个人，不影响其他学生。
  _renderAmbiguousCard: (list) => {
    window._ambList = list;
    window._ambSel = window._ambSel || {};
    const box = document.getElementById('zs-ambiguous-card');
    if (!box) return;
    const cur = (window._scoresSummary && window._scoresSummary.教师评价名单) || 0;
    const rows = list.map((g, gi) => {
      const selSid = window._ambSel[gi];
      const cands = g.candidates.map(c => {
        const selStyle = selSid === c.sid ? 'border-color:var(--primary);background:#eef5ff' : '';
        const ct = c.currentTeacher == null ? '—' : c.currentTeacher;
        return `<div class="amb-cand" data-sid="${FMT.esc(c.sid)}" data-idx="${gi}" style="display:inline-block;padding:8px 12px;margin:4px;border:1px solid #d0d7de;border-radius:6px;cursor:pointer;${selStyle}" onclick="GradeViews._ambPick(${gi},'${FMT.esc(c.sid).replace(/'/g, "\\&#39;")}')">
          <div style="font-size:13px"><b>${FMT.esc(c.name)}</b> <span class="muted">${FMT.esc(c.className || '无班级')}</span></div>
          <div style="font-size:11px;color:#666">学号 ${FMT.esc(c.sid)} · 当前教师分 ${ct}</div>
        </div>`;
      }).join('');
      return `<div class="amb-row" data-gi="${gi}" style="padding:10px;border:1px solid #f0c674;border-radius:8px;margin-bottom:8px;background:#fffbe6">
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
          <div style="flex:0 0 auto"><b>${FMT.esc(g.name)}</b>${g.cls ? ` <span class="muted">（表内班级：${FMT.esc(g.cls)}）</span>` : ''} <span class="muted" style="font-size:12px">重名 ×${g.candidates.length}</span></div>
          <div class="form-item" style="flex:0 0 120px;margin:0"><label style="font-size:11px">加分</label><input type="number" step="0.1" min="0" max="2" id="amb-val-${gi}" value="${g.value}" style="width:100%"></div>
          <div class="muted" style="font-size:11px;flex:1;min-width:200px">点击下方候选卡片选择该名单对应哪名学生（学号/班级消歧）</div>
        </div>
        <div class="amb-cands" style="margin-top:6px">${cands}</div>
      </div>`;
    }).join('');
    box.innerHTML = `<div class="amb-card" style="padding:12px;border:1px solid #f0c674;border-radius:10px;background:#fffbeb">
      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <div style="font-weight:600">⚠ 有 ${list.length} 个重名需消歧（已生效教师评价名单 ${cur} 人，含未列 1.5 基准）</div>
        <div class="muted" style="font-size:12px;flex:1">仅补传这 ${list.length} 名学生的教师评价分，<b>不影响其他已生效的数据</b></div>
      </div>
      ${rows}
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn btn-primary" onclick="GradeViews._doResolveAmbiguous(${list.length})">📤 补传这 ${list.length} 个</button>
        <button class="btn btn-ghost" onclick="GradeViews._cancelAmbiguousCard()">暂不处理</button>
      </div>
    </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  // 选中/切换候选学生（gi=行号，sid=学号）
  _ambPick: (gi, sid) => {
    window._ambSel = window._ambSel || {};
    window._ambSel[gi] = sid;
    GradeViews._renderAmbiguousCard(window._ambList || []);
  },

  // 取消补传卡片（重渲染页面）
  _cancelAmbiguousCard: () => {
    const box = document.getElementById('zs-ambiguous-card');
    if (box) box.innerHTML = '';
    window._ambSel = {};
    window._ambList = [];
    setTimeout(() => App.goto('gradeExport', window._exportMode || 'class'), 200);
  },

  // 提交重名消歧补传（仅追加，不清全库）
  _doResolveAmbiguous: async (n) => {
    if (!window._ambList || !window._ambList.length) return toast('无可消歧项', 'err');
    const resolutions = [];
    for (let gi = 0; gi < n; gi++) {
      const g = window._ambList[gi];
      if (!g) continue;
      const valEl = document.getElementById('amb-val-' + gi);
      const value = Number(valEl ? valEl.value : g.value);
      const selSid = (window._ambSel || {})[gi];
      // 优先级：选中 sid > 原表内 cls（自动）> 无
      const disambiguator = selSid ? { sid: selSid } : (g.cls ? { cls: g.cls } : {});
      resolutions.push({ name: g.name, value, disambiguator });
    }
    try {
      toast('正在消歧补传...');
      const r = await API.post('/api/admin/scores/resolve-ambiguous', { resolutions });
      if (r.补传成功) toast(`✅ 重名消歧补传成功 ${r.补传成功} 人${r.补传失败 && r.补传失败.length ? `，失败 ${r.补传失败.length} 人：${r.补传失败.map(f => f.name + '(' + f.reason + ')').join('、')}` : ''}`);
      else toast(r.补传失败 && r.补传失败.length ? `❌ 补传失败：${r.补传失败.map(f => f.name + '(' + f.reason + ')').join('、')}` : '⚠ 无成功项', 'err');
      window._ambSel = {};
      window._ambList = [];
      setTimeout(() => App.goto('gradeExport', window._exportMode || 'class'), 500);
    } catch (e) { toast(e.message, 'err'); }
  },

  // 清除已导入的智育成绩 / 教师评价分（需二级密码；连带清智育复核链）
  doClearScores: () => {
    openModal(`<div class="modal-head"><h3>🧹 清除导入数据</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8" style="background:var(--danger-bg);padding:10px 14px;border-radius:8px;color:var(--danger);line-height:1.7">⚠️ 此操作将<b>清空全部已导入的智育成绩与教师评价分</b>，并连带清除智育复核链（学生公示版智育回到"未导入"状态）。此操作<b>不可恢复</b>！</div>
        <div class="form-item"><label>二级审核密码（必填）</label><input id="cs-pwd" type="password" placeholder="请输入二级审核密码"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-danger" onclick="GradeViews.doClearScoresConfirm()">确认清除</button></div>`);
  },
  doClearScoresConfirm: async () => {
    const pwd = document.getElementById('cs-pwd').value.trim();
    if (!pwd) return toast('请输入二级审核密码', 'err');
    try {
      const r = await API.post('/api/admin/scores/clear', { secondaryPassword: pwd });
      closeModal();
      toast(`✅ 已清除：scores ${r.clearedScores} 条 / 智育复核链 ${r.clearedZhiyuOverrides} 条`);
      setTimeout(() => App.goto('gradeExport', window._exportMode || 'class'), 400);
    } catch (e) { toast(e.message, 'err'); }
  },

  // 刷新智育/教师评价导入概况 + 同步顶部状态栏
  loadScoresSummary: async () => {
    const box = document.getElementById('zs-scores-summary');
    if (!box) return; // 不在导出页直接返回
    try {
      const [summary, cfg] = await Promise.all([
        API.get('/api/admin/scores/summary'),
        API.get('/api/config'),
      ]);
      window._scoresSummary = summary;
      window._exportConfig = cfg;
      box.innerHTML = `📊 导入概况：学生总数 <b>${summary.学生总数}</b> ｜ 已导入智育 <b>${summary.已导入智育}</b> 人 ｜ 教师评价名单 <b>${summary.教师评价名单 ?? summary.已导入教师评价 ?? 0}</b> 人（未列默认 <b>${summary.教师评价基准分 ?? 1.5}</b> 分）｜ 智育复核链 <b>${summary.智育复核链条数}</b> 条`;
      GradeViews._renderExportStatusBar(summary, cfg);
    } catch (e) { box.innerHTML = ''; }
  },

  stats: async () => {
    const st = await API.gradeStats();
    const maxRate = Math.max(1, ...Object.values(st.byClass).map(c => +c.submitRate));
    let h = `<div class="grid grid-4">
      <div class="stat-card"><div class="label">学生总数</div><div class="num">${st.totalStudents}</div></div>
      <div class="stat-card c-green"><div class="label">已提交人数</div><div class="num">${st.submittedCount}</div><div class="label">提交率 ${(st.submittedCount / Math.max(1, st.totalStudents) * 100).toFixed(1)}%</div></div>
      <div class="stat-card c-blue"><div class="label">材料总数</div><div class="num">${st.totalSubmissions}</div><div class="label">已认定 ${st.byStatus.approved} 条</div></div>
      <div class="stat-card c-orange"><div class="label">待处理事项</div><div class="num" style="font-size:15px">待审 ${st.byStatus.pending} · 异议 ${st.pendingObjections}</div></div>
    </div>
    <div class="grid grid-2 mt16">
      <div class="card"><div class="card-title">材料状态分布</div>
        ${['pending', 'approved', 'rejected', 'resubmit'].map(k => {
          const pct = st.totalSubmissions ? (st.byStatus[k] / st.totalSubmissions * 100).toFixed(1) : 0;
          const c = { pending: '#0891b2', approved: '#16a34a', rejected: '#dc2626', resubmit: '#d97706' }[k];
          return `<div class="sub-meta" style="justify-content:space-between;display:flex"><span>${FMT.status[k].text}（${st.byStatus[k]}）</span><span>${pct}%</span></div>
            <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%;background:${c}"></div></div><div class="mt8"></div>`;
        }).join('')}
      </div>
      <div class="card"><div class="card-title">各班进度</div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>班级</th><th>人数</th><th>已提交</th><th>提交率</th><th>已认定条数</th><th>总分</th></tr></thead><tbody>`;
    Object.entries(st.byClass).forEach(([c, v]) => {
      h += `<tr><td>${FMT.esc(c)}</td><td>${v.studentCount}</td><td>${v.submittedCount}</td>
        <td style="min-width:110px">${v.submitRate}%<div class="bar-wrap"><div class="bar-fill" style="width:${v.submitRate / maxRate * 100}%"></div></div></td>
        <td>${v.approvedCount}</td><td>${v.approvedPoints}</td></tr>`;
    });
    h += '</tbody></table></div></div>';
    return h;
  },
};

/* ================= 综测申请表（整份申请）=================
 * 一次提交一整份申请，按 2023 级纸质表格流程：已认定项目 + 未认定项目 + 证明材料
 * 班长审已认定，年级审未认定 + 可改判已认定
 */
const AppViews = {
  // 学生端：提交新申请表单（一行 = 一个项目 + 对应一条证明材料附件）
  submitApp: () => {
    const u = App.user;
    return `<div class="card">
      <div class="card-title">📋 综测加分申请表（个人版）<span class="sub">按纸质表格流程：每一行项目对应一条证明材料（必传附件）</span></div>
      <div class="grid grid-2">
        <div class="form-item"><label>姓名</label><input value="${FMT.esc(u.name)}" disabled></div>
        <div class="form-item"><label>学号</label><input value="${FMT.esc(u.studentId)}" disabled></div>
      </div>
      <div class="grid grid-2">
        <div class="form-item"><label>班级</label><input value="${FMT.esc(u.className)}" disabled></div>
        <div class="form-item"><label>电话<span class="req" style="color:var(--danger);margin-left:3px">*</span></label><input id="a-phone" required placeholder="11 位手机号" maxlength="11" inputmode="numeric" autocomplete="tel"></div>
      </div>
      <div style="background:var(--info-bg);padding:10px 14px;border-radius:8px;margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;color:var(--info)">
          <input type="checkbox" id="a-noitems" onchange="AppViews.toggleNoItems()">
          📌 声明本人本学年不涉及综测加分项目
        </label>
        <div class="muted mt8" style="font-size:12px">⚠ 如确无不涉及，请勾选此项后直接提交，班长审核确认即可。如误提交可联系班长退回。</div>
      </div>
      <div id="a-items-area">
        <hr class="divider">
        <h3 style="color:var(--primary-dark);font-size:15px;margin-bottom:8px">一、已认定项目加减分申请</h3>
        <p class="muted mb8">每个项目独占一行，并在同一行上传对应的证明材料。<span style="color:var(--danger);font-weight:600">输入序号 → 选择等级 → 系统自动带出项目名称与加分分值</span>；分值为空的等级中，仅 318（院级各类团体）/434（专利）/435（论文）由学生自填 0~2 分，其余由评定小组给定。每行必须上传证明材料附件。</p>
        <div id="a-cert-items"></div>
        <datalist id="cc-code-list"></datalist>
        <button class="btn btn-ghost btn-sm mt8" onclick="AppViews.addCertItem()">+ 添加 已认定项目（含证明材料）</button>
        <hr class="divider">
        <h3 style="color:var(--primary-dark);font-size:15px;margin-bottom:8px">二、未认定项目及社会实践（媒体类）加分申请</h3>
        <p class="muted mb8">每个项目独占一行，并在同一行上传对应的证明材料。<span style="color:var(--danger);font-weight:600">每一行的"所属类型/名称/级别/时间/授予或报道单位/加减分"必须填写完全</span>，并上传证明材料附件。</p>
        <div id="a-uncert-items"></div>
        <button class="btn btn-ghost btn-sm mt8" onclick="AppViews.addUncertItem()">+ 添加 未认定项目（含证明材料）</button>
      </div>
      <hr class="divider">
      <div class="muted mb8">填表说明：以上表格栏目不够可自行添加；已认定项目「加减分」中的减分用于违规违纪（填负数）；每行项目必须上传对应证明材料。</div>
      <div class="form-item"><label>备注（选填，最多 500 字）</label><textarea id="a-notes" maxlength="500" placeholder="如有需要说明的情况可在此填写，例如：本次无任何加分项目、情况说明、特殊原因等"></textarea></div>
      <button class="btn btn-primary" onclick="AppViews.doSubmit()">📤 提交整份申请</button>
    </div>`;
  },

  // 切换"不涉及加分"：勾选时禁用项目区
  toggleNoItems: () => {
    const checked = document.getElementById('a-noitems').checked;
    const area = document.getElementById('a-items-area');
    if (area) { area.style.opacity = checked ? '0.4' : '1'; area.style.pointerEvents = checked ? 'none' : 'auto'; }
  },

  addCertItem: () => {
    const html = AppViews._certRow().replace('cert-row', document.getElementById('re-cert-items') ? 'cert-row re-cert' : 'cert-row');
    const box = document.getElementById('re-cert-items') || document.getElementById('a-cert-items');
    box.insertAdjacentHTML('beforeend', html);
  },
  addUncertItem: () => {
    const html = AppViews._uncertRow().replace('uncert-row', document.getElementById('re-uncert-items') ? 'uncert-row re-uncert' : 'uncert-row');
    const box = document.getElementById('re-uncert-items') || document.getElementById('a-uncert-items');
    box.insertAdjacentHTML('beforeend', html);
  },

  _certRow: () => `<div class="sub-card cert-row" style="padding:10px;margin-bottom:8px">
    <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
      <input class="cert-code" required placeholder="输入序号（如419）" list="cc-code-list" oninput="AppViews.certCodeInput(this)" style="width:110px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <select class="cert-level" style="flex:1.2;min-width:150px;padding:6px;border:1px solid var(--border);border-radius:6px" onchange="AppViews.certLevelChange(this)">
        <option value="">— 先输入序号 —</option>
      </select>
      <input class="cert-points" type="number" step="0.05" readonly placeholder="分值自动带出" style="width:90px;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--gray-bg)">
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.cert-row').remove()">✕</button>
    </div>
    <div class="row mt8" style="gap:6px;flex-wrap:wrap;align-items:center">
      <span class="cert-name tag tag-certified" style="flex:1;min-width:220px;font-size:11.5px">— 输入序号后自动显示项目名称 —</span>
      <span class="cert-note muted" style="font-size:11px;color:var(--text-2)"></span>
    </div>
    <div class="row mt8" style="gap:6px;flex-wrap:wrap;align-items:center">
      <span class="tag tag-grade">📎 证明材料（必传）</span>
      <input class="cert-proof-file" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style="flex:1;min-width:240px">
    </div>
    <div class="cert-file-hint muted" style="font-size:11px;color:var(--text-2);margin-top:4px">💡 建议：请将证明材料文件重命名为对应的项目名称（如：星级宿舍（二星级）.jpg），便于审核人员快速核对。</div>
  </div>`,

  // 目录选择：输入序号 → 匹配目录 → 显示项目名称 + 填充等级下拉
  certCodeInput: (el) => {
    const row = el.closest('.cert-row');
    const code = el.value.trim();
    const cat = (window.__certCat || []).find(c => c.code === code);
    const hint = row.querySelector('.cert-file-hint');
    if (!cat) {
      row.querySelector('.cert-name').textContent = code ? `⚠ 序号 ${code} 不在目录中` : '— 输入序号后自动显示项目名称 —';
      row.querySelector('.cert-name').className = 'cert-name tag tag-rejected';
      row.querySelector('.cert-level').innerHTML = '<option value="">— 先输入序号 —</option>';
      row.querySelector('.cert-points').value = '';
      row.querySelector('.cert-note').textContent = '';
      if (hint) hint.innerHTML = '💡 建议：请将证明材料文件重命名为对应的项目名称（如：星级宿舍（二星级）.jpg），便于审核人员快速核对。';
      return;
    }
    row.querySelector('.cert-name').textContent = cat.name;
    row.querySelector('.cert-name').className = 'cert-name tag tag-certified';
    row.querySelector('.cert-note').textContent = (cat.note || '').slice(0, 60);
    const lvSel = row.querySelector('.cert-level');
    lvSel.innerHTML = cat.levels.map(l => `<option value="${FMT.esc(l.level)}" data-points="${l.points != null ? l.points : ''}">${FMT.esc(l.level)}${l.points != null ? '（' + l.points + '分）' : (SELF_FILL_CODES.has(code) ? '（自填分值）' : '（评定给定）')}</option>`).join('');
    lvSel.disabled = false;
    row.querySelector('.cert-points').value = '';
    row.dataset.catCode = code;
    // 2026-09-06：单等级项目（无选择余地）自动同步分值框状态——白名单内的自填项目即时解锁可输入（修 318/434/435 无法自填 bug），固定分值项目自动带出
    if (cat.levels.length === 1) AppViews.certLevelChange(lvSel);
    // 动态提示：文件名建议用当前项目名称
    if (hint) hint.innerHTML = `💡 建议：请将证明材料文件重命名为「${FMT.esc(cat.name)}」+ 等级（如：${FMT.esc(cat.name)}一等奖.jpg），便于审核人员快速核对。`;
  },

  // 等级选择 → 自动带出分值（固定只读 / 白名单项目自填可输入 / 其余未定分值只读待评定）
  certLevelChange: (el) => {
    const row = el.closest('.cert-row');
    const code = row.querySelector('.cert-code').value.trim();
    const opt = el.options[el.selectedIndex];
    const pts = opt ? opt.dataset.points : '';
    const inp = row.querySelector('.cert-points');
    if (pts !== '') {
      inp.value = pts;
      inp.readOnly = true;
      inp.placeholder = '分值自动带出';
      inp.style.background = 'var(--gray-bg)';
    } else if (SELF_FILL_CODES.has(code)) {
      // 白名单内未定分值 → 学生自填 0~2
      inp.value = '';
      inp.readOnly = false;
      inp.placeholder = '自填分值（0~2）';
      inp.style.background = '#fff';
      inp.focus();
    } else {
      // 未定分值但不在白名单 → 由评定小组给定，禁止自填
      inp.value = '';
      inp.readOnly = true;
      inp.placeholder = '评定小组给定';
      inp.style.background = 'var(--gray-bg)';
    }
  },

  _uncertRow: () => `<div class="sub-card uncert-row" style="padding:10px;margin-bottom:8px">
    <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
      <select class="uncert-type" style="flex:1;min-width:140px;padding:6px;border:1px solid var(--border);border-radius:6px" required>
        <option>社会实践（媒体类）</option><option>活动/竞赛</option><option>其他</option>
      </select>
      <input class="uncert-name" required placeholder="活动/竞赛名称" style="flex:2;min-width:200px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <input class="uncert-level" required placeholder="奖项/报道级别" style="flex:1;min-width:120px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <input class="uncert-date" required placeholder="时间" style="width:100px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <input class="uncert-unit" required placeholder="授予/报道单位" style="flex:1;min-width:120px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <input class="uncert-points" type="number" step="0.5" required placeholder="加减分" style="width:90px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.uncert-row').remove()">✕</button>
    </div>
    <div class="row mt8" style="gap:6px;flex-wrap:wrap;align-items:center">
      <span class="tag tag-obj">📎 证明材料</span>
      <input class="uncert-proof-file" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style="flex:1;min-width:240px">
    </div>
    <div class="muted" style="font-size:11px;color:var(--text-2);margin-top:4px">💡 建议：请将证明材料文件重命名为对应的活动/竞赛名称（如：大学生创新大赛一等奖.jpg），便于审核人员快速核对。</div>
  </div>`,

  // 2026-09-07：提交防重复（包装层，原逻辑 _doSubmitRaw 不变）——避免 503/慢响应时多次点击产生重复提交与孤儿附件
  doSubmit: async () => {
    if (AppViews._submitting) { toast('正在提交中，请勿重复点击…', 'warn'); return; }
    AppViews._submitting = true;
    setTimeout(() => { AppViews._submitting = false; }, 150000); // 兜底释放（网络异常卡住 150s 后自动解锁）
    try { await AppViews._doSubmitRaw(); } catch (_) {}
    AppViews._submitting = false;
  },
  _doSubmitRaw: async () => {
    const notInvolved = document.getElementById('a-noitems').checked;
    const phone = document.getElementById('a-phone').value.trim();
    if (!phone) { toast('联系电话为必填项，请填写本人联系电话', 'err'); return; }
    if (!/^1[3-9]\d{9}$/.test(phone)) { toast('联系电话格式不正确，请填写 11 位手机号（1 开头，共 11 位数字）', 'err'); return; }
    const certRows = [...document.querySelectorAll('#a-cert-items .cert-row')];
    const uncertRows = [...document.querySelectorAll('#a-uncert-items .uncert-row')];
    const certifiedItems = certRows.map(row => {
      const cat = (window.__certCat || []).find(c => c.code === (row.querySelector('.cert-code')?.value || '').trim());
      const levelEl = row.querySelector('.cert-level');
      return {
        code: (row.querySelector('.cert-code')?.value || '').trim(),
        level: levelEl ? levelEl.value : '',
        name: cat ? cat.name : '',
        points: parseFloat(row.querySelector('.cert-points').value) || 0,
        proofFile: row.querySelector('.cert-proof-file').files[0] || null,
      };
    });
    const uncertifiedItems = uncertRows.map(row => ({
      type: row.querySelector('.uncert-type').value,
      name: row.querySelector('.uncert-name').value.trim(),
      level: row.querySelector('.uncert-level').value.trim(),
      date: row.querySelector('.uncert-date').value.trim(),
      unit: row.querySelector('.uncert-unit').value.trim(),
      points: parseFloat(row.querySelector('.uncert-points').value) || 0,
      proofFile: row.querySelector('.uncert-proof-file').files[0] || null,
    }));
    if (!notInvolved) {
      for (const it of certifiedItems) {
        if (!it.code && !it.level && !it.points) continue; // 空行跳过
        if (!it.code) { toast('已认定项目序号不能为空（先输入序号再选等级）', 'err'); return; }
        const cat = (window.__certCat || []).find(c => c.code === it.code);
        if (!cat) { toast(`序号 ${it.code} 不在已认定项目目录中，请选择有效序号`, 'err'); return; }
        if (!it.level) { toast(`请为「${cat.name}」选择等级`, 'err'); return; }
        const lv = cat.levels.find(l => l.level === it.level);
        if (!lv) { toast(`项目「${cat.name}」不存在等级「${it.level}」`, 'err'); return; }
        if (lv.points == null) {
          if (!SELF_FILL_CODES.has(it.code)) { toast(`项目「${cat.name}」分值由评定小组给定，不支持学生自填`, 'err'); return; }
          if (!(it.points > 0 && it.points <= 2)) { toast(`项目「${cat.name}」该等级未定分值，请自填 0~2 之间的分值`, 'err'); return; }
        }
        if (!it.proofFile) { toast(`已认定项目「${cat.name}」必须上传对应证明材料附件`, 'err'); return; }
      }
      for (const it of uncertifiedItems) {
        if (!it.name) continue;
        if (!it.level) { toast(`未认定项目「${it.name}」奖项/报道级别不能为空`, 'err'); return; }
        if (!it.date) { toast(`未认定项目「${it.name}」时间不能为空`, 'err'); return; }
        if (!it.unit) { toast(`未认定项目「${it.name}」授予/报道单位不能为空`, 'err'); return; }
        if (!it.points) { toast('未认定项目分值不能为空', 'err'); return; }
        if (!it.proofFile) { toast(`未认定项目「${it.name}」必须上传对应证明材料附件`, 'err'); return; }
      }
    }
    const validCert = certifiedItems.filter(i => i.code && i.level);
    const validUncert = uncertifiedItems.filter(i => i.name);
    if (!notInvolved && !validCert.length && !validUncert.length) { toast('请至少填写一项已认定或未认定项目，或勾选「不涉及加分」', 'err'); return; }
    const fd = new FormData();
    const payload = {
      phone,
      notInvolved,
      notes: document.getElementById('a-notes')?.value.trim().slice(0, 500) || '',
      certifiedItems: validCert.map(i => ({ code: i.code, level: i.level, points: i.points })),
      uncertifiedItems: validUncert.map(i => ({ type: i.type, name: i.name, level: i.level, date: i.date, unit: i.unit, points: i.points })),
      certifiedProofs: validCert.map(i => ({ code: i.code, content: i.name + i.level, fileName: i.proofFile.name })),
      uncertifiedProofs: validUncert.map(i => ({ name: i.name, platform: i.level || i.unit, fileName: i.proofFile.name })),
    };
    fd.append('payload', JSON.stringify(payload));
    validCert.forEach((i, idx) => fd.append('files', i.proofFile, 'c' + idx + '_' + i.proofFile.name));
    validUncert.forEach((i, idx) => fd.append('files', i.proofFile, 'u' + idx + '_' + i.proofFile.name));
    try {
      const res = await API.uploadWithRetry('/api/applications', fd);
      if (res && res.softDeadline) toast(res.softDeadline);
      else toast(notInvolved ? '已声明不涉及加分，班长将审核' : '整份申请已提交，班长/年级将审核');
      App.goto('myApps');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 学生端：我的申请列表
  myApps: async () => {
    const { applications } = await API.get('/api/my/applications');
    if (!applications.length) return `<div class="card"><div class="empty">还没有提交过综测申请</div></div>`;
    // 拉取系统配置（仅用于判定申请退回是否过期）
    let cfg = null;
    try { cfg = await API.get('/api/config'); } catch (_) {}
    return applications.map(AppViews._appCard.bind(null, { editable: true, showLog: true, cfg })).join('');
  },

  _appCard: (opts, a) => {
    // 学生/班长端：未认定段级审核状态显示"已审核/未审核"；已认定段恢复为完整状态标签（2026-08-16 按用户要求恢复明细显示）
    const viewerRole = (typeof App !== 'undefined' && App.user) ? App.user.role : null;
    const restricted = viewerRole === 'student' || viewerRole === 'monitor';
    const sectionLabel = (s) => {
      if (!s) return '';
      const m = FMT.status[s] || { text: s, cls: '' };
      if (restricted) {
        if (s === 'withdrawn') {
          // 已退回/自行撤回：与"已审核"明确区分，显示完整"已退回"标签
          return `<span class="tag ${m.cls || 'tag-resubmit'}">${m.text || '已退回'}</span>`;
        }
        const rev = (s === 'pending' || s === 'resubmit') ? '未审核' : '已审核';
        return `<span class="tag tag-reviewed">${rev}</span>`;
      }
      return `<span class="tag ${m.cls}">${m.text}</span>`;
    };
    const notInvolvedTag = a.notInvolved ? '<span class="tag tag-grade">📌 不涉及加分</span>' : '';
    // 已认定段：所有角色均显示完整状态标签（不匿名化）
    const certStatus = a.certifiedStatus ? `<span class="tag ${FMT.status[a.certifiedStatus]?.cls || ''}">已认定·${FMT.status[a.certifiedStatus]?.text || a.certifiedStatus}</span>` : '';
    // 未认定段：与已认定统一包在同一个 tag 里（段名·状态）；学生/班长端继续匿名化（已审核/未审核）
    const uncertStatus = a.uncertifiedStatus ? (() => {
      const s = a.uncertifiedStatus;
      let text, cls;
      if (restricted) {
        text = (s === 'pending' || s === 'resubmit') ? '未审核' : '已审核';
        cls = (s === 'pending' || s === 'resubmit') ? 'tag-pending' : 'tag-reviewed';
      } else {
        text = FMT.status[s]?.text || s;
        cls = FMT.status[s]?.cls || '';
      }
      return `<span class="tag ${cls}">未认定·${text}</span>`;
    })() : '';
    // 浮点精度：小计 toFixed(4)（用户确认：小数后 4 位四舍五入）
    const certTotal = Number(a.certifiedItems.reduce((s, i) => s + effPts(i), 0).toFixed(4));
    const uncertTotal = Number(a.uncertifiedItems.reduce((s, i) => s + effPts(i), 0).toFixed(4));
    // 按钮显示条件：段级可改「或」任一 item 处于 resubmit/rejected（混态时段级被 sectionStatus 归并为 pending，但 item 仍需补交，见 B'-16）
    const itemNeedsResubmit = (it) => it && ['resubmit', 'rejected'].includes(it.status);
    const hasResubmitItems = (a.certifiedItems || []).some(itemNeedsResubmit) || (a.uncertifiedItems || []).some(itemNeedsResubmit);
    // 整表作废（两段均 withdrawn）：旧表只读，不进入 resubmit 流程
    const wholeWithdrawn = a.certifiedStatus === 'withdrawn' && a.uncertifiedStatus === 'withdrawn';
    // editable：单段作废（情形2/3）仍可编辑对应段；整表作废不可编辑
    const editable = opts.editable && !wholeWithdrawn && (
      ['resubmit', 'rejected', 'withdrawn'].includes(a.certifiedStatus) ||
      ['resubmit', 'rejected', 'withdrawn'].includes(a.uncertifiedStatus) ||
      hasResubmitItems
    );
    // 学生视角：退回操作（按「班长/年级是否审核」区分四种情形）
    const REVIEWED = ['approved', 'rejected', 'overridden', 'resubmit'];
    const _rev = (s) => REVIEWED.includes(s);
    const _un = (s) => !s || s === 'pending';
    let actions = '';
    if (opts.editable) {
      // 2026-08-31：退回并入学生提交截止；admin 配置的 submitOpenClasses 例外班级不受限
      const _dlOpen = opts.cfg && (opts.cfg.submitOpenClasses || []).includes(a.className);
      const wdExpired = opts.cfg && opts.cfg.gradeDeadline && new Date(opts.cfg.gradeDeadline).getTime() < Date.now() && !_dlOpen;
      const certRev = _rev(a.certifiedStatus), gradeRev = _rev(a.uncertifiedStatus);
      const certUn = _un(a.certifiedStatus), gradeUn = _un(a.uncertifiedStatus);
      if (a.certifiedStatus === 'withdrawn' && a.uncertifiedStatus === 'withdrawn') {
        // 整表已作废（学生自行退回）：旧表只读，仅提供「重新提交申请」新建空白表（不复用旧表）
        actions += `<button class="btn btn-primary btn-sm" onclick="App.goto('submitApp')">📝 重新提交申请</button>`;
      } else if (certUn && gradeUn) {
        // 情形1：两端均未审核 → 自行退回整表重填，不需审批（上限2次）
        const allLeft = 2 - (a.withdrawAllCount || 0);
        if (wdExpired) {
          actions += `<button class="btn btn-ghost btn-sm" disabled title="已超过学生提交截止时间（${FMT.time(opts.cfg.gradeDeadline)}）">↩ 退回重填（已过截止时间）</button>`;
        } else if (allLeft <= 0) {
          actions += `<button class="btn btn-ghost btn-sm" disabled title="整表退回次数已用完（上限2次）">↩ 退回重填（次数已用尽）</button>`;
        } else {
          actions += `<button class="btn btn-ghost btn-sm" onclick="AppViews.withdrawAll('${a.id}')">↩ 退回并重新填写（剩余${allLeft}次）</button>`;
        }
      } else if (certRev && gradeUn) {
        // 情形2：已认定已审核、未认定未审核 → 申请退已认定，需班长同意（上限1次）
        const certLeft = 1 - (a.withdrawCertCount || 0);
        if (a.withdrawRequest && a.withdrawRequest.status === 'pending') {
          actions += `<span class="tag tag-obj">退回申请待班长同意</span>`;
        } else if (wdExpired) {
          actions += `<button class="btn btn-ghost btn-sm" disabled title="已超过学生提交截止时间（${FMT.time(opts.cfg.gradeDeadline)}）">↩ 申请退回已认定（已过截止时间）</button>`;
        } else if (certLeft <= 0) {
          actions += `<button class="btn btn-ghost btn-sm" disabled title="已认定退回次数已用完（上限1次）">↩ 申请退回已认定（次数已用尽）</button>`;
        } else {
          actions += `<button class="btn btn-ghost btn-sm" onclick="AppViews.withdrawCert('${a.id}')">↩ 申请退回已认定项目（剩余${certLeft}次）</button>`;
        }
      } else if (certUn && gradeRev) {
        // 情形3：已认定未审核、未认定已审核 → 申请退未认定，需年级/管理员同意（上限2次）
        const uncertLeft = 2 - (a.withdrawUncertCount || 0);
        if (a.withdrawRequestUncert && a.withdrawRequestUncert.status === 'pending') {
          actions += `<span class="tag tag-obj">退回申请待年级同意</span>`;
        } else if (wdExpired) {
          actions += `<button class="btn btn-ghost btn-sm" disabled title="已超过学生提交截止时间（${FMT.time(opts.cfg.gradeDeadline)}）">↩ 申请退回未认定（已过截止时间）</button>`;
        } else if (uncertLeft <= 0) {
          actions += `<button class="btn btn-ghost btn-sm" disabled title="未认定退回次数已用完（上限2次）">↩ 申请退回未认定（次数已用尽）</button>`;
        } else {
          actions += `<button class="btn btn-ghost btn-sm" onclick="AppViews.withdrawUncert('${a.id}')">↩ 申请退回未认定项目（剩余${uncertLeft}次）</button>`;
        }
      }
      // 情形4：两端均已审核 → 学生端不显示退回入口
    }
    if (editable) {
      // 决定"修改并重新提交"按钮的分支：学生申请退后被同意（情形2/3）→ 整段重写（可改/可删/可增）；
      // 其他段级可改（resubmit/rejected/item级）→ 走原补交逻辑（仅补交被要求的项）
      const wrCert = a.withdrawRequest && a.withdrawRequest.status === 'approved' && a.withdrawRequest.part === 'certified' && a.certifiedStatus === 'withdrawn';
      const wrUncert = a.withdrawRequestUncert && a.withdrawRequestUncert.status === 'approved' && a.withdrawRequestUncert.part === 'uncertified' && a.uncertifiedStatus === 'withdrawn';
      let resubmitClick;
      let resubmitText;
      if (wrCert) { resubmitClick = `AppViews.resubmitRewrite('${a.id}','certified')`; resubmitText = '✏️ 修改/重写已认定项目'; }
      else if (wrUncert) { resubmitClick = `AppViews.resubmitRewrite('${a.id}','uncertified')`; resubmitText = '✏️ 修改/重写未认定项目'; }
      else { resubmitClick = `AppViews.resubmit('${a.id}')`; resubmitText = '✏️ 修改并重新提交'; }
      actions += `<button class="btn btn-warning btn-sm" onclick="${resubmitClick}">${resubmitText}</button>`;
    }
    return `<div class="sub-card">
      <div class="sub-card-head"><span class="sub-title">综测申请</span>${notInvolvedTag}${certStatus}${uncertStatus}</div>
      <div class="sub-meta">
        <span>姓名：${FMT.esc(a.studentName)}</span>
        <span>学号：${FMT.esc(a.studentIdNo)}</span>
        <span>班级：${FMT.esc(a.className)}</span>
        ${a.phone ? `<span>电话：${FMT.esc(a.phone)}</span>` : ''}
        <span>提交：${FMT.time(a.createdAt)}</span>
      </div>
      ${a.notes ? `<div class="sub-desc" style="background:var(--gray-bg);padding:8px 12px;border-radius:6px;margin:6px 0">📝 <b>学生备注：</b>${FMT.esc(a.notes)}</div>` : ''}
      <div class="sub-desc">
        ${a.notInvolved ? '📌 <b>本人声明不涉及综测加分项目</b>' : `📋 已认定项目 <b>${a.certifiedItems.length}</b> 项（小计 ${certTotal} 分）｜ 未认定项目 <b>${a.uncertifiedItems.length}</b> 项（小计 ${uncertTotal} 分）｜ 证明材料共 <b>${a.certifiedProofs.length + a.uncertifiedProofs.length}</b> 份`}
      </div>
      ${a.withdrawRequest && a.withdrawRequest.status !== 'pending' ? `<div class="sub-meta" style="color:var(--text-2)">↩ 已认定部分退回申请已${a.withdrawRequest.status === 'approved' ? '同意' : '驳回'}（${FMT.esc(a.withdrawRequest.replyBy)}${a.withdrawRequest.replyComment ? '：' + FMT.esc(a.withdrawRequest.replyComment) : ''}）</div>` : ''}
      ${a.withdrawRequestUncert && a.withdrawRequestUncert.status !== 'pending' ? `<div class="sub-meta" style="color:var(--text-2)">↩ 未认定部分退回申请已${a.withdrawRequestUncert.status === 'approved' ? '同意' : '驳回'}（${FMT.esc(a.withdrawRequestUncert.replyBy)}${a.withdrawRequestUncert.replyComment ? '：' + FMT.esc(a.withdrawRequestUncert.replyComment) : ''}）</div>` : ''}
      <div class="row">
        <button class="btn btn-ghost btn-sm" onclick="AppViews.viewDetail('${a.id}')">📖 查看详情</button>
        ${actions}
      </div>
      ${opts.showLog ? (AppViews._appLog(a)) : ''}
    </div>`;
  },

  _appLog: (a, opts = {}) => {
    // 学生 / 班长端：隐藏年级评判记录，仅显示"年级未处理/已处理"的简明状态，不暴露处理时间与处理人
    const viewerRole = (typeof App !== 'undefined' && App.user) ? App.user.role : null;
    const hideGrade = opts.hideGrade !== undefined
      ? opts.hideGrade
      : (viewerRole === 'student' || viewerRole === 'monitor');
    const all = [...(a.certifiedLog || []).map(l => ({ ...l, part: '已认定' })), ...(a.uncertifiedLog || []).map(l => ({ ...l, part: '未认定' }))].sort((x, y) => (y.time || '').localeCompare(x.time || ''));
    // 是否存在年级评判（用于"年级未处理/已处理"汇总）
    const hasGrade = (logs) => (logs || []).some(l => l.byRole === 'grade' || l.byRole === 'admin');
    const certHasGrade = hasGrade(a.certifiedLog) || !!a.certifiedOverride;
    const uncHasGrade = hasGrade(a.uncertifiedLog);
    // 过滤掉年级记录
    const filtered = hideGrade ? all.filter(l => l.byRole !== 'grade' && l.byRole !== 'admin') : all;
    // 学生/班长端：在时间线顶部增加简化的"年级未处理/已处理"汇总块
    let summaryHtml = '';
    if (hideGrade) {
      const rows = [];
      // 已认定部分：本身由班长审核，年级只对个别改判。"未处理"是默认常态，对学生无信息量还会误导，故不显示；
      // 仅在年级改判过（certHasGrade=true）时显示"年级已处理"提示。
      if (certHasGrade) rows.push({ part: '已认定', touched: true });
      if (a.uncertifiedItems && a.uncertifiedItems.length) rows.push({ part: '未认定', touched: uncHasGrade });
      if (rows.length) {
        summaryHtml = `<div class="tl-grade-summary" style="background:var(--gray-bg);border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:12.5px">` +
          rows.map(r => `<div style="margin:2px 0"><b>[${r.part}部分]</b> 年级${r.touched ? '<span class="tag tag-obj" style="margin-left:4px">已处理</span>' : '<span class="tag tag-resubmit" style="margin-left:4px">未处理</span>'}</div>`).join('') +
          `</div>`;
      }
    }
    const logHtml = filtered.slice(0, 6).map(l => `<div class="timeline-item"><span class="tl-action">[${l.part}] ${FMT.actionText[l.action] || l.action}</span><span class="tl-time">${FMT.esc(l.byName)} · ${FMT.time(l.time)}</span>${l.comment ? `<div class="tl-comment">${FMT.esc(l.comment)}</div>` : ''}</div>`).join('');
    return '<div class="timeline mt8">' + summaryHtml + logHtml + '</div>';
  },

  viewDetail: async (id) => {
    const { application: a } = await API.get('/api/applications/' + id);
    openModal(AppViews._appDetailHtml(a, true));
  },

  // 2026-09-10：bodyOnly=true 时仅返回 modal-body 内部内容（不含 modal-head / modal 包裹），
  //   供「复核审核界面 → 查看该生综测申请」把多份申请合并渲染进同一个弹窗
  _appDetailHtml: (a, inModal = false, bodyOnly = false) => {
    // 学生 / 班长端：① 已认定段恢复为完整明细表格与完整状态标签（2026-08-16 按用户要求恢复，不再隐藏）；② 未认定段 item 审核结论仍显示"已审核/未审核"；③ 年级改判评论仅年级/管理员可见（hideGradeRecord）
    const viewerRole = (typeof App !== 'undefined' && App.user) ? App.user.role : null;
    const hideGradeRecord = viewerRole === 'student' || viewerRole === 'monitor';
    const sectionLabel = (s) => {
      if (!s) return '';
      if (hideGradeRecord) {
        if (s === 'withdrawn') {
          // 已退回/自行撤回：与"已审核"明确区分，显示完整"已退回"标签
          const wm = FMT.status.withdrawn || { text: '已退回', cls: 'tag-resubmit' };
          return `<span class="tag ${wm.cls}">${wm.text}</span>`;
        }
        const rev = (s === 'pending' || s === 'resubmit') ? '未审核' : '已审核';
        return `<span class="tag tag-reviewed">${rev}</span>`;
      }
      const m = FMT.status[s] || { text: s, cls: '' };
      return `<span class="tag ${m.cls}">${m.text}</span>`;
    };
    // item 行的"审核结论"列：学生/班长端只显示"已审核/未审核"；年级/管理员端保留原文（✓通过 / ✕驳回 / ⚠待补交 / ✎改分）
    const itemReviewLabel = (s) => {
      if (!s) return '';
      if (hideGradeRecord) {
        if (s === 'withdrawn') {
          // 已退回（学生/班长端 item 行）：与"已审核"明确区分，显示完整"已退回"
          const wm = FMT.status.withdrawn || { text: '已退回', cls: 'tag-resubmit' };
          return `<span class="tag ${wm.cls}">${wm.text}</span>`;
        }
        const rev = (s === 'pending' || s === 'resubmit') ? '未审核' : '已审核';
        return `<span class="tag tag-reviewed">${rev}</span>`;
      }
      const m = { pending: '待审', approved: '✓通过', rejected: '✕驳回', resubmit: '⚠待补交', overridden: '✎改分', withdrawn: '↩退回' };
      return `<span class="tag">${m[s] || s}</span>`;
    };
    const itemTag = (s) => { const m = { pending: '待审', approved: '✓通过', rejected: '✕驳回', resubmit: '⚠待补交', overridden: '✎改分', withdrawn: '↩退回' }; return m[s] || s; };
    const certItemsHtml = a.certifiedItems.map(it => { const eff = effPts(it); const changed = !hideGradeRecord && it.status === 'overridden' && it.pointsFinal != null && Number(it.pointsFinal) !== Number(it.points); const ptsOld = (Number(it.points) || 0).toFixed(4); return `<tr><td>${FMT.esc(it.project)}</td><td>${FMT.esc(it.code)}</td><td>${FMT.esc(it.content)}</td><td style="text-align:right;color:${eff < 0 ? 'var(--danger)' : 'var(--primary-dark)'};font-weight:600">${eff}${changed ? ` <span class="muted" style="font-size:11px;font-weight:400">（原 ${ptsOld}）</span>` : ''}</td><td>${it.status ? itemTag(it.status) : ''}${!hideGradeRecord && it.reviewComment ? `<div class="muted" style="font-size:11px">${FMT.esc(it.reviewComment)}</div>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted center">无</td></tr>';
    const uncertItemsHtml = a.uncertifiedItems.map(it => { const eff = effPts(it); const changed = !hideGradeRecord && it.status === 'overridden' && it.pointsFinal != null && Number(it.pointsFinal) !== Number(it.points); const ptsOld = (Number(it.points) || 0).toFixed(4); return `<tr><td>${FMT.esc(it.type)}</td><td>${FMT.esc(it.name)}</td><td>${FMT.esc(it.level)}</td><td>${FMT.esc(it.date)}</td><td>${FMT.esc(it.unit)}</td><td style="text-align:right;color:${eff < 0 ? 'var(--danger)' : 'var(--primary-dark)'};font-weight:600">${eff}${changed ? ` <span class="muted" style="font-size:11px;font-weight:400">（原 ${ptsOld}）</span>` : ''}</td><td>${it.status ? itemReviewLabel(it.status) : ''}${!hideGradeRecord && it.reviewComment ? `<div class="muted" style="font-size:11px">${FMT.esc(it.reviewComment)}</div>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="7" class="muted center">无</td></tr>';
    // 证明材料：从 certifiedItems 直接取 attachment（确保补交后能看到最新文件；
    // server.js 重提交时只更新 item.attachment，未更新 certifiedProofs）
    const certProofsHtml = a.certifiedItems.filter(it => it.attachment).map(it => `<div class="attach-chip">📎 编号${FMT.esc(it.code)}：${FMT.esc(it.content)} — <a href="javascript:void(0)" onclick="AppViews.previewFile('${FMT.esc(it.attachment.url)}','${FMT.esc(it.attachment.name)}')">${FMT.esc(it.attachment.name)}</a></div>`).join('') || '<div class="muted">无</div>';
    const uncertProofsHtml = a.uncertifiedItems.filter(it => it.attachment).map(it => `<div class="attach-chip">📎 ${FMT.esc(it.name || it.type)}（${FMT.esc(it.level || it.unit || '')}） — <a href="javascript:void(0)" onclick="AppViews.previewFile('${FMT.esc(it.attachment.url)}','${FMT.esc(it.attachment.name)}')">${FMT.esc(it.attachment.name)}</a></div>`).join('') || '<div class="muted">无</div>';
    // 已认定部分：所有角色均展示明细表格（2026-08-16 按用户要求，学生/班长端不再隐藏明细）
    // 浮点精度：小计 toFixed(4)
    const certTotal = Number(a.certifiedItems.reduce((s, i) => s + effPts(i), 0).toFixed(4));
    const certSectionHtml = `<h4 class="mt16" style="color:var(--primary-dark)">一、已认定项目</h4>
        <table class="tbl" style="font-size:12.5px"><thead><tr><th>所属项目</th><th>编号</th><th>内容</th><th style="text-align:right">加减分</th><th>审核结论</th></tr></thead><tbody>${certItemsHtml}</tbody></table>
        <h4 class="mt16">证明材料</h4>${certProofsHtml}`;
    // 2026-09-10：内容体先单独构造，便于 bodyOnly 复用（多份申请合并渲染时只取内容）
    const inner = `
        <div class="sub-meta">
          <span><b>${FMT.esc(a.studentName)}</b></span>
          <span>学号 ${FMT.esc(a.studentIdNo)}</span>
          <span>${FMT.esc(a.className)}</span>
          ${a.phone ? `<span>📞 ${FMT.esc(a.phone)}</span>` : ''}
          <span>提交：${FMT.time(a.createdAt)}</span>
        </div>
        ${a.notInvolved ? '<div class="mt8" style="background:var(--info-bg);padding:8px 12px;border-radius:6px;color:var(--info)">📌 <b>本人声明不涉及综测加分项目</b></div>' : ''}
        ${a.notes ? `<div class="mt8" style="background:var(--gray-bg);padding:10px 14px;border-radius:6px">📝 <b>学生备注：</b>${FMT.esc(a.notes)}</div>` : ''}
        ${a.certifiedStatus ? `<div class="mt8"><b>已认定部分状态：</b><span class="tag ${FMT.status[a.certifiedStatus]?.cls || ''}">${FMT.status[a.certifiedStatus]?.text || a.certifiedStatus}</span>${(a.certifiedOverride && !hideGradeRecord) ? `<span class="muted ml8">已被年级改判：${FMT.esc(a.certifiedOverride.comment)}</span>` : ''}</div>` : ''}
        ${a.uncertifiedStatus ? `<div class="mt8"><b>未认定部分状态：</b>${sectionLabel(a.uncertifiedStatus)}</div>` : ''}
        ${certSectionHtml}
        <h4 class="mt16" style="color:var(--primary-dark)">二、未认定项目及社会实践（媒体类）</h4>
        <table class="tbl" style="font-size:12.5px"><thead><tr><th>所属类型</th><th>名称</th><th>级别</th><th>时间</th><th>授予/报道单位</th><th style="text-align:right">加减分</th><th>审核结论</th></tr></thead><tbody>${uncertItemsHtml}</tbody></table>
        <h4 class="mt16">证明材料</h4>${uncertProofsHtml}
        <h4 class="mt16">审核日志</h4>${AppViews._appLog(a)}`;
    if (bodyOnly) return inner;
    let html = `<div class="modal-head"><h3>综测申请详情</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">${inner}
      </div>`;
    if (inModal) {
      // wrap in modal-friendly container
      html = `<div class="modal" style="width:760px;max-width:100%">${html}</div>`;
    }
    return html;
  },

  // 学生补交：仅渲染被要求补充（status==='resubmit'）或所在段可改的具体项目，其余项目保持原结论
  // 段级 filter（2026-08-16 B'-13 修复：段级=submitted 时只列 item.status='resubmit'，否则会把已 approved 项也列出）
  //   - withdrawn → 整段（学生整体撤回后重写）
  //   - 段级=rejected + item.status=rejected（整段驳回要重新交）
  //   - item.status='resubmit'（单独被要求补交）
  resubmit: async (id) => {
    const { application: a } = await API.get('/api/applications/' + id);
    // 整表已作废（学生自行退回）：拒绝编辑旧表，引导新建空白表
    if (a.certifiedStatus === 'withdrawn' && a.uncertifiedStatus === 'withdrawn') {
      toast('该申请已作废，不可修改，请点击「重新提交申请」新建申请表', 'err'); return;
    }
    const resubmitCert = a.certifiedItems.filter(it => {
      if (a.certifiedStatus === 'resubmit') return true;   // 段级改判为补交 → 全部已认定项可补交
      if (a.certifiedStatus === 'withdrawn') return true;
      if (it.status === 'resubmit') return true;
      if (a.certifiedStatus === 'rejected' && it.status === 'rejected') return true;
      return false;
    });
    const resubmitUncert = a.uncertifiedItems.filter(it => {
      if (a.uncertifiedStatus === 'resubmit') return true;  // 段级改判为补交 → 全部未认定项可补交
      if (a.uncertifiedStatus === 'withdrawn') return true;
      if (it.status === 'resubmit') return true;
      if (a.uncertifiedStatus === 'rejected' && it.status === 'rejected') return true;
      return false;
    });
    if (!resubmitCert.length && !resubmitUncert.length) { toast('当前没有需要补交/修改的项目', 'err'); return; }
    openModal(`<div class="modal-head"><h3>补交/修改申请（${FMT.esc(a.period || '')}）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted">仅补交被要求补充的项目（其余项目保持原审核结论）。可重新填写内容；如未重新上传证明材料，将保留原附件；每行必须已有证明材料（新上传或保留原附件）。</div>
        ${resubmitCert.length ? `<h4 style="color:var(--primary-dark)">已认定项目（需补交）</h4><div id="re-cert-items"></div>` : ''}
        ${resubmitUncert.length ? `<h4 style="color:var(--primary-dark);margin-top:14px">未认定项目（需补交）</h4><div id="re-uncert-items"></div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doResubmit('${a.id}')">提交补交</button></div>`);
    if (resubmitCert.length) {
      // 补交场景：确保目录缓存可用（选择式字段需要）
      try {
        const cc = await API.get('/api/cert-catalog');
        window.__certCat = cc.items || [];
        const dl = document.getElementById('cc-code-list');
        if (dl) dl.innerHTML = (cc.items || []).map(c => `<option value="${FMT.esc(c.code)}">${FMT.esc(c.code)} ${FMT.esc(c.name)}</option>`).join('');
      } catch (_) {}
      resubmitCert.forEach(it => {
        const row = AppViews._certRow().replace('cert-row', 'cert-row re-cert');
        document.getElementById('re-cert-items').insertAdjacentHTML('beforeend', row);
        const last = document.querySelectorAll('#re-cert-items .re-cert');
        const r = last[last.length - 1];
        r.dataset.id = it.id;
        if (it.attachment) { r.dataset.attachmentUrl = it.attachment.url || ''; r.dataset.attachmentName = it.attachment.name || ''; }
        // 选择式字段：回填序号 → 触发带出名称与等级
        r.querySelector('.cert-code').value = it.code || '';
        AppViews.certCodeInput(r.querySelector('.cert-code'));
        if (it.level) { r.querySelector('.cert-level').value = it.level; AppViews.certLevelChange(r.querySelector('.cert-level')); }
        if (it.points != null) r.querySelector('.cert-points').value = it.points;
        if (it.attachment) {
          r.querySelector('.row.mt8').insertAdjacentHTML('beforeend', `<span class="tag tag-obj" style="margin-left:6px">📎 已有附件：${FMT.esc(it.attachment.name)}（不重新上传则保留）</span>`);
        }
      });
    }
    if (resubmitUncert.length) {
      resubmitUncert.forEach(it => {
        const row = AppViews._uncertRow().replace('uncert-row', 'uncert-row re-uncert');
        document.getElementById('re-uncert-items').insertAdjacentHTML('beforeend', row);
        const last = document.querySelectorAll('#re-uncert-items .re-uncert');
        const r = last[last.length - 1];
        r.dataset.id = it.id;
        if (it.attachment) { r.dataset.attachmentUrl = it.attachment.url || ''; r.dataset.attachmentName = it.attachment.name || ''; }
        r.querySelector('.uncert-type').value = it.type;
        r.querySelector('.uncert-name').value = it.name || '';
        r.querySelector('.uncert-level').value = it.level || '';
        r.querySelector('.uncert-date').value = it.date || '';
        r.querySelector('.uncert-unit').value = it.unit || '';
        r.querySelector('.uncert-points').value = it.points;
        if (it.attachment) {
          r.querySelector('.row.mt8').insertAdjacentHTML('beforeend', `<span class="tag tag-obj" style="margin-left:6px">📎 已有附件：${FMT.esc(it.attachment.name)}（不重新上传则保留）</span>`);
        }
      });
    }
  },

  // 2026-09-07：提交防重复包装（同 doSubmit）
  doResubmit: async (id) => {
    if (AppViews._submitting) { toast('正在提交中，请勿重复点击…', 'warn'); return; }
    AppViews._submitting = true;
    setTimeout(() => { AppViews._submitting = false; }, 150000);
    try { await AppViews._doResubmitRaw(id); } catch (_) {}
    AppViews._submitting = false;
  },
  _doResubmitRaw: async (id) => {
    const fd = new FormData();
    const payload = {};
    if (document.getElementById('re-cert-items')) {
      const rows = [...document.querySelectorAll('#re-cert-items .re-cert')];
      const certItems = [];
      for (const row of rows) {
        const code = row.querySelector('.cert-code').value.trim();
        const level = row.querySelector('.cert-level').value;
        if (!code && !level) continue;
        const cat = (window.__certCat || []).find(c => c.code === code);
        if (!cat) { toast(`序号 ${code} 不在已认定项目目录中`, 'err'); return; }
        if (!level) { toast(`请为「${cat.name}」选择等级`, 'err'); return; }
        const lv = cat.levels.find(l => l.level === level);
        if (!lv) { toast(`项目「${cat.name}」不存在等级「${level}」`, 'err'); return; }
        if (lv.points != null) {
          // 目录固定分值：以后端校验为准，前端带出
          row.querySelector('.cert-points').value = lv.points;
        }
        const points = lv.points != null ? lv.points : (parseFloat(row.querySelector('.cert-points').value) || 0);
        if (lv.points == null) {
          if (!SELF_FILL_CODES.has(code)) { toast(`项目「${cat.name}」分值由评定小组给定，不支持学生自填`, 'err'); return; }
          if (!(points > 0 && points <= 2)) { toast(`项目「${cat.name}」该等级未定分值，请自填 0~2 之间的分值`, 'err'); return; }
        }
        const o = { id: row.dataset.id, code, level, points };
        const f = row.querySelector('.cert-proof-file').files[0];
        // 附件：优先新上传；否则保留原附件（dataset 由预填写入）；两者皆无 → 拦截
        if (f) { o.attachmentFileName = f.name; fd.append('files', f, 'c' + certItems.length + '_' + f.name); }
        else if (row.dataset.attachmentUrl && row.dataset.attachmentName) { o.attachmentUrl = row.dataset.attachmentUrl; o.attachmentName = row.dataset.attachmentName; }
        else { toast(`已认定项目「${cat.name}」必须上传证明材料附件（或保留原附件）`, 'err'); return; }
        certItems.push(o);
      }
      if (certItems.length) payload.certifiedItems = certItems;
    }
    if (document.getElementById('re-uncert-items')) {
      const rows = [...document.querySelectorAll('#re-uncert-items .re-uncert')];
      const uncertItems = [];
      for (const row of rows) {
        const name = row.querySelector('.uncert-name').value.trim();
        if (!name) continue;
        const o = { id: row.dataset.id, type: row.querySelector('.uncert-type').value, name, level: row.querySelector('.uncert-level').value.trim(), date: row.querySelector('.uncert-date').value.trim(), unit: row.querySelector('.uncert-unit').value.trim(), points: parseFloat(row.querySelector('.uncert-points').value) || 0 };
        const f = row.querySelector('.uncert-proof-file').files[0];
        if (f) { o.attachmentFileName = f.name; fd.append('files', f, 'u' + uncertItems.length + '_' + f.name); }
        else if (row.dataset.attachmentUrl && row.dataset.attachmentName) { o.attachmentUrl = row.dataset.attachmentUrl; o.attachmentName = row.dataset.attachmentName; }
        else { toast(`未认定项目「${name}」必须上传证明材料附件（或保留原附件）`, 'err'); return; }
        uncertItems.push(o);
      }
      if (uncertItems.length) payload.uncertifiedItems = uncertItems;
    }
    if (!payload.certifiedItems && !payload.uncertifiedItems) return toast('请至少填写一项需补交的内容', 'err');
    fd.append('payload', JSON.stringify(payload));
    try {
      const res = await API.uploadWithRetry(`/api/applications/${id}/resubmit`, fd);
      closeModal();
      if (res && res.softDeadline) toast(res.softDeadline);
      else toast('已重新提交');
      App.goto('myApps');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 情形2/3 同意后整段重写（可改/可删/可增），区别于补交（仅补交被要求的项）
  // part: 'certified' | 'uncertified'
  resubmitRewrite: async (id, part) => {
    const { application: a } = await API.get('/api/applications/' + id);
    // 安全校验：必须是"学生申请退后被同意"的状态才允许走整段重写
    const wrField = part === 'certified' ? 'withdrawRequest' : 'withdrawRequestUncert';
    const wr = a[wrField];
    const secStatus = part === 'certified' ? a.certifiedStatus : a.uncertifiedStatus;
    if (!(wr && wr.status === 'approved' && wr.part === part && secStatus === 'withdrawn')) {
      toast('该申请当前不符合「整段重写」条件', 'err'); return;
    }
    const items = part === 'certified' ? a.certifiedItems : a.uncertifiedItems;
    const partLabel = part === 'certified' ? '已认定' : '未认定';
    const containerId = part === 'certified' ? 're-cert-items' : 're-uncert-items';
    openModal(`<div class="modal-head"><h3>修改/重写${partLabel}项目</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted">班长/年级已同意您的退回申请，该段${partLabel}项目可<strong>修改/删除/新增</strong>。未在以下列表中保留的项目将被删除；新增项目请填写完整字段并上传证明材料；原有项目如未重新上传将保留原附件。提交后该段将重新进入待审。</div>
        <h4 style="color:var(--primary-dark);margin-top:14px">${partLabel}项目（共 <span id="rw-count">${items.length}</span> 项）</h4>
        <div id="${containerId}"></div>
        <button class="btn btn-ghost btn-sm mt8" onclick="${part === 'certified' ? 'AppViews.addCertItem()' : 'AppViews.addUncertItem()'}">+ 添加${partLabel}项目</button>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doResubmitRewrite('${a.id}','${part}')">提交重写</button></div>`);
    // 预填该段所有现有 item（保留原附件：dataset 记录 + 显示提示）
    // 先确保目录缓存可用（选择式字段需要）
    try {
      const cc = await API.get('/api/cert-catalog');
      window.__certCat = cc.items || [];
      const dl = document.getElementById('cc-code-list');
      if (dl) dl.innerHTML = (cc.items || []).map(c => `<option value="${FMT.esc(c.code)}">${FMT.esc(c.code)} ${FMT.esc(c.name)}</option>`).join('');
    } catch (_) {}
    items.forEach(it => {
      if (part === 'certified') {
        const row = AppViews._certRow().replace('cert-row', 'cert-row re-cert');
        document.getElementById('re-cert-items').insertAdjacentHTML('beforeend', row);
        const r = document.querySelectorAll('#re-cert-items .re-cert');
        const last = r[r.length - 1];
        last.dataset.id = it.id;
        if (it.attachment) { last.dataset.attachmentUrl = it.attachment.url || ''; last.dataset.attachmentName = it.attachment.name || ''; }
        // 选择式字段：回填序号 → 触发带出名称与等级
        last.querySelector('.cert-code').value = it.code || '';
        AppViews.certCodeInput(last.querySelector('.cert-code'));
        if (it.level) { last.querySelector('.cert-level').value = it.level; AppViews.certLevelChange(last.querySelector('.cert-level')); }
        if (it.points != null) last.querySelector('.cert-points').value = it.points;
        if (it.attachment) {
          last.querySelector('.row.mt8').insertAdjacentHTML('beforeend', `<span class="tag tag-obj" style="margin-left:6px">📎 已有附件：${FMT.esc(it.attachment.name)}（不重新上传则保留）</span>`);
        }
      } else {
        const row = AppViews._uncertRow().replace('uncert-row', 'uncert-row re-uncert');
        document.getElementById('re-uncert-items').insertAdjacentHTML('beforeend', row);
        const r = document.querySelectorAll('#re-uncert-items .re-uncert');
        const last = r[r.length - 1];
        last.dataset.id = it.id;
        if (it.attachment) { last.dataset.attachmentUrl = it.attachment.url || ''; last.dataset.attachmentName = it.attachment.name || ''; }
        last.querySelector('.uncert-type').value = it.type;
        last.querySelector('.uncert-name').value = it.name || '';
        last.querySelector('.uncert-level').value = it.level || '';
        last.querySelector('.uncert-date').value = it.date || '';
        last.querySelector('.uncert-unit').value = it.unit || '';
        last.querySelector('.uncert-points').value = it.points;
        if (it.attachment) {
          last.querySelector('.row.mt8').insertAdjacentHTML('beforeend', `<span class="tag tag-obj" style="margin-left:6px">📎 已有附件：${FMT.esc(it.attachment.name)}（不重新上传则保留）</span>`);
        }
      }
    });
  },

  // 2026-09-07：提交防重复包装（同 doSubmit）
  doResubmitRewrite: async (id, part) => {
    if (AppViews._submitting) { toast('正在提交中，请勿重复点击…', 'warn'); return; }
    AppViews._submitting = true;
    setTimeout(() => { AppViews._submitting = false; }, 150000);
    try { await AppViews._doResubmitRewriteRaw(id, part); } catch (_) {}
    AppViews._submitting = false;
  },
  _doResubmitRewriteRaw: async (id, part) => {
    const fd = new FormData();
    const payload = { rewrite: { part } };
    if (part === 'certified') {
      const rows = [...document.querySelectorAll('#re-cert-items .re-cert')];
      const certItems = [];
      for (const row of rows) {
        const code = row.querySelector('.cert-code').value.trim();
        const level = row.querySelector('.cert-level').value;
        if (!code && !level) continue;
        const cat = (window.__certCat || []).find(c => c.code === code);
        if (!cat) { toast(`序号 ${code} 不在已认定项目目录中`, 'err'); return; }
        if (!level) { toast(`请为「${cat.name}」选择等级`, 'err'); return; }
        const lv = cat.levels.find(l => l.level === level);
        if (!lv) { toast(`项目「${cat.name}」不存在等级「${level}」`, 'err'); return; }
        if (lv.points != null) row.querySelector('.cert-points').value = lv.points;
        const points = lv.points != null ? lv.points : (parseFloat(row.querySelector('.cert-points').value) || 0);
        if (lv.points == null) {
          if (!SELF_FILL_CODES.has(code)) { toast(`项目「${cat.name}」分值由评定小组给定，不支持学生自填`, 'err'); return; }
          if (!(points > 0 && points <= 2)) { toast(`项目「${cat.name}」该等级未定分值，请自填 0~2 之间的分值`, 'err'); return; }
        }
        const o = { code, level, points };
        const f = row.querySelector('.cert-proof-file').files[0];
        // 附件：优先新上传；否则保留原附件（dataset 由预填写入）；两者皆无 → 拦截
        if (f) { o.attachmentFileName = f.name; fd.append('files', f, 'c' + certItems.length + '_' + f.name); }
        else if (row.dataset.attachmentUrl && row.dataset.attachmentName) { o.attachmentUrl = row.dataset.attachmentUrl; o.attachmentName = row.dataset.attachmentName; }
        else { toast(`已认定项目「${cat.name}」必须上传证明材料附件（或保留原附件）`, 'err'); return; }
        certItems.push(o);
      }
      if (!certItems.length) return toast('请至少填写一项已认定项目', 'err');
      payload.certifiedItems = certItems;
    } else {
      const rows = [...document.querySelectorAll('#re-uncert-items .re-uncert')];
      const uncertItems = [];
      for (const row of rows) {
        const name = row.querySelector('.uncert-name').value.trim();
        if (!name) continue;
        const o = { type: row.querySelector('.uncert-type').value, name, level: row.querySelector('.uncert-level').value.trim(), date: row.querySelector('.uncert-date').value.trim(), unit: row.querySelector('.uncert-unit').value.trim(), points: parseFloat(row.querySelector('.uncert-points').value) || 0 };
        const f = row.querySelector('.uncert-proof-file').files[0];
        if (f) { o.attachmentFileName = f.name; fd.append('files', f, 'u' + uncertItems.length + '_' + f.name); }
        else if (row.dataset.attachmentUrl && row.dataset.attachmentName) { o.attachmentUrl = row.dataset.attachmentUrl; o.attachmentName = row.dataset.attachmentName; }
        else { toast(`未认定项目「${name}」必须上传证明材料附件（或保留原附件）`, 'err'); return; }
        uncertItems.push(o);
      }
      if (!uncertItems.length) return toast('请至少填写一项未认定项目', 'err');
      payload.uncertifiedItems = uncertItems;
    }
    fd.append('payload', JSON.stringify(payload));
    try {
      const res = await API.uploadWithRetry(`/api/applications/${id}/resubmit`, fd);
      closeModal();
      if (res && res.softDeadline) toast(res.softDeadline);
      else toast(`${part === 'certified' ? '已认定' : '未认定'}段已重写，已重新进入待审`);
      App.goto('myApps');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 班长端：审核申请（已认定部分）
  monitorAuditApp: async (mode = 'pending') => {
    const { applications } = await API.get('/api/applications?certStatus=all&uncertStatus=all');
    const pending = applications.filter(a => a.certifiedStatus === 'pending');
    const withdraws = applications.filter(a => a.withdrawRequest && a.withdrawRequest.status === 'pending');
    let list = [], badgeText = '';
    if (mode === 'pending') list = pending;
    else if (mode === 'withdraw') list = withdraws;
    else list = applications.filter(a => a.certifiedStatus !== 'pending' && a.certifiedStatus !== null);
    let h = `<div class="filter-bar">
        <button class="btn btn-sm ${mode === 'pending' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('monAuditApp','pending')">待审核已认定（${pending.length}）</button>
        <button class="btn btn-sm ${mode === 'withdraw' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('monAuditApp','withdraw')">退回申请（${withdraws.length}）</button>
        <button class="btn btn-sm ${mode === 'history' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('monAuditApp','history')">已审核记录</button>
      </div>`;
    if (!list.length) return h + `<div class="card"><div class="empty">${mode === 'pending' ? '暂无待审核申请 🎉' : mode === 'withdraw' ? '暂无退回申请 🎉' : '暂无审核记录'}</div></div>`;
    h += list.map(a => {
      const wr = a.withdrawRequest && a.withdrawRequest.status === 'pending';
      // 班长端：已认定段恢复为完整状态标签（2026-08-16 按用户要求恢复）
      return `<div class="sub-card">
      <div class="sub-card-head"><span class="sub-title">${FMT.esc(a.studentName)}（${FMT.esc(a.className)}）</span>
        ${a.certifiedStatus ? `<span class="tag ${FMT.status[a.certifiedStatus]?.cls || ''}">已认定·${FMT.status[a.certifiedStatus]?.text || a.certifiedStatus}</span>` : ''}
        ${wr ? '<span class="tag tag-obj">退回申请</span>' : ''}
      </div>
      <div class="sub-meta">
        <span>已认定项目 <b>${a.certifiedItems.length}</b> 项（小计 ${Number(a.certifiedItems.reduce((s,i)=>s+effPts(i),0).toFixed(4))} 分）</span>
        <span>证明材料 ${a.certifiedProofs.length} 份</span>
        <span>提交：${FMT.time(a.createdAt)}</span>
      </div>
      ${a.notInvolved ? '<div class="sub-desc" style="color:var(--info);font-weight:600">📌 本人声明不涉及综测加分项目</div>' : ''}
      ${a.notes ? `<div class="sub-desc" style="background:var(--gray-bg);padding:6px 10px;border-radius:6px">📝 <b>学生备注：</b>${FMT.esc(a.notes)}</div>` : ''}
      ${wr ? `<div class="sub-desc" style="color:var(--warning)">💬 学生退回理由：${FMT.esc(a.withdrawRequest.reason || '（未填写）')}（${FMT.time(a.withdrawRequest.time)}）</div>` : ''}
      <div class="sub-actions">
        <button class="btn btn-ghost btn-sm" onclick="AppViews.viewDetail('${a.id}')">📖 详情</button>
        ${wr ? `<button class="btn btn-success btn-sm" onclick="AppViews.handleWithdraw('${a.id}', true)">✓ 同意退回</button>
        <button class="btn btn-danger btn-sm" onclick="AppViews.handleWithdraw('${a.id}', false)">✕ 拒绝退回</button>` : ''}
        ${mode === 'pending' ? (a.notInvolved
          ? `<button class="btn btn-success btn-sm" onclick="AppViews.confirmNoItems('${a.id}')">✓ 确认不涉及加分</button>
             <button class="btn btn-ghost btn-sm" onclick="AppViews.forceWithdrawCert('${a.id}')">↩ 退回学生</button>`
          : `<button class="btn btn-success btn-sm" onclick="AppViews.doReviewApp('${a.id}')">📝 逐项审核</button>
             <button class="btn btn-ghost btn-sm" onclick="AppViews.forceWithdrawCert('${a.id}')">↩ 退回学生</button>`) : ''}
      </div>
      ${(a.certifiedOverride && (typeof App === 'undefined' || !App.user || App.user.role === 'grade' || App.user.role === 'admin')) ? `<div class="sub-meta" style="color:var(--danger)">⚠ 年级改判：${FMT.esc(a.certifiedOverride.comment)}（${FMT.esc(a.certifiedOverride.byName)} · ${FMT.time(a.certifiedOverride.time)}）</div>` : ''}
    </div>`;
    }).join('');
    return h;
  },

  // 2026-09-06 修复：班长/年级/管理员确认「不涉及加分」声明（notInvolved 无项目，不走逐项审核）
  confirmNoItems: async (id) => {
    let a;
    try { ({ application: a } = await API.get('/api/applications/' + id)); } catch (e) { return toast(e.message, 'err'); }
    openModal(`<div class="modal-head"><h3>确认「不涉及综测加分项目」</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">学生 <b>${FMT.esc(a.studentName)}</b>（${FMT.esc(a.className)}）声明本学期<b>不涉及任何综测加分项目</b>（无已认定/未认定申报，无需证明材料）。</div>
        <div class="muted" style="background:var(--gray-bg);padding:8px 12px;border-radius:6px">确认后该份申报即审核通过并归档；若该同学实为误勾选或需要补充材料，请选择「↩ 退回学生」。</div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-success" onclick="AppViews.doConfirmNoItems('${id}')">✓ 确认通过</button></div>`);
  },
  doConfirmNoItems: async (id) => {
    try {
      await API.post(`/api/applications/${id}/confirm-noitems`, {});
      closeModal(); toast('已确认通过（不涉及加分）'); App.goto('monAuditApp', 'pending');
    } catch (e) { toast(e.message, 'err'); }
  },

  doReviewApp: async (id) => {
    let a;
    try { ({ application: a } = await API.get('/api/applications/' + id)); } catch (e) { return toast(e.message, 'err'); }
    if (!a.certifiedItems || !a.certifiedItems.length) return toast('该申请无已认定项目', 'err');
    // 2026-08-16 B'-13 修复：只对 item.status === 'pending'/'resubmit' 的项生成可操作表单；
    // 已审项（approved/rejected/overridden/withdrawn）只读展示，避免被误改
    const ITEMS_TAG = { pending: '待审', approved: '✓通过', rejected: '✕驳回', resubmit: '⚠待补交', overridden: '✎改分', withdrawn: '↩退回' };
    const editableRow = (it, i) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><b>${i + 1}. ${FMT.esc(it.project || '')}</b> <span class="muted">${FMT.esc(it.content || '')}</span></div>
          <div>原分 <b>${(Number(it.points) || 0).toFixed(4)}</b></div>
        </div>
        <div style="margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <label><input type="radio" name="rc_${i}" value="approve" checked onchange="AppViews._togglePtsInput('rcp_${i}', this.value)"> 同意</label>
          <label><input type="radio" name="rc_${i}" value="reject" onchange="AppViews._togglePtsInput('rcp_${i}', this.value)"> 驳回</label>
          <label><input type="radio" name="rc_${i}" value="resubmit" onchange="AppViews._togglePtsInput('rcp_${i}', this.value)"> 补交</label>
          <label><input type="radio" name="rc_${i}" value="override" onchange="AppViews._togglePtsInput('rcp_${i}', this.value)"> 改分</label>
          <input id="rcp_${i}" type="number" step="0.5" placeholder="改分时填" value="${effPts(it)}" style="width:90px;padding:4px;display:none">
        </div>
        <textarea id="rcc_${i}" placeholder="该项意见/补交说明（选填）" style="width:100%;margin-top:6px"></textarea>
      </div>`;
    const lockedRow = (it, i) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px;background:var(--gray-bg);opacity:0.85">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><b>${i + 1}. ${FMT.esc(it.project || '')}</b> <span class="muted">${FMT.esc(it.content || '')}</span></div>
          <div>原分 <b>${(Number(it.points) || 0).toFixed(4)}</b></div>
        </div>
        <div style="margin-top:6px;color:var(--success)">
          🔒 已审核（不再操作）：<b>${ITEMS_TAG[it.status] || it.status}</b>
          ${it.reviewBy ? ` · ${FMT.esc(it.reviewBy)}` : ''}
          ${it.reviewComment ? ` · ${FMT.esc(it.reviewComment)}` : ''}
        </div>
      </div>`;
    const rows = a.certifiedItems.map((it, i) => {
      const canEdit = it.status === 'pending' || it.status === 'resubmit';
      return canEdit ? editableRow(it, i) : lockedRow(it, i);
    }).join('');
    const pendingCount = a.certifiedItems.filter(it => it.status === 'pending' || it.status === 'resubmit').length;
    openModal(`<div class="modal-head"><h3>审核已认定部分（逐项）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted">共 ${a.certifiedItems.length} 项，其中 ${pendingCount} 项可操作（其余为已审核项，仅展示，不可改）</div>
        ${rows}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.confirmReviewApp('${id}')">提交审核（${pendingCount} 项）</button></div>`);
  },

  confirmReviewApp: async (id) => {
    let a;
    try { ({ application: a } = await API.get('/api/applications/' + id)); } catch (e) { return toast(e.message, 'err'); }
    // 只对可操作的 item（pending/resubmit）收集，忽略已审项（后端也有同样防御）
    const items = a.certifiedItems.map((it, i) => {
      if (it.status !== 'pending' && it.status !== 'resubmit') return null;
      const sel = document.querySelector('input[name="rc_' + i + '"]:checked');
      const action = sel ? sel.value : 'approve';
      const o = { id: it.id, action };
      if (action === 'override') o.points = parseFloat(document.getElementById('rcp_' + i).value) || 0;
      const c = (document.getElementById('rcc_' + i).value || '').trim();
      if (c) o.comment = c;
      return o;
    }).filter(Boolean);
    if (!items.length) return toast('无可操作项', 'err');
    try {
      await API.post(`/api/applications/${id}/review-certified`, { items });
      closeModal(); toast('已审核'); App.goto('monAuditApp', 'pending');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 审核弹窗 radio「改分」联动：仅选中 override 时显示分值输入框（已认定 rcp_ / 未认定 rup_ 共用）
  _togglePtsInput(id, radioVal) {
    const el = document.getElementById(id);
    if (el) el.style.display = radioVal === 'override' ? 'inline-block' : 'none';
  },

  // 通用分页控件（total ≤ 1 页时隐藏；navFn 为点击页码调用的函数名，如 'AppViews._goXxxPage'）
  __pagerHtml(total, page, totalPages, navFn) {
    if (!totalPages || totalPages <= 1) return '';
    const btn = (p, label, active) => `<button class="btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}" onclick="${navFn}(${p})">${label}</button>`;
    const dis = (label) => `<button class="btn btn-sm btn-ghost" disabled style="opacity:.4">${label}</button>`;
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - page) <= 2) pages.push(i);
    }
    let nums = '', last = 0;
    for (const p of pages) {
      if (last && p - last > 1) nums += '<span class="muted" style="margin:0 4px">…</span>';
      nums += btn(p, p, p === page);
      last = p;
    }
    const prev = page > 1 ? btn(page - 1, '上一页') : dis('上一页');
    const next = page < totalPages ? btn(page + 1, '下一页') : dis('下一页');
    return `<div class="pager-bar" style="display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
      <span class="muted" style="margin-right:auto">共 ${total} 条 · 第 ${page}/${totalPages} 页</span>${prev}${nums}${next}
    </div>`;
  },

  // 年级端：审核申请（未认定部分）+ 改判已认定 —— 服务端过滤 + 分页
  gradeAuditUncertApp: async (mode = 'pending', page = 1) => {
    AppViews._uncertMode = mode;
    AppViews._uncertPage = page;
    let majorMap = {};
    try { const cm = await API.get('/api/class-majors'); majorMap = cm.classMajors || {}; } catch (_) {}
    AppViews._uncertMajorMap = majorMap;
    const f = AppViews._uncertReadFilters();
    const params = { certStatus: 'all', uncertStatus: mode === 'pending' ? 'pending' : 'history', page, pageSize: 50 };
    if (f.q) params.q = f.q;
    if (f.major) params.major = f.major;
    if (f.cls) params.className = f.cls;
    const res = await API.get('/api/applications?' + new URLSearchParams(params));
    const applications = res.applications || res.data || [];
    const classes = res.classes || [];
    const counts = res.uncertCounts || { pending: 0, history: 0 };
    const majors = [...new Set(classes.map(c => (majorMap[c] || '').trim()).filter(Boolean))].sort();
    const majorOpts = ['<option value="">全部专业</option>'].concat(majors.map(m => `<option value="${FMT.esc(m)}" ${f.major === m ? 'selected' : ''}>${FMT.esc(m)}</option>`)).join('');
    const classOpts = ['<option value="">全部班级</option>'].concat(classes.map(c => `<option value="${FMT.esc(c)}" ${f.cls === c ? 'selected' : ''}>${FMT.esc(c)}</option>`)).join('');
    const wcount = applications.filter(a => a.withdrawRequestUncert && a.withdrawRequestUncert.status === 'pending').length;
    let h = `<div class="filter-bar">
        <button class="btn btn-sm ${mode === 'pending' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeAuditApp','pending')">待审核未认定（${counts.pending}）</button>
        <button class="btn btn-sm ${mode === 'history' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeAuditApp','history')">已审核记录（${counts.history}）</button>
        <button class="btn btn-sm ${mode === 'withdraw' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeAuditApp','withdraw')">退回申请（${wcount}）</button>
      </div>`;
    h += `<div class="query-bar">
        🔍 <b>查询：</b>
        <input id="uc-search" class="uc-input" placeholder="姓名 / 学号" value="${FMT.esc(f.q)}" oninput="AppViews._filterUncert()">
        <select id="uc-major" class="uc-sel" onchange="AppViews._filterUncert()">${majorOpts}</select>
        <select id="uc-class" class="uc-sel" onchange="AppViews._filterUncert()">${classOpts}</select>
        <button class="btn btn-sm btn-primary" onclick="AppViews._filterUncert()">查询</button>
        <button class="btn btn-sm" onclick="AppViews._resetUncert()">重置</button>
      </div>`;
    h += `<div id="uc-list">${AppViews._renderUncertList(applications, mode)}</div>`;
    h += `<div id="uc-pager">${AppViews.__pagerHtml(res.total, page, res.totalPages, 'AppViews._goUncertPage')}</div>`;
    return h;
  },
  // 2026-09-09：筛选状态缓存——审批/整页 goto 重渲染会先清空 DOM，此时元素不存在须回读缓存，避免筛选丢失
  _uncertReadFilters() {
    const qEl = document.getElementById('uc-search');
    const mEl = document.getElementById('uc-major');
    const cEl = document.getElementById('uc-class');
    if (qEl) AppViews.__uncertFilters = {
      q: qEl.value.trim(),
      major: mEl?.value?.trim() || '',
      cls: cEl?.value?.trim() || '',
    };
    return { q: '', major: '', cls: '', ...(AppViews.__uncertFilters || {}) };
  },
  _goUncertPage: async (page) => {
    AppViews._uncertPage = page;
    const mode = AppViews._uncertMode;
    const f = AppViews._uncertReadFilters();
    const params = { certStatus: 'all', uncertStatus: mode === 'pending' ? 'pending' : 'history', page, pageSize: 50 };
    if (f.q) params.q = f.q;
    if (f.major) params.major = f.major;
    if (f.cls) params.className = f.cls;
    const res = await API.get('/api/applications?' + new URLSearchParams(params));
    const box = document.getElementById('uc-list');
    const pg = document.getElementById('uc-pager');
    if (box) box.innerHTML = AppViews._renderUncertList(res.applications || res.data || [], mode);
    if (pg) pg.innerHTML = AppViews.__pagerHtml(res.total, page, res.totalPages, 'AppViews._goUncertPage');
  },
  _renderUncertList: (apps, mode) => {
    if (mode === 'withdraw') {
      const list = apps.filter(a => a.withdrawRequestUncert && a.withdrawRequestUncert.status === 'pending');
      if (!list.length) return `<div class="card"><div class="empty">暂无退回申请 🎉</div></div>`;
      return list.map(a => `<div class="sub-card">
        <div class="sub-card-head"><span class="sub-title">${FMT.esc(a.studentName)}（${FMT.esc(a.className)}）</span>
          ${a.uncertifiedStatus ? `<span class="tag ${FMT.status[a.uncertifiedStatus]?.cls || ''}">未认定·${FMT.status[a.uncertifiedStatus]?.text || a.uncertifiedStatus}</span>` : ''}
          <span class="tag tag-obj">退回申请</span></div>
        <div class="sub-desc">${a.notInvolved ? '已认定/未认定部分均无内容' : `未认定项目 ${a.uncertifiedItems.length} 项`}</div>
        <div class="sub-desc" style="color:var(--warning)">💬 学生退回理由：${FMT.esc((a.withdrawRequestUncert.reason) || '（未填写）')}（${FMT.time(a.withdrawRequestUncert.time)}）</div>
        <button class="btn btn-ghost btn-sm" onclick="AppViews.viewDetail('${a.id}')">📖 详情</button>
        <button class="btn btn-success btn-sm" onclick="AppViews.handleWithdrawUncert('${a.id}', true)">✓ 同意退回</button>
        <button class="btn btn-danger btn-sm" onclick="AppViews.handleWithdrawUncert('${a.id}', false)">✕ 拒绝退回</button>
      </div>`).join('');
    }
    const list = mode === 'pending' ? apps.filter(a => a.uncertifiedStatus === 'pending') : apps.filter(a => a.uncertifiedStatus !== 'pending' && a.uncertifiedStatus !== null);
    if (!list.length) return `<div class="card"><div class="empty">${mode === 'pending' ? '暂无待审核未认定项目 🎉' : '暂无审核记录'}</div></div>`;
    return list.map(a => `<div class="sub-card">
      <div class="sub-card-head"><span class="sub-title">${FMT.esc(a.studentName)}（${FMT.esc(a.className)}）</span>
        ${a.notInvolved ? '<span class="tag tag-grade">不涉及加分</span>' : ''}
        ${a.uncertifiedStatus ? `<span class="tag ${FMT.status[a.uncertifiedStatus]?.cls || ''}">未认定·${FMT.status[a.uncertifiedStatus]?.text || a.uncertifiedStatus}</span>` : ''}
      </div>
      <div class="sub-desc">${a.notInvolved ? '已认定/未认定部分均无内容' : `未认定项目 ${a.uncertifiedItems.length} 项（小计 ${Number(a.uncertifiedItems.reduce((s, i) => s + effPts(i), 0).toFixed(4))} 分）｜ 证明材料 ${a.uncertifiedProofs.length} 份`}</div>
      <button class="btn btn-ghost btn-sm" onclick="AppViews.viewDetail('${a.id}')">📖 详情</button>
      ${mode === 'pending' ? `<button class="btn btn-success btn-sm" onclick="AppViews.doReviewUncert('${a.id}')">📝 逐项审核</button>${!a.notInvolved ? `<button class="btn btn-ghost btn-sm" onclick="AppViews.forceWithdrawUncert('${a.id}')">↩ 退回学生</button>` : ''}` : ''}
    </div>`).join('');
  },
  _filterUncert: () => {
    clearTimeout(AppViews.__uncertTimer);
    AppViews.__uncertTimer = setTimeout(() => AppViews._goUncertPage(1), 300);
  },
  _resetUncert: () => {
    for (const id of ['uc-search', 'uc-major', 'uc-class']) { const e = document.getElementById(id); if (e) e.value = ''; }
    AppViews.__uncertFilters = { q: '', major: '', cls: '' };
    AppViews._goUncertPage(1);
  },

  doReviewUncert: async (id) => {
    let a;
    try { ({ application: a } = await API.get('/api/applications/' + id)); } catch (e) { return toast(e.message, 'err'); }
    if (!a.uncertifiedItems || !a.uncertifiedItems.length) return toast('该申请无未认定项目', 'err');
    const UNCERT_CATS = ['文明卫生', '社会服务', '集体活动', '创新能力及劳动素质', '社会实践报告'];
    const catOptions = (cur) => UNCERT_CATS.map(c => `<option value="${c}" ${cur === c ? 'selected' : ''}>${c}</option>`).join('');
    const ITEMS_TAG = { pending: '待审', approved: '✓通过', rejected: '✕驳回', resubmit: '⚠待补交', overridden: '✎改分', withdrawn: '↩退回' };
    // 2026-08-16 B'-13 修复：只对 item.status === 'pending'/'resubmit' 的项生成可操作表单；
    // 已审项（approved/rejected/overridden/withdrawn）只读展示，避免被误改
    const editableRow = (it, i) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><b>${i + 1}. ${FMT.esc(it.type || '')}</b> <span class="muted">原申报：${FMT.esc(it.name || '(未填名称)')}${it.level ? ` · 级别 ${FMT.esc(it.level)}` : ''}</span></div>
          <div>原分 <b>${(Number(it.points) || 0).toFixed(4)}</b></div>
        </div>
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <label style="font-size:13px;color:var(--text-2)">文字修正</label>
          <input id="run_${i}" type="text" value="${FMT.esc(it.name || '')}" placeholder="活动/竞赛名称（留空不改）" style="flex:2;min-width:150px;padding:5px">
          <input id="rul_${i}" type="text" value="${FMT.esc(it.level || '')}" placeholder="奖项/报道级别（如：省级）" style="flex:1;min-width:110px;padding:5px">
        </div>
        <div style="margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <label><input type="radio" name="ru_${i}" value="approve" checked onchange="AppViews._togglePtsInput('rup_${i}', this.value)"> 认定通过</label>
          <label><input type="radio" name="ru_${i}" value="reject" onchange="AppViews._togglePtsInput('rup_${i}', this.value)"> 驳回</label>
          <label><input type="radio" name="ru_${i}" value="resubmit" onchange="AppViews._togglePtsInput('rup_${i}', this.value)"> 补交</label>
          <label><input type="radio" name="ru_${i}" value="override" onchange="AppViews._togglePtsInput('rup_${i}', this.value)"> 改分</label>
          <input id="rup_${i}" type="number" step="0.5" placeholder="改分时填" value="${effPts(it)}" style="width:90px;padding:4px;display:none">
        </div>
        ${(() => {
          // 2026-09-09：媒体类不再锁定——渲染归类下拉，默认「社会实践报告」，可改为其它类目
          // 2026-09-09b：归类仅「认定通过/改分」时必选；驳回/补交不计分，无需归类（选择框仍保留可选手填）
          const defCat = it.type === '社会实践（媒体类）' ? (it.gradedCategory || '社会实践报告') : (it.gradedCategory || '');
          return `<div style="margin-top:6px;display:flex;gap:8px;align-items:center"><label style="font-size:13px">归类到：</label><select id="ruc_cat_${i}" style="padding:4px"><option value="">— 请选择 —</option>${catOptions(defCat)}</select><span class="muted" style="font-size:11px">通过/改分时必选；驳回/补交无需归类</span></div>`;
        })()}
        <textarea id="ruc_${i}" placeholder="该项意见/补交说明（选填）" style="width:100%;margin-top:6px"></textarea>
      </div>`;
    const lockedRow = (it, i) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px;background:var(--gray-bg);opacity:0.85">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><b>${i + 1}. ${FMT.esc(it.type || '')}</b> <span class="muted">${FMT.esc(it.name || '(未填名称)')}${it.level ? ` · 级别 ${FMT.esc(it.level)}` : ''}</span></div>
          <div>原分 <b>${(Number(it.points) || 0).toFixed(4)}</b></div>
        </div>
        <div style="margin-top:6px;color:var(--success)">
          🔒 已审核（不再操作）：<b>${ITEMS_TAG[it.status] || it.status}</b>
          ${it.gradedCategory ? ` · 归类：${FMT.esc(it.gradedCategory)}` : ''}
          ${it.reviewBy ? ` · ${FMT.esc(it.reviewBy)}` : ''}
          ${it.reviewComment ? ` · ${FMT.esc(it.reviewComment)}` : ''}
        </div>
      </div>`;
    const rows = a.uncertifiedItems.map((it, i) => {
      const canEdit = it.status === 'pending' || it.status === 'resubmit';
      return canEdit ? editableRow(it, i) : lockedRow(it, i);
    }).join('');
    const pendingCount = a.uncertifiedItems.filter(it => it.status === 'pending' || it.status === 'resubmit').length;
    openModal(`<div class="modal-head"><h3>审核未认定部分（逐项）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted">共 ${a.uncertifiedItems.length} 项，其中 ${pendingCount} 项可操作（其余为已审核项，仅展示，不可改）</div>
        ${rows}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.confirmReviewUncert('${id}')">提交审核（${pendingCount} 项）</button></div>`);
  },

  confirmReviewUncert: async (id) => {
    let a;
    try { ({ application: a } = await API.get('/api/applications/' + id)); } catch (e) { return toast(e.message, 'err'); }
    // 前端校验：仅「认定通过/改分」项必选归类（计分需归类）；驳回/补交不计分，不强制（2026-09-09b）
    for (let i = 0; i < a.uncertifiedItems.length; i++) {
      const it = a.uncertifiedItems[i];
      if (it.status !== 'pending' && it.status !== 'resubmit') continue;
      const sel0 = document.querySelector('input[name="ru_' + i + '"]:checked');
      const act0 = sel0 ? sel0.value : 'approve';
      if (act0 !== 'approve' && act0 !== 'override') continue;
      const cat = document.getElementById('ruc_cat_' + i)?.value;
      if (!cat) return toast(`第 ${i + 1} 项（${it.type || it.name || '未命名'}）选择认定通过/改分时必须选归类项`, 'err');
    }
    // 只对可操作的 item（pending/resubmit）收集，忽略已审项（后端也有同样防御）
    const items = a.uncertifiedItems.map((it, i) => {
      if (it.status !== 'pending' && it.status !== 'resubmit') return null;
      const sel = document.querySelector('input[name="ru_' + i + '"]:checked');
      const action = sel ? sel.value : 'approve';
      const o = { id: it.id, action };
      if (action === 'override') o.points = parseFloat(document.getElementById('rup_' + i).value) || 0;
      const c = (document.getElementById('ruc_' + i).value || '').trim();
      if (c) o.comment = c;
      // 2026-09-09：媒体类也允许改归类（默认社会实践报告，空则兜底由后端处理）
      // 2026-09-09b：归类仅在通过类动作（认定通过/改分）收集；驳回/补交不计分，不传 category
      if (action === 'approve' || action === 'override') {
        const cat = document.getElementById('ruc_cat_' + i)?.value;
        if (cat) o.category = cat;
        else if (it.type === '社会实践（媒体类）') o.category = '社会实践报告';
      }
      // 2026-09-06：文字修正（名称/级别）——仅当填写且与现值不同才提交，由后端落库并留痕
      const nm = (document.getElementById('run_' + i)?.value || '').trim();
      const lv = (document.getElementById('rul_' + i)?.value || '').trim();
      if (nm && nm !== (it.name || '').trim()) o.name = nm;
      if (lv && lv !== (it.level || '').trim()) o.level = lv;
      return o;
    }).filter(Boolean);
    if (!items.length) return toast('无可操作项', 'err');
    try {
      await API.post(`/api/applications/${id}/review-uncertified`, { items });
      closeModal(); toast('已审核'); App.goto('gradeAuditApp', 'pending');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 年级端：修改已通过/已审定申请（含已认定+未认定，需二级密码）
  gradeOverrideApp: async () => {
    const me = App.user || {};
    const qs = me.role === 'grade' ? '?certStatus=all&uncertStatus=all&includeMod=1' : '?certStatus=all&uncertStatus=all';
    const { applications } = await API.get('/api/applications' + qs);
    const done = applications.filter(a =>
      (a.certifiedStatus === null || a.certifiedStatus !== 'pending') &&
      (a.uncertifiedStatus === null || a.uncertifiedStatus !== 'pending'));
    if (!done.length) return `<div class="card"><div class="empty">暂无已审定（已通过）的综测申请可修改</div></div>`;
    return `<div class="card"><div class="card-title">修改已通过/已审定申请（需二级审核密码 + 修改原因）</div>
      <div class="sub-desc muted" style="margin-bottom:10px">对已审定完成的申请进行逐项修改（含分值与项目状态）。<b>已认定段</b>需为本班「已认定修改负责人」且在班级审批截止前（过截止仅系统管理员可改）；<b>未认定段</b>需为本班「未认定负责人」。每次修改须填写 ≥5 字原因（审计留痕）。</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>学生</th><th>班级</th><th>已认定状态</th><th>未认定状态</th><th>操作</th></tr></thead><tbody>
      ${done.map(a => {
        const my = a._my || { cert: me.role === 'admin', uncert: me.role === 'admin', gate: false };
        const canAny = !!(my.cert || my.uncert);
        const title = my.gate ? '已认定段已过班级审批截止（仅管理员可改已认定）' : '修改（二级密码 + ≥5 字原因）';
        const btn = canAny ? `<button class="btn btn-warning btn-sm" title="${title}" onclick="AppViews.gradeModifyApp('${a.id}')">✏ 修改</button>` : '';
        return `<tr><td>${FMT.esc(a.studentName)}</td><td>${FMT.esc(a.className)}</td>
        <td>${a.certifiedStatus ? `<span class="tag ${FMT.status[a.certifiedStatus]?.cls || ''}">${FMT.status[a.certifiedStatus]?.text || a.certifiedStatus}</span>` : '<span class="muted">无</span>'}</td>
        <td>${a.uncertifiedStatus ? `<span class="tag ${FMT.status[a.uncertifiedStatus]?.cls || ''}">${FMT.status[a.uncertifiedStatus]?.text || a.uncertifiedStatus}</span>` : '<span class="muted">无</span>'}</td>
        <td>${btn}<button class="btn btn-ghost btn-sm" onclick="AppViews.viewDetail('${a.id}')">详情</button></td></tr>`;
      }).join('')}
      </tbody></table></div></div>`;
  },

  // 年级逐项修改弹窗（二级密码 + 逐项 status/pointsFinal/comment）
  gradeModifyApp: async (id) => {
    let a;
    try { ({ application: a } = await API.get('/api/applications/' + id)); } catch (e) { return toast(e.message, 'err'); }
    const row = (kind, it, label) => {
      // 浮点精度：当前分 toFixed(4)
      const cur = (Number(it.pointsFinal ?? it.points ?? 0) || 0).toFixed(4);
      return `
      <div class="gm-row" data-id="${it.id}" data-kind="${kind}" style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><b>${FMT.esc(it.project || it.type || '')}</b> <span class="muted">${FMT.esc(it.content || it.name || '')}${it.level ? `（级别：${FMT.esc(it.level)}）` : ''}</span> <span class="tag tag-grade">${label}</span></div>
          <div>当前分 <b>${cur}</b></div>
        </div>
        <div style="margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <select class="gm-status">
            <option value="approved" ${it.status === 'approved' ? 'selected' : ''}>保留/通过</option>
            <option value="rejected" ${it.status === 'rejected' ? 'selected' : ''}>驳回</option>
            <option value="overridden" ${it.status === 'overridden' ? 'selected' : ''}>年级改判（覆盖分）</option>
          </select>
          <label>分值<input class="gm-points" type="number" step="0.5" value="${cur}" style="width:90px;padding:4px;margin-left:4px"></label>
        </div>
        ${kind === 'u' ? `<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <label style="font-size:13px;color:var(--text-2)">文字修正</label>
          <input class="gm-uname" type="text" value="${FMT.esc(it.name || '')}" placeholder="活动/竞赛名称（留空不改）" style="flex:2;min-width:150px;padding:5px">
          <input class="gm-ulevel" type="text" value="${FMT.esc(it.level || '')}" placeholder="奖项/报道级别（如：省级）" style="flex:1;min-width:110px;padding:5px">
          <span class="muted" style="font-size:11px">同步更新「加减分说明」</span>
        </div>` : ''}
        <textarea class="gm-comment" placeholder="修改说明（选填）" style="width:100%;margin-top:6px"></textarea>
      </div>`;
    };
    const certRows = (a.certifiedItems || []).map(it => row('c', it, '已认定')).join('');
    const uncRows = (a.uncertifiedItems || []).map(it => row('u', it, '未认定')).join('');
    // 2026-09-05：逐段权限（服务端 _my）；无权限的段整段隐藏并提示（不可越权修改）
    const my = a._my || { cert: (App.user.role === 'admin'), uncert: (App.user.role === 'admin'), gate: false };
    const certBlock = certRows
      ? (my.cert
          ? `<div class="sub-desc" style="font-weight:600;margin:6px 0">已认定部分</div>${certRows}`
          : `<div class="sub-desc muted" style="margin:8px 0">已认定部分：${my.gate ? '已过班级审批截止时间，仅系统管理员可修改' : '您不是该班的已认定修改负责人，仅可查看'}</div>`)
      : '';
    const uncBlock = uncRows
      ? (my.uncert
          ? `<div class="sub-desc" style="font-weight:600;margin:6px 0">未认定部分</div>${uncRows}`
          : `<div class="sub-desc muted" style="margin:8px 0">未认定部分：您不是该班的未认定审核负责人，仅可查看</div>`)
      : '';
    if (!my.cert && !my.uncert) {
      // 2026-09-06 修复：仅当 admin/年级对两段都无权时才拒绝（已认定修改负责人 ≠ 未认定负责人可能一边有权）；
      // 注意：两段都无项目（如 notInvolved 已通过申请）也会 certRows/uncRows 都空，但只要任一段有权限就放行，让弹窗体显示「该申请无具体项目」提示
      return toast('您对该申请的已认定/未认定部分均无修改权限', 'err');
    }
    openModal(`<div class="modal-head"><h3>修改已通过申请（二级密码验证）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>二级审核密码</label><input id="gm-pwd" type="password" placeholder="请输入您的二级审核密码" style="width:100%;padding:8px"></div>
        <div class="form-item"><label>修改原因（必填，至少 5 个字）</label><textarea id="gm-reason" placeholder="请说明本次修改的原因（用于审计留痕）" style="width:100%;padding:8px"></textarea></div>
        ${certBlock}
        ${uncBlock}
        ${!certRows && !uncRows ? '<div class="muted">该申请无具体项目</div>' : ''}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doGradeModify('${id}')">保存修改</button></div>`);
  },

  doGradeModify: async (id) => {
    const pwd = document.getElementById('gm-pwd').value;
    const reason = (document.getElementById('gm-reason').value || '').trim();
    if (!pwd) return toast('请输入二级审核密码', 'err');
    if (reason.length < 5) return toast('请填写修改原因（至少 5 个字）', 'err');
    const cert = [], unc = [];
    document.querySelectorAll('.gm-row').forEach(row => {
      const o = {
        id: row.dataset.id,
        status: row.querySelector('.gm-status').value,
        points: parseFloat(row.querySelector('.gm-points').value) || 0,
        comment: (row.querySelector('.gm-comment').value || '').trim(),
      };
      if (row.dataset.kind === 'u') {
        // 2026-09-06：未认定行文字修正（非空才提交，由后端比对落库）
        const nm = (row.querySelector('.gm-uname').value || '').trim();
        const lv = (row.querySelector('.gm-ulevel').value || '').trim();
        if (nm) o.name = nm;
        if (lv) o.level = lv;
        unc.push(o);
      } else {
        cert.push(o);
      }
    });
    try {
      await API.post(`/api/applications/${id}/grade-modify`, { secondaryPassword: pwd, reason, certifiedItems: cert, uncertifiedItems: unc });
      closeModal(); toast('已保存修改'); App.goto('gradeAllApp');
    } catch (e) { toast(e.message, 'err'); }
  },


  // 安全设置弹窗（admin topbar 🔒 按钮）：截屏限制开关 + 当前水印信息
  securitySettings: () => {
    const on = window.Sec && Sec.isPrivacyEnabled();
    const info = window.Sec ? Sec.buildText() : '';
    openModal(`<div class="modal-head"><h3>🔒 安全设置</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <label style="font-weight:600">截屏 / 打印限制</label>
          <select id="ss-privacy" onchange="AppViews.saveSecuritySettings()" style="padding:6px;border:1px solid var(--border);border-radius:6px">
            <option value="1" ${on ? 'selected' : ''}>开启（默认）</option>
            <option value="0" ${!on ? 'selected' : ''}>关闭</option>
          </select>
          <span class="muted" style="font-size:12px">关闭后本浏览器不再拦截右键/打印/复制快捷键（仅影响当前设备）</span>
        </div>
        <div class="muted" style="font-size:12px;background:var(--gray-bg);padding:10px 14px;border-radius:8px;line-height:1.8">💡 说明：页面上的<b>半透明倾斜文字</b>即明水印（含操作人/时间/IP），肉眼可核对；截屏限制仅拦截键盘/右键，无法阻止拍照。</div>
        <div class="sub-card mt8"><div class="card-title">当前水印信息（即页面明水印内容）</div>
          <div style="font-size:12px;line-height:1.9;overflow-wrap:break-word">${FMT.esc(info || '（未初始化）')}</div></div>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" onclick="closeModal()">完成</button></div>`);
  },
  saveSecuritySettings: () => {
    const v = document.getElementById('ss-privacy').value;
    Sec.setPrivacyEnabled(v === '1');
    toast(v === '1' ? '截屏限制已开启' : '截屏限制已关闭（当前浏览器）');
  },


  // ==================== 智育成绩计算（admin）====================
  zhiscoresPage: () => {
    return `<div class="card">
      <div class="card-title">🧮 智育成绩计算（整学年：大三上 + 大三下）</div>
      <div class="sub-desc muted" style="margin-bottom:12px">
        上传 <b>学生成绩表</b>（取"导出"sheet，<b>第一列须为学期</b>：2025-2026-1=大三上 / 2025-2026-2=大三下）与 <b>课程学分表</b>（须含<b>"大三上"+"大三下"</b>两行），系统自动：<br>
        ① 筛选 必修+正常 考核记录；② 按学期匹配必修课清单（跨学期同名课两学期都计入）；③ 解析总评成绩（数字直接/缓考跳过/旷考计0/等级换算）；④ 智育 = Σ(两学期成绩×学分)×0.68 ÷ Σ学分（整学年合并加权）。
      </div>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <div class="form-item" style="flex:1;min-width:220px"><label>学生成绩表（.xlsx）</label><input id="zs-score-file" type="file" accept=".xlsx" style="width:100%"></div>
        <div class="form-item" style="flex:1;min-width:220px"><label>课程学分表（.xlsx）</label><input id="zs-credit-file" type="file" accept=".xlsx" style="width:100%"></div>
        <button class="btn btn-primary" onclick="AppViews.zhiscoresCalc()">⚡ 开始计算</button>
      </div>
      <div id="zs-result"></div>
    </div>`;
  },

  zhiscoresCalc: async () => {
    const scoreFile = document.getElementById('zs-score-file').files[0];
    const creditFile = document.getElementById('zs-credit-file').files[0];
    if (!scoreFile || !creditFile) return toast('请先选择两份文件（成绩表 + 学分表）', 'err');
    const fd = new FormData();
    fd.append('files', scoreFile, 'scores.xlsx');
    fd.append('files', creditFile, 'credits.xlsx');
    const box = document.getElementById('zs-result');
    box.innerHTML = '<div class="empty">⏳ 计算中…（约数秒，请勿关闭页面）</div>';
    try {
      const data = await API.upload('/api/admin/zhiscores/calculate', fd);
      const rows = data.results || [];
      window.__zsRows = rows; // 供导出使用
      const profOrder = ['临床医学', '临床医学(5加3一体化)', '麻醉学', '医学检验技术', '医学影像技术', '医学影像学'];
      const profCnt = {};
      rows.forEach(r => { profCnt[r.专业] = (profCnt[r.专业] || 0) + 1; });
      const warns = data.warnings || [];
      const warnTypes = {
        缺课: warns.filter(w => w.问题 && w.问题.includes('无成绩记录')).length,
        缓考或空: warns.filter(w => w.问题 && w.问题.includes('无法解析')).length,
        其他: warns.filter(w => !(w.问题 && (w.问题.includes('无成绩记录') || w.问题.includes('无法解析')))).length,
      };
      const profHtml = Object.keys(profCnt).map(p => `<span class="tag tag-grade" style="margin:2px">${p} ${profCnt[p]}人</span>`).join('') || '<span class="muted">无</span>';
      box.innerHTML = `
        <div class="sub-card" style="margin-bottom:10px">
          <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
            <div><b>计算完成：共 ${rows.length} 名学生</b><br>
              <span class="muted">专业分布：</span>${profHtml}<br>
              <span class="muted">学分表学期：</span>${(data.学期 || []).map(t => t === '上' ? '大三上' : '大三下').join(' + ') || '未识别'}
            </div>
            <button class="btn btn-primary" onclick="AppViews.zhiscoresExport()">📤 导出 xlsx</button>
          </div>
          <div class="muted mt8">缺课(学分表必修无成绩) <b>${warnTypes.缺课}</b> 条 ｜ 缓考/空/无法解析 <b>${warnTypes.缓考或空 + warnTypes.其他}</b> 条（详见下方警告）</div>
        </div>
        <div class="table-wrap"><table class="tbl" style="font-size:12.5px"><thead><tr><th>#</th><th>专业</th><th>姓名</th><th>学号</th><th style="text-align:right">智育成绩</th><th>计算过程</th><th>缺课</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr>
          <td>${i + 1}</td><td>${FMT.esc(r.专业)}</td><td>${FMT.esc(r.姓名)}</td><td>${FMT.esc(r.学号)}</td>
          <td style="text-align:right;font-weight:600;color:var(--primary-dark)">${r.智育成绩 != null ? r.智育成绩 : ''}</td>
          <td style="font-size:11.5px;color:var(--text-2)">${FMT.esc(r.计算过程)}</td>
          <td>${(r.缺课 || []).length ? `<span class="tag tag-resubmit">${FMT.esc((r.缺课 || []).join('、'))}</span>` : ''}</td>
        </tr>`).join('')}
        </tbody></table></div>
        ${warns.length ? `<div class="sub-card mt8"><div class="card-title">⚠ 警告（${warns.length} 条）</div>
          <table class="tbl" style="font-size:12px"><thead><tr><th>学号</th><th>姓名</th><th>专业</th><th>课程</th><th>问题</th></tr></thead><tbody>
          ${warns.slice(0, 100).map(w => `<tr><td>${FMT.esc(w.学号 || '')}</td><td>${FMT.esc(w.姓名 || '')}</td><td>${FMT.esc(w.专业 || '')}</td><td>${FMT.esc(w.课程 || '')}</td><td>${FMT.esc(w.问题 || '')}</td></tr>`).join('')}
          </tbody></table>${warns.length > 100 ? `<div class="muted mt8">… 共 ${warns.length} 条，导出文件含完整列表</div>` : ''}</div>` : ''}`;
      toast(`计算完成：${rows.length} 名学生`);
    } catch (e) {
      box.innerHTML = `<div class="empty">❌ 计算失败：${FMT.esc(e.message)}</div>`;
      toast(e.message, 'err');
    }
  },

  zhiscoresExport: async () => {
    // 从当前结果表重新获取数据：简化 —— 调后端 export 前先把 rows 缓存到 window
    const rows = window.__zsRows || [];
    if (!rows.length) return toast('没有可导出的结果，请先计算', 'err');
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    try {
      const blob = await API.postBlob('/api/admin/zhiscores/export', { rows, secondaryPassword: pwd });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '智育成绩.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('已导出智育成绩.xlsx');
    } catch (e) { toast(e.message, 'err'); }
  },

  // ==================== 已认定项目目录管理（admin）====================
  // 2026-08-30：学生端"已认定项目"改为目录选择（序号→等级→自动带名称与分值）
  certCatalogPage: async () => {
    const { items } = await API.get('/api/admin/cert-catalog');
    window.__certCat = items || [];
    const PROJ_OPTIONS = ['文明卫生', '社会服务', '集体活动', '创新能力及劳动素质', '社会实践（不含媒体类）'];
    const byProj = {};
    (items || []).forEach(c => { byProj[c.project] = byProj[c.project] || []; byProj[c.project].push(c); });
    const catRows = Object.keys(byProj).map(proj => {
      const rows = byProj[proj].map(c => `<tr>
        <td>${c.enabled !== false ? '✅' : '⛔'}</td>
        <td><b>${FMT.esc(c.code)}</b></td>
        <td style="max-width:280px">${FMT.esc(c.name)}</td>
        <td>${c.levels.map(l => `${FMT.esc(l.level)}${l.points != null ? '·' + l.points : '·自填'}`).join('<br>')}</td>
        <td style="max-width:180px;font-size:11.5px;color:var(--text-2)">${FMT.esc(c.note || '')}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="AppViews.certCatEdit('${c.id}')">✏️ 编辑</button>
            <button class="btn btn-ghost btn-sm" onclick="AppViews.certCatToggle('${c.id}')">${c.enabled !== false ? '停用' : '启用'}</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="AppViews.certCatDel('${c.id}','${FMT.esc(c.name)}')">🗑 删除</button></td>
      </tr>`).join('');
      return `<div class="sub-card"><div class="card-title" style="font-size:14px">${FMT.esc(proj)}（${byProj[proj].length} 项）</div>
        <div class="table-wrap"><table class="tbl" style="font-size:12px"><thead><tr><th>启用</th><th>序号</th><th>名称</th><th>等级·分值</th><th>备注</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join('');
    return `<div class="card">
      <div class="card-title">📚 已认定项目目录（学生端选择依据）</div>
      <div class="sub-desc muted mb8">学生提交"已认定项目"时按此目录选择：输入序号→选等级→自动带出名称与分值。共 ${(items || []).length} 项。等级分值为空的表示"按评定小组评分"：仅 318/434/435 由学生自填（0~2分），其余学生端不可自填（由评定小组给定后录入）。</div>
      <div class="row mb8" style="gap:8px">
        <button class="btn btn-primary" onclick="AppViews.certCatEdit('')">＋ 新增条目</button>
      </div>
      ${catRows || '<div class="empty">目录为空</div>'}
    </div>`;
  },

  certCatEdit: (id) => {
    // 2026-08-31 加固：字面量 'undefined'/'null'（模板注入失败/数据异常）直接报错；
    // 空串 '' 是"新增条目"按钮的合法调用，不能拦截；有 id 但找不到条目也报错（防误入新增）
    if (id === 'undefined' || id === 'null') {
      toast('❌ 数据异常：该条目缺少唯一标识，请联系管理员', 'err');
      console.error('[certCatEdit] 收到无效 ID:', id);
      return;
    }
    const item = id ? (window.__certCat || []).find(c => c.id === id) : null;
    if (id && !item) { toast('未找到该目录条目（可能已删除），请刷新页面后重试', 'err'); return; }
    const PROJ_OPTIONS = ['文明卫生', '社会服务', '集体活动', '创新能力及劳动素质', '社会实践（不含媒体类）'];
    const lvRows = (item && item.levels.length ? item.levels : [{ level: '', points: null }]).map((l, i) => `
      <div class="row cc-lv" style="gap:6px;align-items:center;margin-bottom:4px">
        <input class="lv-level" placeholder="等级名（如：一等奖）" value="${FMT.esc(l.level)}" style="flex:2;min-width:140px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <input class="lv-points" type="number" step="0.05" placeholder="分值（空=仅318/434/435学生可填）" value="${l.points != null ? l.points : ''}" style="flex:1;min-width:110px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.cc-lv').remove()">✕</button>
      </div>`).join('');
    openModal(`<div class="modal-head"><h3>${item ? '编辑目录条目' : '新增目录条目'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body" style="max-height:70vh;overflow:auto">
        <div class="grid grid-2">
          <div class="form-item"><label>序号（如 101）<span class="req">*</span></label><input id="cc-code" value="${item ? FMT.esc(item.code) : ''}" placeholder="3 位数字" style="width:100%;padding:8px"></div>
          <div class="form-item"><label>所属类别<span class="req">*</span></label>
            <select id="cc-project" style="width:100%;padding:8px">${PROJ_OPTIONS.map(p => `<option ${item && item.project === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-item"><label>项目名称<span class="req">*</span></label><input id="cc-name" value="${item ? FMT.esc(item.name) : ''}" placeholder="如：星级宿舍（二星级）" style="width:100%;padding:8px"></div>
        <div class="form-item"><label>等级与分值<span class="req">*</span>（分值为空 = 学生自填 0~2）</label>
          <div id="cc-levels">${lvRows}</div>
          <button class="btn btn-ghost btn-sm" onclick="AppViews.ccAddLv()">＋ 添加等级</button>
        </div>
        <div class="form-item"><label>备注</label><textarea id="cc-note" maxlength="300" placeholder="认定依据说明（选填）" style="width:100%;padding:8px">${item ? FMT.esc(item.note || '') : ''}</textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.certCatSave('${item ? item.id : ''}')">保存</button></div>`);
  },

  ccAddLv: () => {
    const box = document.getElementById('cc-levels');
    box.insertAdjacentHTML('beforeend', `<div class="row cc-lv" style="gap:6px;align-items:center;margin-bottom:4px">
      <input class="lv-level" placeholder="等级名（如：一等奖）" style="flex:2;min-width:140px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <input class="lv-points" type="number" step="0.05" placeholder="分值（空=仅318/434/435学生可填）" style="flex:1;min-width:110px;padding:6px;border:1px solid var(--border);border-radius:6px">
      <button class="btn btn-ghost btn-sm" onclick="this.closest('.cc-lv').remove()">✕</button></div>`);
  },

  certCatSave: async (id) => {
    const code = document.getElementById('cc-code').value.trim();
    const name = document.getElementById('cc-name').value.trim();
    const project = document.getElementById('cc-project').value;
    const note = (document.getElementById('cc-note').value || '').trim();
    const levels = [...document.querySelectorAll('#cc-levels .cc-lv')].map(r => ({
      level: r.querySelector('.lv-level').value.trim(),
      points: r.querySelector('.lv-points').value === '' ? null : Number(r.querySelector('.lv-points').value),
    })).filter(l => l.level);
    if (!code) return toast('序号不能为空', 'err');
    if (!name) return toast('项目名称不能为空', 'err');
    if (!levels.length) return toast('至少配置一个等级', 'err');
    try {
      if (id) await API.put(`/api/admin/cert-catalog/${id}`, { code, name, project, note, levels });
      else await API.post('/api/admin/cert-catalog', { code, name, project, note, levels });
      closeModal(); toast('已保存'); App.goto('certCatalog');
    } catch (e) { toast(e.message, 'err'); }
  },

  certCatToggle: async (id) => {
    const item = (window.__certCat || []).find(c => c.id === id);
    if (!item) return;
    try {
      await API.put(`/api/admin/cert-catalog/${id}`, { enabled: !(item.enabled !== false) });
      toast('已更新'); App.goto('certCatalog');
    } catch (e) { toast(e.message, 'err'); }
  },

  certCatDel: async (id, name) => {
    if (!confirm(`确定删除「${name}」？已提交的申请不受影响。`)) return;
    try {
      await API.del(`/api/admin/cert-catalog/${id}`);
      toast('已删除'); App.goto('certCatalog');
    } catch (e) { toast(e.message, 'err'); }
  },


    // 学生申请退回已认定部分（情形2：已认定已审核、未认定未审核 → 需班长同意）
  withdrawCert: (id) => {
    openModal(`<div class="modal-head"><h3>申请退回已认定项目</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">已认定部分已由班长审核，退回需要班长同意。请填写退回理由。</div>
        <div class="form-item"><label>退回理由（必填，至少3字）</label><textarea id="wd-reason" placeholder="请说明退回原因"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.doWithdrawReq('${id}')">提交退回申请</button></div>`);
  },

  doWithdrawReq: async (id) => {
    const reason = document.getElementById('wd-reason').value.trim();
    try {
      await API.post(`/api/applications/${id}/withdraw-certified`, { reason });
      closeModal(); toast('退回申请已提交，等待班长同意'); App.goto('myApps');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 学生申请退回未认定部分（情形3：已认定未审核、未认定已审核 → 需年级/管理员同意）
  withdrawUncert: (id) => {
    openModal(`<div class="modal-head"><h3>申请退回未认定项目</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">未认定部分已由年级审核，退回需要年级（或管理员）同意。请填写退回理由。</div>
        <div class="form-item"><label>退回理由（必填，至少3字）</label><textarea id="wd-reason" placeholder="请说明退回原因"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.doWithdrawReqUncert('${id}')">提交退回申请</button></div>`);
  },

  doWithdrawReqUncert: async (id) => {
    const reason = document.getElementById('wd-reason').value.trim();
    try {
      await API.post(`/api/applications/${id}/withdraw-uncertified`, { reason });
      closeModal(); toast('退回申请已提交，等待年级同意'); App.goto('myApps');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 学生自行退回整张表（情形1：两端均未审核，不需审批，但需填理由）
  withdrawAll: (id) => {
    openModal(`<div class="modal-head"><h3>退回并重新填写</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">班长与年级均未审核，您可自行退回整张综测加分表后重新填写（不需审批）。请填写退回理由。</div>
        <div class="form-item"><label>退回理由（必填，至少3字）</label><textarea id="wd-reason" placeholder="请说明退回原因"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.doWithdrawAll('${id}')">确认退回</button></div>`);
  },

  doWithdrawAll: async (id) => {
    const reason = document.getElementById('wd-reason').value.trim();
    try {
      await API.post(`/api/applications/${id}/withdraw`, { reason });
      closeModal(); toast('已退回，可重新填写并提交'); App.goto('myApps');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 班长处理退回请求
  handleWithdraw: (id, agree) => {
    openModal(`<div class="modal-head"><h3>${agree ? '同意退回' : '拒绝退回'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-item"><label>处理意见（选填）</label><textarea id="hw-comment" placeholder="${agree ? '同意后学生可修改重新提交' : '请说明拒绝理由'}"></textarea></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-${agree ? 'success' : 'danger'}" onclick="AppViews.doHandleWithdraw('${id}', ${agree})">确认${agree ? '同意' : '拒绝'}</button></div>`);
  },

  doHandleWithdraw: async (id, agree) => {
    const comment = document.getElementById('hw-comment').value.trim();
    try {
      await API.post(`/api/applications/${id}/handle-withdraw`, { agree, comment });
      closeModal(); toast('已处理'); App.goto('monAuditApp', 'pending');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 班长主动退回（纠错/「不涉及加分」误提交）
  forceWithdrawCert: (id) => {
    openModal(`<div class="modal-head"><h3>退回学生修改</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">说明：将该申请的已认定部分退回学生修改（如误勾选不涉及加分需补充材料）。</div>
        <div class="form-item"><label>退回理由（必填，至少3字）</label><textarea id="fw-comment" placeholder="例如：需补充实际加分项目，不能仅勾选不涉及"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doForceWithdrawCert('${id}')">确认退回</button></div>`);
  },

  doForceWithdrawCert: async (id) => {
    const comment = document.getElementById('fw-comment').value.trim();
    try {
      await API.post(`/api/applications/${id}/force-withdraw-certified`, { comment });
      closeModal(); toast('已退回给学生'); App.goto('monAuditApp', 'pending');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 年级主动退回（要求补充材料）
  forceWithdrawUncert: (id) => {
    openModal(`<div class="modal-head"><h3>年级退回（要求补充材料）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">说明：将该申请的未认定部分退回学生修改。</div>
        <div class="form-item"><label>退回理由（必填，至少3字）</label><textarea id="fw2-comment" placeholder="例如：证明材料不清晰，需重新上传"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doForceWithdrawUncert('${id}')">确认退回</button></div>`);
  },

  doForceWithdrawUncert: async (id) => {
    const comment = document.getElementById('fw2-comment').value.trim();
    try {
      await API.post(`/api/applications/${id}/force-withdraw-uncertified`, { comment });
      closeModal(); toast('已退回给学生'); App.goto('gradeAuditApp', 'pending');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 年级/管理员 处理未认定部分的退回请求（情形3）
  handleWithdrawUncert: (id, agree) => {
    openModal(`<div class="modal-head"><h3>${agree ? '同意退回（未认定）' : '拒绝退回（未认定）'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="form-item"><label>处理意见（选填）</label><textarea id="hwu-comment" placeholder="${agree ? '同意后学生可修改未认定部分重新提交' : '请说明拒绝理由'}"></textarea></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-${agree ? 'success' : 'danger'}" onclick="AppViews.doHandleWithdrawUncert('${id}', ${agree})">确认${agree ? '同意' : '拒绝'}</button></div>`);
  },

  doHandleWithdrawUncert: async (id, agree) => {
    const comment = document.getElementById('hwu-comment').value.trim();
    try {
      await API.post(`/api/applications/${id}/handle-withdraw`, { agree, comment, part: 'uncertified' });
      closeModal(); toast('已处理'); App.goto('gradeAuditApp', 'withdraw');
    } catch (e) { toast(e.message, 'err'); }
  },

    // 普通修改密码弹窗（侧栏「改密」入口）：可在「登录密码 / 二级审核密码」间切换
  changePasswordModal: () => {
    // 二级审核密码：admin 与年级（grade）拥有；student/monitor 只显示登录密码表单，不渲染切换按钮
    const hasSec = !!(App.user && (App.user.role === 'admin' || App.user.role === 'grade'));
    const fLogin = `
      <div class="form-item"><label>原登录密码</label><input id="cp-old" type="password" placeholder="当前登录密码"></div>
      <div class="form-item"><label>新登录密码（至少 8 位，不能为纯数字）</label><input id="cp-new" type="password" placeholder="请输入新密码"></div>
      <div class="form-item"><label>确认新登录密码</label><input id="cp-confirm" type="password" placeholder="再次输入新密码"></div>`;
    const fSec = `
      <div class="form-item"><label>当前二级审核密码</label><input id="sp-current" type="password" placeholder="当前二级审核密码（首次设置可留空）"></div>
      <div class="form-item"><label>新二级审核密码（至少 8 位，不能为纯数字）</label><input id="sp-next" type="password" placeholder="请输入新二级审核密码"></div>
      <div class="form-item"><label>确认新二级审核密码</label><input id="sp-next2" type="password" placeholder="再次输入新二级审核密码"></div>`;
    const seg = hasSec ? `
        <div class="row" style="gap:8px;margin-bottom:14px">
          <button type="button" class="btn btn-sm seg-btn btn-primary active" data-mode="login" onclick="AppViews._cpMode('login')">修改登录密码</button>
          <button type="button" class="btn btn-sm seg-btn btn-ghost" data-mode="secondary" onclick="AppViews._cpMode('secondary')">修改二级审核密码</button>
        </div>` : '';
    const secBlock = hasSec ? `<div id="cp-fields-sec" style="display:none">${fSec}</div>` : '';
    openModal(`<div class="modal-head"><h3>🔑 修改密码</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        ${seg}
        <div id="cp-fields-login">${fLogin}</div>
        ${secBlock}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.doChangeCredential()">确认修改</button></div>`);
  },
  // 切换「登录密码 / 二级审核密码」表单
  _cpMode: (mode) => {
    document.querySelectorAll('.seg-btn').forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('btn-primary', on);
      b.classList.toggle('btn-ghost', !on);
      b.classList.toggle('active', on);
    });
    document.getElementById('cp-fields-login').style.display = mode === 'login' ? '' : 'none';
    document.getElementById('cp-fields-sec').style.display = mode === 'secondary' ? '' : 'none';
  },
  // 统一提交：按当前模式调用对应接口
  doChangeCredential: async () => {
    const loginOn = document.getElementById('cp-fields-login').style.display !== 'none';
    if (loginOn) {
      const oldPwd = document.getElementById('cp-old').value;
      const newPwd = document.getElementById('cp-new').value;
      const confirm = document.getElementById('cp-confirm').value;
      if (!oldPwd) return toast('请输入原登录密码', 'err');
      if (!newPwd || newPwd.length < 8 || /^\d+$/.test(newPwd)) return toast('新登录密码至少 8 位且不能为纯数字', 'err');
      if (newPwd !== confirm) return toast('两次新登录密码不一致', 'err');
      try {
        await API.changePassword(oldPwd, newPwd);
        closeModal(); toast('登录密码已修改');
        if (App.user) App.user.mustChangePassword = false;
      } catch (e) { toast(e.message, 'err'); }
    } else {
      const current = document.getElementById('sp-current').value;
      const next = document.getElementById('sp-next').value;
      const next2 = document.getElementById('sp-next2').value;
      if (!next) return toast('请填写新二级密码', 'err');
      if (next.length < 8 || /^\d+$/.test(next)) return toast('新二级密码至少 8 位且不能为纯数字', 'err');
      if (next !== next2) return toast('两次新二级密码不一致', 'err');
      try {
        await API.post('/api/me/secondary-password', { current, next });
        closeModal(); toast('二级审核密码已修改');
        try { const r = await API.get('/api/me'); if (r && r.user && App.user) Object.assign(App.user, r.user); } catch (_) {}
        if (App.user) App.user.mustChangeSecondary = false;
      } catch (e) { toast(e.message, 'err'); }
    }
  },

  // 强制修改登录密码（首次登录 / 被重置密码后）——不可跳过
  forceChangePassword: () => {
    window.__lockModal = true;
    openModal(`<div class="modal-head"><h3>🔐 修改登录密码</h3></div>
      <div class="modal-body">
        <div class="muted mb8">⚠️ 出于账号安全，<b>首次登录或密码被重置后必须修改密码</b>后才能继续使用（不可跳过）。</div>
        <div class="form-item"><label>原密码</label><input id="cp-old" type="password" placeholder="当前密码（重置后用重置时的默认密码；年级账号的二级审核密码同登录密码，均需登录后修改）"></div>
        <div class="form-item"><label>新密码（至少 8 位，不能为纯数字）</label><input id="cp-new" type="password" placeholder="请输入新密码"></div>
        <div class="form-item"><label>确认新密码</label><input id="cp-confirm" type="password" placeholder="再次输入新密码"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" onclick="AppViews.doChangePassword()">确认修改</button></div>`);
  },

  doChangePassword: async () => {
    const oldPwd = document.getElementById('cp-old').value;
    const newPwd = document.getElementById('cp-new').value;
    const confirm = document.getElementById('cp-confirm').value;
    if (!oldPwd) return toast('请输入原密码', 'err');
    if (!newPwd || newPwd.length < 8 || /^\d+$/.test(newPwd)) return toast('新密码至少 8 位且不能为纯数字', 'err');
    if (newPwd !== confirm) return toast('两次新密码不一致', 'err');
    try {
      await API.changePassword(oldPwd, newPwd);
      window.__lockModal = false;
      closeModal();
      toast('密码已修改');
      if (App.user) App.user.mustChangePassword = false;
    } catch (e) { toast(e.message, 'err'); }
  },

  // 强制修改二级审核密码（仍为初始默认值时，登录后必须修改，不可跳过）
  forceChangeSecPwd: () => {
    window.__lockModal = true;
    openModal(`<div class="modal-head"><h3>🔐 修改二级审核密码</h3></div>
      <div class="modal-body">
        <div class="muted mb8">⚠️ 出于账号安全，<b>请先设置您的二级审核密码</b>（尚无可用的二级密码或正处于重置后初始状态，不可跳过；新密码至少 8 位且不能为纯数字）。</div>
        <div class="form-item"><label>新二级密码（至少 8 位，不能为纯数字）</label><input id="sp-next" type="password" placeholder="请输入新二级密码" style="width:100%;padding:8px"></div>
        <div class="form-item"><label>确认新密码</label><input id="sp-next2" type="password" placeholder="再次输入新二级密码" style="width:100%;padding:8px"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" onclick="AppViews.doForceChangeSecPwd()">确认修改</button></div>`);
  },

  doForceChangeSecPwd: async () => {
    const next = document.getElementById('sp-next').value;
    const next2 = document.getElementById('sp-next2').value;
    if (!next || next.length < 8 || /^\d+$/.test(next)) return toast('新二级密码至少 8 位且不能为纯数字', 'err');
    if (next !== next2) return toast('两次输入的新密码不一致', 'err');
    try {
      await API.post('/api/me/secondary-password', { next });
      window.__lockModal = false;
      closeModal();
      toast('二级密码已修改');
      // 防御性：强制从服务器拉一次最新 me（避免任何客户端陈旧状态导致下次仍误弹强制改密窗）
      try {
        const r = await API.get('/api/me');
        if (r && r.user && App.user) Object.assign(App.user, r.user);
      } catch (_) {}
      if (App.user) App.user.mustChangeSecondary = false;
      // 若登录密码也待改，继续弹出登录密码修改
      if (App.user && App.user.mustChangePassword) setTimeout(() => AppViews.forceChangePassword(), 100);
    } catch (e) { toast(e.message, 'err'); }
  },

  // 综测申请总览（班长本班 / 年级全部）—— 服务端筛选 + 分页；年级/管理员可直接「修改」已审定申请
  _appsOverview: async (page = 1) => {
    AppViews.__ovPage = page;
    const f = { className: 'all', kw: '', cstat: 'all', ustat: 'all' };
    const res = await API.get('/api/applications?' + new URLSearchParams(AppViews.__ovParams(f, page)));
    const applications = res.applications || res.data || [];
    // 2026-09-01：去掉「无数据即早退」——total=0 时仍渲染筛选条（专业/班级来自配置），列表区显示「无匹配结果」
    const classes = res.classes || [];
    const majors = res.majors || [];
    const classOpts = ['<option value="all">全部班级</option>'].concat(classes.map(c => `<option>${FMT.esc(c)}</option>`)).join('');
    const majorOpts = ['<option value="all">全部专业</option>'].concat(majors.map(m => `<option>${FMT.esc(m)}</option>`)).join('');
    const stOpts = (label) => `<option value="all">${label}</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="resubmit">补交</option><option value="withdrawn">退回</option>`;
    return `<div class="card">
      <div class="card-title">综测申请总览 <span class="sub" id="ov-count">共 ${res.total} 份</span></div>
      <div class="filter-bar" style="flex-wrap:nowrap;gap:8px;align-items:flex-end;overflow-x:auto">
        <select id="ov-major" style="min-width:130px">${majorOpts}</select>
        <select id="ov-class" style="min-width:130px">${classOpts}</select>
        <input id="ov-kw" placeholder="学号 / 姓名" style="min-width:110px;padding:6px">
        <select id="ov-cstat" style="min-width:120px">${stOpts('已认定状态')}</select>
        <select id="ov-ustat" style="min-width:120px">${stOpts('未认定状态')}</select>
        <button class="btn btn-primary" onclick="AppViews._renderOverview()">🔍 筛选</button>
        <button class="btn btn-ghost" onclick="AppViews._resetOverview()">重置</button>
      </div>
      <div id="ov-list" class="table-wrap" style="margin-top:12px">${AppViews.__ovRowsHtml(applications)}</div>
      <div id="ov-pager">${AppViews.__pagerHtml(res.total, page, res.totalPages, 'AppViews._goOverviewPage')}</div>
    </div>`;
  },

  __ovParams(f, page) {
    const p = { certStatus: 'all', uncertStatus: 'all', page, pageSize: 50 };
    // 2026-09-05：年级总览扩大到「未认定 ∪ 已认定修改」班级范围（gradeAuditApp 工作台不受影响，仍走默认未认定桶）
    if (App.user && App.user.role === 'grade') p.includeMod = '1';
    if (f.major && f.major !== 'all') p.major = f.major;
    if (f.className && f.className !== 'all') p.className = f.className;
    if (f.kw) p.q = f.kw;
    if (f.cstat && f.cstat !== 'all') p.certStatus = f.cstat;
    if (f.ustat && f.ustat !== 'all') p.uncertStatus = f.ustat;
    return p;
  },

  _goOverviewPage: async (page) => {
    AppViews.__ovPage = page;
    const f = {
      major: document.getElementById('ov-major')?.value || 'all',
      className: document.getElementById('ov-class')?.value || 'all',
      kw: document.getElementById('ov-kw')?.value.trim() || '',
      cstat: document.getElementById('ov-cstat')?.value || 'all',
      ustat: document.getElementById('ov-ustat')?.value || 'all',
    };
    const res = await API.get('/api/applications?' + new URLSearchParams(AppViews.__ovParams(f, page)));
    const box = document.getElementById('ov-list');
    const cnt = document.getElementById('ov-count');
    const pg = document.getElementById('ov-pager');
    if (box) box.innerHTML = AppViews.__ovRowsHtml(res.applications || res.data || []);
    if (cnt) cnt.textContent = '共 ' + res.total + ' 份';
    if (pg) pg.innerHTML = AppViews.__pagerHtml(res.total, page, res.totalPages, 'AppViews._goOverviewPage');
  },

  __ovRowsHtml(list) {
    const me = App.user || {};
    const isStaff = me.role === 'admin' || me.role === 'grade';
    if (!list.length) return '<div class="empty">无匹配结果</div>';
    return `<table class="tbl"><thead><tr>
        <th>学生</th><th>班级</th><th>年级</th><th>已认定项数/分</th><th>已认定状态</th>
        <th>未认定项数/分</th><th>未认定状态</th><th>提交时间</th><th>操作</th>
      </tr></thead><tbody>
      ${list.map(a => {
        // 浮点精度：小计 toFixed(4)
        const cTotal = Number(a.certifiedItems.reduce((s,i)=>s+effPts(i),0).toFixed(4));
        const uTotal = Number(a.uncertifiedItems.reduce((s,i)=>s+effPts(i),0).toFixed(4));
        const done = (a.certifiedStatus && a.certifiedStatus !== 'pending') || (a.uncertifiedStatus && a.uncertifiedStatus !== 'pending');
        // 2026-09-05：逐段修改权限来自服务端 _my（cert=可改已认定 / uncert=可改未认定 / gate=已认定段已过截止锁定）
        const my = a._my || { cert: isStaff, uncert: isStaff, gate: false };
        const canAny = !!(my.cert || my.uncert);
        const modifyTitle = my.gate ? '已认定段已过班级审批截止（仅系统管理员可改已认定）；仍可修改未认定段' : '修改（需二级审核密码 + 修改原因）';
        const modifyBtn = (canAny && done) ? `<button class="btn btn-warning btn-sm" title="${modifyTitle}" onclick="AppViews.gradeModifyApp('${a.id}')">✏ 修改</button>` : '';
        return `<tr>
          <td>${FMT.esc(a.studentName)}</td><td>${FMT.esc(a.className)}</td><td>${FMT.esc(a.period || '')}</td>
          <td>${a.certifiedItems.length} / <b>${cTotal}</b></td>
          <td>${a.certifiedStatus ? `<span class="tag ${FMT.status[a.certifiedStatus]?.cls || ''}">${FMT.status[a.certifiedStatus]?.text || a.certifiedStatus}</span>` : '<span class="muted">—</span>'}</td>
          <td>${a.uncertifiedItems.length} / <b>${uTotal}</b></td>
          <td>${a.uncertifiedStatus ? `<span class="tag ${FMT.status[a.uncertifiedStatus]?.cls || ''}">${FMT.status[a.uncertifiedStatus]?.text || a.uncertifiedStatus}</span>` : '<span class="muted">—</span>'}</td>
          <td>${FMT.time(a.createdAt)}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="AppViews.viewDetail('${a.id}')">详情</button>${modifyBtn}</td>
        </tr>`;
      }).join('')}
      </tbody></table>`;
  },

  _renderOverview() {
    AppViews._goOverviewPage(1);
  },

  _resetOverview() {
    const map = { 'ov-major':'all','ov-class':'all','ov-kw':'','ov-cstat':'all','ov-ustat':'all' };
    Object.entries(map).forEach(([id,v]) => { const el = document.getElementById(id); if (el) el.value = v; });
    AppViews._goOverviewPage(1);
  },

  // 通知（学生 / 班长 共用）
  notifications: async () => {
    const { notifications } = await API.myNotifications();
    if (!notifications.length) return `<div class="card"><div class="empty">暂无通知</div></div>`;
    const cards = notifications.map(n => {
      const typeTag = {
        resubmit: '<span class="tag tag-resubmit">待补交</span>',
        reject: '<span class="tag tag-rejected">被驳回</span>',
        notice: '<span class="tag tag-pending">通知</span>',
        urge: '<span class="tag tag-pending">催办</span>',
        'review-withdrawn': '<span class="tag tag-resubmit">复核退回</span>',
      }[n.type] || '';
      // 2026-08-17 B'-14：review-resubmit 类通知被点击 → 直接弹该复核详情（学生从此直接进入补交流程）
      // 2026-09-09：review-withdrawn（整份退回）同理 → 弹详情看退回原因
      const clickAction = ((n.type === 'review-resubmit' || n.type === 'review-withdrawn') && n.reviewId)
        ? `onclick="AppViews.viewReviewDetail('${n.reviewId}'); AppViews.readN('${n.id}', this);"`
        : `onclick="AppViews.readN('${n.id}', this)"`;
      return `<div class="notice-item ${n.read ? '' : 'unread'}" ${clickAction}>
        <div>${typeTag} ${FMT.esc(n.content)}</div>
        <div class="n-time mt8">${FMT.esc(n.fromName)} · ${FMT.time(n.createdAt)}</div>
      </div>`;
    }).join('');
    return cards;
  },

  readN: async (id, el) => {
    await API.readNotification(id);
    el.classList.remove('unread');
  },

  // 统计看板与备份（年级 / 管理员共用）
  statsAndBackup: async (tab = 'stats') => {
    const st = await API.get('/api/grade/stats');
    // 复核审核待办（status=pending 的复核申请）
    let pendingReviews = 0;
    try {
      const { reviews } = await API.get('/api/reviews?round=all&status=all');
      pendingReviews = (reviews || []).filter(r => r.status === 'pending').length;
    } catch (e) {}

    const total = st.totalStudents || 0;
    const totalApps = st.totalApplications || 0;
    const bs = st.byStatus || {};
    const approved = bs.approved || 0;
    const pending = bs.pending || 0;
    const resubmit = bs.resubmit || 0;
    const rejected = bs.rejected || 0;
    const withdrawn = bs.withdrawn || 0;
    const passRate = totalApps ? (approved / totalApps * 100).toFixed(1) : '0.0';
    const todo = pending + resubmit;

    // 顶部：综测复核审核 待办提醒横幅（核心工作流入口）
    const reviewBanner = `<div class="review-todo ${pendingReviews > 0 ? 'has-todo' : ''}" onclick="App.goto('gradeReview')">
      <div class="rt-left"><span class="rt-ico">🔎</span><div>
        <div class="rt-title">综测复核审核</div>
        <div class="rt-sub">核心工作流入口 · 点击进入逐项审核</div>
      </div></div>
      <div class="rt-badge">待办 <b>${pendingReviews}</b> 项${pendingReviews > 0 ? '<span class="rt-dot"></span>' : ''}</div>
    </div>`;

    // 四张指标卡（语义化配色）
    const cards = `<div class="grid grid-4 stat-cards">
      <div class="stat-card c-blue"><div class="sc-label">学生总数</div><div class="sc-num">${total}</div><div class="sc-sub">总人数</div></div>
      <div class="stat-card c-green"><div class="sc-label">申请总数</div><div class="sc-num">${totalApps}</div><div class="sc-sub">含已认定 + 未认定</div></div>
      <div class="stat-card c-orange"><div class="sc-label">审核通过率</div><div class="sc-num">${passRate}%</div><div class="sc-sub">已通过 / 申请总数</div></div>
      <div class="stat-card c-red"><div class="sc-label">待办任务</div><div class="sc-num">${todo}</div><div class="sc-sub">待审 + 待补交</div></div>
    </div>`;

    // 申请状态分布：堆叠进度条（拒绝饼图）
    const segs = [
      { label: '通过', color: '#22c55e', n: approved },
      { label: '退回', color: '#f59e0b', n: withdrawn },
      { label: '待审', color: '#ef4444', n: pending },
      { label: '补交', color: '#f97316', n: resubmit },
      { label: '驳回', color: '#b91c1c', n: rejected },
    ];
    const barSegs = segs.filter(s => s.n > 0).map(s => {
      const pct = totalApps ? (s.n / totalApps * 100) : 0;
      return `<div class="stack-seg" style="width:${pct}%;background:${s.color}" title="${s.label} ${s.n}（${pct.toFixed(1)}%）"></div>`;
    }).join('') || '<div class="stack-seg" style="width:100%;background:#e5e8ef"></div>';
    const legend = segs.map(s => `<span class="stack-legend"><span class="dot" style="background:${s.color}"></span>${s.label} ${s.n}</span>`).join('');
    const statusCard = `<div class="card mt16"><div class="card-title">申请状态分布</div>
      <div class="stack-bar">${barSegs}</div>
      <div class="stack-legend-row">${legend}</div>
      <div class="muted mt8">共 ${totalApps} 份申请；通过率 ${passRate}%，退回占比 ${totalApps ? (withdrawn / totalApps * 100).toFixed(1) : '0.0'}%。退回占比偏高说明学生材料质量较差，建议年级介入指导。</div>
    </div>`;

    // 各班进度表（异常提醒 + 操作入口）
    const rows = Object.entries(st.byClass || {}).map(([c, v]) => {
      const notSub = (v.studentCount || 0) - (v.submittedCount || 0);
      const wd = (v.byStatus && v.byStatus.withdrawn) || 0;
      const anom = [];
      if (wd > 0) anom.push(`<span class="anom anom-warn">⚠️ 退回 ${wd} 项（需修改）</span>`);
      if (notSub > 0) anom.push(`<span class="anom anom-info">⏳ ${notSub} 人未提交</span>`);
      const anomHtml = anom.length ? anom.join(' ') : '<span class="anom anom-ok">✅ 正常</span>';
      const score = (v.approvedPoints > 0) ? v.approvedPoints : '未达标';
      const ops = `<button class="btn btn-ghost btn-sm" onclick="AppViews._ovPreselect('${c}')">查看详情</button>` +
        (notSub > 0 ? `<button class="btn btn-warning btn-sm" onclick="AppViews._urgeClass('${c}',${notSub})">催办</button>` : '');
      return `<tr><td>${FMT.esc(c)}</td><td>${v.submitRate}%</td><td><b>${score}</b></td><td>${anomHtml}</td><td>${ops}</td></tr>`;
    }).join('');
    const classCard = `<div class="card mt16"><div class="card-title">各班进度</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>班级</th><th>提交率</th><th>已认定总分</th><th>异常提醒</th><th>操作</th></tr></thead><tbody>
        ${rows || '<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">暂无班级数据</td></tr>'}
      </tbody></table></div>
      <div class="muted mt8">⚠️ 退回项较多的班级材料质量可能较差，建议重点跟进；⏳ 未提交人数较多的班级可点击「催办」。</div>
    </div>`;

    // Task3（2026-08-30）：统计看板独立成页（纯看板，不再含 Tab 栏与备份操作）
    return reviewBanner + cards + statusCard + classCard;
  },

  // 数据备份卡片（Task3：备份功能移入「系统配置 → 数据备份」Tab）
  _backupCard: () => `<div class="card mt16"><div class="card-title">📦 数据备份</div>
      <div class="sub-desc muted mb8">点击下载当前全量数据备份（含全部账号 / 综测申请 / 日志 / 配置）。建议定期下载保存，防止意外丢失。</div>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <a class="btn btn-primary" href="/api/admin/backup?format=json">⬇ 下载 JSON 备份</a>
        <a class="btn btn-success" href="/api/admin/backup?format=xlsx">⬇ 下载 Excel 备份</a>
      </div>
      <div class="muted mt8">JSON 与 Excel 为同一份全量数据的两种格式；如需恢复，请将备份文件交管理员处理。</div>
    </div>`,

  // 统计看板独立页（菜单入口）
  statsPage: async () => {
    try { return await AppViews.statsAndBackup('stats'); }
    catch (e) { return `<div class="empty">统计看板加载失败：${FMT.esc(e.message || e)}</div>`; }
  },

  // 查看详情：跳转综测申请总览并按班级预筛选
  _ovPreselect: (cls) => {
    App.goto('gradeAllApp');
    setTimeout(() => {
      const sel = document.getElementById('ov-class');
      if (sel) { sel.value = cls; AppViews._renderOverview(); }
    }, 40);
  },

  // 催办：调用后端通知接口，向未提交学生发通知（年级/管理员发起时同步通知本班班长）
  _urgeClass: async (cls, n) => {
    try {
      const r = await API.post('/api/urge/class', { className: cls });
      const target = App.user && App.user.role === 'monitor' ? '本班未提交学生' : '未提交学生与班长';
      toast(`已催办 ${cls}（${r.urged} 名未提交）：${target}已收到通知`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 延期班级勾选网格辅助（2026-08-31）：单个变化/全选/清空 + 计数与高亮同步
  _ccOpenChange: (el, gridId) => {
    const lbl = el.closest('.cc-open-item');
    if (lbl) lbl.classList.toggle('checked', el.checked);
    const grid = document.getElementById(gridId);
    const count = grid ? grid.querySelectorAll('input:checked').length : 0;
    const cEl = document.getElementById(gridId + '-count');
    if (cEl) cEl.textContent = count;
  },
  _ccOpenAll: (gridId) => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.querySelectorAll('input').forEach(i => { i.checked = true; i.closest('.cc-open-item').classList.add('checked'); });
    const cEl = document.getElementById(gridId + '-count');
    if (cEl) cEl.textContent = grid.querySelectorAll('input').length;
  },
  _ccOpenNone: (gridId) => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.querySelectorAll('input').forEach(i => { i.checked = false; i.closest('.cc-open-item').classList.remove('checked'); });
    const cEl = document.getElementById(gridId + '-count');
    if (cEl) cEl.textContent = '0';
  },

  // 倒计时横幅（2026-08-31）：学生端显示「距学生提交截止」、班长端显示「距班级审批截止」；剩余 <3h 才显示
  _deadlineBanner: () => {
    const old = document.getElementById('dl-banner');
    if (old) old.remove();
    if (window._dlTimer) { clearInterval(window._dlTimer); window._dlTimer = null; }
    if (!App.user || !App._cfg) return;
    const role = App.user.role;
    const deadline = role === 'student' ? App._cfg.gradeDeadline : role === 'monitor' ? App._cfg.monitorReviewDeadline : '';
    if (!deadline) return;
    const target = new Date(deadline).getTime();
    if (isNaN(target)) return;
    const label = role === 'student' ? '学生提交截止' : '班级审批截止';
    const render = () => {
      const left = target - Date.now();
      if (left <= 0 || left > 3 * 3600 * 1000) {
        const el = document.getElementById('dl-banner');
        if (el) el.remove();
        if (window._dlTimer) { clearInterval(window._dlTimer); window._dlTimer = null; }
        return;
      }
      const h = Math.floor(left / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const s = Math.floor((left % 60000) / 1000);
      let el = document.getElementById('dl-banner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'dl-banner';
        // 2026-08-31：改为右上角浮动小卡片，不再用 sticky 顶部横条（会挡 logo）
        el.style.cssText = 'position:fixed;top:10px;right:16px;z-index:9990;background:#fff3d6;color:#ad6800;padding:8px 14px;font-size:12.5px;font-weight:600;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);border:1px solid #f0d9a0;max-width:340px;text-align:center;z-index:9999';
        document.body.appendChild(el);
      }
      el.textContent = `⏳ 距${label}还有 ${h} 时 ${m} 分 ${s} 秒`;
    };
    render();
    window._dlTimer = setInterval(render, 1000);
  },

  // 系统配置（截止时间 + 公示开关）—— 2026-08-31 重构：两个截止时间（学生提交/班级审批），admin 可配例外班级
  configPage: async () => {
    const cfg = await API.get('/api/config');
    const u = App.user;
    const isAdmin = u.role === 'admin';
    const isGradeOrAdmin = u.role === 'grade' || u.role === 'admin';
    const toLocal = (iso) => iso ? FMT.time(iso).replace(' ', 'T').slice(0, 16) : '';
    // 例外班级列表（2026-08-31：改用 /api/grade/stats，任何登录角色可读；失败时显示提示而非静默空白）
    let classes = [];
    let classesErr = '';
    if (isAdmin) {
      try {
        const st = await API.get('/api/grade/stats');
        classes = Object.keys(st.byClass || {}).sort();
      } catch (e1) {
        try { classes = (await API.adminUsers({ role: 'all', className: 'all' })).classes || []; }
        catch (e2) { classesErr = '班级列表加载失败，请刷新重试'; }
      }
    }
    // 延期班级：整行可点击卡片 + 显式 inline style 保证可见（2026-08-31 重构）
    const renderOpenGrid = (gridId, list, sel) => {
      const arr = list || [];
      const init = (sel || []).length;
      const items = arr.map(c => {
        const checked = (sel || []).includes(c);
        return `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid ${checked ? '#1f6feb' : '#dcdfe6'};border-radius:8px;cursor:pointer;margin-bottom:6px;background:${checked ? '#e8f0fe' : '#fff'};color:#1f2328;font-size:13.5px;">
          <input type="checkbox" value="${FMT.esc(c)}" ${checked ? 'checked' : ''} onchange="AppViews._ccOpenChange(this,'${gridId}')" style="accent-color:#1f6feb;width:16px;height:16px;flex-shrink:0;cursor:pointer;">
          <span style="flex:1;white-space:nowrap;overflow:visible;color:#1f2328;">${FMT.esc(c)}</span>
          ${checked ? '<span style="color:#1f6feb;font-weight:600;font-size:14px;">✓</span>' : ''}
        </label > `;
      }).join('');
      return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:12.5px;color:#5a6477;">
          <span>已选 <b id="${gridId}-count" style="color:#1f6feb;font-size:13px;">${init}</b> 个班级已延期</span>
          <span>
            <button type="button" class="btn btn-ghost btn-sm" onclick="AppViews._ccOpenAll('${gridId}')">✓ 全选</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="AppViews._ccOpenNone('${gridId}')">✕ 清空</button>
          </span>
        </div>
        <div id="${gridId}" style="max-height:340px;overflow-y:auto;padding:2px 4px;border:1px solid #eef0f4;border-radius:8px;background:#fafbfc;">${items || `<div style="padding:10px;color:#888;font-size:12.5px;">${classesErr || '班级列表为空'}</div>`}</div>`;
    };
    const exceptionBlock = isAdmin ? `
      <div class="card-title mt16" style="font-size:14px">📌 截止后延期班级（仅管理员）</div>
      <div class="muted mb8" style="font-size:12px">到点后仍允许<b>继续提交材料</b> / <b>继续审批</b>的班级（点击勾选，再次点击取消；可用顶部「✓ 全选」「✕ 清空」批量操作）。修改后需点下方「💾 保存配置」生效。</div>
      <div class="grid grid-2">
        <div class="form-item"><label>① 提交截止后仍可提交的班级</label>${renderOpenGrid('cfg-submit-open', classes, cfg.submitOpenClasses)}</div>
        <div class="form-item"><label>② 审批截止后仍可审批的班级</label>${renderOpenGrid('cfg-review-open', classes, cfg.reviewOpenClasses)}</div>
      </div>` : '';
    const gradeBlock = isGradeOrAdmin ? `
      <div class="form-item"><label>学生提交材料截止时间（到点后学生不可 提交/补交/重写/退回）</label>
        <input id="cfg-grade" type="datetime-local" value="${toLocal(cfg.gradeDeadline)}"></div>
      <div class="form-item"><label>班级审批截止时间（到点后班长不可审批）</label>
        <input id="cfg-review" type="datetime-local" value="${toLocal(cfg.monitorReviewDeadline)}"></div>` : '';
    const roundBlock = isGradeOrAdmin ? `
      <div class="card-title mt16" style="font-size:14px">综测复核（年级手动开启；可设各榜截止时间）</div>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:8px">
        <input type="checkbox" id="cfg-rr-seq" ${cfg.reviewRoundSequential !== false ? 'checked' : ''} onchange="AppViews.saveConfig()"> 强制顺序开榜（开启二/三榜前须先标记上一榜「复核完毕」；测试阶段可关闭以同时开启多榜）
      </label>
      <div class="row">
        ${AppViews.ROUNDS.map(r => {
          const dlKey = { first: 'firstReviewDeadline', second: 'secondReviewDeadline', third: 'thirdReviewDeadline' }[r.key];
          const dlVal = (cfg[dlKey]) ? toLocal(cfg[dlKey]) : '';
          return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="cfg-rr-${r.key}" ${cfg.reviewRounds?.[r.key] ? 'checked' : ''} onchange="AppViews.saveConfig()"> ${r.cn}复核开放</label>
          <input type="datetime-local" id="cfg-rr-dl-${r.key}" value="${dlVal}" title="${r.cn}复核截止时间（到点后学生不可提交/撤回，年级/admin 不可退回）" style="padding:4px;border:1px solid var(--border);border-radius:6px">
          <button class="btn btn-ghost btn-sm" onclick="AppViews.markRoundDone('${r.key}')">${cfg.reviewRoundDone?.[r.key] ? '✅ 已标记完毕' : '标记复核完毕'}</button>
        </div>`;
        }).join('')}
      </div>
      <div class="muted mt8">开启后学生端对应榜次的「提交复核」按钮才会出现；到<b>截止时间</b>后学生不可再 提交/撤回，年级/admin 不可再退回（留空=不限制），异常情况由管理员「清除复核记录」处理。强制顺序开启时，开启二/三榜前需先点「标记复核完毕」。</div>` : '';
    return `<div class="card">
      <div class="card-title">⚡ 截止时间配置</div>
      <p class="muted mb8">到点后自动锁定：<b>学生提交截止</b> → 所有学生不可 提交/补交/重写/退回；<b>班级审批截止</b> → 班长不可再审批（年级审核/改判不受限）。两个时间留空表示不限制。</p>
      <div class="grid grid-2">
        ${gradeBlock}
      </div>
      ${exceptionBlock}
      ${roundBlock}
      <div class="muted mb8">当前状态：学生提交截止 ${cfg.gradeDeadline ? FMT.time(cfg.gradeDeadline) : '未设置（不限制）'}；班级审批截止 ${cfg.monitorReviewDeadline ? FMT.time(cfg.monitorReviewDeadline) : '未设置（不限制）'}${isAdmin ? `；提交延期班级 ${(cfg.submitOpenClasses || []).length} 个、审批延期班级 ${(cfg.reviewOpenClasses || []).length} 个` : ''}。</div>
      <button class="btn btn-primary" onclick="AppViews.saveConfig()">💾 保存配置</button>
    </div>`;
  },

  // 班长端配置页（2026-08-31 起不再提供：班长不再有截止时间设置）——保留兼容壳，菜单入口已移除
  monitorConfigPage: async () => `<div class="card"><div class="empty">截止时间设置已由年级/管理员统一管理，班长无需设置</div></div>`,

  saveConfig: async () => {
    const u = App.user;
    const isAdmin = u.role === 'admin';
    const gradeRaw = document.getElementById('cfg-grade') ? document.getElementById('cfg-grade').value : '';
    const reviewRaw = document.getElementById('cfg-review') ? document.getElementById('cfg-review').value : '';
    const gradeDeadline = gradeRaw ? new Date(gradeRaw).toISOString() : '';
    const monitorReviewDeadline = reviewRaw ? new Date(reviewRaw).toISOString() : '';
    const submitOpen = isAdmin && document.getElementById('cfg-submit-open') ? [...document.querySelectorAll('#cfg-submit-open input:checked')].map(i => i.value) : [];
    const reviewOpen = isAdmin && document.getElementById('cfg-review-open') ? [...document.querySelectorAll('#cfg-review-open input:checked')].map(i => i.value) : [];
    // 2026-09-10：三榜复核截止时间（与开启状态分开保存，走 /api/config/deadlines）
    const rd = (k) => { const e = document.getElementById(k); return (e && e.value) ? new Date(e.value).toISOString() : ''; };
    try {
      await API.post('/api/config/deadlines', { gradeDeadline, monitorReviewDeadline, firstReviewDeadline: rd('cfg-rr-dl-first'), secondReviewDeadline: rd('cfg-rr-dl-second'), thirdReviewDeadline: rd('cfg-rr-dl-third'), submitOpenClasses: submitOpen, reviewOpenClasses: reviewOpen });
      // 复核榜次开启状态（仅 grade/admin 页面渲染了该区块）
      if (document.getElementById('cfg-rr-first')) {
        const seqEl = document.getElementById('cfg-rr-seq');
        const rr = { first: document.getElementById('cfg-rr-first').checked, second: document.getElementById('cfg-rr-second').checked, third: document.getElementById('cfg-rr-third').checked, sequential: seqEl ? seqEl.checked : true };
        await API.post('/api/config/review-rounds', rr);
      }
      // 刷新配置缓存并重渲染菜单（学生/班长端综测复核入口按 reviewRounds 显隐）
      try { await App.refreshMenu(); } catch (_) {}
      toast('配置已保存');
      // 2026-08-31 修复：去掉对 isMonitor 的引用（重构截止体系时该变量被删但 goto 残留）
      App.goto('sysConfig'); // 重新渲染配置页反映最新 cfg
    } catch (e) { toast(e.message, 'err'); }
  },

  // 标记某榜「复核完毕」（切换）
  markRoundDone: async (key) => {
    const cn = AppViews.ROUNDS.find(r => r.key === key)?.cn || key;
    const cur = App._cfg && App._cfg.reviewRoundDone && App._cfg.reviewRoundDone[key];
    const next = !cur;
    try {
      await API.post('/api/config/review-round-done', { key, value: next });
      toast(next ? (cn + '已标记为复核完毕') : (cn + '已取消「复核完毕」标记'), 'ok');
      App.goto('gradeConfig');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 操作日志查询与导出（年级/管理员）—— 双 Tab：操作日志 / 审计日志
  logsPage: async () => {
    const classes = (await API.adminUsers({ role: 'all', className: 'all' }).catch(() => ({ classes: [] }))).classes || [];
    const classOptions = ['<option value="all">全部班级</option>'].concat(classes.map(c => `<option>${FMT.esc(c)}</option>`)).join('');
    const actionOpts = ['login','app-submit','app-submit-noitems','app-resubmit','app-action','review-submit','review-item','user-create','user-reset-pwd','secpwd-change','scores-import','scores-clear','export-grade-stats','export-snapshot','export-review-stats','export-zhiscores','export-credential','backup-export','user-clear-submissions']
      .map(a => `<option value="${a}">${a}</option>`).join('');
    return `<div class="card">
      <div class="card-title">📤 操作日志查询与导出</div>
      <div class="filter-bar">
        <button id="lg-tab-store" class="btn btn-sm ${window._logTab === 'audit' ? 'btn-ghost' : 'btn-primary'}" onclick="App.goto('gradeLogs','store')">📋 操作日志</button>
        <button id="lg-tab-audit" class="btn btn-sm ${window._logTab === 'audit' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeLogs','audit')">🛡️ 审计日志（安全）</button>
        <span class="muted" style="font-size:12px">审计日志记录登录/导出/导入/复核/改判/复制/打印等敏感操作，独立存储、保留 365 天</span>
      </div>
      <div id="lg-store-area">
      <div class="filter-bar" style="flex-wrap:wrap;gap:8px;align-items:flex-end">
        <select id="lg-class" style="min-width:150px">${classOptions}</select>
        <input id="lg-student" placeholder="按姓名/学号筛选" style="min-width:140px;padding:6px">
        <select id="lg-role" style="min-width:120px"><option value="all">全部角色</option><option value="admin">管理员</option><option value="grade">年级</option><option value="monitor">班长</option><option value="student">学生</option></select>
        <select id="lg-action" style="min-width:160px"><option value="all">全部操作</option>${actionOpts}</select>
        <input type="datetime-local" id="lg-from" title="开始时间">
        <input type="datetime-local" id="lg-to" title="结束时间">
        <button class="btn btn-primary" onclick="AppViews.loadLogs(1)">🔍 查询</button>
        <button class="btn btn-success" onclick="AppViews.exportLogs()">⬇ 导出 CSV</button>
      </div>
      <div id="lg-result" class="mt16"></div>
      <div id="lg-pager" class="mt12" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"></div>
      </div>
      <div id="lg-audit-area" style="display:none">
        <div class="filter-bar" style="flex-wrap:wrap;gap:8px;align-items:flex-end">
          <select id="lg-a-action" style="min-width:150px"><option value="">全部操作</option>
            ${['login_success','login_failure','logout','view_announce','export_announce','export','import_zhiyu','import_teacher','review_approve','review_reject','review_resubmit','override','copy_text','print_page','pwd_verify_success','pwd_verify_failure'].map(a => `<option value="${a}">${a}</option>`).join('')}
          </select>
          <input id="lg-a-ip" placeholder="按 IP 筛选" style="min-width:130px;padding:6px">
          <input id="lg-a-user" placeholder="按姓名/工号筛选" style="min-width:130px;padding:6px">
          <input id="lg-a-scope" placeholder="操作范围（班级/年级）" style="min-width:130px;padding:6px">
          <input id="lg-a-md5" placeholder="文件 MD5 追溯" style="min-width:150px;padding:6px">
          <input type="datetime-local" id="lg-a-from" title="开始时间">
          <input type="datetime-local" id="lg-a-to" title="结束时间">
          <select id="lg-a-risk" style="min-width:100px"><option value="">全部</option><option value="1">⚠ 高风险</option></select>
          <button class="btn btn-primary" onclick="AppViews.loadAuditLogs(1)">🔍 查询</button>
          <button class="btn btn-success" onclick="AppViews.exportAuditLogs()">⬇ 导出 CSV</button>
        </div>
        <div class="muted mt8" style="font-size:12px">字段：时间 / 操作人(工号) / 角色 / IP / 设备 / 操作 / 范围 / 条数 / 文件指纹(MD5) / 耗时 / 结果 / 前后对比。触发告警的高风险记录<b style="color:var(--danger)">红色高亮</b>。</div>
        <div id="lg-a-result" class="mt16"></div>
        <div id="lg-a-pager" class="mt12" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"></div>
      </div>
    </div>`;
  },
  _switchLogTab: () => {
    const key = window._logTab || 'store';
    const storeArea = document.getElementById('lg-store-area');
    const auditArea = document.getElementById('lg-audit-area');
    if (storeArea) storeArea.style.display = key === 'store' ? '' : 'none';
    if (auditArea) auditArea.style.display = key === 'audit' ? '' : 'none';
    // 同步页签按钮高亮（当前页签 btn-primary 变蓝，另一 btn-ghost）
    const storeTab = document.getElementById('lg-tab-store');
    const auditTab = document.getElementById('lg-tab-audit');
    if (storeTab) storeTab.className = 'btn btn-sm ' + (key === 'store' ? 'btn-primary' : 'btn-ghost');
    if (auditTab) auditTab.className = 'btn btn-sm ' + (key === 'audit' ? 'btn-primary' : 'btn-ghost');
  },
  loadAuditLogs: async (page = 1) => {
    const p = {
      action: document.getElementById('lg-a-action').value,
      ip: document.getElementById('lg-a-ip').value.trim(),
      userId: document.getElementById('lg-a-user').value.trim(),
      scope: document.getElementById('lg-a-scope').value.trim(),
      md5: document.getElementById('lg-a-md5').value.trim(),
      highRisk: document.getElementById('lg-a-risk').value,
      page, pageSize: 100,
    };
    const f = document.getElementById('lg-a-from').value, t = document.getElementById('lg-a-to').value;
    if (f) p.from = new Date(f).toISOString();
    if (t) p.to = new Date(t).toISOString();
    const box = document.getElementById('lg-a-result');
    try {
      const r = await API.get('/api/admin/audit-logs?' + new URLSearchParams(p));
      const { list = [], total = 0 } = r;
      const totalPages = Math.max(1, Math.ceil(total / (p.pageSize)));
      if (!list.length) { box.innerHTML = '<div class="empty">无匹配审计日志</div>'; return; }
      const ACT_CN = { login_success: '登录成功', login_failure: '登录失败', logout: '退出登录', view_announce: '查看公示', export_announce: '导出公示版', export: '导出数据', import_zhiyu: '导入智育', import_teacher: '导入教师评价', review_approve: '复核通过', review_reject: '复核驳回', review_resubmit: '复核补交', override: '改判', copy_text: '复制文本', print_page: '打印页面', pwd_verify_success: '二级密码验证成功', pwd_verify_failure: '二级密码验证失败' };
      const fmtUA = (ua) => { const s = ua || ''; if (!s) return ''; const m = s.match(/(Chrome|Firefox|Safari|Edg|WX)[\/\s]?([\d.]+)?/i); return m ? (m[1] + (m[2] ? ' ' + m[2] : '')) : s.slice(0, 20); };
      box.innerHTML = `<div class="muted mb8">共匹配 <b>${total}</b> 条，第 ${r.page} / ${totalPages} 页</div>
        <div class="table-wrap"><table class="tbl" style="font-size:12px"><thead><tr><th>时间</th><th>操作人</th><th>角色</th><th>IP</th><th>设备</th><th>操作</th><th>范围</th><th>条数</th><th>指纹</th><th>耗时</th><th>结果</th><th>前后对比/说明</th></tr></thead><tbody>
        ${list.map(l => `<tr style="${l.highRisk ? 'background:var(--danger-bg);color:var(--danger);font-weight:600' : ''}">
          <td>${FMT.time(l.timestamp)}</td><td>${FMT.esc(l.actor.userName || '')}(${FMT.esc(l.actor.userId || '')})</td><td>${FMT.esc(l.actor.role || '')}</td>
          <td>${FMT.esc(l.actor.ip || '')}</td><td>${FMT.esc(fmtUA(l.actor.userAgent))}</td>
          <td>${FMT.esc(ACT_CN[l.action] || l.action)}${l.highRisk ? ' ⚠' : ''}</td>
          <td>${FMT.esc(l.target.scope || l.target.type || '')}</td><td style="text-align:right">${l.target.recordCount || ''}</td>
          <td>${l.target.fileMd5 ? `<span title="${FMT.esc(l.target.fileMd5)}">${FMT.esc(l.target.fileMd5.slice(0, 10))}…</span>` : ''}</td>
          <td style="text-align:right">${l.duration != null ? l.duration + 'ms' : ''}</td><td>${FMT.esc(l.result)}</td>
          <td style="white-space:normal;max-width:260px">${l.detail.before !== undefined || l.detail.after !== undefined ? `<b>${FMT.esc(JSON.stringify(l.detail.before || {}))} → ${FMT.esc(JSON.stringify(l.detail.after || {}))}</b>` : ''}${l.detail.error ? `<span style="color:var(--danger)">${FMT.esc(l.detail.error)}</span>` : ''}${l.detail.reason ? FMT.esc(l.detail.reason) : ''}${l.detail.copyContent ? `复制:${FMT.esc(l.detail.copyContent)}` : ''}</td>
        </tr>`).join('')}
        </tbody></table></div>`;
      document.getElementById('lg-a-pager').innerHTML = `<button class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="AppViews.loadAuditLogs(${page - 1})">上一页</button>
        <span class="muted">第 ${r.page} / ${totalPages} 页</span>
        <button class="btn btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="AppViews.loadAuditLogs(${page + 1})">下一页</button>`;
    } catch (e) { box.innerHTML = `<div class="empty">加载失败：${FMT.esc(e.message)}</div>`; }
  },
  exportAuditLogs: async () => {
    const p = {
      action: document.getElementById('lg-a-action').value,
      ip: document.getElementById('lg-a-ip').value.trim(),
      userId: document.getElementById('lg-a-user').value.trim(),
      scope: document.getElementById('lg-a-scope').value.trim(),
      md5: document.getElementById('lg-a-md5').value.trim(),
      highRisk: document.getElementById('lg-a-risk').value,
      pageSize: 500,
    };
    const f = document.getElementById('lg-a-from').value, t = document.getElementById('lg-a-to').value;
    if (f) p.from = new Date(f).toISOString();
    if (t) p.to = new Date(t).toISOString();
    try {
      const r = await API.get('/api/admin/audit-logs?' + new URLSearchParams(p));
      const rows = r.list || [];
      if (!rows.length) return toast('无匹配记录可导出', 'err');
      const esc = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
      const lines = [['时间', '操作人', '工号', '角色', 'IP', '设备', '操作', '范围', '条数', '文件指纹', '耗时', '结果', '前后对比', '错误/说明'].map(esc).join(',')];
      rows.forEach(l => {
        lines.push([l.timestamp, l.actor.userName, l.actor.userId, l.actor.role, l.actor.ip, (l.actor.userAgent || '').slice(0, 60), l.action, l.target.scope || l.target.type || '', l.target.recordCount || '', l.target.fileMd5 || '', l.duration, l.result, (JSON.stringify(l.detail.before) + '->' + JSON.stringify(l.detail.after)), (l.detail.error || l.detail.reason || '')].map(esc).join(','));
      });
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '审计日志_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e.message, 'err'); }
  },

  _lgQuery: () => {
    const q = {
      className: document.getElementById('lg-class').value,
      studentName: document.getElementById('lg-student').value.trim(),
      role: document.getElementById('lg-role').value,
      action: document.getElementById('lg-action').value,
    };
    const f = document.getElementById('lg-from').value, t = document.getElementById('lg-to').value;
    if (f) q.from = new Date(f).toISOString();
    if (t) q.to = new Date(t).toISOString();
    return q;
  },

  loadLogs: async (page = 1) => {
    const q = AppViews._lgQuery();
    q.page = page; q.pageSize = 100;
    const { logs, total, page: pg, pageSize } = await API.logs(q);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const box = document.getElementById('lg-result');
    if (!logs.length) { box.innerHTML = '<div class="empty">无匹配日志</div>'; document.getElementById('lg-pager').innerHTML = ''; return; }
    box.innerHTML = `<div class="muted mb8">共匹配 ${total} 条（上限 50000），当前第 ${pg} / ${totalPages} 页，每页 ${pageSize} 条</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>时间</th><th>操作人</th><th>角色</th><th>班级</th><th>学号</th><th>操作</th><th>详情</th></tr></thead><tbody>
      ${logs.map(l => `<tr><td>${FMT.time(l.time)}</td><td>${FMT.esc(l.byName)}</td><td>${FMT.esc(l.role)}</td><td>${FMT.esc(l.className)}</td><td>${FMT.esc(l.studentId)}</td><td>${FMT.esc(l.action)}</td><td>${FMT.esc(l.detail)}</td></tr>`).join('')}
      </tbody></table></div>`;
    document.getElementById('lg-pager').innerHTML = `<button class="btn btn-sm" ${pg <= 1 ? 'disabled' : ''} onclick="AppViews.loadLogs(${pg - 1})">上一页</button>
      <span class="muted">第 ${pg} / ${totalPages} 页</span>
      <button class="btn btn-sm" ${pg >= totalPages ? 'disabled' : ''} onclick="AppViews.loadLogs(${pg + 1})">下一页</button>`;
  },

  exportLogs: async () => {
    const q = AppViews._lgQuery();
    if (!q.studentName) delete q.studentName;
    q.format = 'csv';
    try {
      const r = await fetch('/api/logs?' + new URLSearchParams(q));
      if (!r.ok) throw new Error('导出失败');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '操作日志_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e.message, 'err'); }
  },

  // 通用附件下载（鉴权 + 后端 Content-Disposition 用原中文名；Cookie 自动携带鉴权）
  downloadFile: async (url, filename) => {
    try {
      const r = await fetch('/api/download?url=' + encodeURIComponent(url) + '&filename=' + encodeURIComponent(filename));
      if (!r.ok) throw new Error('下载失败');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e.message || '下载失败', 'err'); }
  },

  // 在线预览（图片/PDF 内联显示，其它类型直接下载）
  // 2026-09-09：预览改挂独立层 openPreview（不再覆盖下层弹窗——从申请详情/审核详情点开附件，关闭预览后原弹窗保留）；
  //   图片新增 ↺左旋90° / 右旋90°↻（CSS transform 浏览器本地旋转，每次打开归零，旋转后区域可滚动）
  previewFile: (url, name) => {
    const ext = (name || url || '').split('.').pop().toLowerCase();
    const previewable = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'].includes(ext);
    if (!previewable) { AppViews.downloadFile(url, name); return; }
    const enc = encodeURIComponent(url);
    AppViews._previewRot = 0;
    const isImg = ext !== 'pdf';
    const inner = isImg
      ? `<img id="previewImg" src="/api/preview?url=${enc}" alt="预览图片" style="max-height:78vh">`
      : `<iframe src="/api/preview?url=${enc}" style="width:100%;height:100%;min-height:70vh;border:0"></iframe>`;
    const rotBtns = isImg
      ? `<button class="btn btn-ghost btn-sm" onclick="AppViews.rotatePreview(-90)" title="逆时针旋转90°">↺ 左旋90°</button><button class="btn btn-ghost btn-sm" onclick="AppViews.rotatePreview(90)" title="顺时针旋转90°">右旋90° ↻</button>`
      : '';
    openPreview(`<div class="modal-head"><h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:12px">预览：${FMT.esc(name)}</h3><button class="modal-close" onclick="AppViews._closePreview()">×</button></div>
      <div class="preview-body">${inner}</div>
      <div class="modal-foot"><a class="btn btn-ghost" href="/api/preview?url=${enc}" target="_blank">新窗口打开</a>${rotBtns}<button class="btn btn-primary" onclick="AppViews.downloadFile('${FMT.esc(url)}','${FMT.esc(name)}')">下载</button><button class="btn btn-ghost" onclick="AppViews._closePreview()">关闭</button></div>`);
  },
  // 图片旋转：角度累计取模 360（与打开时归零配合）
  rotatePreview: (deg) => {
    const rot = ((Number(AppViews._previewRot) || 0) + deg) % 360;
    AppViews._previewRot = rot;
    const img = document.getElementById('previewImg');
    if (img) img.style.transform = `rotate(${rot}deg)`;
  },
  // 关闭预览：仅关独立预览层，不影响下层弹窗（详情/审核）
  _closePreview: () => { closePreview(); },

  // ==================== 综测复核（三榜）====================
  REVIEW_PROJECTS: ['政治思想', '道德修养', '遵纪守法', '诚实守信', '学习态度', '文明卫生', '社会服务', '集体活动', '创新能力及劳动素质', '社会实践报告'],
  ROUNDS: [{ key: 'first', cn: '一榜' }, { key: 'second', cn: '二榜' }, { key: 'third', cn: '三榜' }],

  // 学生端主页：三榜入口 + 我的复核列表
  // 入口显示逻辑：仅 admin 勾选 X 榜开放 OR 该榜已有历史 → 显示该榜卡片；未开放且无历史 → 整张卡片不出现
  // 已提交的复核记录（"我的复核记录"区）始终可见，不受开关影响
  reviewHome: async () => {
    const { reviews } = await API.get('/api/my/reviews');
    const cfg = await API.get('/api/config');
    const roundsOpen = cfg.reviewRounds || {};
    const visibleRounds = AppViews.ROUNDS.filter(r => roundsOpen[r.key] || reviews.some(x => x.round === r.key));
    let h = '';
    if (visibleRounds.length) {
      h += '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px">';
      visibleRounds.forEach(r => {
        // 2026-09-09：活跃份排除 withdrawn（整份退回作废后学生可重新提交 → 显示新入口而非旧"已退回"份）
        const mine = reviews.find(x => x.round === r.key && x.status !== 'withdrawn');
        const wd = reviews.find(x => x.round === r.key && x.status === 'withdrawn'); // 最近被退回的历史份（取第一条即可展示原因）
        const open = roundsOpen[r.key];
        // 2026-09-10：复核截止时间（未配置=不限制）；wdCount = 该生该榜累计撤回/退回次数（共享 REVIEW_WITHDRAW_LIMIT=2）
        const dlKey = { first: 'firstReviewDeadline', second: 'secondReviewDeadline', third: 'thirdReviewDeadline' }[r.key];
        const dlRaw = (cfg && cfg[dlKey]) || '';
        const deadlinePassed = !!dlRaw && (new Date(dlRaw).getTime() <= Date.now());
        const wdCount = reviews.filter(x => x.round === r.key && x.status === 'withdrawn').length;
        const canSubmit = open && !deadlinePassed;
        const hitLimit = wdCount >= 2;
        const limitNote = hitLimit ? '<div class="muted mt8" style="font-size:12px">已达撤回/退回上限（2/2），如需提交请联系管理员清除</div>'
          : (wdCount > 0 ? `<div class="muted mt8" style="font-size:12px">已撤回/被退回 ${wdCount}/2 次</div>` : '');
        const deadlineNote = (open && deadlinePassed) ? `<div class="muted mt8" style="font-size:12px">已过截止时间${dlRaw ? `（${FMT.time(dlRaw)}）` : ''}，本次复核不再接受提交/撤回</div>` : '';
        h += `<div class="card" style="flex:1;min-width:240px;text-align:center">
          <div class="card-title" style="justify-content:center">${r.cn}复核${AppViews._reviewCdChip(r.key, open, dlRaw)}</div>
          ${mine ? (() => {
            const canWithdrawMine = mine.status === 'pending' && canSubmit;
            return `<div class="sub-meta">${AppViews._reviewStudentStatusTag(mine)}<br>${FMT.time(mine.createdAt)}</div>
            <button class="btn btn-ghost btn-sm mt8" onclick="AppViews.viewReviewDetail('${mine.id}')">查看详情</button>
            ${canWithdrawMine ? `<button class="btn btn-warning btn-sm mt8" onclick="AppViews.reviewSelfWithdrawAsk('${mine.id}')">↩ 撤回申请</button>` : ''}${limitNote}${deadlineNote}`;
          })() :
          wd ? `<div class="sub-meta">${AppViews._reviewStudentStatusTag(wd)}<br>${FMT.time(wd.withdrawnAt || wd.createdAt)}</div>
            ${(canSubmit && !hitLimit) ? `<button class="btn btn-primary btn-sm mt8" onclick="App.goto('reviewSubmit','${r.key}')">重新提交${r.cn}复核申请</button>` : `<div class="muted mt8" style="font-size:12px">${!open ? '该榜次已关闭，无法重新提交' : hitLimit ? '已达 2 次上限，无法再次提交（请联系管理员清除）' : deadlineNote}</div>`}
            ${limitNote}${deadlineNote}
            <button class="btn btn-ghost btn-sm mt8" onclick="AppViews.viewReviewDetail('${wd.id}')">查看退回原因</button>` :
          `<div class="sub-meta"><span class="tag tag-active">${deadlinePassed ? '已截止' : '已开放'}</span></div>
            ${canSubmit ? `<button class="btn btn-primary btn-sm mt8" onclick="App.goto('reviewSubmit','${r.key}')">提交${r.cn}复核申请</button>` : deadlineNote}`}
          ${mine && !open ? '<div class="muted mt8" style="font-size:12px">当前榜次已关闭提交，仅可查看历史</div>' : ''}
        </div>`;
      });
      h += '</div>';
    }
    // 我的历史复核（始终显示，不受复核开放开关影响）
    if (reviews.length) {
      h += `<div class="card"><div class="card-title">我的复核记录</div>
        ${reviews.map(r => {
          // 2026-08-17 B'-14：含待补交项时，额外渲染快捷补交按钮（点开即弹补交材料对话框）
          const resubmitItem = (r.items || []).find(it => it.reviewStatus === 'resubmit');
          const quickBtn = resubmitItem ? `<button class="btn btn-warning btn-sm" style="margin-left:6px" onclick="AppViews.studentResubmitItem('${r.id}','${resubmitItem.id}')">⚠ 立即补交材料</button>` : '';
          return `<div class="sub-card"><div class="sub-card-head"><span class="sub-title">${AppViews.ROUNDS.find(x=>x.key===r.round)?.cn || r.round}复核</span>${AppViews._reviewStudentStatusTag(r)}</div>
          <div class="sub-meta"><span>${FMT.esc(r.studentName)}（${FMT.esc(r.className)}）</span><span>提交：${FMT.time(r.createdAt)}</span></div>
          <button class="btn btn-ghost btn-sm" onclick="AppViews.viewReviewDetail('${r.id}')">查看详情</button>${quickBtn}</div>`;
        }).join('')}
      </div>`;
    }
    if (!visibleRounds.length && !reviews.length) {
      h += '<div class="card"><div class="empty">当前暂无开放的复核榜次，请等待年级开启</div></div>';
    }
    // 2026-09-10：截止倒计时（秒级）——DOM 注入后启动，无 chip 时 ticker 自动停
    setTimeout(() => AppViews._startReviewCdTicker(), 30);
    return h;
  },

  // 2026-09-10 上线前：复核截止倒计时 chip（仅开放榜且有截止时间才渲染；是否可见由 ticker 控制）
  // 内联于卡片标题右侧（非浮层/非定位），不遮挡任何 UI
  _reviewCdChip: (roundKey, open, dlRaw) => {
    if (!open || !dlRaw) return '';
    return `<span class="cd-chip" data-cd-dl="${FMT.esc(dlRaw)}" style="display:none">距截止 <span class="cd-num">--:--:--</span></span>`;
  },

  // 2026-09-10 上线前：倒计时 ticker——每秒更新；距截止 ≤3h 显示、>3h 隐藏、归零转「已截止」
  _startReviewCdTicker: () => {
    if (AppViews._cdTicker) clearInterval(AppViews._cdTicker);
    const tick = () => {
      const chips = Array.from(document.querySelectorAll('.cd-chip[data-cd-dl]'));
      if (!chips.length) { clearInterval(AppViews._cdTicker); AppViews._cdTicker = null; return; }
      const now = Date.now();
      let keep = false;
      for (const c of chips) {
        const dl = new Date(c.dataset.cdDl).getTime();
        const left = dl - now;
        const num = c.querySelector('.cd-num');
        if (left > 3 * 3600 * 1000) { c.style.display = 'none'; continue; } // 超3小时暂不打扰
        c.style.display = 'inline-flex';
        if (left <= 0) { // 已到截止：文案转「已截止」，按钮态由页面下次渲染收敛
          if (num) num.textContent = '已截止';
          c.classList.add('cd-done');
          continue;
        }
        keep = true;
        if (num) num.textContent = AppViews._fmtCd(left);
      }
      if (!keep && chips.every(c => new Date(c.dataset.cdDl).getTime() <= Date.now())) {
        // 全部归零：保留 ticker 也没意义，但需在用户切页时才真正清理（此处继续可让新渲染的 chip 复用）
      }
    };
    tick();
    AppViews._cdTicker = setInterval(tick, 1000);
  },

  _fmtCd: (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = n => String(n).padStart(2, '0');
    return p(h) + ':' + p(m) + ':' + p(s);
  },

  _reviewStatusTag: (r) => {
    if (!r) return '<span class="tag tag-ended">未提交</span>';
    const map = { pending: { t: '待审核', c: 'tag-pending' }, partial: { t: '部分已审', c: 'tag-obj' }, approved: { t: '全部认定', c: 'tag-approved' }, rejected: { t: '全部驳回', c: 'tag-rejected' }, withdrawn: { t: '已退回', c: 'tag-resubmit' } };
    const m = map[r.status] || { t: r.status, c: 'tag-ended' };
    return `<span class="tag ${m.c}">${m.t}</span>`;
  },

  // 2026-09-10 上线前：学生端三态（与详情弹窗聚合口径一致）
  //  - withdrawn → 已退回
  //  - 所有 items ∈ {approved, rejected}（无 pending/resubmit） → 已审核
  //  - 否则 → 未审核
  _reviewStudentStatusTag: (r) => {
    if (!r) return '<span class="tag tag-ended">未提交</span>';
    if (r.status === 'withdrawn') return '<span class="tag tag-resubmit">已退回</span>';
    const items = r.items || [];
    const allDone = items.length > 0 && items.every(it => it.reviewStatus === 'approved' || it.reviewStatus === 'rejected');
    return allDone
      ? '<span class="tag tag-active">已审核</span>'
      : '<span class="tag tag-pending">未审核</span>';
  },
  // 学生端行级（同口径）：withdrawn 份显示已退回；pending/resubmit → 未审核；其余 → 已审核
  _reviewItemStudentTag: (it, reviewStatus) => {
    if (reviewStatus === 'withdrawn') return '<span class="tag tag-resubmit">已退回</span>';
    if (it.reviewStatus === 'pending' || it.reviewStatus === 'resubmit') return '<span class="tag tag-pending">未审核</span>';
    return '<span class="tag tag-active">已审核</span>';
  },

  // 学生端提交复核申请表（一榜/二榜/三榜）
  submitReviewForm: async (round) => {
    const u = App.user;
    const r = AppViews.ROUNDS.find(x => x.key === round);
    let appId = '';
    // 2026-09-10 上线后修复：放宽到「任一段 approved」即可进入复核表——
    //   此前要求 certifiedStatus 与 uncertifiedStatus 同时为 approved，把 88 位
    //   「已认定通过 + 未认定驳回」学生挡在门外。实际上 B 类异议只依赖具体 item
    //   是否被审核通过（item 级别在弹窗内单独校验），C 类智育也不依赖 application 状态，
    //   A 类新增完全独立。所以 application 至少有一段 approved 即放行。
    //   同时显示具体通过情况，让学生对自身状态一目了然。
    try {
      const { applications } = await API.get('/api/my/applications');
      const isAnyApproved = a => a.certifiedStatus === 'approved' || a.uncertifiedStatus === 'approved';
      const app = (applications || []).find(isAnyApproved);
      appId = app ? app.id : '';
      if (!appId) {
        return `<div class="card"><div class="empty">您的原始综测申请尚未通过（已认定/未认定均未审核通过），暂不能申请复核</div></div>`;
      }
    } catch (e) { /* 忽略，提交时后端会再校验 */ }
    return `<div class="card">
      <div class="card-title">📝 ${r.cn}综测复核申请表</div>
      <div class="grid grid-2">
        <div class="form-item"><label>专业</label><input id="rv-major" value="${FMT.esc(u.major || '')}" disabled placeholder="由班级映射自动填"></div>
        <div class="form-item"><label>班级</label><input value="${FMT.esc(u.className)}" disabled></div>
        <div class="form-item"><label>学号</label><input value="${FMT.esc(u.studentId)}" disabled></div>
        <div class="form-item"><label>姓名</label><input value="${FMT.esc(u.name)}" disabled></div>
      </div>
      <hr class="divider">
      <p class="muted mb8">请勾选复核类型（可多选）：</p>
      <div class="row" style="gap:12px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="rv-type-add" onchange="AppViews.onReviewTypeChange('${round}')"> A类·新增加分内容</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="rv-type-objection" onchange="AppViews.onReviewTypeChange('${round}')"> B类·对已审核项目提异议</label>
        ${round !== 'first' ? `<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="rv-type-zhiyu" onchange="AppViews.onReviewTypeChange('${round}')"> C类·智育成绩复核</label>` : ''}
      </div>
      <input type="hidden" id="rv-appid" value="${appId}">
      <div id="rv-type-area" class-mt16>
        <div class="muted" id="rv-type-empty" style="margin-top:14px">请至少勾选一项复核类型（A/B${round !== 'first' ? '/C' : ''}类）</div>
        <!-- A 类区：独立 div，切换显示/隐藏不清空（避免勾 B 时 A 已填内容被擦除，B'-14 修复） -->
        <div id="rv-add-area" style="display:none">
          <div class="card" style="background:var(--info-bg);padding:10px 14px;margin-top:12px;margin-bottom:12px">
            <div class="muted mb8">A类：填写拟新增加的分内容（格式同未认定项目）。<b>所属 10 类别由审核方归类</b>，您无需选择。</div>
            <div id="rv-add-items"></div>
            <button class="btn btn-ghost btn-sm mt8" onclick="AppViews.addReviewAddRow()">+ 添加新增加分项</button>
          </div>
        </div>
        <!-- B 类区：独立 div，仅首次渲染时拉数据；取消时清空 -->
        <div id="rv-obj-area" style="display:none"></div>
        <!-- C 类区：智育复核（仅二/三榜） -->
        <div id="rv-zhiyu-area" style="display:none"></div>
      </div>
      <div class="form-item mt16"><label>备注（选填）</label><textarea id="rv-notes" maxlength="500" placeholder="其他需要说明的情况"></textarea></div>
      <button class="btn btn-primary" onclick="AppViews.doSubmitReview('${round}')">📤 提交${r.cn}复核申请</button>
    </div>`;
  },

  onReviewTypeChange: async (round) => {
    const useAdd = document.getElementById('rv-type-add')?.checked;
    const useObj = document.getElementById('rv-type-objection')?.checked;
    const useZhiyu = document.getElementById('rv-type-zhiyu')?.checked;
    const empty = document.getElementById('rv-type-empty');
    const addArea = document.getElementById('rv-add-area');
    const objArea = document.getElementById('rv-obj-area');
    const zhiyuArea = document.getElementById('rv-zhiyu-area');
    if (!addArea || !objArea) return;
    // 空提示
    if (empty) empty.style.display = (!useAdd && !useObj && !useZhiyu) ? '' : 'none';
    // A 类区：只在取消时清空（用户主动取消）；勾上时若空，自动加一行
    if (useAdd) {
      addArea.style.display = '';
      if (!document.querySelector('#rv-add-items .rv-add-row')) AppViews.addReviewAddRow();
    } else {
      addArea.style.display = 'none';
      // 不清空 #rv-add-items — 学生再次勾选时仍能看到已填的内容；如果用户主动点 × 删行则单独处理
    }
    // B 类区：取消时清空 + 清除缓存标记；勾上时若未加载则拉数据（带 round，展示该榜公示版链末值 + 快照摘要）
    if (useObj) {
      objArea.style.display = '';
      if (!objArea.dataset.loaded) {
        let data = { certified: [], uncertified: [] };
        try { data = await API.get('/api/review/source-items' + (round && round !== 'first' ? '?round=' + round : '')); } catch (e) {}
        const snap = data.snapshot || null;
        objArea.dataset.snapshot = snap ? JSON.stringify(snap) : '';
        const itemRow = (it, kind) => `<div class="sub-card" style="padding:10px;margin-bottom:8px">
          <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
            <input type="checkbox" class="ob-check" data-app="${it.applicationId}" data-item="${it.itemId}" data-kind="${kind}" data-title="${FMT.esc(it.title)}" style="margin-top:4px">
            <div style="flex:1">
              <div><b>${FMT.esc(it.title)}</b> <span class="tag tag-grade">${kind === 'cert' ? '已认定' : '未认定'}</span> <span class="muted">当前 ${fmtNum(it.points)} 分${round && round !== 'first' ? '（该榜公示版值）' : ''}</span></div>
              <div class="row mt8" style="gap:6px;flex-wrap:wrap;align-items:center">
                <input class="ob-req" type="number" step="0.5" placeholder="申请修改为 X 分" style="width:130px;padding:6px;border:1px solid var(--border);border-radius:6px">
                <input class="ob-reason" placeholder="异议理由" style="flex:1;min-width:200px;padding:6px;border:1px solid var(--border);border-radius:6px">
                <span class="tag tag-obj">📎 补充材料</span>
                <input class="ob-proof" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style="flex:1;min-width:160px">
              </div>
            </div>
          </label></div>`;
        const certHtml = (data.certified || []).map(it => itemRow(it, 'cert')).join('') || '<div class="muted">无已认定项目</div>';
        const uncHtml = (data.uncertified || []).map(it => itemRow(it, 'uncert')).join('') || '<div class="muted">无未认定项目</div>';
        const snapHtml = snap ? `<div class="mt8" style="background:var(--warn-bg);padding:8px 12px;border-radius:6px;font-size:13px">📊 您当前该榜公示版分值：德育 <b>${snap.deyu}</b> 分${snap.zhiyu != null ? ` + 智育 <b>${snap.zhiyu}</b> 分 + 体育 <b>${snap.tiyu}</b> 分` : ''}${snap.teacher != null ? ` + 教师评价 <b>${snap.teacher}</b> 分` : ''} = 综测总分 <b>${snap.total}</b> 分</div>` : '';
        objArea.innerHTML = `<div class="card" style="background:var(--info-bg);padding:10px 14px">
          <div class="muted mb8">B类：仅可对<b>已审核通过</b>的已认定/未认定项目提出异议（修改其认定分值）。<b>曾被驳回/未通过的项目不能在此修改</b>，请改用「A类·新增」按新增加分项重新提交。<b style="color:var(--danger)">每个勾选的项目须上传补充材料（证明材料）才能提交</b>。</div>${snapHtml}
          <h4 class="mt8" style="color:var(--primary-dark)">已认定项目（审核通过可异议）</h4>${certHtml}
          <h4 class="mt8" style="color:var(--primary-dark)">未认定项目（审核通过可异议）</h4>${uncHtml}
        </div>`;
        objArea.dataset.loaded = '1';
      }
    } else {
      objArea.style.display = 'none';
      objArea.innerHTML = '';
      delete objArea.dataset.loaded;
      delete objArea.dataset.snapshot;
    }
    // C 类区：智育复核（仅二/三榜）
    if (zhiyuArea) {
      if (useZhiyu) {
        zhiyuArea.style.display = '';
        if (!zhiyuArea.dataset.loaded) {
          let cur = null;
          const cached = objArea.dataset.snapshot ? JSON.parse(objArea.dataset.snapshot) : null;
          if (cached && cached.zhiyu != null) cur = cached.zhiyu;
          else {
            try {
              const data = await API.get('/api/review/source-items?round=' + round);
              if (data.snapshot) { cur = data.snapshot.zhiyu; objArea.dataset.snapshot = JSON.stringify(data.snapshot); }
            } catch (e) {}
          }
          if (cur == null) {
            zhiyuArea.innerHTML = `<div class="card" style="background:var(--warn-bg);padding:10px 14px;margin-top:12px"><div class="muted">当前无智育成绩记录，无法提出智育复核。</div></div>`;
          } else {
            zhiyuArea.innerHTML = `<div class="card" style="background:var(--warn-bg);padding:10px 14px;margin-top:12px">
              <div class="muted mb8">C类：对<b>智育成绩</b>提出复核。当前公示版智育成绩：<b>${fmtNum(cur)} 分</b>。申请分值须在 <b>0~68</b> 之间（与综测智育成绩口径一致）。请上传<b>本学年必修课教务系统成绩截图</b>并填写自算应认定分值。</div>
              <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
                <span class="tag tag-grade">当前 ${fmtNum(cur)} 分</span>
                <input class="zy-apply" type="number" step="0.01" placeholder="自算应认定分值（0~68）" style="width:190px;padding:6px;border:1px solid var(--border);border-radius:6px">
                <input class="zy-reason" placeholder="复核理由" style="flex:1;min-width:200px;padding:6px;border:1px solid var(--border);border-radius:6px">
                <span class="tag tag-obj">📎 教务系统截图（必填）</span>
                <input class="zy-proof" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style="flex:1;min-width:160px">
              </div>
            </div>`;
          }
          zhiyuArea.dataset.loaded = '1';
        }
      } else {
        zhiyuArea.style.display = 'none';
        zhiyuArea.innerHTML = '';
        delete zhiyuArea.dataset.loaded;
      }
    }
  },

  addReviewAddRow: () => {
    const html = `<div class="sub-card rv-add-row" style="padding:10px;margin-bottom:8px">
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
        <select class="rv-type" style="flex:1;min-width:160px;padding:6px;border:1px solid var(--border);border-radius:6px">
          <option>社会实践（媒体类）</option><option>活动/竞赛</option><option>其他</option>
        </select>
        <input class="rv-name" placeholder="名称（如：校级志愿服务先进个人）" style="flex:2;min-width:200px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <input class="rv-level" placeholder="级别" style="width:100px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <input class="rv-date" placeholder="时间" style="width:100px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <input class="rv-unit" placeholder="单位" style="flex:1;min-width:120px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <input class="rv-points" type="number" step="0.5" placeholder="申请加分" style="width:100px;padding:6px;border:1px solid var(--border);border-radius:6px">
        <button class="btn btn-ghost btn-sm" onclick="this.closest('.rv-add-row').remove()">✕</button>
      </div>
      <div class="row mt8" style="gap:6px;flex-wrap:wrap;align-items:center">
        <span class="tag tag-grade">📎 证明材料</span>
        <input class="rv-proof" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style="flex:1;min-width:200px">
      </div>
    </div>`;
    const box = document.getElementById('rv-add-items');
    if (box) box.insertAdjacentHTML('beforeend', html);
  },

  doSubmitReview: async (round) => {
    const useAdd = document.getElementById('rv-type-add')?.checked;
    const useObj = document.getElementById('rv-type-objection')?.checked;
    const useZhiyu = document.getElementById('rv-type-zhiyu')?.checked;
    if (!useAdd && !useObj && !useZhiyu) return toast('请至少勾选一类复核类型（A/B/C类）', 'err');
    const appId = document.getElementById('rv-appid')?.value;
    if (!appId) return toast('未找到已通过的原始申请，无法提交复核', 'err');
    const types = [];
    if (useAdd) types.push('add');
    if (useObj || useZhiyu) types.push('objection');
    let items = [];
    if (useAdd) {
      const rows = [...document.querySelectorAll('#rv-add-items .rv-add-row')];
      const addItems = rows.map(row => ({
        kind: 'add',
        name: row.querySelector('.rv-name').value.trim(),
        type: row.querySelector('.rv-type').value,
        level: row.querySelector('.rv-level').value.trim(),
        date: row.querySelector('.rv-date').value.trim(),
        unit: row.querySelector('.rv-unit').value.trim(),
        points: parseFloat(row.querySelector('.rv-points').value) || 0,
        proofFile: row.querySelector('.rv-proof').files[0] || null,
        proofFileName: row.querySelector('.rv-proof').files[0]?.name || '',
        proofDesc: row.querySelector('.rv-name').value.trim(),
      })).filter(i => i.name);
      for (const it of addItems) {
        if (!it.level) { toast(`新增项「${it.name}」级别不能为空`, 'err'); return; }
        if (!it.date) { toast(`新增项「${it.name}」时间不能为空`, 'err'); return; }
        if (!it.unit) { toast(`新增项「${it.name}」单位不能为空`, 'err'); return; }
        if (it.points === 0) { toast(`新增项「${it.name}」加分不能为空`, 'err'); return; }
        // 2026-09-10 上线前鲁棒性加固：与后端一致的安全界（德育单类目上限 ≤4，>20 必为误填）
        if (!Number.isFinite(it.points) || Math.abs(it.points) > 20) { toast(`新增项「${it.name}」申请加分须在 -20 ~ 20 之间`, 'err'); return; }
        if (!it.proofFile) { toast(`新增项「${it.name}」必须上传证明材料`, 'err'); return; }
      }
      items = items.concat(addItems);
    }
    if (useObj) {
      const checks = [...document.querySelectorAll('#rv-type-area .ob-check')].filter(c => c.checked);
      const objItems = checks.map(c => {
        const row = c.closest('.sub-card');
        const f = row.querySelector('.ob-proof').files[0] || null;
        return {
          kind: 'objection',
          sourceApplicationId: c.dataset.app,
          sourceItemId: c.dataset.item,
          sourceKind: c.dataset.kind,
          requestedPoints: parseFloat(row.querySelector('.ob-req').value) || 0,
          objectionReason: row.querySelector('.ob-reason').value.trim(),
          proofFile: f,
          proofFileName: f?.name || '',
          proofDesc: (row.querySelector('.ob-reason').value.trim()),
        };
      });
      for (const it of objItems) {
        if (it.requestedPoints === 0) { toast('请填写「申请修改为 X 分」', 'err'); return; }
        // 2026-09-10 上线前鲁棒性加固：与后端一致的安全界
        if (!Number.isFinite(it.requestedPoints) || Math.abs(it.requestedPoints) > 20) { toast('B类异议申请修改分值须在 -20 ~ 20 之间', 'err'); return; }
        if (!it.objectionReason) { toast('请填写异议理由', 'err'); return; }
        if (!it.proofFile) { toast('B类异议须上传补充材料（证明材料）才能提交', 'err'); return; }
      }
      items = items.concat(objItems);
    }
    if (useZhiyu) {
      const boxes = [...document.querySelectorAll('#rv-zhiyu-area .card')];
      const zhiyuItems = boxes.map(box => {
        const f = box.querySelector('.zy-proof')?.files[0] || null;
        return {
          kind: 'objection', target: 'zhiyu',
          applyPoints: parseFloat(box.querySelector('.zy-apply')?.value) || 0,
          objectionReason: box.querySelector('.zy-reason')?.value.trim() || '',
          proofFile: f, proofFileName: f?.name || '',
          proofDesc: '智育成绩复核',
        };
      });
      for (const it of zhiyuItems) {
        // 2026-09-10 上线前：智育复核申请分值上限 0~68（与综测智育成绩口径一致）
        if (!(it.applyPoints >= 0 && it.applyPoints <= 68)) { toast('智育复核申请分值须在 0~68 之间', 'err'); return; }
        if (!it.objectionReason) { toast('请填写智育复核理由', 'err'); return; }
        if (!it.proofFile) { toast('请上传本学年必修课教务系统成绩截图', 'err'); return; }
      }
      items = items.concat(zhiyuItems);
    }
    if (!items.length) return toast('请至少填写一项复核事项（至少填一项 A 类行、勾一项 B 类项目或填一项 C 类智育复核）', 'err');
    // 构造 payload（仅带文件的事项标 proofFile:true，按 items 顺序在后端 files 数组中分配）
    const payloadItems = items.map(i => {
      const o = { kind: i.kind, proofFile: !!i.proofFile, proofFileName: i.proofFileName, proofDesc: i.proofDesc };
      if (i.kind === 'add') { o.name = i.name; o.type = i.type; o.level = i.level; o.date = i.date; o.unit = i.unit; o.points = i.points; }
      else {
        o.sourceApplicationId = i.sourceApplicationId; o.sourceItemId = i.sourceItemId; o.sourceKind = i.sourceKind;
        o.requestedPoints = i.requestedPoints; o.objectionReason = i.objectionReason;
        if (i.target === 'zhiyu') { o.target = 'zhiyu'; o.applyPoints = i.applyPoints; }
      }
      return o;
    });
    const fd = new FormData();
    fd.append('payload', JSON.stringify({
      round, types, applicationId: appId,
      major: document.getElementById('rv-major').value.trim(),
      notes: document.getElementById('rv-notes').value.trim(),
      items: payloadItems,
    }));
    items.forEach((i) => { if (i.proofFile) fd.append('files', i.proofFile, i.proofFileName); });
    try {
      await API.upload('/api/reviews', fd);
      toast('复核申请已提交'); App.goto('review');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 复核详情
  viewReviewDetail: async (id) => {
    const { review: r } = await API.get('/api/reviews/' + id);
    const roundCn = AppViews.ROUNDS.find(x => x.key === r.round)?.cn || r.round;
    const isOwner = r.studentId === App.user.id;
    // 2026-09-10：学生/班长查看自己的复核 → 走学生简化视图（仅事项 + 年级已审/未审）
    const isStudentViewer = isOwner && App.user && (App.user.role === 'student' || App.user.role === 'monitor');
    // 缓存 items，供「✏ 修改」弹窗预填（详情页/审核页共用同一份）
    AppViews._lastReviewItems = Object.fromEntries((r.items || []).map(it => [it.id, it]));
    const typeBadge = (it) => it.kind === 'add' ? '<span class="tag tag-grade">A类</span>' : (it.target === 'zhiyu' ? '<span class="tag tag-warning">C类·智育</span>' : '<span class="tag tag-obj">B类</span>');
    // 2026-09-10 上线前：智育（C类）驳回后 admin 也可改——state 范围放宽为 approved|rejected；其他类型仍仅 approved
    const admEditBtn = (it) => (App.user && App.user.role === 'admin' && r.status !== 'withdrawn' && (it.target === 'zhiyu' ? ['approved', 'rejected'].includes(it.reviewStatus) : it.reviewStatus === 'approved'))
      ? `<button class="btn btn-ghost btn-sm" style="color:var(--primary-dark)" onclick="AppViews.reviewItemVerifySecPwd('${r.id}','${it.id}','${it.kind}','${it.reviewStatus}')">✏ 修改</button>` : '';
    // 仅取第一个待补交项用于快捷补交按钮
    const resubmitItem = isOwner ? (r.items || []).find(it => it.reviewStatus === 'resubmit') : null;
    const footHtml = (isOwner && resubmitItem) ? `<div class="modal-foot">
        <button class="btn btn-warning" onclick="AppViews.studentResubmitItem('${r.id}','${resubmitItem.id}')">⚠ 补交材料（${resubmitItem.title ? FMT.esc(resubmitItem.title.slice(0, 12)) : '事项'}）</button>
      </div>` : '';
    // 2026-09-09：整份已退回（作废）→ 顶部原因横幅（学生/审核方均可见）
    const wdNote = r.status === 'withdrawn' ? `<div class="mt8" style="background:var(--warning-bg);color:var(--warning);padding:8px 12px;border-radius:6px">⚠ <b>${r.withdrawnByRole === 'student' ? '本份复核已被撤回（作废）' : '本份复核已被退回作废'}</b>${r.withdrawnBy ? `（${FMT.esc(r.withdrawnBy)} ${FMT.time(r.withdrawnAt || r.updatedAt || r.createdAt)}）` : ''}：${FMT.esc(r.withdrawnReason || '未填写原因')}</div>` : '';
    let h;
    if (isStudentViewer) {
      // 2026-09-10 上线前：学生本生本榜复核——3 列（序号/事项/年级审核），resubmit 项的「补交材料」按钮合并在「年级审核」列末尾
      // （避免之前底部 footHtml 大按钮紧贴弹窗底边造成的误触；同时表头不再出现空「操作」列——学生视图无操作权限）
      const sRows = r.items.map((it, i) => {
        // 2026-09-10：复用 _reviewItemStudentTag helper，保证行级/整份聚合口径一致
        const st = AppViews._reviewItemStudentTag(it, r.status);
        // 2026-09-10：学生简化视图下，resubmit 项在「年级审核」列末尾显示「补交材料」按钮（行内、颜色与 _reviewItemStudentTag 区分）
        const opCell = (isOwner && it.reviewStatus === 'resubmit')
          ? ` <button class="btn btn-warning btn-sm" onclick="AppViews.studentResubmitItem('${r.id}','${it.id}')">补交材料</button>`
          : '';
        return `<tr><td>${i + 1}</td><td>${FMT.esc(it.title || '(未命名事项)')}</td><td style="white-space:nowrap">${st}${opCell}</td></tr>`;
      }).join('');
      // 学生视图：补交按钮已在「年级审核」列末尾行内化，不再渲染底部 footHtml 大按钮（避免误触）
      h = `<div class="modal-head"><h3>${roundCn}综测复核详情</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="sub-meta"><span><b>${FMT.esc(r.studentName)}</b></span><span>学号 ${FMT.esc(r.studentIdNo)}</span><span>${FMT.esc(r.className)}</span></div>
        ${wdNote}
        <div class="table-wrap mt16"><table class="tbl"><thead><tr><th>序号</th><th>事项</th><th>年级审核</th></tr></thead><tbody>${sRows}</tbody></table></div>
      </div>`;
    } else {
      h = `<div class="modal-head"><h3>${roundCn}综测复核详情</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="sub-meta"><span><b>${FMT.esc(r.studentName)}</b></span><span>学号 ${FMT.esc(r.studentIdNo)}</span><span>${FMT.esc(r.className)}</span>${r.major ? `<span>专业 ${FMT.esc(r.major)}</span>` : ''}${r.phone ? `<span>📞 ${FMT.esc(r.phone)}</span>` : ''}</div>
        ${r.notes ? `<div class="mt8" style="background:var(--gray-bg);padding:8px 12px;border-radius:6px">📝 <b>学生备注：</b>${FMT.esc(r.notes)}</div>` : ''}
        ${wdNote}
        <div class="table-wrap mt16"><table class="tbl"><thead><tr><th>序号</th><th>事项</th><th>归类类别</th><th>原分</th><th>申请分</th><th>认定</th><th>审核意见</th><th>证明</th><th>操作</th></tr></thead><tbody>
        ${r.items.map((it, i) => `<tr>
          <td>${i + 1}</td><td>${typeBadge(it)} ${FMT.esc(it.title)}</td><td>${FMT.esc(it.project || (it.kind === 'objection' ? it.sourceCategory || '—' : '待归类'))}</td>
          <td style="text-align:right">${it.originalPoints}</td><td style="text-align:right">${it.requestedPoints}</td>
          <td>${r.status === 'withdrawn' ? '<span class="tag tag-resubmit">已退回</span>' : it.reviewStatus === 'approved' ? `<b style="color:var(--success)">+${it.reviewPoints}</b>` : it.reviewStatus === 'rejected' ? '<span class="tag tag-rejected">驳回</span>' : it.reviewStatus === 'resubmit' ? '<span class="tag tag-pending">待补交</span>' : '<span class="tag tag-pending">待审</span>'}</td>
          <td>${it.reviewComment || (it.reviewStatus === 'rejected' ? `<span style="color:var(--danger)">${FMT.esc(it.rejectReason)}</span>` : '')}${it.reviewProof ? ` <a href="javascript:void(0)" onclick="AppViews.downloadFile('${FMT.esc(it.reviewProof.url)}','${FMT.esc(it.reviewProof.name)}')">📎认定图</a>` : ''}${it.rejectProof ? ` <a href="javascript:void(0)" onclick="AppViews.downloadFile('${FMT.esc(it.rejectProof.url)}','${FMT.esc(it.rejectProof.name)}')">📎驳回图</a>` : ''}</td>
          <td>${it.proof ? `<a href="javascript:void(0)" onclick="AppViews.previewFile('${FMT.esc(it.proof.url)}','${FMT.esc(it.proof.name)}')">${FMT.esc(it.proof.name)}</a>` : ''}</td>
          <td style="white-space:nowrap">${isOwner && it.reviewStatus === 'resubmit' ? `<button class="btn btn-warning btn-sm" onclick="AppViews.studentResubmitItem('${r.id}','${it.id}')">补交材料</button>` : ''}${admEditBtn(it)}</td>
        </tr>`).join('')}
        </tbody></table></div>
      </div>${footHtml}`;
    }
    const box = document.getElementById('modalBox');
    // 2026-09-10 需求#2：复核详情弹窗加宽 min-width:1100px / max-width:96vw（见 style.css .modal-lg）
    // ⚠ 类必须放在 #modalBox 上（外层 .modal 默认 width:560px + overflow:hidden 会裁掉内层宽内容）
    box.className = 'modal modal-lg';
    box.innerHTML = h;
    document.getElementById('modalMask').style.display = 'flex';
  },

  // 学生补交被要求补交的复核材料
  studentResubmitItem: (reviewId, itemId) => {
    openModal(`<div class="modal-head"><h3>补交复核材料</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>补充材料（必填）</label><input id="ri-resubmit-proof" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" required></div>
        <div class="form-item"><label>补充说明（B类异议必填理由）</label><textarea id="ri-resubmit-desc" placeholder="如为异议，请补充理由"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doStudentResubmit('${reviewId}','${itemId}')">确认补交</button></div>`);
  },

  doStudentResubmit: async (reviewId, itemId) => {
    const fd = new FormData();
    const fEl = document.getElementById('ri-resubmit-proof');
    // 2026-09-10 上线前鲁棒性加固：补交必须携带新证明材料（与后端强制一致，防"选填"误导导致 400）
    const f = fEl && fEl.files && fEl.files[0];
    if (!f) { toast('补交必须上传新的证明材料', 'err'); return; }
    fd.append('files', f, f.name);
    const payload = { itemId, objectionReason: document.getElementById('ri-resubmit-desc').value.trim(), proofDesc: f.name };
    fd.append('payload', JSON.stringify(payload));
    try {
      await API.upload(`/api/reviews/${reviewId}/resubmit-item`, fd);
      closeModal(); toast('已补交，等待年级审核'); App.goto('review');
    } catch (e) { toast(e.message, 'err'); }
  },

  // ================= 2026-09-10 需求：复核审核列表「筛选保留」+「待审/已审分区」 =================
  // 状态（模块级缓存，跨重渲染保留）
  _reviewFilterCache: null,   // { q, major, cls } 上次筛选值（换榜/重进仍保留；「重置」清空）
  _reviewGroupPages: null,    // { todo, done, withdrawn } 各分区当前页码（独立分页，互不影响）
  _REVIEW_SEC_PAGE: 20,       // 分区内每页条数（因已审/待审需各自分页，改为前端本地分页）

  // 已审判定（单一来源）：全部事项均已审（approved/rejected）才算「已审」；
  //   已退回(withdrawn) 不计入已审（单独一栏）；无事项视为待审。
  //   用 item 级判定而非 r.status：r.status 存在 partial 等中间态，且历史数据可能未收敛，
  //   与前端 _reviewStudentStatusTag / _reviewItemStudentTag 的学生端口径保持一致。
  _reviewIsDone: (r) => {
    if (!r || r.status === 'withdrawn') return false;
    const items = r.items || [];
    return items.length > 0 && items.every(it => it.reviewStatus === 'approved' || it.reviewStatus === 'rejected');
  },

  // 按榜次过滤后拆分为 待审 / 已审 / 已退回 三组
  _splitReviewsByStatus: (reviews, round) => {
    const filterRound = round !== 'all' ? round : 'first';
    const list = round === 'all' ? reviews : reviews.filter(r => r.round === filterRound);
    const todo = [], done = [], wd = [];
    for (const r of list) {
      if (r.status === 'withdrawn') { wd.push(r); continue; }
      (AppViews._reviewIsDone(r) ? done : todo).push(r);
    }
    return { todo, done, wd, all: list.length };
  },

  // 榜次 tabs（供首渲染与刷新后同步计数）
  _reviewTabsHtml: (counts, round) => {
    const isAll = round === 'all';
    const c = counts || { first: 0, second: 0, third: 0, all: 0 };
    return AppViews.ROUNDS.map(r => `<button class="btn btn-sm ${!isAll && round === r.key ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeReview','${r.key}')">${r.cn}（${c[r.key] || 0}）</button>`).join('')
      + `<button class="btn btn-sm ${isAll ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('gradeReview','all')">全部（${c.all || 0}）</button>`;
  },

  // 三个分区容器（#rv-sections 内），空则整体空态
  _makeSections: (reviews, round) => {
    const g = AppViews._splitReviewsByStatus(reviews, round);
    if (!g.all) return `<div class="card"><div class="empty">当前筛选条件下暂无复核申请</div></div>`;
    let h = AppViews._renderReviewSection(g.todo, round, 'todo');
    h += AppViews._renderReviewSection(g.done, round, 'done');
    if (g.wd.length) h += AppViews._renderReviewSection(g.wd, round, 'withdrawn');
    return h;
  },

  // 单个分区：标题 + 数量 + 卡片 + 独立分页
  _renderReviewSection: (list, round, section) => {
    const meta = {
      todo: { title: '⏳ 待审', empty: '该筛选条件下暂无待审复核' },
      done: { title: '✅ 已审', empty: '该筛选条件下暂无已审复核' },
      withdrawn: { title: '↩️ 已退回 / 作废', empty: '暂无退回记录' },
    }[section];
    const ps = AppViews._REVIEW_SEC_PAGE;
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / ps));
    const pages = AppViews._reviewGroupPages = AppViews._reviewGroupPages || { todo: 1, done: 1, withdrawn: 1 };
    let page = pages[section] || 1;
    if (page > totalPages) page = totalPages;   // 审核后条目减少 → 页码自动收敛，防空白页
    pages[section] = page;
    const slice = list.slice((page - 1) * ps, page * ps);
    const inner = slice.length
      ? slice.map(r => AppViews._renderReviewCard(r, round, section)).join('')
      : `<div class="rv-sec-empty">${meta.empty}</div>`;
    return `<div class="rv-section rv-sec-${section}" id="rv-sec-${section}">
      <div class="rv-sec-head"><span class="rv-sec-title">${meta.title}</span><span class="rv-sec-count">${total}</span></div>
      <div class="rv-sec-body">${inner}</div>
      <div class="rv-sec-pager">${AppViews.__pagerHtml(total, page, totalPages, 'AppViews._goReviewPage_' + section)}</div>
    </div>`;
  },

  // 单张复核卡片（待审/已审/已退回 共用；已审栏按钮改名「查看各项」以区分待审栏的「审核各项」）
  _renderReviewCard: (r, round, section) => {
    // 2026-09-09：整份退回仅 grade/admin 且 pending 可操作；withdrawn 份只读
    const canWithdraw = r.status === 'pending' && App.user && (App.user.role === 'grade' || App.user.role === 'admin');
    const isDone = section === 'done';
    const auditBtn = r.status === 'withdrawn' ? ''
      : `<button class="btn ${isDone ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="AppViews.gradeReviewItem('${r.id}')">${isDone ? '查看各项' : '审核各项'}</button>`;
    const wdBtn = canWithdraw ? `<button class="btn btn-warning btn-sm" onclick="AppViews.reviewWithdraw('${r.id}')">↩ 退回</button>` : '';
    // 2026-09-10：admin 可清除某生某榜次全部复核记录（学生达 2 次上限/超截止后的唯一恢复通道，需二级密码）
    const clrBtn = (App.user && App.user.role === 'admin') ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="AppViews.reviewClearAsk('${r.studentId}','${r.round}','${FMT.esc(r.studentName)}')">🗑 清除该生本榜复核</button>` : '';
    const items = r.items || [];
    const apN = items.filter(i => i.reviewStatus === 'approved').length;
    const rjN = items.filter(i => i.reviewStatus === 'rejected').length;
    return `<div class="sub-card">
      <div class="sub-card-head"><span class="sub-title">${FMT.esc(r.studentName)}（${FMT.esc(r.className)}）· ${AppViews.ROUNDS.find(x => x.key === r.round)?.cn || r.round}</span>${AppViews._reviewStatusTag(r)}</div>
      <div class="sub-desc">复核事项 ${items.length} 项${apN ? `｜已认定 ${apN} 项` : ''}${rjN ? `｜驳回 ${rjN} 项` : ''}${r.status === 'withdrawn' && r.withdrawnReason ? `｜退回原因：${FMT.esc(String(r.withdrawnReason).slice(0, 40))}${String(r.withdrawnReason).length > 40 ? '…' : ''}` : ''}</div>
      ${r.notes ? `<div class="sub-desc" style="color:var(--text-2)">📝 备注：${FMT.esc(r.notes)}</div>` : ''}
      ${auditBtn}
      ${wdBtn}
      ${clrBtn}
      <button class="btn btn-ghost btn-sm" onclick="AppViews.viewStudentApps('${r.id}')">📋 该生综测申请</button>
      <button class="btn btn-ghost btn-sm" onclick="AppViews.viewReviewDetail('${r.id}')">查看</button>
    </div>`;
  },

  // 年级审核列表（按榜次）—— 服务端权限过滤 + 前端分区/分页
  gradeReviewList: async (round = 'first') => {
    AppViews._reviewRound = round;
    // 换榜/首次进入属全新导航：分区页码归 1（筛选值保留，见 _reviewFilterCache）
    AppViews._reviewGroupPages = { todo: 1, done: 1, withdrawn: 1 };
    const f = AppViews._reviewFilterCache || { q: '', major: '', cls: '' };
    const params = { round, status: 'all' };
    if (f.q) params.q = f.q;
    if (f.major) params.major = f.major;
    if (f.cls) params.className = f.cls;
    const res = await API.get('/api/reviews?' + new URLSearchParams(params));
    const reviews = res.reviews || res.data || [];
    const counts = res.roundCounts || { first: 0, second: 0, third: 0, all: 0 };
    const classes = res.classes || [];
    const majors = res.majors || [];
    const majorOpts = ['<option value="">全部专业</option>'].concat(majors.map(m => `<option value="${FMT.esc(m)}" ${f.major === m ? 'selected' : ''}>${FMT.esc(m)}</option>`)).join('');
    const classOpts = ['<option value="">全部班级</option>'].concat(classes.map(c => `<option value="${FMT.esc(c)}" ${f.cls === c ? 'selected' : ''}>${FMT.esc(c)}</option>`)).join('');
    let h = `<div class="filter-bar" id="rv-tabs">${AppViews._reviewTabsHtml(counts, round)}</div>`;
    h += `<div class="query-bar">
        🔍 <b>查询：</b>
        <input id="rv-search" class="uc-input" placeholder="姓名 / 学号" value="${FMT.esc(f.q)}" oninput="AppViews._filterReview()">
        <select id="rv-major" class="uc-sel" onchange="AppViews._filterReview()">${majorOpts}</select>
        <select id="rv-class" class="uc-sel" onchange="AppViews._filterReview()">${classOpts}</select>
        <button class="btn btn-sm btn-primary" onclick="AppViews._filterReview()">查询</button>
        <button class="btn btn-sm" onclick="AppViews._resetReview()">重置</button>
      </div>`;
    h += `<div id="rv-sections">${AppViews._makeSections(reviews, round)}</div>`;
    return h;
  },

  _reviewReadFilters() {
    // 读取时回写缓存 → 任何重渲染都不会丢筛选
    const f = {
      q: (document.getElementById('rv-search')?.value || '').trim(),
      major: (document.getElementById('rv-major')?.value || '').trim(),
      cls: (document.getElementById('rv-class')?.value || '').trim(),
    };
    AppViews._reviewFilterCache = f;
    return f;
  },

  // 2026-09-10 核心：审核/退回/清除后刷新列表，**保留筛选条件与分区页码**、不清空输入框、滚动回顶部
  //   不调用 App.goto（goto 会整页重渲染 → 筛选栏 DOM 被销毁导致筛选丢失）
  _reviewReload: async () => {
    const round = AppViews._reviewRound || 'first';
    const f = AppViews._reviewReadFilters();   // 从现存 DOM 读取（筛选栏未被销毁）
    const params = { round, status: 'all' };
    if (f.q) params.q = f.q;
    if (f.major) params.major = f.major;
    if (f.cls) params.className = f.cls;
    let res;
    try {
      res = await API.get('/api/reviews?' + new URLSearchParams(params));
    } catch (e) { return toast(e.message || '刷新失败', 'err'); }
    const wrap = document.getElementById('rv-sections');
    // 兜底：容器不在（当前已不在复核审核页）→ 退回整页重渲染
    if (!wrap) return App.goto('gradeReview', round);
    wrap.innerHTML = AppViews._makeSections(res.reviews || res.data || [], round);
    const tabs = document.getElementById('rv-tabs');
    if (tabs) tabs.innerHTML = AppViews._reviewTabsHtml(res.roundCounts, round);  // 清除/退回后 tabs 计数同步
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (_) { window.scrollTo(0, 0); }
  },

  // 分区独立翻页（__pagerHtml 以字符串形式回调，故需三个具名包装）
  _goReviewPage_todo: (p) => AppViews._goReviewPage('todo', p),
  _goReviewPage_done: (p) => AppViews._goReviewPage('done', p),
  _goReviewPage_withdrawn: (p) => AppViews._goReviewPage('withdrawn', p),
  _goReviewPage: (section, page) => {
    AppViews._reviewGroupPages = AppViews._reviewGroupPages || { todo: 1, done: 1, withdrawn: 1 };
    AppViews._reviewGroupPages[section] = page;
    return AppViews._reviewReload();
  },

  _filterReview: () => {
    clearTimeout(AppViews.__reviewTimer);
    AppViews._reviewGroupPages = { todo: 1, done: 1, withdrawn: 1 };  // 筛选变化 → 分区页码归 1
    AppViews.__reviewTimer = setTimeout(() => AppViews._reviewReload(), 300);
  },
  _resetReview: () => {
    for (const id of ['rv-search', 'rv-major', 'rv-class']) { const e = document.getElementById(id); if (e) e.value = ''; }
    AppViews._reviewFilterCache = { q: '', major: '', cls: '' };
    AppViews._reviewGroupPages = { todo: 1, done: 1, withdrawn: 1 };
    AppViews._reviewReload();
  },

  // 2026-09-10：复核审核界面——查看该生综测申请（已认定/未认定）情况
  //   复用综测申请总览的详情渲染（_appDetailHtml），一次展示该生全部申请（多份时按时间倒序分段）
  //   用 openPreview 独立层（z-index 150）而非 openModal：从审核弹窗内点开时不会覆盖原弹窗，
  //   关闭查看后审核弹窗原样保留，可继续逐项审核。
  viewStudentApps: async (reviewId) => {
    let res;
    try {
      res = await API.get('/api/reviews/' + reviewId + '/student-applications');
    } catch (e) { return toast(e.message || '加载失败', 'err'); }
    const apps = res.applications || [];
    if (!apps.length) return toast('该生暂无综测申请记录', 'err');
    const sections = apps.map((a, i) => {
      const head = apps.length > 1
        ? `<div class="sub-card-head" style="margin-top:${i ? 16 : 0}px"><span class="sub-title">第 ${i + 1} 份综测申请</span><span class="muted">${FMT.time(a.createdAt)}</span></div>`
        : '';
      return `<div class="sub-card" style="padding:12px 14px;margin-bottom:12px">${head}${AppViews._appDetailHtml(a, false, true)}</div>`;
    }).join('');
    openPreview(`<div class="modal-head"><h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:12px">综测申请情况 — ${FMT.esc(res.studentName || '')}（${FMT.esc(res.className || '')}）</h3><button class="modal-close" onclick="AppViews._closePreview()">×</button></div>
      <div class="preview-body" style="text-align:left;background:#fff;padding:16px">
        <div class="muted mb8">共 ${apps.length} 份综测申请（按提交时间倒序），供复核审核时对照原始申请依据。</div>
        ${sections}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="AppViews._closePreview()">关闭</button></div>`);
  },

  // 年级逐项审核
  gradeReviewItem: async (id) => {
    const { review: r } = await API.get('/api/reviews/' + id);
    // 缓存 items，给 reviewItemAction 用（弹窗展示原分/申请分）
    AppViews._lastReviewItems = Object.fromEntries((r.items || []).map(it => [it.id, it]));
    const roundCn = AppViews.ROUNDS.find(x => x.key === r.round)?.cn || r.round;
    // 2026-08-17 B'-16：admin 端对已审项可见"✏ 修改"按钮（点开需二级密码验证）
    const isAdmin = App.user && App.user.role === 'admin';
    // 2026-09-09：整份退回（作废）仅 grade/admin 且该份 pending（未审核）可操作
    const canWithdraw = r.status === 'pending' && App.user && (App.user.role === 'grade' || App.user.role === 'admin');
    const wdNote = r.status === 'withdrawn' ? `<div class="mt8" style="background:var(--warning-bg);color:var(--warning);padding:8px 12px;border-radius:6px">⚠ <b>${r.withdrawnByRole === 'student' ? '本份复核已被学生撤回（作废）' : '本份复核已被整份退回作废'}</b>${r.withdrawnBy ? `（${FMT.esc(r.withdrawnBy)} ${FMT.time(r.withdrawnAt || r.updatedAt || r.createdAt)}）` : ''}：${FMT.esc(r.withdrawnReason || '未填写原因')}</div>` : '';
    const rows = r.items.map((it, i) => {
      const typeBadge = it.kind === 'add' ? '<span class="tag tag-grade">A类·新增</span>' : (it.target === 'zhiyu' ? '<span class="tag tag-warning">C类·智育</span>' : '<span class="tag tag-obj">B类·异议</span>');
      const extra = it.kind === 'objection' ? `<div class="muted mt4">原分 ${it.originalPoints} → 申请改 ${it.requestedPoints}（${FMT.esc(it.objectionReason || '')}）</div>` : '';
      // withdrawn 份只读：不渲染逐项审核按钮
      const acts = r.status === 'withdrawn' ? '<span class="tag tag-resubmit">已退回</span>' : (it.reviewStatus === 'pending' ? `
        <button class="btn btn-success btn-sm" onclick="AppViews.reviewItemAction('${r.id}','${it.id}','approve','${it.kind}')">认定</button>
        <button class="btn btn-danger btn-sm" onclick="AppViews.reviewItemAction('${r.id}','${it.id}','reject','${it.kind}')">驳回</button>
        <button class="btn btn-warning btn-sm" onclick="AppViews.reviewItemResubmit('${r.id}','${it.id}')">要求补交</button>` :
        it.reviewStatus === 'resubmit' ? `<span class="tag tag-pending">待学生补交</span>` :
        `<span class="tag ${it.reviewStatus === 'approved' ? 'tag-active' : 'tag-rejected'}">${it.reviewStatus === 'approved' ? '已认定 +' + it.reviewPoints : '驳回'}</span>`);
      // 2026-09-10 上线前：智育（C类）驳回后 admin 也可二次修改——放行 zhiyu + approved|rejected；其他类型仍排除 pending
      const editBtn = (isAdmin && r.status !== 'withdrawn' && (it.target === 'zhiyu' ? ['approved', 'rejected'].includes(it.reviewStatus) : it.reviewStatus !== 'pending')) ? `<button class="btn btn-ghost btn-sm" style="margin-left:6px;color:var(--primary-dark)" onclick="AppViews.reviewItemVerifySecPwd('${r.id}','${it.id}','${it.kind}','${it.reviewStatus}')">✏ 修改</button>` : '';
      return `<tr>
      <td>${i + 1}</td><td>${typeBadge} ${FMT.esc(it.title)}</td><td>${FMT.esc(it.project || (it.kind === 'objection' ? it.sourceCategory || '—' : '待归类'))}</td>
      <td style="text-align:right">${it.originalPoints}</td><td style="text-align:right">${it.requestedPoints}</td>
      <td>${acts}${editBtn}</td></tr>${extra ? `<tr><td colspan="6">${extra}</td></tr>` : ''}`;
    }).join('');
    const h = `<div class="modal-head"><h3>${roundCn}复核审核 — ${FMT.esc(r.studentName)}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="sub-meta" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap"><span>${FMT.esc(r.className)}</span><span>学号 ${FMT.esc(r.studentIdNo)}</span>${r.major ? `<span>${FMT.esc(r.major)}</span>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="AppViews.viewStudentApps('${r.id}')">📋 查看该生综测申请（已认定/未认定）</button>
        </div>
        ${wdNote}
        ${canWithdraw ? `<div class="mt8" style="display:flex;justify-content:flex-end"><button class="btn btn-warning btn-sm" onclick="AppViews.reviewWithdraw('${r.id}')">↩ 退回整份（作废，学生可重新提交）</button></div>` : ''}
        <div class="table-wrap mt8"><table class="tbl"><thead><tr><th>序号</th><th>事项</th><th>归类类别</th><th>原分</th><th>申请分</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    const box = document.getElementById('modalBox');
    // 2026-09-10 需求#2：复核审核弹窗与详情弹窗统一宽度
    // ⚠ 类必须放在 #modalBox 上（外层 .modal 默认 width:560px + overflow:hidden 会裁掉内层宽内容）
    box.className = 'modal modal-lg';
    box.innerHTML = h;
    document.getElementById('modalMask').style.display = 'flex';
  },

  // 年级认定/驳回单个事项（kind: add=新增需归类 / objection=异议）
  // 2026-08-17 B'-14：弹窗头部显示原分/申请分；删除「认定图片」栏（驳回图片保留）
  reviewItemAction: (reviewId, itemId, action, kind) => {
    const t = action === 'approve' ? '认定' : '驳回';
    const catSel = (action === 'approve' && kind === 'add') ? `<div class="form-item"><label>归属类别（10 类之一，必填）</label><select id="ri-project" style="padding:6px;border:1px solid var(--border);border-radius:6px">${AppViews.REVIEW_PROJECTS.map(p => `<option>${p}</option>`).join('')}</select></div>` : '';
    // 从最近打开的 review 缓存取 item 数据；可能为 undefined（直接通过 API 进入），按 0 显示
    const it = (AppViews._lastReviewItems && AppViews._lastReviewItems[itemId]) || {};
    // 2026-09-10 上线前鲁棒性加固：认定分值输入动态边界（智育 0~68 / 德育 -20~20，与后端一致提前拦截）
    const isZhi = it.target === 'zhiyu';
    const ptsLim = isZhi ? ' min="0" max="68" step="0.01"' : ' min="-20" max="20" step="0.5"';
    const opScore = (it.originalPoints === undefined || it.originalPoints === null) ? '0' : fmtNum(it.originalPoints);
    const reqScore = (it.requestedPoints === undefined || it.requestedPoints === null) ? '—' : fmtNum(it.requestedPoints);
    const scoreInfo = `<div class="form-item" style="background:var(--gray-bg);padding:10px 14px;border-radius:6px;display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">
      <span>原分：<b>${opScore}</b></span>
      <span>申请分：<b>${reqScore}</b></span>
    </div>`;
    openModal(`<div class="modal-head"><h3>${t}复核事项</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        ${scoreInfo}
        ${catSel}
        ${action === 'approve' ? `<div class="form-item"><label>认定加分分值（必填，${isZhi ? '0~68' : '-20~20'}）</label><input id="ri-points" type="number"${ptsLim} placeholder="如 1"></div>
        <div class="form-item"><label>认定原因（支持文字和图片）</label><textarea id="ri-comment" placeholder="请填写认定依据"></textarea></div>` :
        `<div class="form-item"><label>驳回原因（必填，支持文字和图片）</label><textarea id="ri-comment" placeholder="请填写驳回原因"></textarea></div>
        <div class="form-item"><label>驳回图片（选填）</label><input id="ri-proof" type="file" accept=".jpg,.jpeg,.png,.pdf"></div>`}
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-${action === 'approve' ? 'success' : 'danger'}" onclick="AppViews.doReviewItem('${reviewId}','${itemId}','${action}')">确认${t}</button></div>`);
  },

  doReviewItem: async (reviewId, itemId, action) => {
    const fd = new FormData();
    const payload = { itemId, action };
    const f = document.getElementById('ri-proof');
    if (f && f.files[0]) {
      fd.append('files', f.files[0], 'review_' + f.files[0].name);
      payload.rejectProofName = f.files[0].name;
    }
    if (action === 'approve') {
      const p = document.getElementById('ri-points').value;
      if (!p && p !== 0) return toast('请填写认定加分分值', 'err');
      const pv = parseFloat(p);
      // 2026-09-10 上线前鲁棒性加固：提交前范围校验（与后端一致；防 Infinity/手滑超大值触发 400）
      const _it = (AppViews._lastReviewItems && AppViews._lastReviewItems[itemId]) || {};
      if (!Number.isFinite(pv)) return toast('认定分值必须为有效数字', 'err');
      if (_it.target === 'zhiyu') { if (pv < 0 || pv > 68) return toast('智育复核（C类）认定分值须在 0~68 之间', 'err'); }
      else if (Math.abs(pv) > 20) return toast('德育单项认定分值须在 -20 ~ 20 之间', 'err');
      payload.reviewPoints = pv;
      payload.reviewComment = document.getElementById('ri-comment').value.trim();
      const projEl = document.getElementById('ri-project');
      if (projEl) payload.project = projEl.value;
    } else {
      payload.rejectReason = document.getElementById('ri-comment').value.trim();
      if (!payload.rejectReason) return toast('请填写驳回原因', 'err');
    }
    fd.append('payload', JSON.stringify(payload));
    try {
      await API.upload(`/api/reviews/${reviewId}/review-item`, fd);
      // 2026-09-10：认定/驳回后关闭弹窗、刷新该榜次复核审核列表
      // ⚠ 用 _reviewReload 而非 App.goto：goto 整页重渲染会清空筛选栏 → 筛选丢失（用户需求：认定后保留筛选）
      closeModal(); toast('已审核');
      await AppViews._reviewReload();
    } catch (e) { toast(e.message, 'err'); }
  },

  // 年级要求补交单个复核事项
  reviewItemResubmit: (reviewId, itemId) => {
    openModal(`<div class="modal-head"><h3>要求补交材料</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>补交说明（选填）</label><textarea id="ri-resubmit-reason" placeholder="请说明需要补充的材料"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doReviewItemResubmit('${reviewId}','${itemId}')">确认要求补交</button></div>`);
  },

  doReviewItemResubmit: async (reviewId, itemId) => {
    // 后端 /api/reviews/:id/review-item 统一从 req.body.payload 解析（与 approve/reject 一致，走 multipart FormData）
    const fd = new FormData();
    const payload = { itemId, action: 'resubmit', rejectReason: document.getElementById('ri-resubmit-reason').value.trim() };
    fd.append('payload', JSON.stringify(payload));
    try {
      await API.upload(`/api/reviews/${reviewId}/review-item`, fd);
      // 2026-09-10：与认定/驳回一致 —— 完成后刷新复核审核列表（保留筛选）
      closeModal(); toast('已要求补交，学生将收到通知');
      await AppViews._reviewReload();
    } catch (e) { toast(e.message, 'err'); }
  },

  // 2026-09-09：整份退回复核申请（作废重建）。确认弹窗 → POST /api/reviews/:id/withdraw
  reviewWithdraw: (reviewId) => {
    openModal(`<div class="modal-head"><h3>退回整份复核申请</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>退回原因（必填，将通知学生）</label><textarea id="ri-withdraw-reason" placeholder="请说明退回原因（如：材料不符合要求 / 误提交 / 需重新整理）" style="width:100%;min-height:80px;padding:8px"></textarea></div>
        <div class="muted mt8" style="font-size:12px">⚠ 退回后该份复核将作废（不可恢复），学生可重新提交一份全新复核。同一学生同一榜次累计最多退回 2 次。</div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doReviewWithdraw('${reviewId}')">确认退回作废</button></div>`);
  },

  doReviewWithdraw: async (reviewId) => {
    const reason = ((document.getElementById('ri-withdraw-reason') || {}).value || '').trim();
    if (!reason) return toast('请填写退回原因', 'err');
    try {
      await API.post(`/api/reviews/${reviewId}/withdraw`, { reason });
      closeModal(); toast('已退回，学生将收到通知并可重新提交');
      await AppViews._reviewReload();
    } catch (e) { toast(e.message, 'err'); }
  },

  // 2026-09-10：学生主动撤回自己未审核的复核（确认弹窗，原因选填）→ POST /api/reviews/:id/self-withdraw
  reviewSelfWithdrawAsk: (reviewId) => {
    openModal(`<div class="modal-head"><h3>撤回复核申请</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8" style="color:var(--warning)">⚠ 撤回后本份复核将作废（不可恢复）。同一学生同一榜次累计撤回/被退回最多 2 次，请确认信息无误后再提交。</div>
        <div class="form-item"><label>撤回原因（选填）</label><textarea id="ri-self-wd-reason" placeholder="如：信息填写有误，需修改后重新提交" style="width:100%;min-height:70px;padding:8px"></textarea></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-warning" onclick="AppViews.doReviewSelfWithdraw('${reviewId}')">确认撤回</button></div>`);
  },

  doReviewSelfWithdraw: async (reviewId) => {
    const reason = ((document.getElementById('ri-self-wd-reason') || {}).value || '').trim();
    try {
      await API.post(`/api/reviews/${reviewId}/self-withdraw`, { reason });
      closeModal(); toast('已撤回，如需复核可重新提交');
      App.goto('review');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 2026-09-10：admin 清除某生某榜次全部复核记录（学生达 2 次上限/超截止后的唯一恢复通道；二级密码验证）
  reviewClearAsk: (studentId, round, studentName) => {
    const roundCn = AppViews.ROUNDS.find(x => x.key === round)?.cn || round;
    openModal(`<div class="modal-head"><h3>清除复核记录 — 二级密码验证</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8" style="color:var(--danger)">⚠ 将<b>永久删除</b> ${FMT.esc(studentName)} 在<b>${roundCn}复核</b>的全部记录（含历史退回/撤回记录），删除后该生可重新提交一份全新复核。此操作不可恢复！</div>
        <div class="form-item"><label>二级审核密码（必填）</label><input id="ri-clear-pwd" type="password" placeholder="请输入二级审核密码" style="width:100%;padding:8px" autocomplete="off"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-danger" onclick="AppViews.doReviewClear('${studentId}','${round}')">确认清除</button></div>`);
  },

  doReviewClear: async (studentId, round) => {
    const pwd = (document.getElementById('ri-clear-pwd') || {}).value || '';
    if (!pwd) return toast('请输入二级审核密码', 'err');
    try {
      await API.post('/api/admin/reviews/clear', { studentId, round, secondaryPassword: pwd });
      closeModal(); toast('已清除，该生可重新提交复核');
      await AppViews._reviewReload();
    } catch (e) { toast(e.message, 'err'); }
  },

  // 2026-08-17 B'-16：admin 修改已审项：先弹二级密码验证
  reviewItemVerifySecPwd: (reviewId, itemId, kind, currentStatus) => {
    openModal(`<div class="modal-head"><h3>修改已审事项 — 二级密码验证</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">⚠ 修改已审结果会覆盖原审核记录，请确认后再操作。当前事项状态：<b>${currentStatus === 'approved' ? '已认定' : currentStatus === 'rejected' ? '驳回' : '待补交'}</b>。</div>
        <div class="form-item"><label>二级审核密码（必填）</label><input id="ri-edit-pwd" type="password" placeholder="请输入二级审核密码" style="width:100%;padding:8px" autocomplete="off"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AppViews.reviewItemEditChooser('${reviewId}','${itemId}','${kind}')">下一步</button></div>`);
  },

  // 二级密码验证通过 → 2026-09-10 需求#3：直接修改已认定事项（覆盖生效）；驳回/待补交项仍可走原审核动作
  reviewItemEditChooser: async (reviewId, itemId, kind) => {
    const pwd = (document.getElementById('ri-edit-pwd') || {}).value || '';
    if (!pwd) return toast('请输入二级审核密码', 'err');
    try {
      await API.post('/api/me/verify-secondary', { secondaryPassword: pwd });
    } catch (e) {
      return toast(e.message || '二级密码验证失败', 'err');
    }
    AppViews.__editPwd = pwd; // 供 doReviewItemEdit 直接提交（避免二次输入）
    const it = (AppViews._lastReviewItems && AppViews._lastReviewItems[itemId]) || {};
    // 2026-09-10 上线前：智育（C类）驳回后 admin 也可直改分值——zhiyu 目标 approved|rejected 均视为可直改
    const isApproved = it.reviewStatus === 'approved';
    const isZhiyuDirect = it.target === 'zhiyu' && it.reviewStatus === 'rejected';
    const isDirectEditable = isApproved || isZhiyuDirect;
    const curPts = (it.reviewPoints === undefined || it.reviewPoints === null) ? '' : it.reviewPoints;
    const curCat = it.project || (it.kind === 'objection' ? (it.sourceCategory || '') : '');
    // 已认定/智育驳回 → 直接改字段；否则仅提供审核动作（重新认定/驳回/要求补交）
    let editForm = '';
    if (isDirectEditable) {
      const catOpts = AppViews.REVIEW_PROJECTS.map(p => `<option value="${FMT.esc(p)}" ${p === curCat ? 'selected' : ''}>${p}</option>`).join('');
      const nameField = kind === 'add' ? `<div class="form-item"><label>项目名称（对应「加减分说明」中的文字）</label><input id="ri-edit-name" value="${FMT.esc(it.title || '')}" maxlength="200" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px"></div>` : '';
      const catField = kind === 'add'
        ? `<div class="form-item"><label>归属类别（10 类之一）</label><select id="ri-edit-cat" style="padding:6px;border:1px solid var(--border);border-radius:6px">${catOpts}</select></div>`
        : `<div class="form-item"><label>归属类别</label><input value="${FMT.esc(curCat || '跟随原项目')}" disabled style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--gray-bg)"></div>`;
      // 2026-09-10 上线前：智育 C 类分值输入步长 0.01 + 上限 68 提示；其他类型保持 0.5 步长
      const isZhiyu = it.target === 'zhiyu';
      const ptsStep = isZhiyu ? '0.01' : '0.5';
      const ptsPlaceholder = isZhiyu ? '0~68（智育）' : '';
      const kindTag = isZhiyu ? 'C类·智育' : (kind === 'add' ? 'A类·新增' : 'B类·异议');
      const subNote = isZhiyu ? '智育（C类）分值上限 0~68；名称/类别不可改（跟随原始申请）。' : '仅已认定事项可这样直接改；若需改判为驳回/要求补交，用下方动作按钮。';
      editForm = `<div class="mt8" style="border:1px solid var(--border);border-radius:10px;padding:14px;background:var(--gray-bg)">
        <div class="muted mb8" style="color:var(--warning)">✏ 直接修改（覆盖生效，不重新进入待审；记日志、不通知学生）</div>
        <div class="form-item" style="margin-bottom:10px"><label>当前事项：<b>${kindTag}</b>　认定分 <b>${isZhiyu ? curPts : '+' + curPts}</b></label></div>
        ${nameField}
        ${catField}
        <div class="form-item"><label>认定加分分值（数字，可直接改）</label><input id="ri-edit-points" type="number" step="${ptsStep}" min="0" ${isZhiyu ? 'max="68"' : ''} value="${FMT.esc(curPts)}" placeholder="${ptsPlaceholder}" style="width:160px;padding:8px;border:1px solid var(--border);border-radius:6px"></div>
        <div class="muted" style="font-size:12px">${subNote}</div>
      </div>`;
    }
    const actRow = `<div class="mt8" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="muted" style="font-size:13px">其它审核动作：</span>
      <button class="btn btn-success btn-sm" onclick="closeModal();AppViews.reviewItemAction('${reviewId}','${itemId}','approve','${kind}')">✅ 重新认定</button>
      <button class="btn btn-danger btn-sm" onclick="closeModal();AppViews.reviewItemAction('${reviewId}','${itemId}','reject','${kind}')">❌ 驳回</button>
      <button class="btn btn-warning btn-sm" onclick="closeModal();AppViews.reviewItemResubmit('${reviewId}','${itemId}')">📝 要求补交</button>
    </div>`;
    const foot = isDirectEditable ? `<div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="AppViews.doReviewItemEdit('${reviewId}','${itemId}','${kind}')">💾 保存覆盖</button></div>` : `<div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">关闭</button></div>`;
    openModal(`<div class="modal-head"><h3>${isDirectEditable ? '修改已审事项' : '处理已审事项'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">二级密码验证通过。事项状态：<b>${it.reviewStatus === 'approved' ? '已认定' : it.reviewStatus === 'rejected' ? '驳回' : '待补交'}</b>${isDirectEditable ? '' : '（非已认定状态仅可走下方审核动作重新判定）'}。</div>
        ${editForm}${isDirectEditable ? '<hr class="divider">' : ''}
        ${actRow}
      </div>${foot}`);
  },

  // 2026-09-10 需求#3：保存直接修改 → POST /api/admin/reviews/:id/edit-item
  doReviewItemEdit: async (reviewId, itemId, kind) => {
    const pwd = AppViews.__editPwd || '';
    if (!pwd) return toast('请重新验证二级密码', 'err');
    const payload = { itemId, secondaryPassword: pwd };
    if (kind === 'add') {
      payload.name = ((document.getElementById('ri-edit-name') || {}).value || '').trim();
      const catEl = document.getElementById('ri-edit-cat');
      if (catEl) payload.category = catEl.value;
    }
    const ptsEl = document.getElementById('ri-edit-points');
    if (ptsEl) {
      const p = parseFloat(ptsEl.value);
      if (ptsEl.value === '' || Number.isNaN(p) || p < 0) return toast('认定分值不能为空且须为不小于 0 的数字', 'err');
      // 2026-09-10 上线前：智育 C 类分值上限 0~68（前端先拦，避免无谓 400）
      const targetOf = (AppViews._lastReviewItems && AppViews._lastReviewItems[itemId] || {}).target;
      if (targetOf === 'zhiyu' && p > 68) return toast('智育复核（C类）认定分值须在 0~68 之间', 'err');
      payload.points = p;
    }
    try {
      await API.post(`/api/admin/reviews/${reviewId}/edit-item`, payload);
      // 2026-09-10：覆盖保存后同样关闭并回到该榜次审核列表（从详情/审核弹窗发起编辑均回到列表，层级一致）
      closeModal(); toast('✅ 已覆盖生效（已记日志，未通知学生）');
      await AppViews._reviewReload();
    } catch (e) { toast(e.message || '修改失败', 'err'); }
  },

  // 班长查看复核（只读）
  // 与年级端同步：仅 admin 勾选 X 榜开放 OR 该榜已有数据 → 显示该榜 tab 与列表
  monReviewList: async (round = 'all') => {
    const cfg = await API.get('/api/config');
    const roundsOpen = cfg.reviewRounds || {};
    const { reviews } = await API.get('/api/reviews?round=all&status=all');
    const visibleRounds = AppViews.ROUNDS.filter(r => roundsOpen[r.key] || reviews.some(x => x.round === r.key));
    if (!visibleRounds.length) {
      return '<div class="card"><div class="empty">当前暂无开放的复核榜次，请等待年级开启</div></div>';
    }
    if (round !== 'all' && !visibleRounds.find(r => r.key === round)) round = 'all';
    const list = round === 'all' ? reviews : reviews.filter(r => r.round === round);
    const tabs = visibleRounds.map(r =>
      `<button class="btn btn-sm ${round === r.key ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('monReview','${r.key}')">${r.cn}（${reviews.filter(x => x.round === r.key).length}）</button>`
    ).join('');
    let h = `<div class="filter-bar">${tabs}<button class="btn btn-sm ${round === 'all' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('monReview','all')">全部</button></div>`;
    if (!list.length) return h + `<div class="card"><div class="empty">本班暂无复核申请</div></div>`;
    h += `<div class="card"><div class="card-title">综测复核（只读）</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>学生</th><th>榜次</th><th>事项数</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>
      ${list.map(r => `<tr><td>${FMT.esc(r.studentName)}</td><td>${AppViews.ROUNDS.find(x=>x.key===r.round)?.cn || r.round}</td><td>${r.items.length}</td><td>${AppViews._reviewStatusTag(r)}</td><td>${FMT.time(r.createdAt)}</td><td><button class="btn btn-ghost btn-sm" onclick="AppViews.viewReviewDetail('${r.id}')">查看</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    return h;
  },
};

/* ================= 管理员端 ================= */
const AdminViews = {

  users: async (q = {}) => {
    const { users, classes } = await API.adminUsers({ role: q.role || 'all', className: q.className || 'all' });
    const isAdmin = !!(App.user && App.user.role === 'admin');
    window._adminUsers = users;       // 分页/搜索用（性能优化 2026-08-30：1043 行改为每页 100 行）
    window._adminUserQ = q || {};
    window._adminUserPage = 1;
    window._adminSelectedUids = new Set(); // 跨页全选持久化（2026-09-01：全选改造）
    window._adminPageUids = [];
    const byClass = {};
    users.forEach(u => byClass[u.className] = (byClass[u.className] || 0) + 1);
    let h = `<div class="card"><div class="card-title">👥 账号管理 <span class="sub">共 <span id="au-total">${users.length}</span> 人</span>
        <button class="btn btn-warning btn-sm" onclick="AdminViews.batchUpdateUsers()">✏️ 批量修改</button>
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="AdminViews.batchFreezeUsers(true)">❄️ 批量冻结</button>
        <button class="btn btn-ghost btn-sm" onclick="AdminViews.batchFreezeUsers(false)">✅ 批量解冻</button>
        <button class="btn btn-warning btn-sm" onclick="AdminViews.batchClearSubmissions()">🧹 批量清除提交</button>
        <button class="btn btn-danger btn-sm" onclick="AdminViews.batchDeleteUsers()">🗑 批量删除</button>` : ''}
        <button class="btn btn-primary btn-sm" onclick="AdminViews.createUser()">➕ 新建账号</button></div>
      <div class="filter-bar">
        <select onchange="App.goto('adminUsers',{role:this.value})">
          <option value="all" ${!q.role || q.role === 'all' ? 'selected' : ''}>全部角色</option>
          <option value="student" ${q.role === 'student' ? 'selected' : ''}>学生</option>
          <option value="monitor" ${q.role === 'monitor' ? 'selected' : ''}>班长</option>
          <option value="grade" ${q.role === 'grade' ? 'selected' : ''}>年级</option>
          <option value="admin" ${q.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
        <select onchange="App.goto('adminUsers',{role:'${q.role || 'all'}',className:this.value})">
          <option value="all">全部班级</option>
          ${classes.map(c => `<option ${q.className === c ? 'selected' : ''}>${FMT.esc(c)}</option>`).join('')}
        </select>
        <input id="au-search" placeholder="🔍 搜索 账号/姓名/学号" oninput="AdminViews._usersRender()" style="flex:1;min-width:160px;padding:7px;border:1px solid var(--border);border-radius:6px">
      </div>
      <div class="mt8 mb8" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="AdminViews._selectAllFiltered()" title="选中当前筛选/搜索条件下的全部账号（跨页）">☑ 全选当前筛选下全部</button>
        <span id="au-selcount" class="muted" style="font-size:12px;white-space:nowrap">已选 <b>0</b> 人</span>
        <span class="muted" style="font-size:12px">表头复选框 = 全选本页；批量操作作用于全部已选账号（跨页有效）</span>
      </div>
      <div class="table-wrap"><table class="tbl tbl-admin"><thead><tr>
        <th style="width:32px"><input type="checkbox" id="au-checkall" onchange="AdminViews._togglePageAll(this.checked)" title="全选本页"></th>
        <th>账号</th><th>姓名</th><th>角色</th><th>班级</th><th>操作</th>
      </tr></thead><tbody id="au-tbody"></tbody></table></div>
      <div id="au-pager" class="mt12" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div>
    </div>`;
    // DOM 插入后渲染表格（分页）
    setTimeout(() => AdminViews._usersRender(), 50);
    return h;
  },
  // 分页 + 搜索渲染（每页 100 行；按 账号/姓名/学号 即时过滤）
  _usersRender: () => {
    const users = window._adminUsers || [];
    const isAdmin = !!(App.user && App.user.role === 'admin');
    const kw = (document.getElementById('au-search')?.value || '').trim().toLowerCase();
    const filtered = kw
      ? users.filter(u => (u.username || '').toLowerCase().includes(kw) || (u.name || '').toLowerCase().includes(kw) || (u.studentId || '').toLowerCase().includes(kw))
      : users;
    window._adminFiltered = filtered; // 全选当前筛选全部用
    const total = filtered.length;
    const pageSize = 100;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let page = window._adminUserPage || 1;
    if (page > pages) page = pages;
    window._adminUserPage = page;
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    window._adminPageUids = slice.map(u => u.id); // 全选本页/表头状态用
    let h = '';
    slice.forEach(u => {
      // Task4：角色彩色标签（学生蓝 / 班长绿 / 年级橙 / 管理员红）
      const roleTag = {
        student: '<span class="role-tag role-student">学生</span>',
        monitor: '<span class="role-tag role-monitor">班长</span>',
        grade: '<span class="role-tag role-grade">年级</span>',
        admin: '<span class="role-tag role-admin">管理员</span>',
      }[u.role] || u.role;
      const frozenTag = u.frozen ? '<span class="tag tag-rejected" title="冻结中，无法登录">❄️ 已冻结</span>' : '';
      const clsName = u.className || '';
      const stuTitle = u.studentId ? '学号 ' + u.studentId : '';
      h += `<tr data-uid="${u.id}" data-username="${FMT.esc(u.username)}" data-sid="${FMT.esc(u.studentId || '')}" data-role="${FMT.esc(u.role)}" data-class="${FMT.esc(clsName)}"><td><input type="checkbox" class="adm-uid" data-uid="${u.id}" ${window._adminSelectedUids && window._adminSelectedUids.has(u.id) ? 'checked' : ''} onchange="AdminViews._toggleUid('${u.id}', this.checked)"></td><td title="${FMT.esc(stuTitle)}">${FMT.esc(u.username)} ${frozenTag}</td><td>${FMT.esc(u.name)}</td><td>${roleTag}</td><td title="${FMT.esc(clsName)}">${FMT.esc(clsName)}</td>
        <td class="au-ops">
          <button class="btn btn-ghost btn-sm" onclick="AdminViews.editUser('${u.id}')">修改</button>${isAdmin ? `<button class="btn btn-sm ${u.frozen ? 'btn-ghost' : 'btn-warning'}" onclick="AdminViews.freezeUser('${u.id}','${FMT.esc(u.name)}',${u.frozen ? 'false' : 'true'})">${u.frozen ? '解冻' : '冻结'}</button>` : ''}<button class="btn btn-ghost btn-sm" onclick="AdminViews.resetPwd('${u.id}','${FMT.esc(u.name)}')">重置密码</button>${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="AdminViews.moreUserActions('${u.id}','${FMT.esc(u.name)}','${FMT.esc(u.username)}')">更多▾</button>` : ''}</td></tr>`;
    });
    const tbody = document.getElementById('au-tbody');
    if (tbody) tbody.innerHTML = h || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">无匹配用户</td></tr>';
    const totalEl = document.getElementById('au-total');
    if (totalEl) totalEl.textContent = total;
    const pager = document.getElementById('au-pager');
    if (pager) {
      pager.innerHTML = `第 <b>${page}</b>/${pages} 页 ｜ 共 <b>${total}</b> 人
        <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="AdminViews._usersPage(${page - 1})">◀ 上一页</button>
        <button class="btn btn-ghost btn-sm" ${page >= pages ? 'disabled' : ''} onclick="AdminViews._usersPage(${page + 1})">下一页 ▶</button>
        <span class="muted" style="font-size:12px">每页 100 行</span>`;
    }
    AdminViews._updateSelCount();
  },
  _usersPage: (n) => { window._adminUserPage = n; AdminViews._usersRender(); },

  // ---- 选中管理（2026-09-01：跨页 Set 持久化全选）----
  _toggleUid: (id, checked) => {
    if (!window._adminSelectedUids) window._adminSelectedUids = new Set();
    if (checked) window._adminSelectedUids.add(String(id)); else window._adminSelectedUids.delete(String(id));
    AdminViews._updateSelCount();
  },
  // 表头复选框：全选/取消本页（跨页已选不受影响）
  _togglePageAll: (checked) => {
    if (!window._adminSelectedUids) window._adminSelectedUids = new Set();
    (window._adminPageUids || []).forEach(id => checked ? window._adminSelectedUids.add(String(id)) : window._adminSelectedUids.delete(String(id)));
    AdminViews._usersRender();
  },
  // 全选当前筛选/搜索条件下的全部账号（跨页）
  _selectAllFiltered: () => {
    if (!window._adminSelectedUids) window._adminSelectedUids = new Set();
    const filtered = window._adminFiltered || [];
    filtered.forEach(u => window._adminSelectedUids.add(String(u.id)));
    AdminViews._usersRender();
    toast(`已全选当前筛选下全部 ${filtered.length} 个账号`);
  },
  // 更新已选计数 + 表头复选框状态
  _updateSelCount: () => {
    const el = document.getElementById('au-selcount');
    const n = window._adminSelectedUids ? window._adminSelectedUids.size : 0;
    if (el) el.innerHTML = '已选 <b>' + n + '</b> 人';
    const ca = document.getElementById('au-checkall');
    if (ca) {
      const pageUids = window._adminPageUids || [];
      ca.checked = pageUids.length > 0 && pageUids.every(id => window._adminSelectedUids && window._adminSelectedUids.has(String(id)));
    }
  },
  // 当前已选账号 id 列表（所有批量操作统一入口）
  _selectedUids: () => [...(window._adminSelectedUids || [])],

  createUser: async () => {
    let classes = [];
    try { classes = (await API.adminUsers({ role: 'all', className: 'all' })).classes || []; } catch (_) {}
    const classOptions = classes.map(c => `<option value="${FMT.esc(c)}">${FMT.esc(c)}</option>`).join('');
    openModal(`<div class="modal-head"><h3>新建账号</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>角色<span style="color:#c00">*</span></label><select id="cu-role" onchange="AdminViews.cuRoleChange()">
          <option value="student">学生</option><option value="monitor">班长</option><option value="grade">年级</option><option value="admin">系统管理员</option></select></div>
        <div class="form-item"><label>账号（登录名）<span style="color:#c00">*</span><span class="muted" style="font-weight:normal">仅英文+数字</span></label><input id="cu-username" placeholder="学生将自动等于学号"></div>
        <div class="form-item"><label>姓名<span style="color:#c00">*</span></label><input id="cu-name" placeholder="如 张三"></div>
        <div class="form-item" id="cu-class-wrap"><label>班级<span style="color:#c00">*</span><span class="muted" style="font-weight:normal">学生/班长必填</span></label>
          <select id="cu-class" style="padding:9px 12px;border:1px solid var(--border);border-radius:8px;width:100%">
            <option value="">-- 请选择班级 --</option>
            ${classOptions}
          </select></div>
        <div class="form-item" id="cu-sid-wrap"><label>学号<span style="color:#c00">*</span><span class="muted" style="font-weight:normal">学生必填</span></label><input id="cu-studentId" placeholder="如 202300000099" oninput="AdminViews.cuSidInput()"></div>
        <div class="form-item"><label>初始密码<span class="muted" style="font-weight:normal">（留空按角色生成：学生=student+学号 / 班长=monitor+账号 / 年级=grade+账号 / 管理员=默认密码）</span></label><input id="cu-pwd" placeholder="留空=自动生成"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AdminViews.doCreate()">创建</button></div>`);
    AdminViews.cuRoleChange();
  },

  cuRoleChange: () => {
    const role = document.getElementById('cu-role').value;
    const uEl = document.getElementById('cu-username');
    const sidWrap = document.getElementById('cu-sid-wrap');
    const classWrap = document.getElementById('cu-class-wrap');
    const sidEl = document.getElementById('cu-studentId');
    if (role === 'student') {
      uEl.readOnly = true; uEl.style.background = '#f2f2f2'; uEl.placeholder = '自动=学号';
      uEl.value = sidEl.value; sidWrap.style.display = ''; classWrap.style.display = '';
    } else if (role === 'monitor') {
      uEl.readOnly = false; uEl.style.background = ''; uEl.placeholder = '英文+数字';
      sidWrap.style.display = 'none'; classWrap.style.display = '';
    } else {
      uEl.readOnly = false; uEl.style.background = ''; uEl.placeholder = '英文+数字';
      sidWrap.style.display = 'none'; classWrap.style.display = 'none';
    }
  },

  cuSidInput: () => {
    if (document.getElementById('cu-role').value === 'student') {
      document.getElementById('cu-username').value = document.getElementById('cu-studentId').value;
    }
  },

  doCreate: async () => {
    const role = document.getElementById('cu-role').value;
    const username = document.getElementById('cu-username').value.trim();
    const name = document.getElementById('cu-name').value.trim();
    const className = document.getElementById('cu-class').value.trim();
    const studentId = document.getElementById('cu-studentId').value.trim();
    const password = document.getElementById('cu-pwd').value;
    if (!username || !name) return toast('请填写账号和姓名', 'err');
    if (!/^[A-Za-z0-9]+$/.test(username)) return toast('账号只能包含英文字母和数字', 'err');
    if (role === 'student') {
      if (!className) return toast('学生必须填写班级', 'err');
      if (!studentId) return toast('学生必须填写学号', 'err');
    } else if (role === 'monitor') {
      if (!className) return toast('班长必须填写班级', 'err');
    }
    try {
      const r = await API.createUser({ username, password, name, role, className, studentId });
      AdminViews.showCreateResult(r.user, r.defaultPassword);
    } catch (e) { toast(e.message, 'err'); }
  },

  showCreateResult: (user, pwd) => {
    window.__crRows = [{ username: user.username, name: user.name, role: user.role, className: user.className || '', password: pwd }];
    const roleCn = { student: '学生', monitor: '班长', grade: '年级', admin: '管理员' }[user.role] || user.role;
    openModal(`<div class="modal-head"><h3>✅ 创建成功</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">请妥善记录初始密码，当面/私聊告知本人（首次登录需修改）。</div>
        <div class="form-item"><label>账号</label><input value="${FMT.esc(user.username)}" readonly></div>
        <div class="form-item"><label>姓名</label><input value="${FMT.esc(user.name)}" readonly></div>
        <div class="form-item"><label>角色</label><input value="${roleCn}" readonly></div>
        <div class="form-item"><label>班级</label><input value="${FMT.esc(user.className || '-')}" readonly></div>
        <div class="form-item"><label>初始密码</label><input id="cr-pwd" value="${FMT.esc(pwd)}" readonly></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText(document.getElementById('cr-pwd').value);toast('已复制密码')">复制密码</button>
        <button class="btn btn-success" onclick="AdminViews.exportCredential(window.__crRows)">导出 Excel 凭证</button>
        <button class="btn btn-primary" onclick="closeModal();App.goto('adminUsers')">完成</button>
      </div>`);
  },

  exportCredential: async (rows) => {
    const pwd = await GradeViews.getExportPwd();
    if (!pwd) return;
    try {
      const blob = await API.postBlob('/api/admin/export-credential', { rows, secondaryPassword: pwd });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '账号凭证.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('已导出 Excel 凭证');
    } catch (e) { toast(e.message, 'err'); }
  },

  resetPwd: (id, name) => {
    openModal(`<div class="modal-head"><h3>重置密码（${FMT.esc(name)}）</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="muted mb8">留空则按角色生成默认密码：学生=student+学号 / 班长=monitor+账号 / 年级=grade+账号 / 管理员=默认密码。重置后该用户下次登录需修改。</div>
      <div class="form-item"><label>新密码（留空=按角色生成）</label><input id="rp-pwd" placeholder="自定义则填写，留空自动生成"></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AdminViews.doReset('${id}')">重置</button></div>`);
  },

  // 修改账号信息（账号/姓名/角色/班级/学号）——班级下拉可选，用于把学生分配给班长
  editUser: async (id) => {
    const row = document.querySelector(`tr[data-uid="${id}"]`);
    const curName = row?.cells[1]?.textContent.trim() || '';
    const curUsername = row?.dataset.username || '';
    const curRole = row?.dataset.role || 'student';
    const curClass = row?.dataset.class || '';
    const curSid = row?.dataset.sid || '';
    const isGrade = !!(App.user && App.user.role === 'grade');
    let classes = [];
    try { classes = (await API.adminUsers({ role: 'all', className: 'all' })).classes || []; } catch (_) {}
    const classOptions = classes.map(c => `<option value="${FMT.esc(c)}" ${c === curClass ? 'selected' : ''}>${FMT.esc(c)}</option>`).join('');
    // 角色下拉：年级端仅显示 student / monitor；admin 端显示全部
    const roleOptions = isGrade
      ? `<option value="student" ${curRole==='student'?'selected':''}>学生（某班同学）</option>
         <option value="monitor" ${curRole==='monitor'?'selected':''}>班长（负责某班）</option>`
      : `<option value="student" ${curRole==='student'?'selected':''}>学生（某班同学）</option>
         <option value="monitor" ${curRole==='monitor'?'selected':''}>班长（负责某班）</option>
         <option value="grade" ${curRole==='grade'?'selected':''}>年级</option>
         <option value="admin" ${curRole==='admin'?'selected':''}>系统管理员</option>`;
    const tip = isGrade
      ? '<span style="color:#c00">年级端仅可修改为「学生」或「班长」；这两类账号 4 项均必填。</span>'
      : '<span style="color:#c00">学生/班长 4 项均必填；年级/管理员 仅姓名+角色必填。</span>';
    openModal(`<div class="modal-head"><h3>修改账号 / 分配班级</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">${tip}</div>
        <div class="form-item"><label>账号（登录名）<span style="color:#c00">*</span><span class="muted" style="font-weight:normal">仅英文+数字；修改后该用户需重新登录</span></label><input id="eu-username" value="${FMT.esc(curUsername)}" placeholder="英文+数字"></div>
        <div class="form-item"><label>姓名<span style="color:#c00">*</span></label><input id="eu-name" value="${FMT.esc(curName)}" placeholder="如张三"></div>
        <div class="form-item"><label>角色<span style="color:#c00">*</span></label><select id="eu-role" onchange="AdminViews.euRoleChange()">${roleOptions}</select></div>
        <div class="form-item" id="eu-class-wrap"><label>班级<span style="color:#c00">*</span><span class="muted" style="font-weight:normal">（学生/班长必填）</span></label>
          <select id="eu-class" style="padding:9px 12px;border:1px solid var(--border);border-radius:8px;width:100%">
            <option value="">-- 请选择班级 --</option>
            ${classOptions}
          </select>
        </div>
        <div class="form-item" id="eu-sid-wrap"><label>学号<span style="color:#c00">*</span><span class="muted" style="font-weight:normal">（学生必填）</span></label><input id="eu-studentId" value="${FMT.esc(curSid)}" placeholder="如 202300000099" oninput="AdminViews.euSidInput()"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AdminViews.doEditUser('${id}')">保存修改</button></div>`);
    AdminViews.euRoleChange();
  },

  euRoleChange: () => {
    const role = document.getElementById('eu-role').value;
    const uEl = document.getElementById('eu-username');
    const sidWrap = document.getElementById('eu-sid-wrap');
    const classWrap = document.getElementById('eu-class-wrap');
    const sidEl = document.getElementById('eu-studentId');
    if (role === 'student') {
      uEl.readOnly = true; uEl.style.background = '#f2f2f2'; uEl.value = sidEl.value;
      sidWrap.style.display = ''; classWrap.style.display = '';
    } else if (role === 'monitor') {
      uEl.readOnly = false; uEl.style.background = '';
      sidWrap.style.display = 'none'; classWrap.style.display = '';
    } else {
      uEl.readOnly = false; uEl.style.background = '';
      sidWrap.style.display = 'none'; classWrap.style.display = 'none';
    }
  },

  euSidInput: () => {
    if (document.getElementById('eu-role').value === 'student') {
      document.getElementById('eu-username').value = document.getElementById('eu-studentId').value;
    }
  },

  doEditUser: async (id) => {
    const username = document.getElementById('eu-username').value.trim();
    const name = document.getElementById('eu-name').value.trim();
    const role = document.getElementById('eu-role').value;
    const className = document.getElementById('eu-class').value.trim();
    const studentId = document.getElementById('eu-studentId').value.trim();
    if (!username) return toast('账号不能为空', 'err');
    if (!/^[A-Za-z0-9]+$/.test(username)) return toast('账号只能包含英文字母和数字', 'err');
    if (!name) return toast('姓名不能为空', 'err');
    if (role === 'student') {
      if (!className) return toast('学生必须填写班级', 'err');
      if (!studentId) return toast('学生必须填写学号', 'err');
    } else if (role === 'monitor') {
      if (!className) return toast('班长必须填写班级', 'err');
    }
    try {
      await API.post(`/api/admin/users/${id}/update`, { username, name, role, className, studentId });
      closeModal(); toast('已修改'); App.goto('adminUsers');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 查看密码已下线：请使用「重置密码」功能给该学生重置一个新密码（仅一次性返回），然后告知学生本人
  showPassword: (id, name) => {
    AdminViews.resetPassword(id, name);
  },

  // 删除账号
  deleteUser: (id, name) => {
    if (!confirm(`确定删除账号「${name}」？此操作不可恢复！该用户相关的 session 也会被清理。`)) return;
    API.deleteUser(id).then(() => {
      toast('已删除'); App.goto('adminUsers');
    }).catch(e => toast(e.message, 'err'));
  },

  // 清除用户已提交的综测信息（保留账号，用于测试复测）
  clearSubmissions: (id, name) => {
    if (!confirm(`确定清除账号「${name}」已提交的综测信息吗？\n将删除其：综测申请 / 旧版材料 / 相关通知 / 复核材料提交记录。\n账号本身保留，可重新提交。\n此操作不可恢复！`)) return;
    API.post(`/api/admin/users/${id}/clear-submissions`, {}).then(r => {
      toast(`已清除：${r.cleared.applications} 条申请 / ${r.cleared.submissions} 条材料 / ${r.cleared.notifications} 条通知 / ${r.cleared.reviews || 0} 条复核记录`);
      App.goto('adminUsers');
    }).catch(e => toast(e.message, 'err'));
  },

  // 批量删除（勾选项，跨页）
  batchDeleteUsers: () => {
    const ids = AdminViews._selectedUids();
    if (!ids.length) return toast('请先勾选要删除的账号', 'err');
    if (!confirm(`确定批量删除选中的 ${ids.length} 个账号？此操作不可恢复！`)) return;
    Promise.all(ids.map(id => API.deleteUser(id))).then(results => {
      const ok = results.filter(r => r && r.ok).length;
      toast(`批量删除完成：成功 ${ok} / 共 ${ids.length}`); App.goto('adminUsers');
    }).catch(e => toast(e.message, 'err'));
  },

  // 批量冻结/解冻（admin）：frozen=true 冻结（不能登录、会话立即失效）；false 解冻
  batchFreezeUsers: (frozen) => {
    const ids = AdminViews._selectedUids();
    if (!ids.length) return toast('请先勾选要操作的账号', 'err');
    if (!confirm(`确定${frozen ? '冻结' : '解冻'}选中的 ${ids.length} 个账号吗？${frozen ? '\n冻结后账号将无法登录，已有会话立即失效。' : ''}`)) return;
    API.post('/api/admin/users/batch-freeze', { ids, frozen }).then(r => {
      toast(`已${frozen ? '冻结' : '解冻'} ${r.count} 个账号`);
      App.goto('adminUsers');
    }).catch(e => toast(e.message, 'err'));
  },

  // 批量清除提交记录（admin；需二级审核密码；语义与单用户清除一致：保留账号/附件，删 4 类记录）
  batchClearSubmissions: () => {
    const ids = AdminViews._selectedUids();
    if (!ids.length) return toast('请先勾选要清除提交记录的账号', 'err');
    openModal(`<div class="modal-head"><h3>🧹 批量清除提交记录 · ${ids.length} 个账号</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8" style="background:var(--warning-bg);padding:10px 14px;border-radius:8px;line-height:1.6">将删除所选账号的：<b>综测申请 / 旧版材料 / 相关通知 / 复核材料提交记录</b>。账号本身与磁盘附件保留，可重新提交。<b>此操作不可恢复！</b>请输入二级审核密码确认：</div>
        <div class="form-item"><label>二级审核密码</label><input id="bcs-pwd" type="password" placeholder="请输入二级审核密码" autocomplete="off"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-danger" onclick="AdminViews._confirmBatchClear()">确认清除</button></div>`);
    setTimeout(() => { const el = document.getElementById('bcs-pwd'); if (el) el.focus(); }, 120);
  },
  _confirmBatchClear: () => {
    const pwd = document.getElementById('bcs-pwd')?.value.trim() || '';
    if (!pwd) return toast('请输入二级审核密码', 'err');
    const ids = AdminViews._selectedUids();
    closeModal();
    API.post('/api/admin/users/batch-clear-submissions', { ids, secondaryPassword: pwd }).then(r => {
      const skippedNote = r.skipped && r.skipped.length ? `（跳过管理员：${r.skipped.join('、')}）` : '';
      toast(`已清除 ${r.count} 个账号：${r.cleared.applications} 条申请 / ${r.cleared.submissions} 条材料 / ${r.cleared.notifications} 条通知 / ${r.cleared.reviews} 条复核记录${skippedNote}`);
      App.goto('adminUsers');
    }).catch(e => toast(e.message, 'err'));
  },

  // Task4：操作列折叠为「操作 ▼」—— 点击展开 修改 / 冻结(解冻) / 重置密码 / 更多
  openUserActions: (id, name, username, frozen) => {
    const isAdmin = !!(App.user && App.user.role === 'admin');
    const freezeBtn = isAdmin
      ? (frozen
        ? `<button class="btn btn-ghost" style="width:100%" onclick="closeModal();AdminViews.freezeUser('${id}','${FMT.esc(name)}',false)">✅ 解冻账号</button>`
        : `<button class="btn btn-warning" style="width:100%" onclick="closeModal();AdminViews.freezeUser('${id}','${FMT.esc(name)}',true)">❄️ 冻结账号</button>`)
      : '';
    openModal(`<div class="modal-head"><h3>账号操作 · ${FMT.esc(name)}<span class="muted" style="font-size:12px;font-weight:400"> （${FMT.esc(username)}）</span></h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="row" style="flex-direction:column;gap:10px">
          <button class="btn btn-primary" style="width:100%" onclick="closeModal();AdminViews.editUser('${id}')">✏️ 修改信息</button>
          ${freezeBtn}
          <button class="btn btn-ghost" style="width:100%" onclick="closeModal();AdminViews.resetPwd('${id}','${FMT.esc(name)}')">🔑 重置密码</button>
          <button class="btn btn-ghost" style="width:100%" onclick="AdminViews.moreUserActions('${id}','${FMT.esc(name)}','${FMT.esc(username)}')">📋 更多（清除提交 / 删除）</button>
        </div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button></div>`);
  },

  // 更多操作（P2 2026-08-30 UI 整理）：低频/危险操作收进弹窗，防误点
  moreUserActions: (id, name, username) => {
    const isAdmin = !!(App.user && App.user.role === 'admin');
    const delBtn = isAdmin ? `<button class="btn btn-danger" style="width:100%" onclick="closeModal();AdminViews.deleteUser('${id}','${FMT.esc(name)}')">🗑 删除账号</button>` : '';
    const clrBtn = isAdmin ? `<button class="btn btn-warning" style="width:100%" onclick="closeModal();AdminViews.clearSubmissions('${id}','${FMT.esc(name)}')">🧹 清除提交记录</button>` : '';
    openModal(`<div class="modal-head"><h3>更多操作 · ${FMT.esc(name)}<span class="muted" style="font-size:12px;font-weight:400"> （${FMT.esc(username)}）</span></h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="row" style="flex-direction:column;gap:10px">
          <button class="btn btn-ghost" style="width:100%" onclick="closeModal();AdminViews.resetPwd('${id}','${FMT.esc(name)}')">🔑 重置密码</button>
          ${clrBtn}
          ${delBtn}
        </div>
        <div class="muted mt8" style="font-size:12px">删除/清除为不可逆操作，请谨慎确认。</div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button></div>`);
  },

  // 单个冻结/解冻
  freezeUser: (id, name, frozen) => {
    if (!confirm(`确定${frozen ? '冻结' : '解冻'}账号「${name}」吗？${frozen ? '\n冻结后该账号无法登录，已有会话立即失效。' : ''}`)) return;
    API.post('/api/admin/users/batch-freeze', { ids: [id], frozen }).then(r => {
      toast(`已${frozen ? '冻结' : '解冻'}「${name}」`);
      App.goto('adminUsers');
    }).catch(e => toast(e.message, 'err'));
  },

  // 批量修改班级/角色
  batchUpdateUsers: async () => {
    const ids = AdminViews._selectedUids();
    if (!ids.length) return toast('请先勾选要修改的账号', 'err');
    let classes = [];
    try { classes = (await API.adminUsers({ role: 'all', className: 'all' })).classes || []; } catch (_) {}
    const classOptions = classes.map(c => `<option value="${FMT.esc(c)}">${FMT.esc(c)}</option>`).join('');
    openModal(`<div class="modal-head"><h3>批量修改 ${ids.length} 个账号</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">留空表示不修改该字段。班级即班长归属：学生放入某班即由该班班长负责。</div>
        <div class="form-item"><label>姓名（留空不改）</label><input id="bu-name" placeholder="新姓名（可选）"></div>
        <div class="form-item"><label>角色</label><select id="bu-role"><option value="">不修改</option>
          <option value="student">学生</option><option value="monitor">班长</option>
          <option value="grade">年级</option><option value="admin">管理员</option></select></div>
        <div class="form-item"><label>班级（留空不改）</label>
          <select id="bu-class" style="padding:9px 12px;border:1px solid var(--border);border-radius:8px;width:100%">
            <option value="">-- 不修改 --</option>
            ${classOptions}
          </select></div>
        <div class="form-item"><label>学号（留空不改）</label><input id="bu-sid" placeholder="新学号（可选）"></div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AdminViews.doBatchUpdate('${ids.join(',')}')">确认修改</button></div>`);
  },

  doBatchUpdate: async (idsStr) => {
    const ids = idsStr.split(',');
    const updates = {};
    const name = document.getElementById('bu-name').value.trim();
    const role = document.getElementById('bu-role').value;
    const className = document.getElementById('bu-class').value.trim();
    const studentId = document.getElementById('bu-sid').value.trim();
    if (name) updates.name = name;
    if (role) updates.role = role;
    if (className) updates.className = className;
    if (studentId) updates.studentId = studentId;
    if (!Object.keys(updates).length) return toast('请至少填写一项要修改的字段', 'err');
    try {
      const results = await Promise.all(ids.map(id => API.updateUser(id, updates)));
      closeModal();
      const ok = results.filter(r => r && r.ok).length;
      toast(`批量修改完成：成功 ${ok} / 共 ${ids.length}`); App.goto('adminUsers');
    } catch (e) { toast(e.message, 'err'); }
  },

  doReset: async (id) => {
    const password = document.getElementById('rp-pwd').value;
    try {
      const r = await API.resetPassword(id, { password });
      closeModal(); toast(`已重置，新密码：${r.newPassword}`);
    } catch (e) { toast(e.message, 'err'); }
  },

  stats: async () => {
    const st = await API.adminStats();
    return `<div class="grid grid-4">
      <div class="stat-card"><div class="label">学生总数</div><div class="num">${st.students}</div></div>
      <div class="stat-card"><div class="label">班级数</div><div class="num">${st.classes}</div></div>
      <div class="stat-card c-green"><div class="label">班长数</div><div class="num">${st.monitors}</div></div>
      <div class="stat-card c-blue"><div class="label">材料总数</div><div class="num">${st.submissions}</div></div>
      <div class="stat-card c-green"><div class="label">已通过</div><div class="num">${st.approved}</div></div>
      <div class="stat-card c-orange"><div class="label">待审核</div><div class="num">${st.pending}</div></div>
      <div class="stat-card c-red"><div class="label">异议数</div><div class="num">${st.objections}</div></div>
      <div class="stat-card c-gray"><div class="label">数据备份</div><div class="num" style="font-size:16px"><a href="/api/admin/backup" onclick="return this.href.includes('backup')" style="font-size:13px">⬇ 下载备份</a></div></div>
    </div>
    <div class="card mt16"><div class="card-title">使用说明</div>
      <div class="sub-desc">1️⃣ 先在「学生名单导入」中批量创建学生账号（CSV：学号,姓名,班级），账号=学号，初始密码=学号后6位。</div>
      <div class="sub-desc">2️⃣ 为每个班级创建班长账号（手动创建，角色选班长，填班级）。</div>
      <div class="sub-desc">3️⃣ 学生提交材料 → 已认定部分班长审核、未认定部分年级审核 → 年级可改判 → 发起公示 → 学生可异议 → 年级处理。</div>
      <div class="sub-desc">4️⃣ 定期点击「下载备份」保存全部数据（data/data.json），防止意外丢失。</div>
    </div>`;
  },

  // 班级→专业映射（仅 admin）
  // P3（2026-08-30 UI 整理）：系统配置 —— 合并原「时间配置（截止时间）」+「班级→专业映射」为双 Tab 单页
  sysConfigPage: async (tab = 'time') => {
    const isTime = tab !== 'class' && tab !== 'backup';
    const tabs = `<div class="filter-bar">
      <button class="btn btn-sm ${isTime ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('sysConfig','time')">⏰ 时间与开榜配置</button>
      <button class="btn btn-sm ${tab === 'class' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('sysConfig','class')">🛠 班级与审核权限</button>
      <button class="btn btn-sm ${tab === 'backup' ? 'btn-primary' : 'btn-ghost'}" onclick="App.goto('sysConfig','backup')">💾 数据备份</button>
    </div>
    <div id="syscfg-body" class="mt16"><div class="muted">加载中…</div></div>`;
    setTimeout(async () => {
      const box = document.getElementById('syscfg-body');
      if (!box) return;
      try {
        if (tab === 'backup') box.innerHTML = AppViews._backupCard(); // Task3：备份入口移至此处
        else box.innerHTML = isTime ? await AppViews.configPage() : await AdminViews.classMajorsPage();
      } catch (e) { box.innerHTML = `<div class="empty">加载失败：${FMT.esc(e.message)}</div>`; }
    }, 30);
    return tabs;
  },

  classMajorsPage: async () => {
    let data = { classes: [], classMajors: {}, grades: [], assignments: {} };
    try {
      const r = await API.get('/api/admin/classMajors');
      data.classes = r.classes || [];
      data.classMajors = r.classMajors || {};
      const r2 = await API.get('/api/admin/users?role=grade');
      data.grades = r2.users || [];
      const r3 = await API.get('/api/admin/class-grade-assignments');
      data.assignments = r3.assignments || {};
    } catch (e) { return toast(e.message, 'err'); }
    // 状态：cls|type -> [userId]；每次渲染重置，避免跨页残留
    AdminViews._cga = {};
    AdminViews._cgaGrades = data.grades;
    AdminViews._cgaNames = {};
    data.grades.forEach(g => { AdminViews._cgaNames[g.id] = g.name || g.username; });
    const norm = v => Array.isArray(v) ? v.map(String) : (v === '' || v == null ? [] : [String(v)]);
    for (const cls of data.classes) {
      const asg = data.assignments[cls] || {};
      for (const t of ['uncertified', 'round1', 'round2', 'round3', 'certModify']) {
        AdminViews._cga[cls + '|' + t] = norm(asg[t]);
      }
    }
    // 缓存班级列表与专业映射，供批量填充弹窗筛选使用
    AdminViews._cgaClasses = data.classes;
    AdminViews._cgaMajorMap = data.classMajors || {};
    // 单元格：显示已选人 chip + 点击打开多选弹窗
    const cgaCell = (cls, type) => {
      const ids = AdminViews._cga[cls + '|' + type] || [];
      const inner = ids.length
        ? ids.map(id => `<span class="chip">${FMT.esc(AdminViews._cgaNames[id] || id)}</span>`).join(' ')
        : '<span class="muted">（未分配）</span>';
      return `<div class="cga-cell" data-cls="${FMT.esc(cls)}" data-type="${type}" onclick="AdminViews.openCgaModalFromCell(this)">${inner}<span class="cga-edit">✎</span></div>`;
    };
    const rows = data.classes.map((cls, i) => {
      const m = data.classMajors[cls] || '';
      const prevCls = i > 0 ? data.classes[i - 1] : '';
      const copyBtn = i === 0
        ? '<span class="muted">—</span>'
        : `<button class="btn btn-ghost btn-sm" onclick="AdminViews.copyPrevRow('${FMT.esc(cls)}', '${FMT.esc(prevCls)}')">⧉ 复制上一行</button>`;
      return `<tr>
        <td>${FMT.esc(cls)}</td>
        <td><input data-cls="${FMT.esc(cls)}" class="cm-major" value="${FMT.esc(m)}" placeholder="如：临床医学"></td>
        <td>${cgaCell(cls, 'uncertified')}</td>
        <td>${cgaCell(cls, 'round1')}</td>
        <td>${cgaCell(cls, 'round2')}</td>
        <td>${cgaCell(cls, 'round3')}</td>
        <td>${cgaCell(cls, 'certModify')}</td>
        <td class="center">${copyBtn}</td>
      </tr>`;
    }).join('');
    return `<div class="card">
      <div class="card-title">🏫 班级→专业映射 & 年级负责人分配</div>
      <div class="muted mb8">为每个班级维护对应专业，并指定 5 类审核的年级负责人（未认定项目 / 一榜 / 二榜 / 三榜复核 / <b>已认定修改</b>），<b>每类可设多人</b>。<b>已认定修改负责人</b>负责在班级审批截止前修改本班「已认定」项（过截止仅管理员可改）；<b>修改后立即生效</b>；未分配则仅管理员可操作（兜底）。</div>
      <div class="bf-toolbar">💡 <b>批量填充：</b>点击下方负责人列头中的「⚡批量」按钮，可一次性为多个班级设置同一位年级负责人（支持按专业筛选 / 班级范围筛选 / 全选）。修改仅暂存，需点下方「保存负责人分配」才生效。</div>
      <table class="tbl"><thead><tr>
        <th>班级</th>
        <th>对应专业</th>
        <th>未认定负责人<br><button class="th-batch" onclick="AdminViews.openBatchFill('uncertified')">⚡批量</button></th>
        <th>一榜负责人<br><button class="th-batch" onclick="AdminViews.openBatchFill('round1')">⚡批量</button></th>
        <th>二榜负责人<br><button class="th-batch" onclick="AdminViews.openBatchFill('round2')">⚡批量</button></th>
        <th>三榜负责人<br><button class="th-batch" onclick="AdminViews.openBatchFill('round3')">⚡批量</button></th>
        <th>已认定修改负责人<br><button class="th-batch" onclick="AdminViews.openBatchFill('certModify')">⚡批量</button></th>
        <th class="center">操作</th>
      </tr></thead><tbody>${rows || '<tr><td colspan=8 class="muted" style="text-align:center">尚无可配置班级（请在「系统配置」中添加班级）</td></tr>'}</tbody></table>
      <div class="mt16 row" style="gap:8px">
        <button class="btn btn-primary" onclick="AdminViews.saveClassMajors()">💾 保存专业映射</button>
        <button class="btn btn-success" onclick="AdminViews.saveClassGradeAssignments()">👥 保存负责人分配</button>
        <span class="muted">点击单元格弹窗勾选负责人，每类可设多人；留空由管理员兜底审核</span>
      </div>
    </div>`;
  },

  saveClassMajors: async () => {
    const inputs = [...document.querySelectorAll('.cm-major')];
    const mapping = {};
    for (const inp of inputs) mapping[inp.dataset.cls] = inp.value.trim();
    try {
      await API.post('/api/admin/classMajors', { mapping });
      toast('班级→专业映射已保存');
      App.goto('classMajors');
    } catch (e) { toast(e.message, 'err'); }
  },

  // 打开负责人多选弹窗（从单元格触发）
  openCgaModalFromCell: (el) => {
    AdminViews.openCgaModal(el.dataset.cls, el.dataset.type, el);
  },
  openCgaModal: (cls, type, cellEl) => {
    const key = cls + '|' + type;
    const cur = AdminViews._cga[key] || [];
    const grades = AdminViews._cgaGrades || [];
    const labels = { uncertified: '未认定负责人', round1: '一榜负责人', round2: '二榜负责人', round3: '三榜负责人', certModify: '已认定修改负责人' };
    const opts = grades.map(g => {
      const checked = cur.includes(String(g.id)) ? 'checked' : '';
      return `<label class="cga-opt"><input type="checkbox" value="${g.id}" ${checked}> ${FMT.esc(g.name || g.username)}</label>`;
    }).join('');
    openModal(`<div class="modal-head"><h3>选择${labels[type]} · ${FMT.esc(cls)}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="muted mb8">可多选；不勾选任何人或点「清空」表示未分配（由管理员兜底审核）。</div>
        <div class="cga-opts">${opts || '<div class="muted">暂无 role=grade 账号，请先在「账号管理」创建</div>'}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="AdminViews._cgaTmpClear()">清空（未分配）</button>
        <button class="btn btn-primary" onclick="AdminViews._cgaConfirm('${FMT.esc(cls)}','${type}')">确定</button>
      </div>`);
    AdminViews._cgaCell = cellEl;
  },
  _cgaTmpClear: () => {
    document.querySelectorAll('.cga-opt input').forEach(c => { c.checked = false; });
  },
  // 重绘单个负责人单元格（内存态 -> DOM）
  _paintCgaCell: (cls, type) => {
    const cells = document.querySelectorAll('.cga-cell');
    for (const cell of cells) {
      if (cell.dataset.cls === cls && cell.dataset.type === type) {
        const ids = AdminViews._cga[cls + '|' + type] || [];
        const inner = ids.length
          ? ids.map(id => `<span class="chip">${FMT.esc(AdminViews._cgaNames[id] || id)}</span>`).join(' ')
          : '<span class="muted">（未分配）</span>';
        cell.innerHTML = inner + '<span class="cga-edit">✎</span>';
        return;
      }
    }
  },
  _cgaConfirm: (cls, type) => {
    const key = cls + '|' + type;
    const checked = [...document.querySelectorAll('.cga-opt input:checked')].map(c => c.value);
    AdminViews._cga[key] = checked;
    closeModal();
    AdminViews._paintCgaCell(cls, type);
  },
  // 批量填充弹窗（按列）
  openBatchFill: (type) => {
    const labels = { uncertified: '未认定负责人', round1: '一榜负责人', round2: '二榜负责人', round3: '三榜负责人', certModify: '已认定修改负责人' };
    const short = { uncertified: '未认定', round1: '一榜', round2: '二榜', round3: '三榜', certModify: '已认定修改' };
    const grades = AdminViews._cgaGrades || [];
    const classes = AdminViews._cgaClasses || [];
    const majorMap = AdminViews._cgaMajorMap || {};
    const majors = [...new Set(Object.values(majorMap).map(m => (m || '').trim()).filter(Boolean))];
    const gradeOpts = grades.length
      ? grades.map(g => `<label class="cga-opt"><input type="radio" name="bf-grade" value="${g.id}"> ${FMT.esc(g.name || g.username)}</label>`).join('')
      : '<div class="muted">暂无 role=grade 账号，请先在「账号管理」创建</div>';
    const majorOpts = ['<option value="">全部专业</option>'].concat(majors.map(m => `<option value="${FMT.esc(m)}">${FMT.esc(m)}</option>`)).join('');
    const clsList = classes.map(c => `<label class="bf-cls" data-major="${FMT.esc((majorMap[c] || '').trim())}"><input type="checkbox" class="bf-cls-cb" value="${FMT.esc(c)}"> ${FMT.esc(c)}</label>`).join('');
    openModal(`<div class="modal-head"><h3>批量填充 · ${labels[type]}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-item"><label>① 选择一位年级负责人（单选）</label><div class="cga-opts">${gradeOpts}</div></div>
        <div class="bf-divider"></div>
        <div class="row" style="gap:8px;align-items:flex-end">
          <div class="form-item" style="margin:0;min-width:150px"><label>按专业筛选</label><select id="bf-major" onchange="AdminViews._bfFilter()" class="bf-sel">${majorOpts}</select></div>
          <div class="form-item" style="margin:0;flex:1"><label>班级范围/关键词（留空=不限）</label><input id="bf-kw" oninput="AdminViews._bfFilter()" placeholder="如：临床医学 / 2023级"></div>
        </div>
        <div class="row mt8" style="gap:8px;align-items:center">
          <button class="btn btn-sm" onclick="AdminViews._bfSelectAll(true)">全选筛选结果</button>
          <button class="btn btn-sm" onclick="AdminViews._bfSelectAll(false)">清空选择</button>
          <span class="muted" id="bf-count"></span>
        </div>
        <div class="bf-cls-list">${clsList}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="AdminViews._bfConfirm('${type}')">确认填充</button>
      </div>`);
    AdminViews._bfType = type;
    AdminViews._bfFilter();
  },
  _bfFilter: () => {
    const major = (document.getElementById('bf-major')?.value || '').trim();
    const kw = (document.getElementById('bf-kw')?.value || '').trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll('.bf-cls').forEach(l => {
      const m = (l.dataset.major || '').trim();
      const txt = l.textContent.toLowerCase();
      const show = (!major || m === major) && (!kw || txt.includes(kw));
      l.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const cnt = document.getElementById('bf-count');
    if (cnt) cnt.textContent = `当前可勾选 ${visible} 个班级`;
  },
  _bfSelectAll: (flag) => {
    document.querySelectorAll('.bf-cls').forEach(l => {
      if (l.style.display === 'none') return;
      const cb = l.querySelector('input');
      if (cb) cb.checked = flag;
    });
  },
  _bfConfirm: (type) => {
    const rb = document.querySelector('input[name="bf-grade"]:checked');
    if (!rb) { toast('请先选择一位年级负责人', 'err'); return; }
    const checked = [...document.querySelectorAll('.bf-cls-cb:checked')].map(c => c.value);
    if (!checked.length) { toast('请至少选择一个班级', 'err'); return; }
    for (const cls of checked) {
      AdminViews._cga[cls + '|' + type] = [rb.value];
      AdminViews._paintCgaCell(cls, type);
    }
    closeModal();
    toast(`已为 ${checked.length} 个班级填充「${ {uncertified: '未认定', round1: '一榜', round2: '二榜', round3: '三榜'}[type] }」负责人（待保存）`);
  },
  // 复制上一行的 4 个负责人到当前行
  copyPrevRow: (cls, prevCls) => {
    if (!prevCls) return;
    for (const t of ['uncertified', 'round1', 'round2', 'round3', 'certModify']) {
      AdminViews._cga[cls + '|' + t] = [...(AdminViews._cga[prevCls + '|' + t] || [])];
      AdminViews._paintCgaCell(cls, t);
    }
    toast(`已复制「${prevCls}」的负责人设置到「${cls}」（待保存）`);
  },
  // 保存年级负责人分配（独立于专业映射，避免互相覆盖）
  saveClassGradeAssignments: async () => {
    const assignments = {};
    for (const key of Object.keys(AdminViews._cga || {})) {
      const i = key.indexOf('|');
      const cls = key.slice(0, i), type = key.slice(i + 1);
      assignments[cls] = assignments[cls] || { uncertified: [], round1: [], round2: [], round3: [], certModify: [] };
      assignments[cls][type] = AdminViews._cga[key];
    }
    try {
      await API.post('/api/admin/class-grade-assignments', { assignments });
      toast('年级负责人分配已保存（立即生效）');
    } catch (e) { toast(e.message, 'err'); }
  },
};
