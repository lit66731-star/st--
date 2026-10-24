// ============ 悬置之境 (Suspension Realm) · 酒馆巡查插件 ============
//
// 功能（按上线顺序）：
//   功能3 · 插件巡查（本版已实现）：静默捕获运行中插件的报错 / 失败
//           （console.error / console.warn / 未捕获异常 / 未处理 Promise 拒绝），
//           归档到面板，可搜索 / 过滤 / 复制；不弹窗、不打断。
//   功能1 · 预设启用巡查（已实现）：绑定预设，每轮检查预设是否被模型读取并实施，
//           冲突标注，下一轮自动注入给模型矫正。
//   功能2 · 文风注入自检（规划中）：标记预设中的文风段落，每轮自检正文是否脱风，
//           脱离则下一轮自动注入矫正。
//   功能4 · 人设巡查（规划中）：绑定当前人物卡，每轮检查是否 OOC / 超雄等，
//           冲突归档到面板，下一轮静默注入矫正。
//
// 功能 1/2/4 的「巡查判定」统一走独立可配裁判 endpoint（settings.judge）。

import { extension_settings, extensionNames, extensionTypes, getExtensionManifest } from '../../../extensions.js';
import {
    chat,
    characters,
    this_chid,
    getRequestHeaders,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import { openai_setting_names, openai_settings } from '../../../openai.js';

const extensionName = 'suspension';
const VERSION = '0.8.0';
const MAX_ENTRIES = 200;        // 插件巡查最多保留条数
const DEDUP_WINDOW_MS = 5000;   // 同来源 + 插件 + 消息在窗口内重复 → 只累加计数
// 功能1 预设巡查
const MAX_PRESET_ENTRIES = 100;   // 冲突记录最多保留条数
const JUDGE_TIMEOUT_MS = 90000;   // 裁判调用超时
const MODEL_FETCH_TIMEOUT_MS = 30000;  // 拉取模型列表超时

// 捕获来源 → 面板展示名
const SRC_LABELS = {
    'console.error': 'console.error',
    'console.warn': 'console.warn',
    'window.error': '未捕获异常',
    'unhandledrejection': '未处理拒绝',
};
const SRC_ORDER = ['console.error', 'console.warn', 'window.error', 'unhandledrejection'];

// ---------------- 设置 ----------------
function freshSettings() {
    return {
        enabled: true,                              // 总开关
        judge: { url: '', key: '', model: '' },     // 独立裁判 endpoint（功能 1/2/4 共用）
        features: {
            preset: { enabled: false, presetName: '', autoInject: true, entries: [], items: [] },  // 功能1 预设启用巡查
            style: { enabled: false, presetName: '', autoInject: true, marked: [], entries: [] },  // 功能2 文风注入自检
            pluginWatch: { enabled: true, entries: [] },  // 功能3 插件巡查（已实现）
            persona: { enabled: false, autoInject: true, charId: -1, charName: '', persona: '', entries: [] },  // 功能4 人设巡查
        },
    };
}
let settings = freshSettings();
let pendingCorrections = { preset: '', style: '', persona: '' };   // 各功能当前待注入给模型的矫正文本（单轮有效，供面板展示）

function loadSettings() {
    const s = extension_settings[extensionName];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
        extension_settings[extensionName] = freshSettings();
        settings = extension_settings[extensionName];
        return;
    }
    const def = freshSettings();
    if (typeof s.enabled !== 'boolean') s.enabled = def.enabled;
    s.judge = Object.assign({}, def.judge, (s.judge && typeof s.judge === 'object' && !Array.isArray(s.judge)) ? s.judge : {});
    if (!s.features || typeof s.features !== 'object' || Array.isArray(s.features)) s.features = {};
    for (const k of Object.keys(def.features)) {
        if (!s.features[k] || typeof s.features[k] !== 'object' || Array.isArray(s.features[k])) s.features[k] = {};
        if (typeof s.features[k].enabled !== 'boolean') s.features[k].enabled = def.features[k].enabled;
        if (k === 'pluginWatch' && !Array.isArray(s.features[k].entries)) s.features[k].entries = [];
        if (k === 'preset') {
            if (typeof s.features[k].presetName !== 'string') s.features[k].presetName = '';
            if (typeof s.features[k].autoInject !== 'boolean') s.features[k].autoInject = true;
            if (!Array.isArray(s.features[k].entries)) s.features[k].entries = [];
            if (!Array.isArray(s.features[k].items)) s.features[k].items = [];
        }
        if (k === 'style') {
            if (typeof s.features[k].presetName !== 'string') s.features[k].presetName = '';
            if (typeof s.features[k].autoInject !== 'boolean') s.features[k].autoInject = true;
            if (!Array.isArray(s.features[k].marked)) s.features[k].marked = [];
            if (!Array.isArray(s.features[k].entries)) s.features[k].entries = [];
        }
        if (k === 'persona') {
            if (typeof s.features[k].charName !== 'string') s.features[k].charName = '';
            if (typeof s.features[k].persona !== 'string') s.features[k].persona = '';
            if (typeof s.features[k].autoInject !== 'boolean') s.features[k].autoInject = true;
            if (typeof s.features[k].charId !== 'number') s.features[k].charId = -1;
            if (!Array.isArray(s.features[k].entries)) s.features[k].entries = [];
        }
    }
    settings = s;
}

function saveSettings() { saveSettingsDebounced(); }

function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 复制到剪贴板（clipboard API 优先，失败回退 execCommand），成功后按钮短暂显示「已复制」
function clipboardCopy(text, $btn) {
    const done = () => {
        if (!$btn || !$btn.length) return;
        const orig = $btn.text();
        $btn.addClass('susp__copied').text('已复制');
        setTimeout(() => { $btn.removeClass('susp__copied').text(orig); }, 1200);
    };
    const fallback = () => {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        } catch (e) { /* 忽略复制失败 */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => { fallback(); done(); });
    } else {
        fallback();
        done();
    }
}

