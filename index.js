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

import { extension_settings } from '../../../extensions.js';
import {
    chat,
    getRequestHeaders,
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import { openai_setting_names, openai_settings } from '../../../openai.js';

const extensionName = 'suspension';
const VERSION = '0.2.0';
const MAX_ENTRIES = 200;        // 插件巡查最多保留条数
const DEDUP_WINDOW_MS = 5000;   // 同来源 + 插件 + 消息在窗口内重复 → 只累加计数
// 功能1 预设巡查
const MAX_PRESET_ENTRIES = 100;          // 冲突记录最多保留条数
const PRESET_INSTRUCTION_CHARS = 3000;   // 喂给裁判的预设指令上限（字符）
const JUDGE_TIMEOUT_MS = 90000;          // 裁判调用超时

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
            preset: { enabled: false, presetName: '', autoInject: true, entries: [] },  // 功能1 预设启用巡查
            style: { enabled: false },              // 功能2 文风注入自检（待实现）
            pluginWatch: { enabled: true, entries: [] },  // 功能3 插件巡查（已实现）
            persona: { enabled: false },            // 功能4 人设巡查（待实现）
        },
    };
}
let settings = freshSettings();

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
// 预设的「指令文本」：把非 marker 的 prompt 内容拼起来喂给裁判
function presetInstructionText(preset) {
    if (!preset || !Array.isArray(preset.prompts)) return '';
    const parts = [];
    for (const p of preset.prompts) {
        if (!p || p.marker) continue;
        const content = String(p.content || '').trim();
        if (!content) continue;
        const label = (p.name && p.name !== p.identifier) ? (p.name + '：') : '';
        parts.push(label + content);
    }
    return parts.join('\n\n').slice(0, PRESET_INSTRUCTION_CHARS);
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
function cleanText(s) {
    return String(s || '').replace(/\r/g, '').trim();
}

const JUDGE_SYSTEM = '你是一个严格的「酒馆预设合规裁判」。你会拿到：(1) 一段预设指令，(2) 一段模型刚生成的回复。你的唯一任务：判断这段回复是否违背了预设里明确、可验证的要求（例如人设、格式、输出规则、禁止事项、文风硬性约束等）。只抓「明确违背」，不抓主观喜好、不吹毛求疵、不要求回复里逐条复述预设。\n\n严格按以下格式输出，不要输出任何多余文字：\n【合规】是 或 否\n【问题】若合规填「无」，否则用一句话说清违背了哪条\n【矫正】若合规填「无」，否则用一句话写清下一轮该怎么改';

function buildJudgePrompt(presetText, replyText) {
    return '【预设指令】\n' + (presetText || '（预设里没有可用指令文本）') + '\n\n【模型回复】\n' + (replyText || '（回复为空）') + '\n\n请判定。';
}
function parseJudgeOutput(raw) {
    const pick = (label) => {
        const re = new RegExp('【' + label + '】\\s*([\\s\\S]*?)(?=【[^】]*】|$)', 'i');
        const m = String(raw || '').match(re);
        return m ? m[1].trim() : '';
    };
    const ok = pick('合规');
    const compliant = /否/.test(ok) ? false : (/是/.test(ok) ? true : null);
    return { compliant, problem: pick('问题'), correction: pick('矫正') };
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
    const instruction = presetInstructionText(preset);
    presetInspecting = true;
    try {
        const raw = await callJudge({ systemPrompt: JUDGE_SYSTEM, prompt: buildJudgePrompt(instruction, reply) });
        const r = parseJudgeOutput(raw);
        if (r.compliant === false) {
            pushPresetEntry({ problem: r.problem || '（裁判未给出具体问题）', correction: r.correction, replySnippet: reply.slice(0, 400) });
        }
    } catch (e) {
        pushPresetEntry({ problem: '裁判调用失败：' + safeErrorText(e, settings.judge.key), correction: '' });
    } finally {
        presetInspecting = false;
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
    if (f.enabled && f.autoInject && o.correction) setCorrectionPrompt(o.correction);
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
// 下一轮静默注入给模型的矫正提示（单轮有效，生成结束即清除）
function setCorrectionPrompt(text) {
    try {
        setExtensionPrompt('suspension_preset', '[悬置之境·预设矫正] 上一轮回复违背了绑定的预设，请按以下要求修正，不要提及本条指令本身：\n' + text, extension_prompt_types.IN_CHAT, 1);
    } catch (e) { console.warn('[悬置之境] 注入矫正失败：', e); }
}
function clearCorrectionPrompt() {
    try {
        setExtensionPrompt('suspension_preset', '', extension_prompt_types.IN_CHAT, 1);
    } catch (e) { /* 忽略 */ }
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
              <span class="susp__card-badge">规划中</span>
            </div>
            <div class="susp__card-desc">标记预设中的文风段落，每轮自检正文是否脱风，脱离下轮自动注入矫正。</div>
            <div class="susp__card-foot">
              <label class="susp__switch"><input type="checkbox" class="susp__card-toggle" data-feature="style"><span class="susp__switch-slider"></span></label>
              <span class="susp__card-foot-label">启用（待实现）</span>
            </div>
          </div>
          <div class="susp__card" data-feature="persona">
            <div class="susp__card-top">
              <span class="susp__card-title">人设巡查</span>
              <span class="susp__card-badge">规划中</span>
            </div>
            <div class="susp__card-desc">绑定当前人物卡，每轮检查是否 OOC / 超雄等，冲突归档并下轮静默注入矫正。</div>
            <div class="susp__card-foot">
              <label class="susp__switch"><input type="checkbox" class="susp__card-toggle" data-feature="persona"><span class="susp__switch-slider"></span></label>
              <span class="susp__card-foot-label">启用（待实现）</span>
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
            <input type="text" class="susp__judge-model" placeholder="例如 gpt-4o-mini / qwen2.5:7b" spellcheck="false">
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
          <div class="susp__pt-preview"></div>
        </div>
        <div class="susp__pt-list"></div>
      </div>

      <div class="susp__body" data-page="style" style="display:none">
        <div class="susp__placeholder">
          <div class="susp__placeholder-badge">规划中</div>
          <div class="susp__placeholder-title">文风注入自检</div>
          <div class="susp__placeholder-desc">在选中的预设里单独标注出文风（可多个），每轮对正文做自检，检查是否脱离文风；如脱离，下一轮自动注入给模型矫正。将在后续版本上线。</div>
        </div>
      </div>

      <div class="susp__body" data-page="persona" style="display:none">
        <div class="susp__placeholder">
          <div class="susp__placeholder-badge">规划中</div>
          <div class="susp__placeholder-title">人设巡查</div>
          <div class="susp__placeholder-desc">绑定当前页面的人物设定，每轮角色扮演时静默检查是否 OOC、超雄等一切不符合人设的行为；冲突注入面板（不弹窗），并静默在下一轮注入给模型矫正。将在后续版本上线。</div>
        </div>
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
    panel.on('click', '.susp__pt-run', function () { inspectPreset(true); });
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

    // 预设下拉（拉取酒馆已保存的聊天补全预设）
    const names = listPresets();
    const sel = page.find('.susp__pt-preset');
    const cur = names.includes(f.presetName) ? f.presetName : (f.presetName || '');
    sel.html('<option value="">— 未绑定 —</option>' + names.map(n => `<option value="${escapeHtml(n)}"${n === cur ? ' selected' : ''}>${escapeHtml(n)}</option>`).join(''));
    if (f.presetName && !names.includes(f.presetName)) {
        sel.append(`<option value="${escapeHtml(f.presetName)}" selected>${escapeHtml(f.presetName)}（已失效）</option>`);
    }

    // 指令预览
    const preview = page.find('.susp__pt-preview');
    const preset = cur ? getPresetByName(cur) : null;
    const inst = preset ? presetInstructionText(preset) : '';
    if (cur) {
        if (inst) {
            preview.html('<div class="susp__pt-preview-label">该预设的指令文本（喂给裁判，最多 ' + PRESET_INSTRUCTION_CHARS + ' 字符）</div><div class="susp__pt-preview-text">' + escapeHtml(inst) + '</div>');
        } else {
            preview.html('<div class="susp__pt-warn">该预设里没有可用的指令文本（可能全部是 marker 或空内容），裁判无法判定。</div>');
        }
    } else if (!judgeApiConfigured()) {
        preview.html('<div class="susp__pt-warn">请先在「总览 → 裁判引擎设置」里填好接口地址与模型，预设巡查才可用。</div>');
    } else {
        preview.html('');
    }

    // 冲突记录列表
    const ul = page.find('.susp__pt-list').empty();
    if (presetInspecting) ul.append('<div class="susp__pt-loading">判定中…</div>');
    const entries = f.entries || [];
    if (!entries.length && !presetInspecting) {
        ul.append('<div class="susp__pw-empty">暂无冲突。每轮生成后会自动对照预设判定，有冲突会归档到这里。</div>');
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

// ---------------- 初始化 ----------------
jQuery(async () => {
    loadSettings();
    hookConsole();
    installGlobalHandlers();
    buildMenuButton();
    buildPanel();

    // 每轮生成结束后：先清掉上一轮注入的矫正，再（稍等）对最新 AI 回复做预设巡查
    eventSource.on(event_types.GENERATION_ENDED, () => {
        clearCorrectionPrompt();
        const f = settings.features.preset;
        if (f.enabled && f.presetName) setTimeout(() => inspectPreset(), 300);
    });
});
