// ============ API 封装 ============
// 认证：服务端把 token 设在 httpOnly Cookie，前端无法读取。
// token 仅保留内存态作为"已登录态"标记（不再写入 localStorage、不再发送 Authorization 头），
// 一切请求只依赖 Cookie（credentials: 'include'）。
const API = (() => {
  let token = ''; // 内存标记：本会话是否登录过（真实认证在 httpOnly Cookie）
  // GET 请求 30s TTL 缓存（2026-08-30 性能优化）：key=完整 url（含 query）
  const getCache = new Map();
  const GET_TTL = 30 * 1000;

  async function request(method, url, body, isForm) {
    const headers = {};
    if (body && !isForm) headers['Content-Type'] = 'application/json';
    // GET 30s TTL 缓存（2026-08-30 性能优化）：去重跨页面重复请求（如 adminUsers 208KB 被拉 3 次）
    if (method === 'GET' && !isForm) {
      const hit = getCache.get(url);
      if (hit && Date.now() - hit.ts < GET_TTL) return hit.data;
    }
    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include', // ★ 关键：携带 httpOnly Cookie
      body: isForm ? body : (body ? JSON.stringify(body) : undefined),
    });
    const data = await res.json().catch(() => ({}));
    // 401：会话过期（中间件 code=session_expired）→ 清登录态跳登录页；
    //      其他 401（端点内业务错误，如密码错）→ 直接 toast 后端真实错误，不清登录态
    if (res.status === 401) {
      if (data && data.code === 'session_expired') {
        localStorage.removeItem('zc_token');
        localStorage.removeItem('zc_user');
        API.setToken('');
        throw new Error('会话已过期，请重新登录');
      }
      throw new Error(data.error || '认证失败');
    }
    // 403：角色不匹配 → 视为会话过期（旧行为兼容）
    if (res.status === 403) {
      localStorage.removeItem('zc_token');
      localStorage.removeItem('zc_user');
      API.setToken('');
      throw new Error(data.error || '无权操作此功能，请重新登录');
    }
    if (!res.ok) throw new Error(data.error || '请求失败');
    // 缓存写回：GET 缓存成功响应；任何写操作（POST/PUT/DELETE）后整体失效（保数据一致性）
    if (method === 'GET' && !isForm) {
      getCache.set(url, { data, ts: Date.now() });
    } else if (method !== 'GET') {
      getCache.clear();
    }
    return data;
  }
  // 二进制下载（POST + Blob 响应）：用于 Excel 导出等
  async function postBlob(url, body) {
    const headers = {};
    headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401 || res.status === 403) {
      // 先读 body：session_expired 才是真会话过期；业务 401（如二级密码错误）直接透传后端错误
      let errBody = null;
      try { errBody = await res.clone().json(); } catch (_) {}
      if (errBody && errBody.code === 'session_expired') {
        localStorage.removeItem('zc_token');
        localStorage.removeItem('zc_user');
        API.setToken('');
        throw new Error('会话已过期，请重新登录');
      }
      if (errBody && errBody.error) throw new Error(errBody.error);
      if (res.status === 403) {
        localStorage.removeItem('zc_token');
        localStorage.removeItem('zc_user');
        API.setToken('');
        throw new Error('无权操作此功能，请重新登录');
      }
      throw new Error('请求失败（401）');
    }
    if (!res.ok) {
      let err = '请求失败';
      try { const d = await res.json(); err = d.error || err; } catch (_) {}
      throw new Error(err);
    }
    return await res.blob();
  }
  // multipart 上传 + Blob 响应（如"上传智育文件生成公示版"）
  async function uploadBlob(url, formData) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('zc_token');
      localStorage.removeItem('zc_user');
      API.setToken('');
      throw new Error('会话已过期，请重新登录');
    }
    if (!res.ok) {
      let err = '请求失败';
      try { const d = await res.json(); err = d.error || err; } catch (_) {}
      throw new Error(err);
    }
    return await res.blob();
  }

  // multipart 上传 + 自动重试（2026-08-31 软截止配套）：仅网络错误/5xx 重试 2 次（1s/3s 退避）；
  // 4xx 业务错误（校验失败、截止拒绝等）直接抛不重试，防止重复提交
  async function uploadWithRetry(url, formData, maxRetries = 2) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 3000));
      try {
        const res = await fetch(url, { method: 'POST', credentials: 'include', body: formData });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && data && data.code === 'session_expired') {
          localStorage.removeItem('zc_token'); localStorage.removeItem('zc_user');
          API.setToken('');
          throw new Error('会话已过期，请重新登录');
        }
        if (res.status === 403) {
          localStorage.removeItem('zc_token'); localStorage.removeItem('zc_user');
          API.setToken('');
          throw new Error('无权操作此功能，请重新登录');
        }
        if (res.ok) { getCache.clear(); return data; }
        if (res.status >= 500) { lastErr = new Error(data.error || '服务器繁忙，请稍后重试'); continue; }
        throw new Error(data.error || '请求失败'); // 4xx：业务错误，不重试
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('会话') || msg.includes('无权') || msg.includes('请求失败')) throw e;
        lastErr = e; // 网络错误 → 下一轮重试
      }
    }
    throw lastErr || new Error('上传失败，请稍后重试');
  }

  return {
    get token() { return token; },
    setToken(t) { token = t; }, // 仅内存标记，不再写 localStorage
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url, body) => request('DELETE', url, body),
    upload: (url, formData) => request('POST', url, formData, true),
    uploadWithRetry: (url, formData, maxRetries) => uploadWithRetry(url, formData, maxRetries),
    uploadBlob: (url, formData) => uploadBlob(url, formData),
    postBlob: (url, body) => postBlob(url, body),
    // ---- 认证 ----
    login: (username, password) => request('POST', '/api/login', { username, password }),
    // ---- 学生 ----
    myNotifications: () => request('GET', '/api/my/notifications'),
    readNotification: (id) => request('POST', `/api/my/notifications/${id}/read`),
    announcements: () => request('GET', '/api/announcements'),
    announcementDetail: (id) => request('GET', `/api/announcements/${id}`),
    raiseObjection: (id, body) => request('POST', `/api/announcements/${id}/objections`, body),
    // ---- 班长 ----
    monitorStudents: () => request('GET', '/api/monitor/students'),
    monitorStats: () => request('GET', '/api/monitor/stats'),
    notifyStudent: (stuId, body) => request('POST', `/api/students/${stuId}/notify`, body),
    // ---- 年级 ----
    objections: () => request('GET', '/api/objections'),
    handleObjection: (oid, body) => request('POST', `/api/objections/${oid}/handle`, body),
    createAnnouncement: (body) => request('POST', '/api/announcements', body),
    endAnnouncement: (id) => request('POST', `/api/announcements/${id}/end`),
    gradeStats: () => request('GET', '/api/grade/stats'),
    logs: (q) => request('GET', '/api/logs?' + new URLSearchParams(q)),
    // ---- 管理员 ----
    adminUsers: (q) => request('GET', '/api/admin/users?' + new URLSearchParams(q)),
    createUser: (body) => request('POST', '/api/admin/users', body),
    updateUser: (id, body) => request('POST', `/api/admin/users/${id}/update`, body),
    deleteUser: (id) => request('DELETE', `/api/admin/users/${id}`),
    resetPassword: (id, body) => request('POST', `/api/admin/users/${id}/reset-password`, body),
    // ⚠️ showPassword 已移除：忘记密码统一走 resetPassword 让系统生成新密码
    changePassword: (oldPwd, newPwd) => request('POST', '/api/me/change-password', { oldPassword: oldPwd, newPassword: newPwd }),
    adminStats: () => request('GET', '/api/admin/stats'),
  };
})();