// ---------------- 功能3 · 插件巡查（报错捕获） ----------------
// 从报错 URL / 堆栈里猜是哪个插件：ST 第三方扩展在 /scripts/extensions/third-party/<name>/，
// 服务端插件在 /plugins/<name>/，其它扩展在 /extensions/<name>/。
function pluginFromUrl(url) {
    if (!url) return '';
    let m = String(url).match(/extensions\/third-party\/([^/?#]+)/i);
    if (m) return m[1];
    m = String(url).match(/\/plugins\/([^/?#]+)/i);
    if (m) return m[1];
    m = String(url).match(/\/extensions\/([^/?#]+)/i);
    if (m) return m[1];
    return '';
}
function resolvePlugin(stack) {
    if (stack) {
        const urls = String(stack).match(/https?:\/\/[^\s()]+/g) || [];
        for (const u of urls) { const p = pluginFromUrl(u); if (p) return p; }
        if (/script\.js|\/scripts\//i.test(stack)) return '酒馆核心';
    }
    return '未知';
}

// ---------------- 功能3 · 插件清单（运行中 / 未运行） ----------------
// ST 扩展注册表：extensionNames（已安装内部键）、extensionTypes（键→类型）、
// 启用状态看 extension_settings.disabledExtensions（列入 = 已禁用 = 未运行）。
function shortExtensionName(name) {
    return String(name || '').replace(/^(third-party|local|global)\//, '');
}
function extensionTypeLabel(type, name) {
    if (type === 'third-party' || String(name).startsWith('third-party/')) return '第三方';
    if (type === 'local') return '本地';
    if (type === 'global') return '全局';
    return '内置';
}
function listExtensions() {
    const names = Array.isArray(extensionNames) ? extensionNames : [];
    const disabled = Array.isArray(extension_settings.disabledExtensions) ? extension_settings.disabledExtensions : [];
    return names.map(name => {
        const short = shortExtensionName(name);
        let manifest = null;
        try { manifest = getExtensionManifest(short); } catch (e) { /* 忽略 */ }
        const type = (extensionTypes && extensionTypes[name]) || '';
        return {
            key: name,
            name: short,
            type: type,
            typeLabel: extensionTypeLabel(type, name),
            displayName: (manifest && manifest.display_name) || short,
            author: (manifest && manifest.author) || '',
            version: (manifest && manifest.version) || '',
            enabled: !disabled.includes(name),
        };
    });
}

function pushEntry(source, plugin, message, stack) {
    const entries = settings.features.pluginWatch.entries;
    const now = Date.now();
    const last = entries[0];
    if (last && last.source === source && last.plugin === plugin && last.message === message && (now - last.ts) < DEDUP_WINDOW_MS) {
        last.count = (last.count || 1) + 1;
        last.ts = now;
    } else {
        entries.unshift({ id: uid(), ts: now, source, plugin, message, stack: stack || '', count: 1 });
        if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    }
    saveSettings();
    if ($('#st-suspension').is(':visible')) renderPluginWatch();
}

function capture(source, args, stack) {
    if (!settings.enabled || !settings.features.pluginWatch.enabled) return;
    let message = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message || a.name;
        if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
    }).join(' ').replace(/\s+/g, ' ').trim();
    if (!message) return;
    pushEntry(source, resolvePlugin(stack), message.slice(0, 800), stack);
}

// 接管 console.error / console.warn，静默记录后仍照常输出到原控制台（不改变原有行为）
let consoleHooked = false;
const _origError = console.error.bind(console);
const _origWarn = console.warn.bind(console);
function hookConsole() {
    if (consoleHooked) return;
    consoleHooked = true;
    console.error = function (...args) {
        try { capture('console.error', args, new Error().stack || ''); } catch (e) { /* 绝不因捕获失败影响原调用 */ }
        _origError(...args);
    };
    console.warn = function (...args) {
        try { capture('console.warn', args, new Error().stack || ''); } catch (e) { }
        _origWarn(...args);
    };
}

function installGlobalHandlers() {
    window.addEventListener('error', (e) => {
        if (!settings.enabled || !settings.features.pluginWatch.enabled) return;
        const stack = (e.error && e.error.stack) ? e.error.stack : (e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : '');
        let plugin = resolvePlugin(stack);
        if (plugin === '未知') plugin = pluginFromUrl(e.filename) || '未知';
        pushEntry('window.error', plugin, String(e.message || '').slice(0, 800), stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
        if (!settings.enabled || !settings.features.pluginWatch.enabled) return;
        const r = e.reason;
        const stack = (r && r.stack) ? r.stack : '';
        let message;
        if (r instanceof Error) message = r.message || r.name;
        else if (typeof r === 'string') message = r;
        else if (r && typeof r === 'object' && r.url != null && r.status != null) message = 'HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '') + ' ' + r.url;
        else if (r == null) message = '未知原因';
        else { try { message = JSON.stringify(r); } catch (err) { message = String(r); } }
        pushEntry('unhandledrejection', resolvePlugin(stack), String(message).slice(0, 800), stack);
    });
}

// 单个条目 → 完整可复制文本
function formatEntryText(e) {
    const lines = [
        '[悬置之境 · 插件巡查]',
        '时间: ' + fmtTime(e.ts),
        '来源: ' + (SRC_LABELS[e.source] || e.source),
        '插件: ' + e.plugin,
        '消息: ' + e.message,
    ];
    if (e.count > 1) lines.push('重复次数: ' + e.count);
    if (e.stack) lines.push('堆栈:\n' + e.stack);
    return lines.join('\n');
}

// ---------------- 功能1 · 预设启用巡查 ----------------
let presetInspecting = false;
let comboInspecting = false;   // 文风 + 人设 综合裁判共用同一把锁

// 酒馆已保存的聊天补全预设名列表（openai_setting_names 的键即预设名）
function listPresets() {
    if (!openai_setting_names || typeof openai_setting_names !== 'object' || Array.isArray(openai_setting_names)) return [];
    return Object.keys(openai_setting_names).filter(n => n && n !== 'undefined' && n !== 'null');
}
// 按名取预设对象（openai_settings 数组按 index 对齐 openai_setting_names）
function getPresetByName(name) {
    if (!name || !openai_setting_names || !openai_settings || !Array.isArray(openai_settings)) return null;
    const idx = openai_setting_names[name];
    if (idx == null) return null;
    return openai_settings[idx] || null;
}
// 预设里「未启用」的模块：prompt_order 里对应 identifier 的 enabled === false（禁用的模块不会被删，只是 order 项标 enabled:false）
function disabledPresetIdentifiers(preset) {
    const disabled = new Set();
    const orders = (preset && Array.isArray(preset.prompt_order)) ? preset.prompt_order : [];
    for (const o of orders) {
        if (!o || !Array.isArray(o.order)) continue;
        for (const it of o.order) {
            if (it && it.enabled === false && it.identifier) disabled.add(it.identifier);
        }
    }
    return disabled;
}
// 预设的「条目」：把非 marker、且「已启用」的 prompt 内容拆成逐条，交给裁判逐条判定
function presetItems(preset) {
    if (!preset || !Array.isArray(preset.prompts)) return [];
    const disabled = disabledPresetIdentifiers(preset);
    const items = [];
    for (const p of preset.prompts) {
        if (!p || p.marker) continue;
        if (p.identifier && disabled.has(p.identifier)) continue;   // 没打开的条目不管，不判也不显示
        const content = String(p.content || '').trim();
        if (!content) continue;
        const label = (p.name && p.name !== p.identifier) ? p.name : (p.identifier || '');
        items.push({ name: label || ('条目' + (items.length + 1)), content });
    }
    return items;
}

// ---------------- 裁判引擎（独立 endpoint，转发写法沿用 st-amor） ----------------
function judgeApiConfigured() {
    const c = settings.judge || {};
    return !!(c.url && c.model);
}
function judgeEndpoint(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(url)) return url;
    return url + '/chat/completions';
}
function judgeBaseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}
function safeErrorText(e, key, max = 160) {
    let t = String((e && e.message) ? e.message : e);
    const k = String(key || '').trim();
    if (k.length >= 6) t = t.split(k).join('***');
    t = t.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer ***')
        .replace(/\b(sk|rk|pk|ak|key)-[A-Za-z0-9_*-]{6,}/gi, '$1-***')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}
// 经酒馆服务器转发（不受浏览器跨域限制）
async function callJudgeViaServer({ systemPrompt, prompt }) {
    const c = settings.judge;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JUDGE_TIMEOUT_MS);
    let res;
    try {
        res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: judgeBaseUrl(c.url),
                custom_include_headers: 'Authorization: ' + JSON.stringify(c.key ? 'Bearer ' + c.key.trim() : '') + '\n',
                model: c.model.trim(),
                messages,
                stream: false,
            }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round(JUDGE_TIMEOUT_MS / 1000) + ' 秒）');
        const err = new Error(safeErrorText(e, c.key) || '网络请求失败');
        err.unreachable = true;
        throw err;
    } finally {
        clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 405 || res.status === 403 || res.status === 401) {
        const err = new Error('酒馆转发接口不可用（HTTP ' + res.status + '）');
        err.unreachable = true;
        throw err;
    }
    const text = await res.text().catch(() => '');
    let d = null;
    try { d = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!res.ok || (d && d.error)) {
        const msg = d && d.error && (d.error.message || (typeof d.error === 'string' ? d.error : ''));
        throw new Error('HTTP ' + res.status + ' ' + safeErrorText(msg || text, c.key));
    }
    const out = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!out) throw new Error('返回内容为空');
    return out;
}
async function callJudgeDirect({ systemPrompt, prompt }) {
    const c = settings.judge;
    const headers = { 'Content-Type': 'application/json' };
    if (c.key) headers.Authorization = 'Bearer ' + c.key.trim();
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JUDGE_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(judgeEndpoint(c.url), {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: c.model.trim(), messages, stream: false }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round(JUDGE_TIMEOUT_MS / 1000) + ' 秒）');
        const m = safeErrorText(e, c.key) || '网络请求失败';
        throw new Error(/failed to fetch|networkerror|load failed/i.test(m) ? '浏览器直连被拦截（多半是对方服务不允许跨域），请检查地址是否可达' : m);
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        const detail = safeErrorText(t, c.key);
        throw new Error('HTTP ' + res.status + (detail ? ' ' + detail : ''));
    }
    const d = await res.json();
    const out = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!out) throw new Error('返回内容为空');
    return out;
}
async function callJudge({ systemPrompt, prompt }) {
    try {
        return await callJudgeViaServer({ systemPrompt, prompt });
    } catch (e) {
        if (!e || !e.unreachable) throw e;
        console.warn('[悬置之境] 酒馆转发不可用，改用浏览器直连：', e.message);
    }
    return callJudgeDirect({ systemPrompt, prompt });
}

// ---------------- 裁判模型拉取 + 弹窗选择 ----------------
async function fetchJudgeModels() {
    const c = settings.judge;
    if (!c.url) throw new Error('请先填接口地址');
    const endpoint = judgeBaseUrl(c.url) + '/models';
    const headers = {};
    if (c.key) headers.Authorization = 'Bearer ' + c.key.trim();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_FETCH_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(endpoint, { headers, signal: ctrl.signal });
    } catch (e) {
        clearTimeout(timer);
        const m = safeErrorText(e, c.key) || '拉取失败';
        throw new Error(/failed to fetch|networkerror|load failed/i.test(m) ? '浏览器直连被拦截（对方服务可能不允许跨域 CORS），无法拉取模型列表，请手动填写模型名' : m);
    }
    clearTimeout(timer);
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + ' ' + safeErrorText(t, c.key));
    }
    const d = await res.json();
    let list = [];
    if (d && Array.isArray(d.data)) list = d.data.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model))).filter(Boolean);
    else if (d && Array.isArray(d.models)) list = d.models.map(m => (typeof m === 'string' ? m : (m.name || m.model || m.id))).filter(Boolean);
    else if (Array.isArray(d)) list = d.map(m => (typeof m === 'string' ? m : (m.id || m.name || m.model))).filter(Boolean);
    return list;
}
function showModelPicker(models) {
    $('.susp__modal-mask').remove();
    const mask = $(`
      <div class="susp__modal-mask">
        <div class="susp__modal">
          <div class="susp__modal-head">
            <span class="susp__modal-title">选择模型（${models.length}）</span>
            <button type="button" class="susp__modal-close" title="关闭">×</button>
          </div>
          <input type="text" class="susp__modal-search" placeholder="搜索模型…" spellcheck="false">
          <div class="susp__modal-list"></div>
        </div>
      </div>`);
    const list = mask.find('.susp__modal-list');
    const render = (q) => {
        list.empty();
        for (const m of models) {
            if (q && String(m).toLowerCase().indexOf(q) < 0) continue;
            const item = $(`<div class="susp__modal-item${m === settings.judge.model ? ' on' : ''}">${escapeHtml(m)}</div>`);
            item.on('click', () => { settings.judge.model = m; saveSettings(); renderOverview(); mask.remove(); });
            list.append(item);
        }
        if (!list.children().length) list.append('<div class="susp__modal-empty">无匹配模型</div>');
    };
    render('');
    mask.on('click', '.susp__modal-close', () => mask.remove());
    mask.on('click', (e) => { if (e.target === mask[0]) mask.remove(); });
    mask.find('.susp__modal-search').on('input', function () { render(String($(this).val() || '').trim().toLowerCase()); });
    $('body').append(mask);
    mask.find('.susp__modal-search').trigger('focus');
}

