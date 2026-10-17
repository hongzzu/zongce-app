/* ============================================================
 * 综测系统安全防护模块（自研，零外部依赖，2026-08-30）
 * 1. 明水印   ：Canvas 生成半透明倾斜文字 + MutationObserver 防删除
 * 2. 暗水印   ：LSB 像素隐写（文本写入页面背景图最低位，肉眼不可见，截图可解码）
 * 3. 文本水印 ：零宽字符（ZWSP/ZWNJ/ZWJ）嵌入不可见水印
 * 4. 截屏/打印限制：右键 + 快捷键拦截（admin 可开关）
 * 5. 统一水印内容：操作人 / 时间 / 页面 / IP / 设备(UA前50) / 唯一ID
 * ============================================================ */
(function () {
  'use strict';
  const Sec = {};

  // ---------- 工具 ----------
  Sec.uuid = () => {
    try { return crypto.randomUUID(); } catch (e) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
  };
  const pad2 = n => String(n).padStart(2, '0');
  Sec.fmtTime = (d) => d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : '';

  // ---------- 水印内容（统一规范） ----------
  // 操作人：姓名(工号) | 时间：YYYY-MM-DD HH:mm:ss | 页面：xxx | IP：x.x.x.x | 设备：UA前50 | ID：uuid
  Sec._info = { name: '', username: '', role: '', page: '', ip: '', ua: '', id: '' };
  Sec.setInfo = (info) => { Object.assign(Sec._info, info || {}); if (!Sec._info.id) Sec._info.id = Sec.uuid(); };
  Sec.getInfo = () => Object.assign({}, Sec._info);
  Sec.buildText = (page) => {
    const i = Sec._info;
    const uaShort = (i.ua || navigator.userAgent || '').slice(0, 50);
    return `操作人：${i.name || '未知'}(${i.username || '-'}) | 时间：${Sec.fmtTime(new Date())} | 页面：${page || i.page || '-'} | IP：${i.ip || '-'} | 设备：${uaShort} | ID：${i.id}`;
  };

  // ============================================================
  // 1. 明水印（Canvas + MutationObserver 防删除）
  // ============================================================
  Sec._wm = { el: null, observer: null, text: '', opts: null };
  Sec.initVisibleWatermark = function (options = {}) {
    // opacity 0.08（略提可见性便于核对），字号 15
    const opts = Object.assign({ color: '#333333', opacity: 0.08, fontSize: 15, rotate: -28, density: 200, text: '' }, options);
    Sec._wm.text = opts.text || Sec.buildText();
    Sec._wm.opts = opts;
    Sec._destroyVisible();
    Sec._createVisible();
    Sec._watchVisible();
  };
  Sec._destroyVisible = () => {
    if (Sec._wm.observer) { Sec._wm.observer.disconnect(); Sec._wm.observer = null; }
    if (Sec._wm.el && Sec._wm.el.parentNode) Sec._wm.el.parentNode.removeChild(Sec._wm.el);
    Sec._wm.el = null;
  };
  Sec._createVisible = () => {
    const opts = Sec._wm.opts; const size = opts.density;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.rotate((opts.rotate * Math.PI) / 180);
    ctx.font = `${opts.fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillStyle = opts.color;
    ctx.globalAlpha = opts.opacity;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = Sec._wm.text.split(' | ');
    lines.forEach((ln, idx) => ctx.fillText(ln, 0, (idx - (lines.length - 1) / 2) * (opts.fontSize + 6)));
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;` +
      `background-image:url(${canvas.toDataURL('image/png')});background-repeat:repeat;background-size:${size}px ${size}px;`;
    div.setAttribute('data-wb-wm', '1');
    (document.body || document.documentElement).appendChild(div);
    Sec._wm.el = div;
  };
  Sec._watchVisible = () => {
    Sec._wm.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          const removed = Array.from(m.removedNodes || []);
          if (removed.some(n => n === Sec._wm.el || (n.contains && n.contains(Sec._wm.el)))) { Sec._createVisible(); break; }
        }
        if (m.type === 'attributes' && m.target === Sec._wm.el) { Sec._createVisible(); break; }
      }
    });
    Sec._wm.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'id'] });
  };

  // ============================================================
  // 2. 暗水印（LSB 像素隐写）—— 编码文本到页面背景图最低位
  // ============================================================
  // 编码格式：前 32 bit = UTF-8 字节长度 N；之后 N×8 bit = 字节流（每像素 R 通道 1 bit）
  Sec._textToBytes = (s) => {
    if (window.TextEncoder) return Array.from(new TextEncoder().encode(s));
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) { bytes.push(192 | (c >> 6), 128 | (c & 63)); }
      else { bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); }
    }
    return bytes;
  };
  Sec._bytesToText = (bytes) => {
    if (window.TextDecoder) return new TextDecoder().decode(new Uint8Array(bytes));
    let out = ''; for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      if (b < 128) { out += String.fromCharCode(b); i++; }
      else if (b < 224) { out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
      else { out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
    }
    return out;
  };
  // 生成暗水印背景 dataURL（铺满视口，1:1 像素）
  Sec.makeDarkCanvasDataURL = (text, w = window.innerWidth, h = window.innerHeight) => {
    if (!w || !h) { w = 1600; h = 900; }
    const bytes = Sec._textToBytes(text || '');
    const totalBits = 32 + bytes.length * 8;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const data = img.data;
    // 写入：每像素 R 通道低位
    let bitIdx = 0;
    const bitAt = (idx) => {
      if (idx < 32) return (bytes.length >> (31 - idx)) & 1;
      const bi = (idx - 32) >> 3;
      if (bi >= bytes.length) return 0;
      return (bytes[bi] >> (7 - ((idx - 32) & 7))) & 1;
    };
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      let r = 255;
      if (bitIdx < totalBits) { r = (255 & ~1) | bitAt(bitIdx); bitIdx++; }
      data[p] = r; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  };
  // 初始化暗水印：作为 body 背景（截图会携带像素低位信息）
  Sec._darkBg = null;
  Sec.initDarkWatermark = (text) => {
    const bg = Sec.makeDarkCanvasDataURL(text || Sec.buildText());
    Sec._darkBg = bg;
    document.body.style.backgroundImage = `url(${bg})`;
    document.body.style.backgroundRepeat = 'repeat';
    document.body.style.backgroundSize = `${window.innerWidth || 1600}px ${window.innerHeight || 900}px`;
  };
  // 解码：图片文件/DataURL → 文本
  Sec.decodeDark = (fileOrDataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        // 读位
        let bitIdx = 0; const bits = [];
        for (let i = 0; i < c.width * c.height; i++) { bits.push(d[i * 4] & 1); }
        // 解析长度（前 32 bit）
        const readBits = (from, count) => {
          let v = 0; for (let k = 0; k < count; k++) v = (v << 1) | (bits[from + k] || 0); return v;
        };
        const len = readBits(0, 32);
        if (len <= 0 || len > 1024 * 1024) return resolve('');
        const bytes = [];
        for (let bi = 0; bi < len; bi++) {
          let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | (bits[32 + bi * 8 + k] || 0);
          bytes.push(b);
        }
        const txt = Sec._bytesToText(bytes);
        resolve(txt && txt.trim() ? txt : '');
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('图片加载失败'));
    if (fileOrDataUrl instanceof Blob || fileOrDataUrl instanceof File) {
      const rd = new FileReader();
      rd.onload = () => { img.src = rd.result; };
      rd.onerror = () => reject(new Error('文件读取失败'));
      rd.readAsDataURL(fileOrDataUrl);
    } else img.src = fileOrDataUrl;
  });

  // ============================================================
  // 3. 文本水印（零宽字符）
  //   0 → \u200B(ZWSP)  1 → \u200C(ZWNJ)
  // ============================================================
  Sec._encZW = (text) => {
    const bytes = Sec._textToBytes(text || '');
    let out = '';
    // 前 16 bit 长度
    for (let k = 15; k >= 0; k--) out += ((bytes.length >> k) & 1) ? '\u200C' : '\u200B';
    for (const b of bytes) for (let k = 7; k >= 0; k--) out += ((b >> k) & 1) ? '\u200C' : '\u200B';
    return out;
  };
  Sec._decZW = (s) => {
    const zws = (s || '').match(/[\u200B\u200C]/g) || [];
    if (zws.length < 16) return '';
    const readBits = (from, count) => {
      let v = 0; for (let k = 0; k < count; k++) v = (v << 1) | (zws[from + k] === '\u200C' ? 1 : 0); return v;
    };
    const len = readBits(0, 16);
    if (len <= 0 || len > 1024 * 256) return '';
    const bytes = [];
    for (let bi = 0; bi < len; bi++) {
      let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | (zws[16 + bi * 8 + k] === '\u200C' ? 1 : 0);
      bytes.push(b);
    }
    return Sec._bytesToText(bytes);
  };
  Sec.addTextWatermark = (content, info) => {
    const wm = Sec._encZW((info || Sec.buildText()));
    return (content || '') + wm;
  };
  Sec.extractTextWatermark = (s) => Sec._decZW(s);

  // ============================================================
  // 5. 明水印增强查看（截图 → 旋转校正 + 对比度增强，供人眼读取）
  // opts: { rotate(度, 默认28=校正-28°倾斜), contrast(1~5, 默认2.2), invert(反色), zoom(放大) }
  // ============================================================
  Sec.renderWatermarkEnhance = function (img, canvas, opts = {}) {
    const rotate = opts.rotate != null ? opts.rotate : 28;
    const contrast = opts.contrast != null ? opts.contrast : 2.2;
    const invert = !!opts.invert;
    const zoom = opts.zoom || 1;
    const ctx = canvas.getContext('2d');
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return '';
    const rad = rotate * Math.PI / 180;
    const cw = Math.ceil((Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) * zoom);
    const ch = Math.ceil((Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h) * zoom);
    canvas.width = cw; canvas.height = ch;
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rad);
    ctx.filter = `contrast(${contrast}) brightness(1.08)${invert ? ' invert(1)' : ''}`;
    ctx.drawImage(img, (-w * zoom) / 2, (-h * zoom) / 2, w * zoom, h * zoom);
    ctx.restore();
    try { return canvas.toDataURL('image/png'); } catch (e) { return ''; }
  };

  // ============================================================
  // 4. 截屏/打印限制（admin 可开关；开关状态存 localStorage）
  // ============================================================
  Sec._privacyEnabled = true;
  Sec._privacyKey = 'wb_privacy_block';
  Sec.isPrivacyEnabled = () => {
    const v = localStorage.getItem(Sec._privacyKey);
    return v === null ? true : v !== '0';
  };
  Sec.setPrivacyEnabled = (on) => {
    localStorage.setItem(Sec._privacyKey, on ? '1' : '0');
    Sec._privacyEnabled = on;
    if (on) Sec.enablePrivacy(); else Sec.disablePrivacy();
  };
  Sec._privacyOn = false;
  Sec._lastEventReport = 0;
  Sec._reportEvent = (action, page, content) => {
    // 节流：同一事件 2 秒内只上报一次，避免刷日志
    const now = Date.now();
    if (now - Sec._lastEventReport < 2000) return;
    Sec._lastEventReport = now;
    try {
      fetch('/api/audit/event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action, page: Sec._info.page || '', content: content || '', scope: '' }),
      }).catch(() => {});
    } catch (_) {}
  };
  Sec.enablePrivacy = () => {
    if (Sec._privacyOn) return;
    Sec._privacyOn = true;
    Sec._onCtx = (e) => { e.preventDefault(); Sec._privacyTip('已禁止右键菜单（保护数据安全）'); };
    Sec._onKey = (e) => {
      const k = (e.key || '').toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && ['s', 'p', 'c', 'x', 'u'].includes(k)) {
        e.preventDefault();
        // 审计上报：复制/打印事件
        if (k === 'p') Sec._reportEvent('print_page');
        if (k === 'c') {
          let sel = '';
          try { sel = String(window.getSelection ? window.getSelection().toString() : '').slice(0, 50); } catch (_) {}
          Sec._reportEvent('copy_text', '', sel);
        }
        Sec._privacyTip('已禁止此快捷键（保护数据安全）');
        return false;
      }
      // 单独拦截 Ctrl+P 打印、Ctrl+S 保存（最常被用来泄露）
      if ((e.ctrlKey || e.metaKey) && (k === 'p' || k === 's')) {
        e.preventDefault();
        if (k === 'p') Sec._reportEvent('print_page');
        return false;
      }
    };
    document.addEventListener('contextmenu', Sec._onCtx, true);
    document.addEventListener('keydown', Sec._onKey, true);
  };
  Sec.disablePrivacy = () => {
    if (!Sec._privacyOn) return;
    Sec._privacyOn = false;
    document.removeEventListener('contextmenu', Sec._onCtx, true);
    document.removeEventListener('keydown', Sec._onKey, true);
  };
  Sec._privacyTip = (msg) => {
    if (window.toast) toast(msg, 'err');
  };

  // ---------- 一键初始化（登录后调用） ----------
  // info: { name, username, role, ip, ua, page }
  Sec.init = (info, opts = {}) => {
    Sec.setInfo(info);
    if (opts.visible !== false) Sec.initVisibleWatermark({ text: Sec.buildText(info.page) });
    if (opts.dark !== false) Sec.initDarkWatermark(Sec.buildText(info.page));
    if (opts.privacy !== false && Sec.isPrivacyEnabled()) Sec.enablePrivacy();
  };
  // 刷新水印（页面切换时更新"页面"字段；页面暗水印已停用，仅刷新明水印）
  Sec.refresh = (page) => {
    Sec._info.page = page;
    const t = Sec.buildText(page);
    if (Sec._wm.el) Sec.initVisibleWatermark({ text: t, ...(Sec._wm.opts || {}) });
  };

  window.Sec = Sec;
})();