// ============ 通用工具 ============
const FMT = {
  time: (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  status: {
    pending: { text: '待审核', cls: 'tag-pending' },
    approved: { text: '已通过', cls: 'tag-approved' },
    rejected: { text: '已驳回', cls: 'tag-rejected' },
    resubmit: { text: '待补交', cls: 'tag-resubmit' },
    overridden: { text: '已改判', cls: 'tag-obj' },
    withdrawn: { text: '已退回', cls: 'tag-resubmit' },
    // 学生/班长端专用：隐藏具体审核结果，统一显示"已审核/未审核"
    reviewed: { text: '已审核', cls: 'tag-reviewed' },
    unreviewed: { text: '未审核', cls: 'tag-pending' },
  },
  category: {
    certified: { text: '已认定', cls: 'tag-certified' },
    uncertified: { text: '未认定', cls: 'tag-uncertified' },
  },
  actionText: {
    submit: '提交材料', resubmit: '重新提交', approve: '审核通过',
    reject: '审核驳回', resubmit2: '要求补交', override: '年级改判',
    'objection-agree': '异议成立', 'objection-reject': '异议不成立',
    withdraw: '自行撤回', 'withdraw-ok': '同意退回', 'withdraw-reject': '拒绝退回',
    // 2026-08-27 新增：4 情形退回 + 整段重写 + 二级密码修改 + 复核补交
    'withdraw-all': '自行退回整表',
    'withdraw-req-cert': '申请退回已认定',
    'withdraw-req-uncert': '申请退回未认定',
    'force-withdraw': '主动退回',
    rewrite: '重写本段',
    'review-items': '批量审核项目',
    'grade-modify': '二级密码修改',
    'resubmit-item': '补交材料',
  },
  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
};

// ============ Toast ============
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ============ 弹窗 ============
// window.__lockModal 为 true 时，弹窗被锁定（强制改密等场景不可关闭，防止跳过）
function openModal(html) {
  document.getElementById('modalBox').innerHTML = html;
  document.getElementById('modalMask').style.display = 'flex';
}
function closeModal() {
  if (window.__lockModal) return; // 锁定状态下禁止关闭
  document.getElementById('modalMask').style.display = 'none';
  document.getElementById('modalBox').innerHTML = '';
  // 2026-09-10 重置 modal-lg 状态（避免前次 modal-lg 弹窗残留类名，导致下次普通弹窗也被拉宽）
  document.getElementById('modalBox').className = 'modal';
}
document.getElementById('modalMask')?.addEventListener('click', (e) => {
  if (window.__lockModal) return;
  if (e.target === e.currentTarget) closeModal();
});

// ============ 附件预览独立层（2026-09-09）============
// 与 openModal/closeModal 完全独立：预览显示在更高层级容器，不覆盖下层弹窗。
// 用于 previewFile：从「综测申请详情/审核详情」等弹窗里点开附件，关闭预览后原弹窗保留。
function openPreview(html) {
  document.getElementById('previewBox').innerHTML = html;
  document.getElementById('previewMask').style.display = 'flex';
}
function closePreview() {
  document.getElementById('previewMask').style.display = 'none';
  document.getElementById('previewBox').innerHTML = '';
}
document.getElementById('previewMask')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePreview();
});