// ---------------- 判定逻辑 ----------------
function lastAIMessage() {
    const msgs = Array.isArray(chat) ? chat : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].is_user === false && typeof msgs[i].mes === 'string' && msgs[i].mes.trim()) {
            return msgs[i].mes.trim();
        }
    }
    return '';
}
const JUDGE_SYSTEM = '你是一个严格的「酒馆预设合规裁判」。你会拿到：预设里的多个条目（每个条目有编号、名称、内容），以及一段模型刚生成的回复。\n\n对每个条目，判断模型回复对该条目要求的落实情况，三选一：\n- 遵循：回复明显落实 / 遵守了该条目的要求（绿灯）\n- 冲突：回复明确违背了该条目的要求（红灯）\n- 未使用：该条目与这轮回复无关，既谈不上遵循也谈不上违背（白灯）\n\n只判「明确可验证」的要求，不吹毛求疵。严格按以下格式输出，每个条目一行，不要输出任何多余文字：\n【条目1】遵循/冲突/未使用 ｜ 简短说明（冲突时说明违背了哪条，遵循或未使用时填「无」）\n【条目2】… 依次类推，直到【条目N】';

function buildJudgePrompt(items, replyText) {
    const list = items.map((it, i) => '条目' + (i + 1) + '（' + it.name + '）：' + it.content).join('\n\n');
    return '【预设条目】\n' + (list || '（预设里没有可用条目）') + '\n\n【模型回复】\n' + (replyText || '（回复为空）') + '\n\n请逐条判定。';
}
function parseItemJudgeOutput(raw, count) {
    const items = [];
    for (let i = 1; i <= count; i++) {
        const re = new RegExp('【条目' + i + '】\\s*([\\s\\S]*?)(?=【条目' + (i + 1) + '】|$)', 'i');
        const m = String(raw || '').match(re);
        const line = m ? m[1].trim() : '';
        const first = line.split(/[｜|]/)[0].replace(/\s+/g, '');
        let status = 'white';
        if (/冲突|违背|违反|不符|没有遵循|未遵循|没遵循/.test(first)) status = 'red';
        else if (/遵循|遵守|落实|符合/.test(first) && !/未|不|没|无/.test(first)) status = 'green';
        const note = line.split(/[｜|]/).slice(1).join('｜').trim();
        items.push({ status, note: note || '' });
    }
    return items;
}

async function inspectPreset(force) {
    const f = settings.features.preset;
    if (presetInspecting) return;
    if (!settings.enabled || !f.presetName) return;
    if (!f.enabled && !force) return;
    if (!judgeApiConfigured()) return;
    const reply = lastAIMessage();
    if (!reply) return;
    const preset = getPresetByName(f.presetName);
    const items = presetItems(preset);
    if (!items.length) return;
    presetInspecting = true;
    try {
        const raw = await callJudge({ systemPrompt: JUDGE_SYSTEM, prompt: buildJudgePrompt(items, reply) });
        const results = parseItemJudgeOutput(raw, items.length);
        const snapshot = items.map((it, i) => ({ name: it.name, status: results[i].status, note: results[i].note }));
        f.items = snapshot;
        const reds = snapshot.filter(x => x.status === 'red');
        if (reds.length) {
            const problem = reds.map(x => '· ' + x.name + '：' + (x.note && x.note !== '无' ? x.note : '未说明违背点')).join('\n');
            const correction = reds.map(x => x.name + '：' + (x.note && x.note !== '无' ? x.note : '请遵循该条目')).join('\n');
            pushPresetEntry({ problem, correction, replySnippet: reply.slice(0, 400) });
        }
    } catch (e) {
        f.items = [];
        pushPresetEntry({ problem: '裁判调用失败：' + safeErrorText(e, settings.judge.key), correction: '' });
    } finally {
        presetInspecting = false;
        saveSettings();
        if ($('#st-suspension').is(':visible')) renderPreset();
    }
}
function pushPresetEntry(o) {
    const f = settings.features.preset;
    f.entries.unshift({
        id: uid(),
        ts: Date.now(),
        problem: String(o.problem || '').slice(0, 1000),
        correction: String(o.correction || '').slice(0, 1000),
        reply: String(o.replySnippet || ''),
    });
    if (f.entries.length > MAX_PRESET_ENTRIES) f.entries.length = MAX_PRESET_ENTRIES;
    saveSettings();
    // 冲突 + 开了自动注入 → 下一轮静默注入矫正
    if (f.enabled && f.autoInject && o.correction) setFeatureCorrection('preset', o.correction);
}
function formatPresetEntryText(e) {
    const lines = [
        '[悬置之境 · 预设巡查]',
        '时间: ' + fmtTime(e.ts),
        '预设: ' + (settings.features.preset.presetName || '未绑定'),
        '问题: ' + (e.problem || ''),
    ];
    if (e.correction) lines.push('矫正: ' + e.correction);
    if (e.reply) lines.push('回复片段: ' + e.reply);
    return lines.join('\n');
}
// ---------------- 矫正注入（各功能先各自记录，round 结束合并成一条综合矫正注入，避免互相冲突） ----------------
const INJECT_KEY = 'suspension_correction';
const INJECT_PAGE = { preset: 'preset', style: 'style', persona: 'persona' };
const INJECT_EMPTY_TEXT = '暂无。检测到问题且开启「自动注入矫正」后，这里会显示下一轮将要注入给模型的矫正内容（作为 IN_CHAT 提示注入，聊天里不可见）。';

function updateInjectBox(feature) {
    const box = $('#st-suspension [data-page="' + INJECT_PAGE[feature] + '"] .susp__pt-inject-text');
    if (box.length) box.text(pendingCorrections[feature] || INJECT_EMPTY_TEXT);
}
// 只记录到 pendingCorrections，不立即注入；统一在 round 结束时合并成一条注入
function setFeatureCorrection(feature, text) {
    pendingCorrections[feature] = text || '';
    updateInjectBox(feature);
}
function injectMergedCorrection() {
    const parts = [];
    if (pendingCorrections.preset) parts.push('【预设】\n' + pendingCorrections.preset);
    if (pendingCorrections.style) parts.push('【文风】\n' + pendingCorrections.style);
    if (pendingCorrections.persona) parts.push('【人设】\n' + pendingCorrections.persona);
    const merged = parts.join('\n\n');
    if (!merged) { clearInjectPrompt(); return; }
    try {
        setExtensionPrompt(INJECT_KEY, '[悬置之境·综合矫正] 上一轮回复存在以下问题，请在下一轮回复中一并修正、彼此不要冲突，不要提及本条指令本身：\n' + merged, extension_prompt_types.IN_CHAT, 1);
    } catch (e) { console.warn('[悬置之境] 注入矫正失败：', e); }
}
function clearInjectPrompt() {
    try { setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_CHAT, 1); } catch (e) { /* 忽略 */ }
}
function clearCorrections() {
    pendingCorrections.preset = '';
    pendingCorrections.style = '';
    pendingCorrections.persona = '';
    clearInjectPrompt();
    updateInjectBox('preset');
    updateInjectBox('style');
    updateInjectBox('persona');
}

