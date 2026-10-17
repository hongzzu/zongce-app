// ============ 应用入口：登录 / 菜单 / 视图路由 ============
const App = (() => {
  let user = null;
  let current = null;

  const ROLE_LABEL = { student: '学生', monitor: '班长', grade: '年级管理员', admin: '系统管理员' };

  const MENUS = {
    student: [
      { key: 'submitApp', ico: '📝', title: '提交综测申请' },
      { key: 'myApps', ico: '📂', title: '我的综测申请' },
      { key: 'review', ico: '🔎', title: '综测复核' },
      { key: 'notifications', ico: '🔔', title: '我的通知' },
      { group: '个人', items: [
        { key: 'changePwd', ico: '🔑', title: '修改密码', action: 'changePwd' },
        { key: 'logout', ico: '🚪', title: '退出登录', action: 'logout' },
      ] },
    ],
    monitor: [
      { key: 'monAuditApp', ico: '✅', title: '审核综测申请（已认定）' },
      { key: 'monAllApp', ico: '📋', title: '本班综测申请总览' },
      { key: 'monReview', ico: '🔎', title: '综测复核查看' },
      { key: 'monOverview', ico: '📊', title: '班级总览' },
      { key: 'monNotifications', ico: '🔔', title: '我的通知' },
      // 2026-08-31：去掉班长端「截止时间设置」（截止时间统一由年级/admin 管理）
      { group: '个人', items: [
        { key: 'changePwd', ico: '🔑', title: '修改密码', action: 'changePwd' },
        { key: 'logout', ico: '🚪', title: '退出登录', action: 'logout' },
      ] },
    ],
    grade: [
      { key: 'gradeReview', ico: '🔎', title: '复核审核' },
      { key: 'gradeAuditApp', ico: '✅', title: '审核未认定项目' },
      { key: 'gradeAllApp', ico: '📋', title: '综测申请总览' },
      { key: 'gradeOverrideApp', ico: '✏️', title: '修改已通过申请' },
      // 2026-08-30 权限收紧：grade 取消「统计看板」「账号管理」，仅保留 admin 分配班级对应的功能
      { group: '个人', items: [
        { key: 'changePwd', ico: '🔑', title: '修改密码', action: 'changePwd' },
        { key: 'logout', ico: '🚪', title: '退出登录', action: 'logout' },
      ] },
    ],
    admin: [
      // 2026-08-30 UI 信息架构优化 V1.0：按「用户任务流」分 5 组；children 为二级子菜单
      { group: '日常工作流', items: [
        { key: 'gradeAllApp', ico: '📋', title: '综测申请总览' },
        { key: 'gradeAuditApp', ico: '✅', title: '审核未认定项目' },
        { key: 'gradeReview', ico: '🔎', title: '复核审核' },
      ] },
      { group: '基础数据管理', items: [
        { key: 'certCatalog', ico: '📚', title: '已认定项目目录' },
        { key: 'sysConfig', ico: '🛠', title: '系统配置' }, // 时间与开榜 / 班级与审核权限 / 数据备份 三 Tab
        { key: 'adminUsers', ico: '👥', title: '账号管理' },
        { key: 'gradeLogs', ico: '🗂', title: '日志与审计' },
      ] },
      { group: '数据与统计', items: [
        { key: 'stats', ico: '📊', title: '统计看板' },
        { key: 'gradeExport', ico: '📤', title: '数据导出' },
        { key: 'zhiscores', ico: '🧮', title: '智育成绩计算' },
      ] },
      { group: '个人', items: [
        { key: 'changePwd', ico: '🔑', title: '修改密码', action: 'changePwd' },
        { key: 'logout', ico: '🚪', title: '退出登录', action: 'logout' },
      ] },
    ],
  };

  // 菜单路径索引（供 Task2 面包屑反查「首页 > 分组 > 当前页」）
  function buildMenuPath(role) {
    const map = {};
    // 当前角色最后遍历 → 其分组名优先覆盖（避免 grade/monitor 看到 admin 的分组名）
    const others = Object.keys(MENUS).filter(r => r !== role);
    const ordered = role ? [...others, role] : Object.keys(MENUS);
    ordered.forEach(r => {
      (MENUS[r] || []).forEach(g => {
        const items = (g && g.items) ? g.items : [g];
        items.forEach(m => {
          map[m.key] = { group: g.group || '', parent: '' };
          (m.children || []).forEach(c => { map[c.key] = { group: g.group || '', parent: m.title }; });
        });
      });
    });
    return map;
  }
  // 注：_menuPath 在登录后 renderMenu() 中按当前角色重新赋值；goto() 内以 (App._menuPath || {}) 兜底

  const TITLES = {
    submit: '提交材料（兼容旧版）', mySubs: '我的材料',
    submitApp: '提交综测申请表', myApps: '我的综测申请',
    review: '综测复核', notifications: '我的通知',
    monAudit: '审核中心（兼容）', monAll: '班级材料总览（兼容）', monOverview: '班级总览',
    monNotifications: '我的通知',
    monAuditApp: '审核综测申请（已认定部分）', monAllApp: '本班综测申请总览', monReview: '综测复核查看',
    gradeAudit: '审核中心（兼容）', gradeAll: '材料总览（兼容）',
    gradeAuditApp: '审核未认定项目', gradeAllApp: '综测申请总览',
    zhiscores: '智育成绩计算',
    certCatalog: '已认定项目目录',
    gradeReview: '综测复核审核',
    gradeExport: '数据导出',
    // 2026-08-30 UI 整理：页面标题统一命名（与菜单文案一致）
    gradeReview: '复核审核',
    gradeAuditApp: '审核未认定项目',
    gradeAllApp: '综测申请总览',
    gradeOverrideApp: '修改已通过申请',
    statsAndBackup: '统计与备份',
    gradeExport: '数据导出',
    gradeConfig: '时间与开榜配置',
    classMajors: '班级→专业映射',
    sysConfig: '系统配置',
    stats: '统计看板',
    statsAndBackup: '统计与备份',
    gradeLogs: '日志与审计',
    adminUsers: '账号管理',
    zhiscores: '智育成绩计算',
    certCatalog: '已认定项目目录',
  };

  async function renderMenu() {
    // 拉取最新配置（用于复核开放控制等需要动态显隐菜单的场景）
    try {
      App._cfg = await API.get('/api/config');
    } catch (_) {
      App._cfg = App._cfg || { reviewRounds: { first: false, second: false, third: false } };
    }
    // 统一为分组结构：admin 用 [{group, items}]，其它角色为平铺数组 → 归一化为 [{group:'', items}]
    let groups = (MENUS[user.role] || []).map(g => (g && g.items) ? { group: g.group || '', items: g.items.slice() } : { group: '', items: [g] });
    // 复核开放显示：仅 admin 勾选 X 榜复核开放，学生/班长端才显示该入口；三榜全关则完全隐藏
    if (user.role === 'student' || user.role === 'monitor') {
      const rr = (App._cfg && App._cfg.reviewRounds) || {};
      const anyOpen = !!(rr.first || rr.second || rr.third);
      if (!anyOpen) {
        groups = groups.map(g => ({ ...g, items: g.items.filter(m => m.key !== 'review' && m.key !== 'monReview') }));
      }
    }
    // 学生端：已有进行中/已通过的综测申请时禁用"提交综测申请"菜单（防止重复提交）
    let submitAppBlocked = false;
    if (user.role === 'student') {
      try {
        const { applications } = await API.get('/api/my/applications');
        submitAppBlocked = (applications || []).some(a => [a.certifiedStatus, a.uncertifiedStatus].some(s => s && s !== 'withdrawn'));
      } catch (_) {}
    }
    const hasChildren = (m) => Array.isArray(m.children) && m.children.length > 0;
    // 单项渲染：父按钮（可带 ▾ 箭头展开子项）+ 可选子菜单容器
    const itemHtml = (m, isSub) => {
      const blocked = (m.key === 'submitApp' && submitAppBlocked);
      const titleAttr = blocked ? ' title="您已有综测申请在审核中或已通过，需经班长/年级退回后才能重新提交"' : '';
      const cls = ['menu-item', blocked ? 'disabled' : '', isSub ? 'menu-sub' : '', hasChildren(m) ? 'has-children' : ''].filter(Boolean).join(' ');
      const ico = blocked ? '🚫' : m.ico;
      const hint = blocked ? ' <span style="font-size:11px;color:var(--text-2);display:block">已有申请</span>' : '';
      let onclick = '';
      if (!blocked) {
        if (m.action === 'logout') onclick = `App.doLogout()`;
        else if (m.action === 'changePwd') onclick = `App.openChangePwd()`;
        else if (hasChildren(m)) onclick = `App.toggleSubMenu('${m.key}', this)`;
        else onclick = `App.goto('${m.key}')`;
      }
      const arrow = hasChildren(m) ? '<span class="menu-arrow">▾</span>' : '';
      // 有 action 的父项（退出登录）子项默认展开，便于直接点改密；纯容器（安全配置）默认折叠
      const defaultOpen = !!m.action;
      const childrenHtml = hasChildren(m)
        ? `<div class="menu-children" id="submenu-${m.key}" style="display:${defaultOpen ? '' : 'none'}">${m.children.map(c => itemHtml(c, true)).join('')}</div>`
        : '';
      return `<button class="${cls}" data-key="${m.key}"${titleAttr}${blocked ? ' disabled' : ''} onclick="${onclick}">
          <span class="menu-ico">${ico}</span><span class="menu-txt">${m.title}</span>${hint}${arrow}</button>${childrenHtml}`;
    };
    document.getElementById('menu').innerHTML = groups.map(g => {
      if (!g.items.length) return '';
      const btns = g.items.map(m => itemHtml(m, false)).join('');
      // 分组标题（仅分组菜单有 group 文案）
      return g.group ? `<div class="menu-group">${g.group}</div>${btns}` : btns;
    }).join('');
    // 刷新当前角色的面包屑路径索引（Task2）
    App._menuPath = buildMenuPath(user.role);
    document.getElementById('roleLabel').textContent = ROLE_LABEL[user.role];
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userClass').textContent = user.role === 'student' ? (user.className + ' · ' + user.studentId) : user.className;
    document.getElementById('userAvatar').textContent = user.name.slice(0, 1);
  }

  async function goto(key, param) {
    current = key;
    // 学生端兜底：已存在未退出的申请时，禁止进入"提交综测申请"页（防止 URL 绕过或调用 App.goto）
    if (key === 'submitApp' && user && user.role === 'student') {
      try {
        const { applications } = await API.get('/api/my/applications');
        const blocked = (applications || []).some(a => [a.certifiedStatus, a.uncertifiedStatus].some(s => s && s !== 'withdrawn'));
        if (blocked) {
          toast('您已有综测申请在审核中或已通过，需经班长/年级退回后才能重新提交', 'err');
          // 跳到"我的综测申请"页以便查看
          key = 'myApps';
        }
      } catch (_) {}
    }
    document.querySelectorAll('.menu-item').forEach(el => el.classList.toggle('active', el.dataset.key === key));
    document.getElementById('pageTitle').textContent = TITLES[key] || '工作台';
    // 安全防护：页面切换时刷新水印"页面"字段
    try { if (window.Sec && typeof Sec.refresh === 'function') Sec.refresh(TITLES[key] || key || ''); } catch (_) {}
    const el = document.getElementById('content');
    el.innerHTML = '<div class="empty">加载中…</div>';
    try {
      let html;
      switch (key) {
        case 'review': html = await AppViews.reviewHome(); break;
        case 'reviewSubmit': html = await AppViews.submitReviewForm(param || 'first'); break;
        case 'monReview': html = await AppViews.monReviewList(param || 'all'); break;
        case 'gradeReview': html = await AppViews.gradeReviewList(param || 'first'); break;
        // 公示与异议板块已移除
        case 'notifications': html = await AppViews.notifications(); break;
        case 'monNotifications': html = await AppViews.notifications(); break;
        case 'submitApp':
          html = AppViews.submitApp();
          // 提交后初始化默认空行
          setTimeout(async () => {
            // 加载已认定项目目录缓存（学生端选择用）
            try {
              const cc = await API.get('/api/cert-catalog');
              window.__certCat = cc.items || [];
              const dl = document.getElementById('cc-code-list');
              if (dl) dl.innerHTML = (cc.items || []).map(c => `<option value="${FMT.esc(c.code)}">${FMT.esc(c.code)} ${FMT.esc(c.name)}</option>`).join('');
            } catch (_) { window.__certCat = window.__certCat || []; }
            if (document.getElementById('a-cert-items') && !document.getElementById('a-cert-items').children.length) AppViews.addCertItem();
            if (document.getElementById('a-uncert-items') && !document.getElementById('a-uncert-items').children.length) AppViews.addUncertItem();
          }, 50);
          break;
        case 'myApps': html = await AppViews.myApps(); break;
        case 'monStudents': html = await MonitorViews.overview(); break;
        case 'monOverview': html = await MonitorViews.overview(); break;
        case 'monStats': html = await MonitorViews.overview(); break;
        case 'monAuditApp': html = await AppViews.monitorAuditApp(param || 'pending'); break;
        case 'monAllApp': html = await AppViews._appsOverview(); break;
        case 'monConfig': html = await AppViews.monitorConfigPage(); break; // 2026-08-31：菜单已移除，分支保留兼容直接访问
        case 'gradeAuditApp': html = await AppViews.gradeAuditUncertApp(param || 'pending'); break;
        case 'gradeAllApp': html = await AppViews._appsOverview(); break;
        case 'gradeOverrideApp': html = await AppViews.gradeOverrideApp(); break;
        case 'gradeStats': html = await AppViews.statsAndBackup(); break;
        case 'statsAndBackup': html = await AppViews.statsPage(); break; // 旧入口兼容（Task3 后指向独立统计看板）
        case 'stats': html = await AppViews.statsPage(); break; // Task3：统计看板独立页（备份已移入系统配置）
        case 'gradeExport': html = await GradeViews.exportGradeStatsPage(param || 'class'); break;
        case 'gradeConfig': html = await AppViews.configPage(); break;
        case 'sysConfig': html = await AdminViews.sysConfigPage(param || 'time'); break; // P3：系统配置双 Tab
        case 'classMajors': html = await AdminViews.classMajorsPage(); break; // 兼容旧入口（新入口为 sysConfig 的 class Tab）
        case 'gradeLogs':
          window._logTab = param || 'store';
          html = await AppViews.logsPage();
          setTimeout(() => {
            AppViews._switchLogTab();
            if (window._logTab === 'audit') AppViews.loadAuditLogs(1);
          }, 80);
          break;
        case 'classMajors': html = await AdminViews.classMajorsPage(); break;
        case 'adminUsers': html = await AdminViews.users(param || {}); break;
        case 'zhiscores': if (user.role !== 'admin') { html = '<div class="empty">仅管理员可访问</div>'; } else { html = await AppViews.zhiscoresPage(); } break;
        case 'certCatalog': if (user.role !== 'admin') { html = '<div class="empty">仅管理员可访问</div>'; } else { html = await AppViews.certCatalogPage(); } break;
        default: html = '<div class="empty">页面不存在</div>';
      }
      // Task2（2026-08-30）：统一面包屑「首页 › 分组 › 当前页」，插在内容区顶部
      el.innerHTML = breadcrumbHtml(key) + html;
      // 刷新未读通知角标
      refreshBadges();
    } catch (e) {
      // 会话过期/角色不匹配 → 自动回到登录页
      if (String(e.message).includes('会话') || String(e.message).includes('无权') || String(e.message).includes('登录')) {
        showLogin();
        return;
      }
      el.innerHTML = `<div class="card"><div class="empty">加载失败：${FMT.esc(e.message)}</div></div>`;
    }
  }

  function classFilterHtml(key, selected, classes) {
    return `<select onchange="App.goto('${key}',{className:this.value})">
      <option value="all" ${!selected || selected === 'all' ? 'selected' : ''}>全部班级</option>
      ${(classes || []).map(c => `<option value="${FMT.esc(c)}" ${selected === c ? 'selected' : ''}>${FMT.esc(c)}</option>`).join('')}
    </select>`;
  }

  async function refreshBadges() {
    try {
      if (user.role === 'student' || user.role === 'monitor') {
        const { notifications } = await API.myNotifications();
        const unread = notifications.filter(n => !n.read).length;
        const badge = document.getElementById('announceBadge');
        badge.style.display = unread ? 'inline-block' : 'none';
        badge.textContent = unread + ' 条未读通知';
      }
    } catch (_) { }
  }

  function showMain(u) {
    user = u;
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('mainPage').style.display = 'flex';
    (async () => {
      // 安全防护初始化（2026-08-30）：明水印 + 截屏/打印限制（页面暗水印效果不佳已停用）
      try {
        const sec = await API.get('/api/me/security');
        Sec.init({ name: u.name, username: u.username, role: u.role, ip: sec.ip || '', ua: sec.ua || '', page: '' }, { dark: false });
      } catch (_) {
        Sec.init({ name: u.name, username: u.username, role: u.role, page: '' }, { dark: false });
      }
      // admin 显示安全设置入口（截屏限制开关 + 水印信息）
      const secBtn = document.getElementById('secToggleBtn');
      if (secBtn) {
        secBtn.style.display = u.role === 'admin' ? 'inline-flex' : 'none';
        secBtn.onclick = () => AppViews.securitySettings();
      }
      await renderMenu();
      goto(user.role === 'student' ? 'submitApp' : user.role === 'monitor' ? 'monAuditApp' : 'gradeAuditApp');
      // 截止倒计时横幅（2026-08-31）：学生端距提交截止 / 班长端距审批截止，剩余 <3h 显示
      try { AppViews._deadlineBanner(); } catch (_) {}
      // 强制修改二级审核密码（仍为初始默认值时必须改）
      if (u.mustChangeSecondary) {
        setTimeout(() => AppViews.forceChangeSecPwd(), 100);
      } else if (u.mustChangePassword) {
        // 强制修改登录密码（首次登录或被重置密码后）
        setTimeout(() => AppViews.forceChangePassword(), 100);
      }
    })();
  }

  // 跳回登录页（清空当前界面状态，不刷新页面，避免循环）
  function showLogin() {
    user = null;
    current = null;
    document.getElementById('menu').innerHTML = '';
    document.getElementById('mainPage').style.display = 'none';
    document.getElementById('loginPage').style.display = 'flex';
    document.getElementById('loginPassword').value = '';
  }

  // Task2：面包屑 HTML（首页 › 分组 › 父级 › 当前页）
  function breadcrumbHtml(key) {
    const cur = TITLES[key] || '';
    if (!cur) return ''; // 无标题页面（如登录）不显示
    const path = (App._menuPath || {})[key] || {};
    const homeKey = user.role === 'student' ? 'submitApp' : user.role === 'monitor' ? 'monAuditApp' : 'gradeAllApp';
    const parts = [`<span class="bc-home" onclick="App.goto('${homeKey}')">🏠 首页</span>`];
    if (path.group) parts.push(`<span class="bc-sep">›</span><span>${FMT.esc(path.group)}</span>`);
    if (path.parent) parts.push(`<span class="bc-sep">›</span><span>${FMT.esc(path.parent)}</span>`);
    parts.push(`<span class="bc-cur">${FMT.esc(cur)}</span>`);
    return `<nav class="breadcrumb">${parts.join('')}</nav>`;
  }

  // ===== 菜单动作（2026-08-30 UI 优化）：供菜单项 action 调用 =====
  // 注意：这些方法原以 App.x = ... 在 IIFE 构造期赋值，会触发 TDZ（Cannot access 'App' before initialization）。
  // 改为局部函数声明，并在末尾 return 中暴露，避免构造期引用 App。
  async function doLogout() {
    if (!confirm('确定退出登录吗？')) return;
    try { await API.post('/api/logout'); } catch (_) {}
    localStorage.removeItem('zc_token'); localStorage.removeItem('zc_user');
    API.setToken('');
    showLogin();
  }
  function openChangePwd() { try { AppViews.changePasswordModal(); } catch (_) {} }
  // 二级子菜单展开/折叠
  function toggleSubMenu(key, el) {
    const box = document.getElementById('submenu-' + key);
    if (!box) return;
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : '';
    if (el) el.classList.toggle('expanded', !open);
  }

  async function init() {
    // 登录
    document.getElementById('loginBtn').addEventListener('click', doLogin);
    document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    // 手机端：汉堡菜单开合
    const sidebar = document.getElementById('mainPage').querySelector('.sidebar');
    document.getElementById('menuToggle').addEventListener('click', () => sidebar.classList.toggle('open'));
    document.getElementById('content').addEventListener('click', () => sidebar.classList.remove('open'));
    document.getElementById('menu').addEventListener('click', () => sidebar.classList.remove('open'));
    // 文件选择列表
    document.addEventListener('change', (e) => {
      if (e.target.id === 'f-files') {
        const names = [...e.target.files].map(f => f.name).join('、');
        const el = document.getElementById('f-file-list');
        if (el) el.textContent = names ? '已选择：' + names : '';
      }
    });
    // 恢复登录：真实认证在 httpOnly Cookie（服务端），只要有本地登录态记录就尝试 /api/me 校验
    const saved = localStorage.getItem('zc_user');
    if (saved) {
      try {
        const { user: u } = await API.get('/api/me');
        // 探测：调用角色专属 API，验证 token 与角色匹配（防止残留旧 token 导致界面显示但接口全 403）
        if (u.role === 'student') await API.get('/api/my/submissions');
        else if (u.role === 'monitor') await API.get('/api/monitor/students');
        else await API.get('/api/grade/stats');
        localStorage.setItem('zc_user', JSON.stringify(u));
        showMain(u);
        return;
      } catch (e) {
        // 会话过期/角色不匹配 → 清除并显示登录页
        localStorage.removeItem('zc_token');
        localStorage.removeItem('zc_user');
        API.setToken('');
        showLogin();
        return;
      }
    }
    showLogin();
  }

  async function doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) { showLoginError('请输入账号和密码'); return; }
    try {
      const { token, user: u } = await API.login(username, password);
      API.setToken(token);
      localStorage.setItem('zc_user', JSON.stringify(u));
      showMain(u);
    } catch (e) { showLoginError(e.message); }
  }

  function showLoginError(msg) {
    document.getElementById('loginError').textContent = msg;
  }

  return { init, goto, classFilterHtml, setContent: (h) => { document.getElementById('content').innerHTML = h; },
    refreshMenu: async () => { await renderMenu(); },
    doLogout, openChangePwd, toggleSubMenu,
    get user() { return user; },
    showLogin, showMain };
})();

// ============ 学生：修改并重新提交 ============

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