// ---------------- 功能2 + 功能4 · 文风自检 + 人设巡查（综合裁判，NSFW 豁免） ----------------
// 把「文风段落」和「人物卡人设」一起交给同一个裁判：先判是否 NSFW 且应豁免，否则逐项判脱风 / OOC 违和。
const JUDGE_COMBINED_SYSTEM = '你是一个严格的「文风 + 人设综合裁判」。你会拿到（可能只有其一或两者都有）：\n- 文风段落：角色/故事应保持的文风（若提供）。\n- 人物卡人设：人格/描述/场景/示例对话/开场白（若提供）。\n- 一段模型刚生成的回复正文。\n\n第一步：判断这段回复是否属于 NSFW / 亲密剧情，且角色在该剧情下的表现与其人设/文风一致、应当豁免严格的文风与人设检查（NSFW 场景里角色放松、强势、或文风偏移往往是被剧情允许的）。\n若是，只输出一行：\n【豁免】\n\n否则，按提供的内容选择性输出（每行一个结论，不要输出任何多余文字）：\n- 若提供了文风段落：判断是否脱风 —— 输出「【脱风】一句话说明哪里脱了、该怎么回到文风」或「【未脱风】无」。\n- 若提供了人设：判断是否 OOC / 超雄等违和 —— 输出「【违和】一句话说明哪里违和、该怎么回到人设」或「【正常】无」。\n\n只判「明确可验证」的问题，不吹毛求疵。';
function buildCombinedJudgePrompt(stylePassages, personaText, replyText) {
    const parts = [];
    if (stylePassages && stylePassages.length) {
        parts.push('【文风段落】\n' + stylePassages.map((m, i) => '文风' + (i + 1) + '：' + m.content).join('\n\n'));
    }
    if (personaText) parts.push('【人物卡人设】\n' + personaText);
    parts.push('【模型回复正文】\n' + (replyText || '（回复为空）'));
    parts.push('请先判断是否豁免，否则按提供的内容逐项判定脱风 / OOC 违和。');
    return parts.join('\n\n');
}
function parseCombinedOutput(raw) {
    const s = String(raw || '').trim();
    if (!s) return { exempt: false, deviated: false, violated: false, styleNote: '', personaNote: '' };
    const lines = s.split(/\n+/).map(x => x.trim()).filter(Boolean);
    let exempt = false, deviated = false, violated = false, styleNote = '', personaNote = '';
    for (const line of lines) {
        const tag = line.match(/【([^】]+)】/);
        const note = line.replace(/【[^】]*】/, '').replace(/^[｜|]\s*/, '').trim();
        if (!tag) continue;
        const t = tag[1];
        if (/豁免/.test(t)) { exempt = true; break; }
        if (/脱风/.test(t)) {
            deviated = !/[未没不无]/.test(t);
            styleNote = (note === '无' ? '' : note);
        } else if (/违和/.test(t)) {
            violated = !/[未没不无正常]/.test(t);
            personaNote = (note === '无' ? '' : note);
        }
    }
    if (exempt) return { exempt: true, deviated: false, violated: false, styleNote: '', personaNote: '' };
    return { exempt: false, deviated, violated, styleNote, personaNote };
}
function styleActive(force) {
    const f = settings.features.style;
    if (!f.presetName) return false;
    if (!(f.marked || []).some(m => m.content)) return false;
    return force || !!f.enabled;
}
function personaActive(force) {
    const f = settings.features.persona;
    if (!f.charName || !f.persona) return false;
    return force || !!f.enabled;
}
async function inspectStylePersona(force) {
    if (comboInspecting) return;
    if (!settings.enabled && !force) return;
    if (!judgeApiConfigured()) return;
    const styleOn = styleActive(force);
    const personaOn = personaActive(force);
    if (!styleOn && !personaOn) return;
    const reply = lastAIMessage();
    if (!reply) return;
    comboInspecting = true;
    try {
        const fs = settings.features.style;
        const fn = settings.features.persona;
        const stylePassages = styleOn ? (fs.marked || []).filter(m => m.content) : [];
        const personaText = personaOn ? fn.persona : '';
        const raw = await callJudge({ systemPrompt: JUDGE_COMBINED_SYSTEM, prompt: buildCombinedJudgePrompt(stylePassages, personaText, reply) });
        const r = parseCombinedOutput(raw);
        if (r.exempt) {
            // NSFW / 亲密剧情：整轮豁免，不判、不归档、不注入矫正
        } else {
            if (styleOn && r.deviated) {
                pushStyleEntry({ problem: r.styleNote || '正文明显脱离标记文风', correction: r.styleNote || '请回到标记的文风', replySnippet: reply.slice(0, 400) });
            }
            if (personaOn && r.violated) {
                pushPersonaEntry({ problem: r.personaNote || '回复存在 OOC / 超雄等违和', correction: r.personaNote || '请回到人物设定', replySnippet: reply.slice(0, 400) });
            }
        }
    } catch (e) {
        const msg = '裁判调用失败：' + safeErrorText(e, settings.judge.key);
        if (styleActive(force)) pushStyleEntry({ problem: msg, correction: '' });
        if (personaActive(force)) pushPersonaEntry({ problem: msg, correction: '' });
    } finally {
        comboInspecting = false;
        saveSettings();
        if ($('#st-suspension').is(':visible')) { renderStyle(); renderPersona(); }
    }
}
function pushStyleEntry(o) {
    const f = settings.features.style;
    f.entries.unshift({
        id: uid(),
        ts: Date.now(),
        problem: String(o.problem || '').slice(0, 1000),
        correction: String(o.correction || '').slice(0, 1000),
        reply: String(o.replySnippet || ''),
    });
    if (f.entries.length > MAX_PRESET_ENTRIES) f.entries.length = MAX_PRESET_ENTRIES;
    saveSettings();
    if (f.enabled && f.autoInject && o.correction) setFeatureCorrection('style', o.correction);
}
function formatStyleEntryText(e) {
    const lines = ['[悬置之境 · 文风自检]', '时间: ' + fmtTime(e.ts), '问题: ' + (e.problem || '')];
    if (e.correction) lines.push('矫正: ' + e.correction);
    if (e.reply) lines.push('回复片段: ' + e.reply);
    return lines.join('\n');
}

// ---------------- 功能4 · 人设巡查（判定已并入上方综合裁判，这里只保留归档/格式化） ----------------
function pushPersonaEntry(o) {
    const f = settings.features.persona;
    f.entries.unshift({
        id: uid(),
        ts: Date.now(),
        problem: String(o.problem || '').slice(0, 1000),
        correction: String(o.correction || '').slice(0, 1000),
        reply: String(o.replySnippet || ''),
    });
    if (f.entries.length > MAX_PRESET_ENTRIES) f.entries.length = MAX_PRESET_ENTRIES;
    saveSettings();
    if (f.enabled && f.autoInject && o.correction) setFeatureCorrection('persona', o.correction);
}
function formatPersonaEntryText(e) {
    const lines = ['[悬置之境 · 人设巡查]', '时间: ' + fmtTime(e.ts), '问题: ' + (e.problem || '')];
    if (e.correction) lines.push('矫正: ' + e.correction);
    if (e.reply) lines.push('回复片段: ' + e.reply);
    return lines.join('\n');
}

// 功能2/4 冲突记录通用渲染（复制/清空按 data-feature 分发）
const ENTRY_META = {
    style: { format: formatStyleEntryText, badge: '脱风' },
    persona: { format: formatPersonaEntryText, badge: '违和' },
};
function renderFeatureEntries(box, feature, inspecting, emptyText) {
    const f = settings.features[feature];
    const entries = f.entries || [];
    const badge = ENTRY_META[feature].badge;
    box.empty();
    if (inspecting) box.append('<div class="susp__pt-loading">判定中…</div>');
    if (!entries.length && !inspecting) box.append('<div class="susp__pw-empty">' + emptyText + '</div>');
    for (const e of entries) {
        const item = $(`
          <div class="susp__pt-item">
            <div class="susp__pw-item-top">
              <span class="susp__pw-time">${escapeHtml(fmtTime(e.ts))}</span>
              <span class="susp__pw-badge danger">${badge}</span>
              <span class="susp__spacer"></span>
              <button type="button" class="susp__btn susp__fx-copy" data-feature="${feature}" data-id="${e.id}">复制</button>
            </div>
            <div class="susp__pt-problem">${escapeHtml(e.problem || '')}</div>
            ${e.correction ? `<div class="susp__pt-corr"><b>矫正</b> ${escapeHtml(e.correction)}</div>` : ''}
            ${e.reply ? `<details class="susp__pw-stack"><summary>回复片段</summary><pre>${escapeHtml(e.reply)}</pre></details>` : ''}
          </div>`);
        box.append(item);
    }
    if (entries.length) {
        box.append('<div class="susp__pt-clear-row"><button type="button" class="susp__btn susp__fx-clear" data-feature="' + feature + '">清空记录</button></div>');
    }
}

// ---------------- 面板 ----------------
function buildMenuButton() {
    if ($('#st-suspension-menu-button').length) return;
    const btn = $(`
        <div id="st-suspension-menu-button" class="list-group-item flex-container flexGap5 interactable"
             title="悬置之境：酒馆巡查" tabindex="0" role="listitem">
            <div class="fa-fw fa-solid fa-eye extensionsMenuExtensionButton"></div>
            <span>悬置之境</span>
        </div>`);
    btn.on('click', () => togglePanel());
    $('#extensionsMenu').append(btn);
}

function buildPanel() {
    if ($('#st-suspension').length) return;
    const html = `
    <div id="st-suspension" class="susp__panel" style="display:none">
      <div class="susp__head">
        <div class="susp__head-titles">
          <span class="susp__title">悬置之境</span>
          <span class="susp__subtitle">酒馆巡查</span>
          <span class="susp__version">v${VERSION}</span>
        </div>
        <button type="button" class="susp__close" title="关闭">×</button>
      </div>

      <div class="susp__tabs">
        <button type="button" class="susp__tab on" data-tab="overview">总览</button>
        <button type="button" class="susp__tab" data-tab="pluginWatch">插件巡查</button>
        <button type="button" class="susp__tab" data-tab="preset">预设巡查</button>
        <button type="button" class="susp__tab" data-tab="style">文风自检</button>
        <button type="button" class="susp__tab" data-tab="persona">人设巡查</button>
      </div>

      <div class="susp__body" data-page="overview">
        <div class="susp__master">
          <label class="susp__switch"><input type="checkbox" class="susp__enabled"><span class="susp__switch-slider"></span></label>
          <span class="susp__master-label">总开关</span>
          <span class="susp__master-hint">关闭后停止一切巡查与捕获</span>
        </div>
        <div class="susp__cards">
          <div class="susp__card" data-feature="pluginWatch">
            <div class="susp__card-top">
              <span class="susp__card-title">插件巡查</span>
              <span class="susp__card-badge on">已上线</span>
            </div>
            <div class="susp__card-desc">静默捕获运行中插件的报错与失败，归档到面板可复制，不弹窗。</div>
            <div class="susp__card-foot">
              <label class="susp__switch"><input type="checkbox" class="susp__card-toggle" data-feature="pluginWatch"><span class="susp__switch-slider"></span></label>
              <span class="susp__card-foot-label">启用</span>
            </div>
          </div>
          <div class="susp__card" data-feature="preset">
            <div class="susp__card-top">
              <span class="susp__card-title">预设巡查</span>
              <span class="susp__card-badge on">已上线</span>
            </div>
            <div class="susp__card-desc">绑定预设，每轮检查是否被模型读取并实施，冲突下轮自动注入矫正。</div>
            <div class="susp__card-foot">
              <label class="susp__switch"><input type="checkbox" class="susp__card-toggle" data-feature="preset"><span class="susp__switch-slider"></span></label>
              <span class="susp__card-foot-label">启用</span>
            </div>
          </div>
          <div class="susp__card" data-feature="style">
            <div class="susp__card-top">
              <span class="susp__card-title">文风自检</span>
              <span class="susp__card-badge wip">进行中</span>
            </div>
            <div class="susp__card-desc">标记预设中的文风段落，每轮自检正文是否脱风，脱离下轮自动注入矫正。</div>
            <div class="susp__card-foot">
              <label class="susp__switch"><input type="checkbox" class="susp__card-toggle" data-feature="style"><span class="susp__switch-slider"></span></label>
              <span class="susp__card-foot-label">启用</span>
            </div>
          </div>
          <div class="susp__card" data-feature="persona">
            <div class="susp__card-top">
              <span class="susp__card-title">人设巡查</span>
              <span class="susp__card-badge wip">进行中</span>
            </div>
            <div class="susp__card-desc">绑定当前人物卡，每轮检查是否 OOC / 超雄等，冲突归档并下轮静默注入矫正。</div>
            <div class="susp__card-foot">
              <label class="susp__switch"><input type="checkbox" class="susp__card-toggle" data-feature="persona"><span class="susp__switch-slider"></span></label>
              <span class="susp__card-foot-label">启用</span>
            </div>
          </div>
        </div>
        <details class="susp__judge">
          <summary>裁判引擎设置（功能 1/2/4 共用，独立于聊天模型）</summary>
          <div class="susp__judge-hint">巡查判定需要一个独立的 OpenAI 兼容接口当裁判；留空则 1/2/4 功能暂不可用（插件巡查不依赖它）。</div>
          <div class="susp__field">
            <label>接口地址</label>
            <input type="text" class="susp__judge-url" placeholder="https://…（可带 /v1）" spellcheck="false">
          </div>
          <div class="susp__field">
            <label>密钥（可选）</label>
            <input type="password" class="susp__judge-key" placeholder="Bearer Key" spellcheck="false">
          </div>
          <div class="susp__field">
            <label>模型</label>
            <div class="susp__judge-model-row">
              <input type="text" class="susp__judge-model" placeholder="例如 gpt-4o-mini / qwen2.5:7b" spellcheck="false">
              <button type="button" class="susp__btn susp__judge-models">拉取模型</button>
            </div>
          </div>
        </details>
      </div>

      <div class="susp__body" data-page="pluginWatch" style="display:none">
        <div class="susp__pw-toolbar">
          <label class="susp__switch"><input type="checkbox" class="susp__pw-enabled"><span class="susp__switch-slider"></span></label>
          <span class="susp__pw-enable-label">启用巡查</span>
          <span class="susp__pw-stat">共 <b class="susp__pw-total">0</b> 条</span>
          <span class="susp__spacer"></span>
          <button type="button" class="susp__btn susp__pw-copyall">复制全部</button>
          <button type="button" class="susp__btn susp__pw-clear">清空</button>
        </div>
        <div class="susp__pw-roster">
          <div class="susp__pw-roster-head">
            <span class="susp__pw-roster-title">插件清单</span>
            <span class="susp__spacer"></span>
            <button type="button" class="susp__btn susp__pw-roster-refresh">刷新插件列表</button>
          </div>
          <div class="susp__pw-roster-cols">
            <div class="susp__pw-roster-col">
              <div class="susp__pw-roster-colhead on">运行中 <b class="susp__pw-run-count">0</b></div>
              <div class="susp__pw-roster-list susp__pw-running"></div>
            </div>
            <div class="susp__pw-roster-col">
              <div class="susp__pw-roster-colhead off">未运行 <b class="susp__pw-off-count">0</b></div>
              <div class="susp__pw-roster-list susp__pw-notrunning"></div>
            </div>
          </div>
        </div>
        <div class="susp__pw-filters">
          <div class="susp__pw-srcs"></div>
          <select class="susp__pw-plugin"><option value="">全部插件</option></select>
          <input type="text" class="susp__pw-search" placeholder="搜索消息…" spellcheck="false">
        </div>
        <div class="susp__pw-list"></div>
      </div>

      <div class="susp__body" data-page="preset" style="display:none">
        <div class="susp__pt-toolbar">
          <label class="susp__switch"><input type="checkbox" class="susp__pt-enabled"><span class="susp__switch-slider"></span></label>
          <span class="susp__pw-enable-label">启用巡查</span>
          <span class="susp__spacer"></span>
          <button type="button" class="susp__btn susp__pt-refresh">刷新预设列表</button>
          <button type="button" class="susp__btn susp__pt-run">手动巡查一次</button>
        </div>
        <div class="susp__pt-bind">
          <div class="susp__field">
            <label>绑定预设（拉取你酒馆里已保存的聊天补全预设）</label>
            <select class="susp__pt-preset"><option value="">— 未绑定 —</option></select>
          </div>
          <label class="susp__pt-auto"><input type="checkbox" class="susp__pt-autoinject"> 冲突时下一轮自动注入矫正</label>
          <div class="susp__pt-legend">
            <span><span class="susp__pt-dot green"></span>遵循 / 已读取</span>
            <span><span class="susp__pt-dot red"></span>冲突 / 没遵循</span>
            <span><span class="susp__pt-dot white"></span>本轮未使用</span>
          </div>
          <div class="susp__pt-inject">
            <div class="susp__pt-inject-label">下一轮注入矫正</div>
            <div class="susp__pt-inject-text"></div>
          </div>
          <div class="susp__pt-items"></div>
        </div>
        <div class="susp__pt-list"></div>
      </div>

      <div class="susp__body" data-page="style" style="display:none">
        <div class="susp__pt-toolbar">
          <label class="susp__switch"><input type="checkbox" class="susp__st-enabled"><span class="susp__switch-slider"></span></label>
          <span class="susp__pw-enable-label">启用自检</span>
          <span class="susp__spacer"></span>
          <button type="button" class="susp__btn susp__st-run">手动巡查一次</button>
          <button type="button" class="susp__btn susp__st-refresh">刷新预设列表</button>
        </div>
        <div class="susp__pt-bind">
          <div class="susp__field">
            <label>绑定预设（从中勾选文风段落）</label>
            <select class="susp__st-preset"><option value="">— 未绑定 —</option></select>
          </div>
          <label class="susp__pt-auto"><input type="checkbox" class="susp__st-autoinject"> 脱风时下一轮自动注入矫正</label>
          <div class="susp__pt-inject">
            <div class="susp__pt-inject-label">下一轮注入矫正</div>
            <div class="susp__pt-inject-text"></div>
          </div>
          <div class="susp__st-hint">勾选下面的条目，把它标记为「文风段落」（可多个）。每轮生成后，独立裁判会检查正文是否脱离这些文风，脱离则下一轮自动注入矫正。已标记 <b class="susp__st-count">0</b> 段。</div>
          <div class="susp__st-items"></div>
        </div>
        <div class="susp__st-list"></div>
      </div>

      <div class="susp__body" data-page="persona" style="display:none">
        <div class="susp__pt-toolbar">
          <label class="susp__switch"><input type="checkbox" class="susp__pn-enabled"><span class="susp__switch-slider"></span></label>
          <span class="susp__pw-enable-label">启用巡查</span>
          <span class="susp__spacer"></span>
          <button type="button" class="susp__btn susp__pn-run">手动巡查一次</button>
          <button type="button" class="susp__btn susp__pn-bind">绑定当前人物卡</button>
        </div>
        <div class="susp__pt-bind">
          <div class="susp__pn-char">
            <div class="susp__pn-char-name"></div>
            <div class="susp__pn-char-hint"></div>
          </div>
          <label class="susp__pt-auto"><input type="checkbox" class="susp__pn-autoinject"> 违和时下一轮自动注入矫正</label>
          <div class="susp__pt-inject">
            <div class="susp__pt-inject-label">下一轮注入矫正</div>
            <div class="susp__pt-inject-text"></div>
          </div>
          <div class="susp__pn-persona"></div>
        </div>
        <div class="susp__pn-list"></div>
      </div>
    </div>`;
    $('body').append(html);
    const panel = $('#st-suspension');

    panel.find('.susp__close').on('click', () => togglePanel(false));
    panel.on('click', '.susp__tab', function () {
        const tab = $(this).data('tab');
        panel.find('.susp__tab').removeClass('on');
        $(this).addClass('on');
        panel.find('.susp__body').hide();
        panel.find('.susp__body[data-page="' + tab + '"]').show();
    });

    // 总开关
    panel.on('change', '.susp__enabled', function () {
        settings.enabled = $(this).prop('checked');
        saveSettings();
        renderOverview();
    });
    // 各功能开关
    panel.on('change', '.susp__card-toggle', function () {
        const k = $(this).data('feature');
        if (!settings.features[k]) return;
        settings.features[k].enabled = $(this).prop('checked');
        saveSettings();
        renderOverview();
    });
    // 插件巡查开关
    panel.on('change', '.susp__pw-enabled', function () {
        settings.features.pluginWatch.enabled = $(this).prop('checked');
        saveSettings();
        renderPluginWatch();
    });
    // 裁判引擎配置
    panel.on('change', '.susp__judge-url', function () { settings.judge.url = String($(this).val() || '').trim(); saveSettings(); });
    panel.on('change', '.susp__judge-key', function () { settings.judge.key = String($(this).val() || '').trim(); saveSettings(); });
    panel.on('change', '.susp__judge-model', function () { settings.judge.model = String($(this).val() || '').trim(); saveSettings(); });
    panel.on('click', '.susp__judge-models', function () {
        const btn = $(this);
        if (btn.prop('disabled')) return;
        btn.prop('disabled', true).text('拉取中…');
        fetchJudgeModels()
            .then(models => {
                if (!models.length) throw new Error('接口没有返回模型列表');
                showModelPicker(models);
            })
            .catch(e => {
                const m = safeErrorText(e, settings.judge.key);
                if (typeof toastr !== 'undefined') toastr.warning(m || '拉取模型失败');
                else console.warn('[悬置之境] 拉取模型失败：', m);
            })
            .finally(() => { btn.prop('disabled', false).text('拉取模型'); });
    });

    // 插件巡查：来源过滤 / 插件过滤 / 搜索 / 清空 / 复制全部 / 单条复制
    panel.on('click', '.susp__pw-src', function () {
        pwFilter.src = $(this).data('src') || 'all';
        renderPluginWatch();
    });
    panel.on('change', '.susp__pw-plugin', function () {
        pwFilter.plugin = $(this).val() || '';
        renderPluginWatch();
    });
    panel.on('input', '.susp__pw-search', function () {
        pwFilter.q = String($(this).val() || '').trim().toLowerCase();
        renderPluginWatch();
    });
    panel.on('click', '.susp__pw-clear', function () {
        settings.features.pluginWatch.entries = [];
        saveSettings();
        renderPluginWatch();
    });
    panel.on('click', '.susp__pw-copyall', function () {
        const list = filteredEntries();
        if (!list.length) return;
        clipboardCopy(list.map(formatEntryText).join('\n\n' + '-'.repeat(40) + '\n\n'), $(this));
    });
    panel.on('click', '.susp__pw-copy', function () {
        const id = $(this).data('id');
        const e = settings.features.pluginWatch.entries.find(x => x.id === id);
        if (e) clipboardCopy(formatEntryText(e), $(this));
    });
    panel.on('click', '.susp__pw-roster-refresh', function () { renderExtensionRoster(); });
    // 预设巡查：开关 / 绑定 / 自动注入 / 刷新 / 手动巡查 / 单条复制 / 清空
    panel.on('change', '.susp__pt-enabled', function () {
        settings.features.preset.enabled = $(this).prop('checked');
        saveSettings();
        renderPreset();
        renderOverview();
    });
    panel.on('change', '.susp__pt-preset', function () {
        settings.features.preset.presetName = $(this).val() || '';
        saveSettings();
        renderPreset();
    });
    panel.on('change', '.susp__pt-autoinject', function () {
        settings.features.preset.autoInject = $(this).prop('checked');
        saveSettings();
    });
    panel.on('click', '.susp__pt-refresh', function () { renderPreset(); });
    panel.on('click', '.susp__pt-run', async function () { clearCorrections(); await inspectPreset(true); injectMergedCorrection(); });
    panel.on('click', '.susp__pt-copy', function () {
        const id = $(this).data('id');
        const e = settings.features.preset.entries.find(x => x.id === id);
        if (e) clipboardCopy(formatPresetEntryText(e), $(this));
    });
    panel.on('click', '.susp__pt-clear', function () {
        settings.features.preset.entries = [];
        saveSettings();
        renderPreset();
    });
    // 文风自检：开关 / 绑定 / 自动注入 / 刷新 / 标记文风段落
    panel.on('change', '.susp__st-enabled', function () {
        settings.features.style.enabled = $(this).prop('checked');
        saveSettings();
        renderStyle();
        renderOverview();
    });
    panel.on('change', '.susp__st-preset', function () {
        settings.features.style.presetName = $(this).val() || '';
        settings.features.style.marked = [];
        saveSettings();
        renderStyle();
    });
    panel.on('change', '.susp__st-autoinject', function () {
        settings.features.style.autoInject = $(this).prop('checked');
        saveSettings();
    });
    panel.on('click', '.susp__st-refresh', function () { renderStyle(); });
    panel.on('change', '.susp__st-mark', function () {
        const name = $(this).data('name');
        const on = $(this).prop('checked');
        const f = settings.features.style;
        const i = f.marked.findIndex(m => m.name === name);
        if (on && i < 0) {
            const preset = getPresetByName(f.presetName);
            const it = preset ? presetItems(preset).find(x => x.name === name) : null;
            f.marked.push({ name, content: it ? it.content : '' });
        }
        if (!on && i >= 0) f.marked.splice(i, 1);
        saveSettings();
        renderStyle();
    });
    // 人设巡查：开关 / 绑定当前人物卡 / 自动注入
    panel.on('change', '.susp__pn-enabled', function () {
        settings.features.persona.enabled = $(this).prop('checked');
        saveSettings();
        renderPersona();
        renderOverview();
    });
    panel.on('change', '.susp__pn-autoinject', function () {
        settings.features.persona.autoInject = $(this).prop('checked');
        saveSettings();
    });
    panel.on('click', '.susp__pn-bind', function () {
        const c = currentCharacter();
        if (!c) {
            if (typeof toastr !== 'undefined') toastr.warning('当前没有载入人物卡，无法绑定。');
            return;
        }
        const f = settings.features.persona;
        f.charId = (typeof this_chid !== 'undefined') ? Number(this_chid) : -1;
        f.charName = c.name || '';
        f.persona = buildPersonaText(c);
        saveSettings();
        renderPersona();
    });
    // 文风 / 人设：手动巡查一次（走同一个综合裁判）+ 冲突记录复制/清空
    panel.on('click', '.susp__st-run', async function () { clearCorrections(); await inspectStylePersona(true); injectMergedCorrection(); });
    panel.on('click', '.susp__pn-run', async function () { clearCorrections(); await inspectStylePersona(true); injectMergedCorrection(); });
    panel.on('click', '.susp__fx-copy', function () {
        const feature = $(this).data('feature');
        const id = $(this).data('id');
        const e = (settings.features[feature].entries || []).find(x => x.id === id);
        if (e) clipboardCopy(ENTRY_META[feature].format(e), $(this));
    });
    panel.on('click', '.susp__fx-clear', function () {
        const feature = $(this).data('feature');
        settings.features[feature].entries = [];
        saveSettings();
        if (feature === 'style') renderStyle();
        else renderPersona();
    });
}

function togglePanel(show) {
    const panel = $('#st-suspension');
    if (show == null) show = !panel.is(':visible');
    if (show) { renderPanel(); panel.show(); } else { panel.hide(); }
    document.body.classList.toggle('suspension-open', show);
}

// ---------------- 渲染 ----------------
function renderPanel() {
    const panel = $('#st-suspension');
    if (!panel.length) return;
    renderOverview();
    renderPluginWatch();
    renderPreset();
    renderStyle();
    renderPersona();
    renderExtensionRoster();
}

function renderOverview() {
    const panel = $('#st-suspension');
    panel.find('.susp__enabled').prop('checked', settings.enabled);
    panel.toggleClass('susp__off', !settings.enabled);
    for (const k of ['preset', 'style', 'pluginWatch', 'persona']) {
        panel.find('.susp__card-toggle[data-feature="' + k + '"]').prop('checked', !!settings.features[k].enabled);
    }
    panel.find('.susp__judge-url').val(settings.judge.url || '');
    panel.find('.susp__judge-key').val(settings.judge.key || '');
    panel.find('.susp__judge-model').val(settings.judge.model || '');
}

// 插件巡查过滤状态（仅会话内，不持久化）
const pwFilter = { q: '', src: 'all', plugin: '' };

function filteredEntries() {
    const entries = settings.features.pluginWatch.entries || [];
    return entries.filter(e => {
        if (pwFilter.src !== 'all' && e.source !== pwFilter.src) return false;
        if (pwFilter.plugin && e.plugin !== pwFilter.plugin) return false;
        if (pwFilter.q && String(e.message).toLowerCase().indexOf(pwFilter.q) < 0) return false;
        return true;
    });
}

function renderExtensionRoster() {
    const box = $('#st-suspension .susp__pw-roster');
    if (!box.length) return;
    const all = listExtensions();
    const running = all.filter(x => x.enabled);
    const off = all.filter(x => !x.enabled);
    box.find('.susp__pw-run-count').text(running.length);
    box.find('.susp__pw-off-count').text(off.length);
    const row = (x) => {
        const meta = [];
        if (x.name !== x.displayName) meta.push(x.name);
        if (x.typeLabel) meta.push(x.typeLabel);
        if (x.version) meta.push('v' + x.version);
        return `<div class="susp__pw-roster-item"><span class="susp__pw-roster-name">${escapeHtml(x.displayName)}</span><span class="susp__pw-roster-meta">${escapeHtml(meta.join(' · '))}</span></div>`;
    };
    box.find('.susp__pw-running').html(running.map(row).join('') || '<div class="susp__pw-roster-empty">无</div>');
    box.find('.susp__pw-notrunning').html(off.map(row).join('') || '<div class="susp__pw-roster-empty">无</div>');
}

function renderPluginWatch() {
    const page = $('#st-suspension [data-page="pluginWatch"]');
    if (!page.length) return;
    const entries = settings.features.pluginWatch.entries || [];
    page.find('.susp__pw-enabled').prop('checked', !!settings.features.pluginWatch.enabled);
    page.find('.susp__pw-total').text(entries.length);

    // 来源过滤按钮
    const srcs = page.find('.susp__pw-srcs').empty();
    srcs.append(`<button type="button" class="susp__pw-src${pwFilter.src === 'all' ? ' on' : ''}" data-src="all">全部</button>`);
    for (const s of SRC_ORDER) {
        srcs.append(`<button type="button" class="susp__pw-src${pwFilter.src === s ? ' on' : ''}" data-src="${s}">${SRC_LABELS[s]}</button>`);
    }

    // 插件下拉
    const plugins = Array.from(new Set(entries.map(e => e.plugin)));
    const sel = page.find('.susp__pw-plugin');
    const cur = pwFilter.plugin && plugins.includes(pwFilter.plugin) ? pwFilter.plugin : '';
    sel.html('<option value="">全部插件</option>' + plugins.map(p => `<option value="${escapeHtml(p)}"${p === cur ? ' selected' : ''}>${escapeHtml(p)}</option>`).join(''));
    pwFilter.plugin = cur;

    // 列表
    const list = filteredEntries();
    const ul = page.find('.susp__pw-list').empty();
    if (!list.length) {
        ul.append('<div class="susp__pw-empty">暂无捕获。插件运行正常，或还没有产生报错 / 失败。</div>');
        return;
    }
    for (const e of list) {
        const badgeCls = e.source === 'window.error' || e.source === 'unhandledrejection' ? 'danger' : (e.source === 'console.warn' ? 'warn' : 'info');
        const item = $(`
          <div class="susp__pw-item">
            <div class="susp__pw-item-top">
              <span class="susp__pw-time">${escapeHtml(fmtTime(e.ts))}</span>
              <span class="susp__pw-badge ${badgeCls}">${escapeHtml(SRC_LABELS[e.source] || e.source)}</span>
              <span class="susp__pw-plugin">${escapeHtml(e.plugin)}</span>
              ${e.count > 1 ? `<span class="susp__pw-count">×${e.count}</span>` : ''}
              <span class="susp__spacer"></span>
              <button type="button" class="susp__btn susp__pw-copy" data-id="${e.id}">复制</button>
            </div>
            <div class="susp__pw-msg">${escapeHtml(e.message)}</div>
            ${e.stack ? `<details class="susp__pw-stack"><summary>堆栈</summary><pre>${escapeHtml(e.stack)}</pre></details>` : ''}
          </div>`);
        ul.append(item);
    }
}

function renderPreset() {
    const page = $('#st-suspension [data-page="preset"]');
    if (!page.length) return;
    const f = settings.features.preset;
    page.find('.susp__pt-enabled').prop('checked', !!f.enabled);
    page.find('.susp__pt-autoinject').prop('checked', !!f.autoInject);
    updateInjectBox('preset');

    // 预设下拉（拉取酒馆已保存的聊天补全预设）
    const names = listPresets();
    const sel = page.find('.susp__pt-preset');
    const cur = names.includes(f.presetName) ? f.presetName : (f.presetName || '');
    sel.html('<option value="">— 未绑定 —</option>' + names.map(n => `<option value="${escapeHtml(n)}"${n === cur ? ' selected' : ''}>${escapeHtml(n)}</option>`).join(''));
    if (f.presetName && !names.includes(f.presetName)) {
        sel.append(`<option value="${escapeHtml(f.presetName)}" selected>${escapeHtml(f.presetName)}（已失效）</option>`);
    }

    // 条目清单：每条亮灯（绿=遵循/已读取，红=冲突/没遵循，白=本轮未使用）
    const itemsBox = page.find('.susp__pt-items').empty();
    const preset = cur ? getPresetByName(cur) : null;
    const items = preset ? presetItems(preset) : [];
    if (!cur) {
        itemsBox.append('<div class="susp__pt-warn">' + (judgeApiConfigured() ? '请先绑定一个预设，绑定后这里会列出预设里的每个条目。' : '请先在「总览 → 裁判引擎设置」里填好接口地址与模型，预设巡查才可用。') + '</div>');
    } else if (!items.length) {
        itemsBox.append('<div class="susp__pt-warn">该预设里没有可用的指令条目（可能全部是 marker 或空内容），无法逐条判定。</div>');
    } else {
        const last = f.items || [];
        const statusLabel = { green: '遵循', red: '冲突', white: '未使用' };
        for (const it of items) {
            const r = last.find(x => x.name === it.name);
            const status = r ? r.status : 'white';
            const note = (r && r.note && r.note !== '无') ? r.note : '';
            itemsBox.append(`
              <div class="susp__pt-itemlight">
                <span class="susp__pt-dot ${status}"></span>
                <div class="susp__pt-itemlight-body">
                  <div class="susp__pt-itemlight-name">${escapeHtml(it.name)} <span class="susp__pt-itemlight-status ${status}">${statusLabel[status] || '未使用'}</span></div>
                  ${note ? `<div class="susp__pt-itemlight-note">${escapeHtml(note)}</div>` : ''}
                  <details class="susp__pt-itemlight-details"><summary>查看内容</summary><div class="susp__pt-itemlight-content">${escapeHtml(it.content)}</div></details>
                </div>
              </div>`);
        }
    }

    // 冲突历史记录
    const ul = page.find('.susp__pt-list').empty();
    if (presetInspecting) ul.append('<div class="susp__pt-loading">判定中…</div>');
    const entries = f.entries || [];
    if (!entries.length && !presetInspecting) {
        ul.append('<div class="susp__pw-empty">暂无冲突记录。每轮生成后会自动逐条判定，冲突会归档到这里。</div>');
    }
    for (const e of entries) {
        const item = $(`
          <div class="susp__pt-item">
            <div class="susp__pw-item-top">
              <span class="susp__pw-time">${escapeHtml(fmtTime(e.ts))}</span>
              <span class="susp__pw-badge danger">冲突</span>
              <span class="susp__spacer"></span>
              <button type="button" class="susp__btn susp__pt-copy" data-id="${e.id}">复制</button>
            </div>
            <div class="susp__pt-problem">${escapeHtml(e.problem || '')}</div>
            ${e.correction ? `<div class="susp__pt-corr"><b>矫正</b> ${escapeHtml(e.correction)}</div>` : ''}
            ${e.reply ? `<details class="susp__pw-stack"><summary>回复片段</summary><pre>${escapeHtml(e.reply)}</pre></details>` : ''}
          </div>`);
        ul.append(item);
    }
    if (entries.length) {
        ul.append('<div class="susp__pt-clear-row"><button type="button" class="susp__btn susp__pt-clear">清空记录</button></div>');
    }
}

function renderStyle() {
    const page = $('#st-suspension [data-page="style"]');
    if (!page.length) return;
    const f = settings.features.style;
    page.find('.susp__st-enabled').prop('checked', !!f.enabled);
    page.find('.susp__st-autoinject').prop('checked', !!f.autoInject);
    updateInjectBox('style');

    // 预设下拉（拉取酒馆已保存的聊天补全预设）
    const names = listPresets();
    const sel = page.find('.susp__st-preset');
    const cur = names.includes(f.presetName) ? f.presetName : (f.presetName || '');
    sel.html('<option value="">— 未绑定 —</option>' + names.map(n => `<option value="${escapeHtml(n)}"${n === cur ? ' selected' : ''}>${escapeHtml(n)}</option>`).join(''));
    if (f.presetName && !names.includes(f.presetName)) {
        sel.append(`<option value="${escapeHtml(f.presetName)}" selected>${escapeHtml(f.presetName)}（已失效）</option>`);
    }

    // 条目勾选：勾中即标记为「文风段落」
    const itemsBox = page.find('.susp__st-items').empty();
    const preset = cur ? getPresetByName(cur) : null;
    const items = preset ? presetItems(preset) : [];
    const markedNames = new Set((f.marked || []).map(m => m.name));
    page.find('.susp__st-count').text((f.marked || []).length);
    if (!cur) {
        itemsBox.append('<div class="susp__pt-warn">' + (judgeApiConfigured() ? '请先绑定一个预设，绑定后这里会列出预设里的每个条目，勾选即为「文风段落」。' : '请先在「总览 → 裁判引擎设置」里填好接口地址与模型，文风自检才可用。') + '</div>');
    } else if (!items.length) {
        itemsBox.append('<div class="susp__pt-warn">该预设里没有可用的指令条目（可能全部是 marker 或空内容），无法标记文风。</div>');
    } else {
        for (const it of items) {
            const on = markedNames.has(it.name);
            itemsBox.append(`
              <div class="susp__st-item${on ? ' on' : ''}">
                <label class="susp__st-item-row">
                  <input type="checkbox" class="susp__st-mark" data-name="${escapeHtml(it.name)}"${on ? ' checked' : ''}>
                  <span class="susp__st-item-name">${escapeHtml(it.name)}</span>
                  <span class="susp__st-item-tag">文风</span>
                </label>
                <details class="susp__pt-itemlight-details"><summary>查看内容</summary><div class="susp__pt-itemlight-content">${escapeHtml(it.content)}</div></details>
              </div>`);
        }
    }

    renderFeatureEntries(page.find('.susp__st-list'), 'style', comboInspecting, '暂无脱风记录。每轮生成后会自动判定，脱风会归档到这里（NSFW / 亲密剧情整轮豁免，不判）。');
}

function currentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) return null;
    const c = characters[this_chid];
    return c && typeof c === 'object' ? c : null;
}
function buildPersonaText(c) {
    const parts = [];
    const push = (label, v) => { const s = String(v || '').trim(); if (s) parts.push('【' + label + '】\n' + s); };
    push('人格', c.personality);
    push('描述', c.description);
    push('场景', c.scenario);
    push('示例对话', c.mes_example);
    push('开场白', c.first_mes);
    return parts.join('\n\n');
}
function renderPersona() {
    const page = $('#st-suspension [data-page="persona"]');
    if (!page.length) return;
    const f = settings.features.persona;
    page.find('.susp__pn-enabled').prop('checked', !!f.enabled);
    page.find('.susp__pn-autoinject').prop('checked', !!f.autoInject);
    updateInjectBox('persona');

    const cur = currentCharacter();
    const nameBox = page.find('.susp__pn-char-name');
    const hintBox = page.find('.susp__pn-char-hint');
    const personaBox = page.find('.susp__pn-persona').empty();

    if (!f.charName) {
        nameBox.text('未绑定人物卡');
        hintBox.removeClass('warn').text(cur ? '点击右上角「绑定当前人物卡」把当前角色「' + cur.name + '」绑进来。' : '当前没有载入人物卡。');
    } else {
        nameBox.text('已绑定：' + f.charName);
        if (cur && cur.name && cur.name !== f.charName) {
            hintBox.addClass('warn').text('当前已切换到「' + cur.name + '」，与绑定的「' + f.charName + '」不一致，可重新绑定。');
        } else if (cur) {
            hintBox.removeClass('warn').text('与当前人物卡一致。');
        } else {
            hintBox.removeClass('warn').text('当前没有载入人物卡。');
        }
        personaBox.append('<details class="susp__pn-persona-details"><summary>查看人设文本（用于判定）</summary><div class="susp__pn-persona-content">' + escapeHtml(f.persona || '(空)') + '</div></details>');
    }

    renderFeatureEntries(page.find('.susp__pn-list'), 'persona', comboInspecting, '暂无违和记录。每轮生成后会自动判定，OOC / 超雄等违和会归档到这里（NSFW / 亲密剧情整轮豁免，不判）。');
}

// ---------------- 每轮综合巡查入口：预设 + 文风/人设 并行跑完，再合并注入一条矫正 ----------------
async function runInspections(force) {
    if (!settings.enabled && !force) return;
    if (!judgeApiConfigured()) return;
    const tasks = [];
    const fp = settings.features.preset;
    if (force || (fp.enabled && fp.presetName)) tasks.push(inspectPreset(force));
    if (styleActive(force) || personaActive(force)) tasks.push(inspectStylePersona(force));
    await Promise.allSettled(tasks);
    injectMergedCorrection();
}

// ---------------- 初始化 ----------------
jQuery(async () => {
    loadSettings();
    hookConsole();
    installGlobalHandlers();
    buildMenuButton();
    buildPanel();

    // 每轮生成结束后：先清掉上一轮注入的矫正，再（稍等）对最新 AI 回复做各功能巡查
    eventSource.on(event_types.GENERATION_ENDED, () => {
        clearCorrections();
        if (!settings.enabled) return;
        setTimeout(() => runInspections(false), 300);
    });
});

// ST 更新钩子：更新完成后自动刷新整页（manifest 的 hooks.update 指向此导出函数）
export function reloadOnUpdate() {
    location.reload();
}
