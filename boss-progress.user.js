// ==UserScript==
// @name         BOSS投递进度助手
// @namespace    https://www.zhipin.com/
// @version      0.6.5
// @description  记录并展示BOSS投递进度，支持本地数据库、搜索、CSV导入导出
// @match        https://www.zhipin.com/web/geek/recommend*
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/web/geek/*
// @downloadURL  https://raw.githubusercontent.com/g-jiangjiang/boss-progress/main/boss-progress.user.js
// @updateURL    https://raw.githubusercontent.com/g-jiangjiang/boss-progress/main/boss-progress.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const DB_NAME = 'boss_progress_db';
    const DB_VERSION = 2;
    const STORE_RECORDS = 'records';
    const STORE_COMPANY_BLACKLIST = 'companyBlacklist';
    const STORE_BOSS_BLACKLIST = 'bossBlacklist';
    const STORE_META = 'meta';
    const PANEL_ID = 'boss-progress-panel';
    const BADGE_CLASS = 'boss-progress-badge';
    const DETAIL_BADGE_CLASS = 'boss-progress-detail-badge';

    const state = {
        db: null,
        accountKey: null,
        accountLabel: null,
        refreshTimer: null,
        scanTimer: null,
        muteObserver: false,
        lastScanAt: 0,
        searchQuery: '',
        statusFilter: 'all',
        cityFilter: 'all',
        accountFilter: 'all',
        dataView: 'progress',
        syncStatus: '',
        activeShieldDialogSource: '',
        enableNetwork: false,
        tabStatusMap: {}
    };

    function log(...args) {
        console.log('[boss-progress]', ...args);
    }

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_RECORDS)) {
                    const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
                    store.createIndex('by_account', 'accountKey', { unique: false });
                    store.createIndex('by_job', ['accountKey', 'jobId'], { unique: false });
                    store.createIndex('by_company', ['accountKey', 'companyId'], { unique: false });
                    store.createIndex('by_updated', 'updatedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_COMPANY_BLACKLIST)) {
                    const store = db.createObjectStore(STORE_COMPANY_BLACKLIST, { keyPath: 'id' });
                    store.createIndex('by_account', 'accountKey', { unique: false });
                    store.createIndex('by_company_key', ['accountKey', 'companyKey'], { unique: false });
                    store.createIndex('by_updated', 'updatedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_BOSS_BLACKLIST)) {
                    const store = db.createObjectStore(STORE_BOSS_BLACKLIST, { keyPath: 'id' });
                    store.createIndex('by_account', 'accountKey', { unique: false });
                    store.createIndex('by_boss_key', ['accountKey', 'bossKey'], { unique: false });
                    store.createIndex('by_company_boss', ['accountKey', 'companyKey', 'bossKey'], { unique: false });
                    store.createIndex('by_updated', 'updatedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_META)) {
                    db.createObjectStore(STORE_META, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function withStore(storeName, mode, fn) {
        return new Promise((resolve, reject) => {
            const tx = state.db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            try {
                result = fn(store);
            } catch (err) {
                reject(err);
                return;
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    function getMeta(key) {
        return withStore(STORE_META, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const req = store.get(key);
                req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
                req.onerror = () => reject(req.error);
            });
        });
    }

    function setMeta(key, value) {
        return withStore(STORE_META, 'readwrite', (store) => {
            store.put({ key, value });
        });
    }

    function hashString(input) {
        let hash = 5381;
        for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) + hash) + input.charCodeAt(i);
            hash &= 0xffffffff;
        }
        return Math.abs(hash).toString(36);
    }

    function guessAccountKey() {
        const cookie = document.cookie || '';
        const cookieCandidates = ['zp_uid', 'zp_uid_ck', 'uid', 'uid_ck', 'userId', 'userid'];
        for (const name of cookieCandidates) {
            const match = cookie.match(new RegExp(`${name}=([^;]+)`));
            if (match && match[1]) {
                return `acc_${hashString(`${name}:${match[1]}`)}`;
            }
        }

        try {
            const keys = Object.keys(localStorage || {});
            for (const key of keys) {
                if (!/uid|user|geek|boss/i.test(key)) continue;
                const value = localStorage.getItem(key);
                if (value && value.length >= 6) {
                    return `acc_${hashString(`${key}:${value}`)}`;
                }
            }
        } catch (err) {
            // ignore
        }

        return 'acc_unknown';
    }

    async function resolveAccountKey() {
        const key = guessAccountKey();
        if (key && key !== 'acc_unknown') {
            await setMeta('lastAccountKey', key);
            return key;
        }
        const last = await getMeta('lastAccountKey');
        if (last) return last;
        return key || 'acc_unknown';
    }

    async function ensureAccount() {
        if (state.accountKey) return;
        const key = await resolveAccountKey();
        state.accountKey = key;
        const label = await getMeta(`accountLabel:${key}`);
        state.accountLabel = label || '未命名账号';
    }

    async function setAccountLabel(label) {
        state.accountLabel = label || '未命名账号';
        await setMeta(`accountLabel:${state.accountKey}`, state.accountLabel);
        renderPanel();
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function getUrlParam(name) {
        try {
            return new URLSearchParams(location.search).get(name) || '';
        } catch (err) {
            return '';
        }
    }

    function isRecommendPage() {
        return /\/web\/geek\/recommend/.test(location.pathname || '');
    }

    function isJobsPage() {
        return /\/web\/geek\/jobs/.test(location.pathname || '');
    }

    function isPrivacySetPage() {
        return /\/web\/geek\/privacy-set/.test(location.pathname || '');
    }

    function isShieldCompanyPage() {
        return isPrivacySetPage() && getUrlParam('type') === 'shieldCompany';
    }

    function isBossBlacklistPage() {
        return isPrivacySetPage() && getUrlParam('type') === 'bossBlacklist';
    }

    function detectDataViewFromPage() {
        if (isShieldCompanyPage()) return 'companyBlacklist';
        if (isBossBlacklistPage()) return 'bossBlacklist';
        return state.dataView || 'progress';
    }

    function syncDataViewFromPage() {
        const nextView = detectDataViewFromPage();
        if (state.dataView !== nextView) {
            state.dataView = nextView;
            renderPanel();
        }
    }

    function getRecommendTab() {
        return getUrlParam('tab');
    }

    function getFixedStatusForTab(tab) {
        if (tab === '1') return '已沟通';
        if (tab === '2') return '已投递';
        if (tab === '3') return '已面试';
        if (tab === '4') return '已收藏';
        return '';
    }

    function isTargetRecommendTabPage() {
        const tab = getRecommendTab();
        return isRecommendPage() && ['1', '2', '3', '4'].includes(tab);
    }

    function getTabKey() {
        const tab = getUrlParam('tab');
        const tag = getUrlParam('tag');
        if (!tab && !tag) return '';
        return `tab=${tab || ''}|tag=${tag || ''}`;
    }

    function getTabKeyLabel() {
        const tab = getUrlParam('tab');
        const tag = getUrlParam('tag');
        if (!tab && !tag) return '无tab参数';
        return `tab=${tab || '-'} tag=${tag || '-'}`;
    }

    function normalizeStatusLabel(text) {
        const normalized = normalizeText(text);
        if (!normalized) return '';
        if (/沟通过|已沟通/.test(normalized)) return '已沟通';
        if (/已投递|投递/.test(normalized)) return '已投递';
        if (/面试/.test(normalized)) return '已面试';
        return normalized;
    }

    function normalizeKey(text) {
        return normalizeText(text)
            .toLowerCase()
            .replace(/[\s·•\u00b7·|]/g, '')
            .replace(/[()\[\]{}（）]/g, '')
            .replace(/[-–—_]/g, '');
    }

    function normalizeBossName(text) {
        return normalizeText(text)
            .replace(/(先生|女士|小姐|老板|Boss|BOSS|HR|人事|招聘|经理|主管|负责人|专员|顾问|总监|CTO|CEO|HRBP)/ig, '')
            .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
            .toLowerCase();
    }

    function extractBossName(text) {
        const normalized = normalizeText(text);
        if (!normalized) return '';
        const honorific = normalized.match(/([\u4e00-\u9fa5A-Za-z]{1,8})(先生|女士|小姐)/);
        if (honorific) return `${honorific[1]}${honorific[2]}`;
        const first = normalized.split(/[｜|·\-\s]/).find((part) => normalizeBossName(part).length >= 1 && normalizeBossName(part).length <= 8);
        return first || normalized;
    }

    function isChatPage() {
        return /\/web\/geek\/chat/.test(location.pathname || '');
    }

    function stripBracketText(text) {
        return normalizeText(text)
            .replace(/\s*\[[^\]]+\]/g, '')
            .replace(/\s*\([^\)]+\)/g, '')
            .replace(/\s*（[^）]+）/g, '');
    }

    function stripJobNoise(text) {
        return normalizeText(text)
            .replace(/\d+\s*[-~]\s*\d+\s*[kK万千][^\s]*/g, '')
            .replace(/\d+\s*[-~]\s*\d+\s*薪/g, '');
    }

    function normalizeJobKey(text, loose) {
        const cleaned = stripJobNoise(text);
        const finalText = loose ? stripBracketText(cleaned) : cleaned;
        return normalizeKey(finalText);
    }

    function buildTextKey(companyName, jobName, loose) {
        if (!companyName || !jobName) return '';
        const companyKey = normalizeKey(companyName);
        const jobKey = normalizeJobKey(jobName, loose);
        if (!companyKey || !jobKey) return '';
        return `${companyKey}|${jobKey}`;
    }

    function pickDatasetValue(node, keys) {
        if (!node || !node.dataset) return '';
        for (const key of keys) {
            const value = node.dataset[key];
            if (value) return value;
        }
        return '';
    }

    function pickDataAttribute(node, attrs) {
        if (!node) return '';
        for (const attr of attrs) {
            const value = node.getAttribute(attr);
            if (value) return value;
        }
        return '';
    }

    function findNestedDataAttribute(root, attrs) {
        if (!root) return '';
        const direct = pickDataAttribute(root, attrs);
        if (direct) return direct;
        const selector = attrs.map((attr) => `[${attr}]`).join(',');
        if (!selector) return '';
        const el = root.querySelector(selector);
        if (!el) return '';
        return pickDataAttribute(el, attrs);
    }

    function looksLikeJobTitle(text) {
        if (!text) return false;
        return /工程师|开发|产品|运营|设计|测试|算法|前端|后端|全栈|Java|Python|PHP|Go|C\+\+|架构|客户端|安卓|Android|iOS|运维|安全|销售|客服|实习|分析师|经理|主管|专员|顾问/.test(text);
    }

    function shouldCleanCompanyName(text) {
        if (!text) return false;
        if (looksLikeJobTitle(text)) return true;
        if (/\d+\s*[-~]\s*\d+\s*[kK万千]/.test(text)) return true;
        if (/\[[^\]]+]/.test(text) || /（[^）]+）/.test(text) || /\([^)]*\)/.test(text)) return true;
        return false;
    }

    function cleanCompanyNameFromMix(text, jobName) {
        let cleaned = normalizeText(text);
        if (!cleaned) return '';
        const job = normalizeText(jobName || '');
        if (job) {
            cleaned = cleaned.replace(job, '');
            cleaned = cleaned.replace(job.replace(/\s+/g, ''), '');
        }
        cleaned = cleaned.replace(/\d+\s*[-~]\s*\d+\s*[kK万千][^\\s]*/g, '');
        cleaned = cleaned.replace(/\[[^\]]+]/g, '');
        cleaned = cleaned.replace(/（[^）]+）/g, '');
        cleaned = cleaned.replace(/\([^)]*\)/g, '');
        cleaned = cleaned.replace(/[|]/g, ' ');
        cleaned = cleaned.replace(/\s+/g, ' ').trim();
        return cleaned;
    }

    function normalizeCompanyCandidate(text, jobName) {
        let cleaned = normalizeText(text);
        if (!cleaned) return '';
        if (shouldCleanCompanyName(cleaned)) {
            const next = cleanCompanyNameFromMix(cleaned, jobName);
            if (next) cleaned = next;
        }
        return cleaned;
    }

    function pickCompanyCandidate(text, jobName) {
        const cleaned = normalizeCompanyCandidate(text, jobName);
        return isLikelyCompanyName(cleaned) ? cleaned : '';
    }

    function isLikelyCompanyName(text) {
        if (!text) return false;
        if (/^(HR|人事|招聘|猎头)/i.test(text)) return false;
        if (/HR|人事|招聘|猎头/.test(text)) return false;
        if (/先生|女士|HRBP/.test(text)) return false;
        if (/沟通|投递|面试|薪资|待遇/.test(text)) return false;
        if (/^\d/.test(text)) return false;
        if (looksLikeJobTitle(text)) return false;
        if (/\d+\s*[-~]\s*\d+\s*[kK万千]/.test(text)) return false;
        if (/\[[^\]]+]/.test(text) || /（[^）]+）/.test(text) || /\([^)]*\)/.test(text)) return false;
        if (text.length > 40) return false;
        return true;
    }

    function isLikelyJobName(text) {
        if (!text) return false;
        if (/先生|女士/.test(text)) return false;
        if (/HR|人事|招聘|猎头/.test(text) && !/工程师|开发|产品|运营|设计|测试|算法|前端|后端|全栈|Java|Python|PHP|Go|C\+\+/.test(text)) {
            return false;
        }
        if (text.length < 2) return false;
        return true;
    }

    function isInIgnoredArea(el) {
        if (!el) return false;
        const base = `#${PANEL_ID}, header, nav, footer, .header, .nav, .navbar, .top-bar, .boss-header, .geek-header, .site-nav, .menu, .menu-bar, .toolbar, .footer`;
        const full = `${base}, .sidebar, .side-bar, .sider`;
        const selector = isChatPage() ? base : full;
        return !!el.closest(selector);
    }

    function pickJobNameFromText(card) {
        if (!card) return '';
        const nodes = card.querySelectorAll('a, span, div, p');
        for (const el of nodes) {
            const text = normalizeText(el.textContent || '');
            if (!text || text.length < 3 || text.length > 36) continue;
            if (/先生|女士|HR|人事|招聘|猎头/.test(text)) continue;
            if (/\d+\s*[-~]\s*\d+\s*[kK千万]/.test(text)) continue;
            if (/公司|融资|人数|规模|行业|地址|面试|沟通|投递/.test(text)) continue;
            if (/\[.*\]/.test(text) || /工程师|开发|产品|运营|设计|测试|算法|前端|后端|全栈|Java|Python|PHP|Go|C\+\+/.test(text)) {
                return text;
            }
        }
        return '';
    }

    function pickCompanyFromTextBlock(text) {
        const content = normalizeText(text);
        if (!content) return '';
        const match = content.match(/([\u4e00-\u9fa5A-Za-z0-9·]{2,30}(公司|集团|科技|网络|信息|有限公司|股份|工作室|研究院|医院|银行|证券|基金|软件|咨询|传媒|物流|教育|医疗|数据|智能|通信|电子))/);
        return match ? match[1] : '';
    }

    async function getTabStatusMap() {
        const map = await getMeta('tabStatusMap');
        if (map && typeof map === 'object') return map;
        return {};
    }

    async function setTabStatusMap(map) {
        await setMeta('tabStatusMap', map || {});
    }

    function defaultTabStatusGuess() {
        const tab = getRecommendTab();
        return getFixedStatusForTab(tab);
    }

    function containsStatusText(text) {
        return /沟通过|已沟通|已投递|投递|面试|已面试/.test(text || '');
    }

    function findActiveStatusFromDom() {
        const candidates = [
            '.tab-item.active', '.tab-item.cur', '.tab-item.selected', '.tab-item.on',
            '.tabs .active', '.tabs .selected', '.switch-tab .active', '.switch-tab .cur',
            '.geek-tabs .active', '.geek-tabs .cur', '.segment .active', '.segment .selected',
            '.list-tab .active', '.list-tab .cur', '.nav-tab .active', '.nav-tab .cur',
            '[role="tab"][aria-selected="true"]', '[aria-selected="true"]'
        ];
        for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el) {
                const t = normalizeText(el.textContent || '');
                if (containsStatusText(t)) return t;
            }
        }

        const activeEls = Array.from(document.querySelectorAll('[class*="active"], [class*="cur"], [class*="on"], [class*="selected"]'));
        for (let i = 0; i < activeEls.length && i < 200; i += 1) {
            const t = normalizeText(activeEls[i].textContent || '');
            if (containsStatusText(t)) return t;
        }

        const statusEls = Array.from(document.querySelectorAll('a, li, span, button'));
        for (let i = 0; i < statusEls.length && i < 400; i += 1) {
            const el = statusEls[i];
            const t = normalizeText(el.textContent || '');
            if (!containsStatusText(t)) continue;
            const activeParent = el.closest('.active, .cur, .on, .selected, [aria-selected="true"]');
            if (activeParent) return t;
        }

        return '';
    }

    function getPageStatusHint() {
        let text = '';
        let source = 'dom';
        const tabKey = getTabKey();
        if (tabKey && state.tabStatusMap && state.tabStatusMap[tabKey]) {
            text = state.tabStatusMap[tabKey];
            source = 'map';
        } else if (isTargetRecommendTabPage()) {
            const fixed = getFixedStatusForTab(getRecommendTab());
            if (fixed) {
                text = fixed;
                source = 'fixed';
            }
        }
        if (!containsStatusText(text)) {
            const domText = findActiveStatusFromDom();
            if (containsStatusText(domText)) {
                text = domText;
                source = 'dom';
            } else {
                const guess = defaultTabStatusGuess();
                if (guess) {
                    text = guess;
                    source = 'guess';
                }
            }
        }
        text = normalizeStatusLabel(text);
        const flags = deriveFlags(text, null);
        return { statusText: text, flags, source };
    }

    function parseBoolean(value) {
        if (value === true) return true;
        if (value === false) return false;
        if (typeof value === 'number') return value > 0;
        if (typeof value === 'string') {
            const trimmed = value.trim().toLowerCase();
            return trimmed === 'true' || trimmed === '1' || trimmed === 'yes' || trimmed === 'y';
        }
        return false;
    }

    function deriveFlags(text, raw) {
        const normalized = text || '';
        const flags = {
            communicated: /已沟通|沟通中|沟通过/.test(normalized),
            delivered: /已投递|已申请|已发送|已投简历|已投|已投递简历/.test(normalized),
            interviewed: /已面试|面试中|已约面|约面|待面试/.test(normalized)
        };

        if (raw) {
            const val = (v) => {
                if (v === true) return true;
                if (typeof v === 'number') return v > 0;
                if (typeof v === 'string') {
                    const trimmed = v.trim().toLowerCase();
                    if (trimmed === 'true' || trimmed === 'yes' || trimmed === 'y') return true;
                    if (/^\d+$/.test(trimmed)) return Number(trimmed) > 0;
                }
                return false;
            };
            if (val(raw.interviewStatus) || val(raw.interview_status) || val(raw.hasInterview) || val(raw.interviewed) || val(raw.isInterview) || val(raw.interviewFlag)) {
                flags.interviewed = true;
            }
            if (val(raw.communicationStatus) || val(raw.communicateStatus) || val(raw.communicate_status) || val(raw.hasCommunicated) || val(raw.communicated) || val(raw.chatStatus) || val(raw.imStatus) || val(raw.isChat)) {
                flags.communicated = true;
            }
            if (val(raw.deliverStatus) || val(raw.applyStatus) || val(raw.deliveryStatus) || val(raw.hasDeliver) || val(raw.hasDelivery) || val(raw.delivered) || val(raw.isDeliver) || val(raw.apply) || val(raw.applied)) {
                flags.delivered = true;
            }
        }

        return flags;
    }

    function statusRank(flags) {
        if (flags.interviewed) return 3;
        if (flags.delivered) return 2;
        if (flags.communicated) return 1;
        return 0;
    }

    function buildStatusText(flags, fallback) {
        if (flags.interviewed) return '已面试';
        if (flags.delivered) return '已投递';
        if (flags.communicated) return '已沟通';
        return fallback || '';
    }

    async function deleteRecordById(id) {
        if (!id) return;
        await withStore(STORE_RECORDS, 'readwrite', (store) => {
            store.delete(id);
        });
    }

    function buildCompanyBlacklistId(accountKey, companyKey) {
        return [accountKey, 'companyBlacklist', companyKey || 'unknown'].join('|');
    }

    function buildBossBlacklistId(accountKey, companyKey, bossKey) {
        return [accountKey, 'bossBlacklist', companyKey || 'unknown', bossKey || 'unknown'].join('|');
    }

    async function deleteBlacklistById(storeName, id) {
        if (!id) return;
        await withStore(storeName, 'readwrite', (store) => {
            store.delete(id);
        });
    }

    async function clearStoreByAccount(storeName, accountKey) {
        const records = await listStoreByAccount(storeName, accountKey);
        await withStore(storeName, 'readwrite', (store) => {
            records.forEach((record) => store.delete(record.id));
        });
        return records.length;
    }

    function getDataViewLabel(view) {
        if (view === 'companyBlacklist') return '屏蔽公司';
        if (view === 'bossBlacklist') return '拉黑Boss';
        return '投递记录';
    }

    function buildRecordId(accountKey, scope, companyId, jobId) {
        return [accountKey, scope || 'company', companyId || 'unknown', jobId || 'none'].join('|');
    }

    function pickFirst(obj, keys) {
        for (const key of keys) {
            if (obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null) {
                return obj[key];
            }
        }
        return undefined;
    }

    function sanitizeString(value) {
        if (value === undefined || value === null) return '';
        return String(value).trim();
    }

    function sanitizeFilenamePart(value) {
        return String(value || '')
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, '')
            .slice(0, 40) || 'account';
    }

    function initEdgeResize(panel) {
        if (!panel || panel.__bossProgressResize) return;
        const EDGE = 6;
        const minWidth = 300;
        const minHeight = 260;
        let resizing = false;
        let dir = null;
        let startX = 0;
        let startY = 0;
        let startRect = null;

        const getDir = (event) => {
            const rect = panel.getBoundingClientRect();
            const left = event.clientX - rect.left;
            const right = rect.right - event.clientX;
            const top = event.clientY - rect.top;
            const bottom = rect.bottom - event.clientY;
            const onLeft = left >= 0 && left <= EDGE;
            const onRight = right >= 0 && right <= EDGE;
            const onTop = top >= 0 && top <= EDGE;
            const onBottom = bottom >= 0 && bottom <= EDGE;
            if (!(onLeft || onRight || onTop || onBottom)) return null;
            return { left: onLeft, right: onRight, top: onTop, bottom: onBottom };
        };

        const cursorForDir = (d) => {
            if (!d) return '';
            if ((d.left && d.top) || (d.right && d.bottom)) return 'nwse-resize';
            if ((d.right && d.top) || (d.left && d.bottom)) return 'nesw-resize';
            if (d.left || d.right) return 'ew-resize';
            if (d.top || d.bottom) return 'ns-resize';
            return '';
        };

        const onMouseMove = (event) => {
            if (resizing) return;
            const nextDir = getDir(event);
            panel.style.cursor = cursorForDir(nextDir);
        };

        const onMouseLeave = () => {
            if (!resizing) panel.style.cursor = '';
        };

        const onMouseDown = (event) => {
            if (event.button !== 0) return;
            const nextDir = getDir(event);
            if (!nextDir) return;
            event.preventDefault();
            event.stopPropagation();
            resizing = true;
            dir = nextDir;
            startX = event.clientX;
            startY = event.clientY;
            startRect = panel.getBoundingClientRect();
            panel.style.left = `${startRect.left}px`;
            panel.style.top = `${startRect.top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.width = `${startRect.width}px`;
            panel.style.height = `${startRect.height}px`;

            const onMove = (moveEvent) => {
                const dx = moveEvent.clientX - startX;
                const dy = moveEvent.clientY - startY;
                const maxWidth = Math.floor(window.innerWidth * 0.9);
                const maxHeight = Math.floor(window.innerHeight * 0.9);
                let newWidth = startRect.width;
                let newHeight = startRect.height;
                let newLeft = startRect.left;
                let newTop = startRect.top;

                if (dir.right) {
                    newWidth = Math.min(Math.max(startRect.width + dx, minWidth), maxWidth);
                }
                if (dir.left) {
                    newWidth = Math.min(Math.max(startRect.width - dx, minWidth), maxWidth);
                    newLeft = startRect.right - newWidth;
                }
                if (dir.bottom) {
                    newHeight = Math.min(Math.max(startRect.height + dy, minHeight), maxHeight);
                }
                if (dir.top) {
                    newHeight = Math.min(Math.max(startRect.height - dy, minHeight), maxHeight);
                    newTop = startRect.bottom - newHeight;
                }

                panel.style.width = `${newWidth}px`;
                panel.style.height = `${newHeight}px`;
                panel.style.left = `${newLeft}px`;
                panel.style.top = `${newTop}px`;
            };

            const onUp = () => {
                resizing = false;
                dir = null;
                panel.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        panel.addEventListener('mousemove', onMouseMove);
        panel.addEventListener('mouseleave', onMouseLeave);
        panel.addEventListener('mousedown', onMouseDown);
        panel.__bossProgressResize = true;
    }

    function initPanelDrag(panel) {
        if (!panel || panel.__bossProgressDrag) return;
        const header = panel.querySelector('.bp-header');
        if (!header) return;
        header.style.cursor = 'move';
        header.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            if (event.target && event.target.closest('.bp-toggle')) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = panel.getBoundingClientRect();
            const startX = event.clientX;
            const startY = event.clientY;
            const offsetX = startX - rect.left;
            const offsetY = startY - rect.top;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            const onMove = (moveEvent) => {
                const nextLeft = Math.min(Math.max(moveEvent.clientX - offsetX, 0), window.innerWidth - 50);
                const nextTop = Math.min(Math.max(moveEvent.clientY - offsetY, 0), window.innerHeight - 50);
                panel.style.left = `${nextLeft}px`;
                panel.style.top = `${nextTop}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        panel.__bossProgressDrag = true;
    }

    function formatTimestampForFilename(date) {
        const pad = (num) => String(num).padStart(2, '0');
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate())
        ].join('') + '-' + [
            pad(date.getHours()),
            pad(date.getMinutes()),
            pad(date.getSeconds())
        ].join('');
    }

    function formatAccountLabel(record) {
        if (!record) return '';
        const label = sanitizeString(record.accountLabel || '');
        if (label) return label;
        const key = sanitizeString(record.accountKey || '');
        return key || '';
    }

    function formatStatusWithScope(record, companyOnly) {
        if (!record) return '';
        const status = sanitizeString(record.statusText || '');
        if (!status) return '';
        return companyOnly ? `公司${status}` : status;
    }

    function formatStatusAccount(status, accountLabel) {
        if (!status) return '';
        const label = sanitizeString(accountLabel || '');
        return label ? `${status} ${label}` : status;
    }

    function getStatusClass(statusText) {
        const text = statusText || '';
        if (/面试/.test(text)) return 'bp-status-interviewed';
        if (/投递|申请|投/.test(text)) return 'bp-status-delivered';
        if (/沟通/.test(text)) return 'bp-status-communicated';
        if (/收藏|感兴趣/.test(text)) return 'bp-status-favorite';
        return 'bp-status-unknown';
    }

    function shouldShowChatStatus(record) {
        if (!record) return false;
        const flags = record.flags || {};
        if (flags.interviewed || flags.delivered) return true;
        return /已投递|已面试/.test(record.statusText || '');
    }

    function formatCompanyJobList(jobNames, inlineLimit) {
        const unique = Array.from(new Set((jobNames || []).filter(Boolean)));
        if (!unique.length) return { inline: '', full: '' };
        const full = unique.join('、');
        if (inlineLimit && unique.length > inlineLimit) {
            return { inline: `${unique.slice(0, inlineLimit).join('、')}等${unique.length}个`, full };
        }
        return { inline: full, full };
    }

    function formatJobListForTitle(text) {
        if (!text) return '';
        return normalizeText(text).replace(/、/g, '\n');
    }

    function formatBadgeTitle(record, companyOnly, jobListText) {
        if (!record) return '';
        const lines = [];
        const firstLineParts = [];
        const account = formatAccountLabel(record);
        const status = formatStatusWithScope(record, companyOnly);
        if (account) firstLineParts.push(`账号:${account}`);
        if (status) firstLineParts.push(`状态:${status}`);
        if (record.companyName) firstLineParts.push(`公司:${record.companyName}`);
        if (firstLineParts.length) lines.push(firstLineParts.join(' | '));
        if (record.jobName) lines.push(`岗位:${record.jobName}`);
        if (companyOnly && jobListText) {
            const formatted = formatJobListForTitle(jobListText);
            lines.push(`曾投岗位:\n${formatted}`);
        }
        return lines.join('\n');
    }

    function hasAnyFlag(flags) {
        return !!(flags && (flags.communicated || flags.delivered || flags.interviewed));
    }

    function safeParseJson(text) {
        if (!text) return null;
        const trimmed = text.trim();
        if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
        try {
            return JSON.parse(trimmed);
        } catch (err) {
            return null;
        }
    }

    async function getRecordByIndex(indexName, key) {
        return withStore(STORE_RECORDS, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const index = store.index(indexName);
                const req = index.get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        });
    }

    async function listRecordsByAccount(accountKey) {
        return withStore(STORE_RECORDS, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const index = store.index('by_account');
                const req = index.openCursor(IDBKeyRange.only(accountKey));
                const results = [];
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (cursor) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        });
    }

    async function listAllRecords() {
        return withStore(STORE_RECORDS, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const req = store.openCursor();
                const results = [];
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (cursor) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        });
    }

    async function listStoreByAccount(storeName, accountKey) {
        return withStore(storeName, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const index = store.index('by_account');
                const req = index.openCursor(IDBKeyRange.only(accountKey));
                const results = [];
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (cursor) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        });
    }

    async function listAllFromStore(storeName) {
        return withStore(storeName, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const req = store.openCursor();
                const results = [];
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (cursor) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        });
    }

    async function upsertStoreRecord(storeName, record) {
        return withStore(storeName, 'readwrite', (store) => {
            store.put(record);
        });
    }

    async function getStoreRecord(storeName, id) {
        return withStore(storeName, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const req = store.get(id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        });
    }

    async function upsertRecord(record) {
        return withStore(STORE_RECORDS, 'readwrite', (store) => {
            store.put(record);
        });
    }

    async function mergeAndSaveRecord(incoming) {
        if (!incoming || !incoming.accountKey) return;
        const existing = await withStore(STORE_RECORDS, 'readonly', (store) => {
            return new Promise((resolve, reject) => {
                const req = store.get(incoming.id);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        });

        let record = incoming;
        if (existing) {
            const mergedFlags = {
                communicated: existing.flags?.communicated || incoming.flags?.communicated || false,
                delivered: existing.flags?.delivered || incoming.flags?.delivered || false,
                interviewed: existing.flags?.interviewed || incoming.flags?.interviewed || false
            };
            const existingRank = statusRank(existing.flags || {});
            const incomingRank = statusRank(incoming.flags || {});
            const statusText = incomingRank >= existingRank ? incoming.statusText : existing.statusText;
            record = {
                ...existing,
                ...incoming,
                companyName: incoming.companyName || existing.companyName,
                jobName: incoming.jobName || existing.jobName,
                hrInfo: incoming.hrInfo || existing.hrInfo,
                interviewTime: incoming.interviewTime || existing.interviewTime,
                flags: mergedFlags,
                statusText,
                updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0)
            };
        }

        record.statusText = buildStatusText(record.flags || {}, record.statusText);
        record.searchText = normalizeText(`${record.companyName || ''} ${record.jobName || ''} ${record.statusText || ''} ${record.hrInfo || ''}`);
        await upsertRecord(record);
        scheduleRefresh();
    }

    async function mergeAndSaveCompanyBlacklist(incoming) {
        if (!incoming || !incoming.accountKey || !incoming.companyName) return;
        if (!isBlacklistCompanyName(incoming.companyName)) return;
        incoming.companyKey = incoming.companyKey || normalizeKey(incoming.companyName);
        if (!incoming.companyKey) return;
        incoming.id = buildCompanyBlacklistId(incoming.accountKey, incoming.companyKey);
        const existing = await getStoreRecord(STORE_COMPANY_BLACKLIST, incoming.id);
        const existingSources = String(existing?.sourceTypes || '').split(/[、,]/).map((v) => v.trim()).filter(Boolean);
        const incomingSources = String(incoming.sourceTypes || incoming.sourceType || '').split(/[、,]/).map((v) => v.trim()).filter(Boolean);
        const hasNewSource = incomingSources.some((source) => !existingSources.includes(source));
        const sourceTypes = new Set([
            ...existingSources,
            ...incomingSources
        ]);
        const record = {
            ...existing,
            ...incoming,
            accountLabel: incoming.accountLabel || existing?.accountLabel || state.accountLabel,
            sourceTypes: Array.from(sourceTypes).join('、') || incoming.sourceType || existing?.sourceTypes || '',
            updatedAt: existing && !hasNewSource ? existing.updatedAt : (incoming.updatedAt || Date.now())
        };
        record.searchText = normalizeText(`${record.companyName || ''} ${record.sourceTypes || ''} ${record.accountLabel || ''}`);
        await upsertStoreRecord(STORE_COMPANY_BLACKLIST, record);
    }

    async function mergeAndSaveBossBlacklist(incoming) {
        if (!incoming || !incoming.accountKey || !incoming.bossName) return;
        incoming.companyKey = incoming.companyKey || normalizeKey(incoming.companyName);
        incoming.bossKey = incoming.bossKey || normalizeBossName(incoming.bossName);
        if (!incoming.bossKey) return;
        incoming.id = buildBossBlacklistId(incoming.accountKey, incoming.companyKey, incoming.bossKey);
        const existing = await getStoreRecord(STORE_BOSS_BLACKLIST, incoming.id);
        const record = {
            ...existing,
            ...incoming,
            accountLabel: incoming.accountLabel || existing?.accountLabel || state.accountLabel,
            companyName: incoming.companyName || existing?.companyName || '',
            title: incoming.title || existing?.title || '',
            updatedAt: Math.max(existing?.updatedAt || 0, incoming.updatedAt || Date.now())
        };
        record.searchText = normalizeText(`${record.bossName || ''} ${record.companyName || ''} ${record.title || ''} ${record.accountLabel || ''}`);
        await upsertStoreRecord(STORE_BOSS_BLACKLIST, record);
    }

    async function findBestRecord(accountKey, jobId, companyId) {
        if (jobId) {
            const record = await getRecordByIndex('by_job', [accountKey, jobId]);
            if (record) return record;
        }
        if (companyId) {
            const record = await getRecordByIndex('by_company', [accountKey, companyId]);
            if (record) return record;
        }
        return null;
    }

    function scheduleRefresh() {
        if (state.refreshTimer) return;
        state.refreshTimer = setTimeout(() => {
            state.refreshTimer = null;
            renderPanel();
            applyBadges();
        }, 300);
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
      <div class="bp-header">
        <div class="bp-title">BOSS记录</div>
        <button class="bp-toggle" title="收起/展开">≡</button>
      </div>
      <div class="bp-body">
        <div class="bp-account">
          <span>账号：<strong class="bp-account-label"></strong></span>
          <button class="bp-set-account">设置</button>
        </div>
        <div class="bp-view-switch">
          <button class="bp-view-btn" data-view="progress">投递</button>
          <button class="bp-view-btn" data-view="companyBlacklist">屏蔽公司</button>
          <button class="bp-view-btn" data-view="bossBlacklist">拉黑Boss</button>
        </div>
        <div class="bp-actions">
          <button class="bp-sync">同步页面</button>
          <button class="bp-export">导出CSV</button>
          <button class="bp-import">导入CSV</button>
          <button class="bp-clear">清空数据</button>
        </div>
        <div class="bp-sync-status"></div>
        <div class="bp-tab bp-progress-only">
          <div class="bp-tab-label">当前页签状态</div>
          <div class="bp-tab-buttons">
            <button class="bp-tab-btn" data-status="auto">自动</button>
            <button class="bp-tab-btn" data-status="已沟通">沟通</button>
            <button class="bp-tab-btn" data-status="已投递">投递</button>
            <button class="bp-tab-btn" data-status="已面试">面试</button>
          </div>
          <div class="bp-tab-hint"></div>
        </div>
        <div class="bp-search-wrap">
          <input class="bp-search" placeholder="搜索 公司 / 岗位 / 状态" />
          <button class="bp-search-clear" type="button" title="清空搜索" aria-label="清空搜索" hidden>×</button>
        </div>
        <div class="bp-filter bp-progress-only">
          <label>状态筛选</label>
          <div class="bp-select-combo" data-filter="status">
            <button class="bp-select-toggle bp-status-filter" type="button" aria-haspopup="listbox" aria-expanded="false">全部</button>
            <div class="bp-select-menu bp-status-menu" role="listbox" hidden></div>
          </div>
        </div>
        <div class="bp-filter bp-progress-only">
          <label>城市筛选</label>
          <div class="bp-select-combo" data-filter="city">
            <button class="bp-select-toggle bp-city-filter" type="button" aria-haspopup="listbox" aria-expanded="false">全部</button>
            <div class="bp-select-menu bp-city-menu" role="listbox" hidden></div>
          </div>
        </div>
        <div class="bp-filter">
          <label>账号筛选</label>
          <div class="bp-select-combo" data-filter="account">
            <button class="bp-select-toggle bp-account-filter" type="button" aria-haspopup="listbox" aria-expanded="false">全部</button>
            <div class="bp-select-menu bp-account-menu" role="listbox" hidden></div>
          </div>
        </div>
        <div class="bp-stats"></div>
        <div class="bp-list"></div>
      </div>
      <input class="bp-file" type="file" accept=".csv" style="display:none" />
    `;

        const style = document.createElement('style');
        style.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; bottom: 16px; width: 390px; min-width: 320px; min-height: 260px; max-width: 80vw; max-height: 80vh; resize: none !important; overflow: auto; font-size: 12px; color: #1f2d3d; z-index: 999999; border-radius: 12px; box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18); }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .bp-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: #0f172a; color: #fff; border-radius: 12px 12px 0 0; }
      #${PANEL_ID} .bp-title { font-weight: 700; letter-spacing: .2px; }
      #${PANEL_ID} .bp-toggle { background: transparent; border: none; color: #fff; cursor: pointer; font-size: 16px; }
      #${PANEL_ID} .bp-body { background: #ffffff; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; padding: 12px; }
      #${PANEL_ID} .bp-account { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #eef2f7; }
      #${PANEL_ID} .bp-account button { margin-left: 6px; }
      #${PANEL_ID} .bp-view-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 4px 0 12px; padding: 6px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 12px; }
      #${PANEL_ID} .bp-view-switch button { min-width: 0; border-color: transparent; background: transparent; }
      #${PANEL_ID} .bp-view-switch button.active { background: #0f766e; border-color: #0f766e; color: #fff; box-shadow: 0 6px 14px rgba(15, 118, 110, 0.18); }
      #${PANEL_ID} .bp-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; padding: 8px; background: #fbfdff; border: 1px solid #e6edf7; border-radius: 12px; }
      #${PANEL_ID} .bp-actions button { width: 100%; min-width: 0; }
      #${PANEL_ID} .bp-sync-status { color: #0f766e; margin: 2px 0 8px; min-height: 18px; line-height: 1.45; padding: 0 2px; }
      #${PANEL_ID} .bp-tab { margin-bottom: 10px; padding: 8px; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 10px; }
      #${PANEL_ID} .bp-tab-label { color: #64748b; margin-bottom: 4px; }
      #${PANEL_ID} .bp-tab-buttons { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-bottom: 4px; }
      #${PANEL_ID} .bp-tab-buttons button { min-width: 0; }
      #${PANEL_ID} .bp-tab-hint { color: #94a3b8; }
      #${PANEL_ID} button { border: 1px solid #cbd5f5; background: #f8fafc; padding: 7px 8px; border-radius: 7px; cursor: pointer; line-height: 1.2; }
      #${PANEL_ID} button:hover { background: #eef2ff; }
      #${PANEL_ID} .bp-search-wrap { position: relative; margin-bottom: 8px; }
      #${PANEL_ID} .bp-search { width: 100%; padding: 8px 34px 8px 8px; border: 1px solid #cbd5f5; border-radius: 8px; outline: none; }
      #${PANEL_ID} .bp-search:focus { border-color: #0f766e; box-shadow: 0 0 0 2px rgba(15, 118, 110, 0.08); }
      #${PANEL_ID} .bp-search-clear { position: absolute; top: 50%; right: 7px; transform: translateY(-50%); width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: none; border-radius: 50%; background: transparent; color: #94a3b8; font-size: 16px; line-height: 1; }
      #${PANEL_ID} .bp-search-clear:hover { background: #f1f5f9; color: #475569; }
      #${PANEL_ID} .bp-search-clear[hidden] { display: none; }
      #${PANEL_ID} .bp-filter { display: flex; align-items: center; gap: 6px; margin: 0 0 8px 0; color: #64748b; }
      #${PANEL_ID} .bp-filter label { white-space: nowrap; }
      #${PANEL_ID} .bp-select-combo { position: relative; flex: 1; min-width: 0; }
      #${PANEL_ID} .bp-select-toggle { width: 100%; min-width: 0; padding: 5px 26px 5px 8px; border: 1px solid #cbd5f5; border-radius: 7px; background: #fff; color: #1f2d3d; text-align: left; position: relative; font-size: 12px; line-height: 1.4; }
      #${PANEL_ID} .bp-select-toggle::after { content: "⌄"; position: absolute; right: 8px; top: 50%; transform: translateY(-55%); color: #64748b; font-size: 12px; }
      #${PANEL_ID} .bp-select-toggle:hover { background: #fff; border-color: #9fb2f3; }
      #${PANEL_ID} .bp-select-menu { position: absolute; z-index: 1000000; top: calc(100% + 4px); left: 0; right: 0; max-height: 190px; overflow: auto; padding: 4px; border: 1px solid #cbd5f5; border-radius: 8px; background: #fff; box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16); }
      #${PANEL_ID} .bp-select-menu[hidden] { display: none; }
      #${PANEL_ID} .bp-select-option { display: block; width: 100%; padding: 6px 8px; border: none; border-radius: 6px; background: transparent; color: #1f2d3d; text-align: left; font-size: 12px; }
      #${PANEL_ID} .bp-select-option:hover { background: #f1f5f9; }
      #${PANEL_ID} .bp-select-option.active { background: #0f766e; color: #fff; }
      #${PANEL_ID} .bp-stats { margin-bottom: 8px; color: #475569; padding: 6px 8px; background: #f8fafc; border-radius: 8px; }
      #${PANEL_ID} .bp-list { max-height: 45vh; overflow: auto; border-top: 1px dashed #e2e8f0; padding-top: 8px; }
      #${PANEL_ID} .bp-item { margin-bottom: 0; padding: 8px 0; border-bottom: 1px solid #f1f5f9; display: flex; gap: 8px; align-items: flex-start; }
      #${PANEL_ID} .bp-item:last-child { border-bottom: none; }
      #${PANEL_ID} .bp-item-main { flex: 1; min-width: 0; }
      #${PANEL_ID} .bp-item-title { font-weight: 600; }
      #${PANEL_ID} .bp-item-sub { color: #64748b; }
      #${PANEL_ID} .bp-item-delete { border: 1px solid #fecaca; background: #fff1f2; color: #b91c1c; padding: 4px 7px; border-radius: 7px; cursor: pointer; font-size: 12px; }
      #${PANEL_ID} .bp-item-delete:hover { background: #ffe4e6; }
      #${PANEL_ID}.collapsed { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible; }
      #${PANEL_ID}.collapsed .bp-body { display: none; }
      #${PANEL_ID}.collapsed .bp-header { border-radius: 12px; }
      .${BADGE_CLASS} { position: absolute; top: 8px; right: 8px; background: transparent; padding: 0; font-size: 12px; border-radius: 10px; z-index: 20; max-width: 160px; display: flex; flex-direction: column; align-items: flex-end; }
      .${BADGE_CLASS}.boss-progress-jobs-badge { top: 38px; right: 10px; max-width: 152px; pointer-events: none; }
      .${BADGE_CLASS} .bp-badge-line { display: inline-block; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; padding: 2px 6px; border-radius: 10px; line-height: 1.2; background: #f1f5f9; color: #334155; }
      .${BADGE_CLASS} .bp-badge-sub { display: inline-block; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; font-size: 11px; padding: 2px 6px; border-radius: 10px; line-height: 1.2; background: #f8fafc; color: #64748b; }
      .${BADGE_CLASS} .bp-badge-gap { height: 2px; }
      .bp-status-communicated { background: #e0f2fe; color: #0369a1; }
      .bp-status-delivered { background: #ffedd5; color: #9a3412; }
      .bp-status-interviewed { background: #dcfce7; color: #166534; }
      .bp-status-favorite { background: #f3e8ff; color: #6b21a8; }
      .bp-status-company-blacklist { background: #fee2e2; color: #991b1b; }
      .bp-status-boss-blacklist { background: #fce7f3; color: #9d174d; }
      .bp-status-unknown { background: #f1f5f9; color: #334155; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-communicated { background: #e0f2fe !important; color: #0369a1 !important; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-delivered { background: #ffedd5 !important; color: #9a3412 !important; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-interviewed { background: #dcfce7 !important; color: #166534 !important; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-favorite { background: #f3e8ff !important; color: #6b21a8 !important; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-company-blacklist { background: #fee2e2 !important; color: #991b1b !important; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-boss-blacklist { background: #fce7f3 !important; color: #9d174d !important; }
      .${BADGE_CLASS} .bp-badge-line.bp-status-unknown { background: #f1f5f9 !important; color: #334155 !important; }
      .boss-progress-has-badge::before,
      .boss-progress-has-badge::after,
      .boss-progress-has-badge .${BADGE_CLASS}::before,
      .boss-progress-has-badge .${BADGE_CLASS}::after { content: none !important; }
      .${DETAIL_BADGE_CLASS} { display: inline-block; margin-left: 8px; background: #dbeafe; color: #1d4ed8; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
      .${DETAIL_BADGE_CLASS}.bp-status-communicated { background: #e0f2fe; color: #0369a1; }
      .${DETAIL_BADGE_CLASS}.bp-status-delivered { background: #ffedd5; color: #9a3412; }
      .${DETAIL_BADGE_CLASS}.bp-status-interviewed { background: #dcfce7; color: #166534; }
      .${DETAIL_BADGE_CLASS}.bp-status-favorite { background: #f3e8ff; color: #6b21a8; }
    `;
        document.head.appendChild(style);
        document.body.appendChild(panel);

        panel.querySelector('.bp-toggle').addEventListener('click', () => {
            panel.classList.toggle('collapsed');
        });
        initEdgeResize(panel);
        initPanelDrag(panel);
        panel.querySelector('.bp-set-account').addEventListener('click', async () => {
            const label = prompt('请输入当前账号标识（用于区分来源账号）', state.accountLabel || '');
            if (label !== null) {
                await setAccountLabel(label.trim() || '未命名账号');
            }
        });
        panel.querySelectorAll('.bp-view-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.dataView = btn.dataset.view || 'progress';
                renderPanel();
            });
        });
        panel.querySelector('.bp-sync').addEventListener('click', async () => {
            try {
                if (isShieldCompanyPage()) {
                    state.dataView = 'companyBlacklist';
                    await syncShieldCompanyPage();
                    return;
                }
                if (isBossBlacklistPage()) {
                    state.dataView = 'bossBlacklist';
                    await syncBossBlacklistPage();
                    return;
                }
                if (!isTargetRecommendTabPage()) {
                    alert('投递数据仅支持在投递进度页（recommend?tab=1-4）同步；黑名单请到隐私保护页面同步。');
                    return;
                }
                state.dataView = 'progress';
                scanDom();
            } catch (err) {
                log('sync failed', err);
                state.syncStatus = '同步失败，详情看控制台';
                renderPanel();
            }
        });
        panel.querySelector('.bp-export').addEventListener('click', exportCsv);
        panel.querySelector('.bp-import').addEventListener('click', () => {
            panel.querySelector('.bp-file').click();
        });
        panel.querySelector('.bp-clear').addEventListener('click', clearCurrentData);
        panel.querySelectorAll('.bp-tab-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const status = btn.dataset.status || 'auto';
                const tabKey = getTabKey();
                if (!tabKey) {
                    alert('当前URL没有tab参数，无法绑定页签状态。');
                    return;
                }
                if (!state.tabStatusMap) state.tabStatusMap = {};
                if (status === 'auto') {
                    delete state.tabStatusMap[tabKey];
                } else {
                    state.tabStatusMap[tabKey] = status;
                }
                await setTabStatusMap(state.tabStatusMap);
                renderPanel();
                scanDom();
            });
        });
        panel.querySelector('.bp-search').addEventListener('input', (event) => {
            state.searchQuery = event.target.value.trim().toLowerCase();
            const clearBtn = panel.querySelector('.bp-search-clear');
            if (clearBtn) clearBtn.hidden = !event.target.value;
            renderPanel();
        });
        panel.querySelector('.bp-search-clear').addEventListener('click', () => {
            const searchInput = panel.querySelector('.bp-search');
            state.searchQuery = '';
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
            const clearBtn = panel.querySelector('.bp-search-clear');
            if (clearBtn) clearBtn.hidden = true;
            renderPanel();
        });
        panel.addEventListener('click', (event) => {
            const toggle = event.target.closest('.bp-select-toggle');
            const option = event.target.closest('.bp-select-option');
            const combo = event.target.closest('.bp-select-combo');
            if (toggle && combo && panel.contains(combo)) {
                const menu = combo.querySelector('.bp-select-menu');
                if (!menu) return;
                const shouldOpen = menu.hidden;
                closeFilterMenus(panel, menu);
                menu.hidden = !shouldOpen;
                toggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
                return;
            }
            if (option && combo && panel.contains(combo)) {
                const value = option.dataset.value || 'all';
                const filter = combo.dataset.filter || '';
                if (filter === 'status') state.statusFilter = value;
                if (filter === 'city') state.cityFilter = value;
                if (filter === 'account') state.accountFilter = value;
                closeFilterMenus(panel);
                renderPanel();
                return;
            }
            if (!combo) closeFilterMenus(panel);
        });
        document.addEventListener('click', (event) => {
            if (panel.contains(event.target)) return;
            closeFilterMenus(panel);
        });
        panel.querySelector('.bp-file').addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                importCsv(file);
            }
            event.target.value = '';
        });
    }

    function closeFilterMenus(panel, exceptMenu) {
        if (!panel) return;
        panel.querySelectorAll('.bp-select-combo').forEach((combo) => {
            const menu = combo.querySelector('.bp-select-menu');
            const toggle = combo.querySelector('.bp-select-toggle');
            if (!menu || menu === exceptMenu) return;
            menu.hidden = true;
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
    }

    function renderFilterOptions(panel, filter, values, selectedValue, getLabel) {
        const combo = panel.querySelector(`.bp-select-combo[data-filter="${filter}"]`);
        if (!combo) return;
        const toggle = combo.querySelector('.bp-select-toggle');
        const menu = combo.querySelector('.bp-select-menu');
        if (!toggle || !menu) return;
        const selected = selectedValue || 'all';
        const wasOpen = !menu.hidden;
        menu.innerHTML = '';
        values.forEach((value) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'bp-select-option';
            option.dataset.value = value;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', value === selected ? 'true' : 'false');
            option.classList.toggle('active', value === selected);
            option.textContent = getLabel(value);
            menu.appendChild(option);
        });
        toggle.textContent = getLabel(selected);
        toggle.setAttribute('aria-expanded', wasOpen ? 'true' : 'false');
        menu.hidden = !wasOpen;
    }

    function renderStatusOptions(panel) {
        const values = ['all', '已沟通', '已投递', '已面试', '已收藏'];
        renderFilterOptions(panel, 'status', values, state.statusFilter, (value) => value === 'all' ? '全部' : value);
    }

    function renderAccountOptions(panel, records) {
        const labels = Array.from(new Set(records.map((record) => formatAccountLabel(record)).filter(Boolean)));
        labels.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        if (state.accountFilter !== 'all' && !labels.includes(state.accountFilter)) {
            state.accountFilter = 'all';
        }
        renderFilterOptions(panel, 'account', ['all', ...labels], state.accountFilter, (value) => value === 'all' ? '全部' : value);
    }

    const CITY_NAME_LIST = [
        '北京', '上海', '深圳', '广州', '杭州', '南京', '苏州', '成都', '重庆', '武汉',
        '西安', '天津', '长沙', '郑州', '青岛', '厦门', '宁波', '合肥', '福州', '济南',
        '大连', '沈阳', '长春', '哈尔滨', '无锡', '常州', '南通', '佛山', '东莞', '珠海',
        '中山', '惠州', '嘉兴', '绍兴', '金华', '温州', '台州', '湖州', '扬州', '镇江',
        '泰州', '徐州', '泉州', '南昌', '石家庄', '太原', '昆明', '贵阳', '南宁', '海口',
        '兰州', '银川', '西宁', '乌鲁木齐', '呼和浩特', '拉萨', '香港', '澳门'
    ];

    function inferCityFromText(text) {
        const value = sanitizeString(text).replace(/\s+/g, '');
        if (!value) return '';
        const bracketMatch = value.match(/[【\[(（]([^】\])）]{2,16})[】\])）]/);
        if (bracketMatch) {
            const hit = CITY_NAME_LIST.find((city) => bracketMatch[1].includes(city));
            if (hit) return hit;
        }
        return CITY_NAME_LIST.find((city) => value.includes(city)) || '';
    }

    function getRecordCity(record) {
        if (!record) return '';
        return inferCityFromText(record.companyName || '') || inferCityFromText(record.jobName || '');
    }

    function renderCityOptions(panel, records) {
        const cityCounts = new Map();
        records.forEach((record) => {
            const city = getRecordCity(record);
            if (!city) return;
            cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
        });
        const cities = Array.from(cityCounts.keys()).sort((a, b) => {
            const countDiff = (cityCounts.get(b) || 0) - (cityCounts.get(a) || 0);
            if (countDiff !== 0) return countDiff;
            return a.localeCompare(b, 'zh-Hans-CN');
        });
        if (state.cityFilter !== 'all' && !cities.includes(state.cityFilter)) {
            state.cityFilter = 'all';
        }
        renderFilterOptions(panel, 'city', ['all', ...cities], state.cityFilter, (value) => {
            return value === 'all' ? '全部' : `${value} (${cityCounts.get(value) || 0})`;
        });
        const cityToggle = panel.querySelector('.bp-select-combo[data-filter="city"] .bp-select-toggle');
        if (cityToggle) cityToggle.textContent = state.cityFilter === 'all' ? '全部' : state.cityFilter;
    }

    function renderListItems(panel, records, renderRecord, deleteRecord, sortFn) {
        const list = panel.querySelector('.bp-list');
        list.innerHTML = '';
        const sorter = sortFn || ((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const visible = records.slice().sort(sorter);
        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '暂无记录';
            empty.className = 'bp-item-sub';
            list.appendChild(empty);
            return;
        }
        for (const record of visible) {
            const item = document.createElement('div');
            item.className = 'bp-item';
            const main = document.createElement('div');
            main.className = 'bp-item-main';
            const { titleText, subText } = renderRecord(record);
            const title = document.createElement('div');
            title.className = 'bp-item-title';
            title.textContent = titleText;
            const sub = document.createElement('div');
            sub.className = 'bp-item-sub';
            sub.textContent = subText;
            main.appendChild(title);
            main.appendChild(sub);
            item.appendChild(main);
            const delBtn = document.createElement('button');
            delBtn.className = 'bp-item-delete';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', async () => {
                const ok = confirm('确认删除这条记录？');
                if (!ok) return;
                await deleteRecord(record);
                scheduleRefresh();
            });
            item.appendChild(delBtn);
            list.appendChild(item);
        }
    }

    async function renderPanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelector('.bp-account-label').textContent = state.accountLabel || '未命名账号';
        panel.querySelector('.bp-sync-status').textContent = state.syncStatus || '';
        const clearBtn = panel.querySelector('.bp-clear');
        if (clearBtn) clearBtn.textContent = `清空${getDataViewLabel(state.dataView)}`;
        const searchInput = panel.querySelector('.bp-search');
        if (searchInput) {
            searchInput.placeholder = state.dataView === 'bossBlacklist'
                ? '搜索 Boss / 公司 / 职位'
                : state.dataView === 'companyBlacklist'
                    ? '搜索 公司 / 来源'
                    : '搜索 公司 / 岗位 / 状态';
        }
        const clearSearchBtn = panel.querySelector('.bp-search-clear');
        if (clearSearchBtn && searchInput) clearSearchBtn.hidden = !searchInput.value && !state.searchQuery;
        panel.querySelectorAll('.bp-view-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.view === state.dataView);
        });
        panel.querySelectorAll('.bp-progress-only').forEach((el) => {
            el.style.display = state.dataView === 'progress' ? '' : 'none';
        });

        const tabHintEl = panel.querySelector('.bp-tab-hint');
        if (tabHintEl) {
            const pageHint = getPageStatusHint();
            const tabKey = getTabKey();
            const mapStatus = tabKey && state.tabStatusMap ? state.tabStatusMap[tabKey] : '';
            const sourceLabel = pageHint.source === 'dom'
                ? '页面'
                : pageHint.source === 'map'
                    ? '手动'
                    : pageHint.source === 'fixed'
                        ? '固定映射'
                        : pageHint.source === 'guess'
                            ? 'URL推测'
                            : '未知';
            const statusLabel = pageHint.statusText || '无';
            const mapLabel = mapStatus ? ` · 绑定: ${mapStatus}` : '';
            tabHintEl.textContent = `当前${getTabKeyLabel()} · 识别: ${statusLabel} (${sourceLabel})${mapLabel}`;
        }

        const storeName = state.dataView === 'companyBlacklist'
            ? STORE_COMPANY_BLACKLIST
            : state.dataView === 'bossBlacklist'
                ? STORE_BOSS_BLACKLIST
                : STORE_RECORDS;
        let records = state.dataView === 'progress'
            ? await listRecordsByAccount(state.accountKey)
            : await listStoreByAccount(storeName, state.accountKey);
        if (state.dataView === 'companyBlacklist') {
            records = records.filter((record) => isBlacklistCompanyName(record.companyName || ''));
        }
        let filtered = state.searchQuery
            ? records.filter((record) => (record.searchText || '').toLowerCase().includes(state.searchQuery))
            : records.slice();
        if (state.dataView === 'progress' && state.statusFilter && state.statusFilter !== 'all') {
            filtered = filtered.filter((record) => record.statusText === state.statusFilter);
        }
        if (state.dataView === 'progress' && state.cityFilter && state.cityFilter !== 'all') {
            filtered = filtered.filter((record) => getRecordCity(record) === state.cityFilter);
        }
        if (state.accountFilter && state.accountFilter !== 'all') {
            filtered = filtered.filter((record) => formatAccountLabel(record) === state.accountFilter);
        }
        renderStatusOptions(panel);
        renderAccountOptions(panel, records);
        renderCityOptions(panel, records);

        const stats = panel.querySelector('.bp-stats');
        if (state.dataView === 'companyBlacklist') {
            const manual = records.filter((r) => /手动屏蔽/.test(r.sourceTypes || '')).length;
            const auto = records.filter((r) => /简历自动屏蔽/.test(r.sourceTypes || '')).length;
            const smart = records.filter((r) => /智能屏蔽/.test(r.sourceTypes || '')).length;
            stats.textContent = `屏蔽公司 ${records.length} · 手动 ${manual} · 自动 ${auto} · 智能 ${smart}`;
            renderListItems(panel, filtered, (record) => ({
                titleText: record.companyName || '未知公司',
                subText: `账号:${formatAccountLabel(record)} · ${record.sourceTypes || '屏蔽公司'}`
            }), (record) => deleteBlacklistById(STORE_COMPANY_BLACKLIST, record.id), (a, b) => {
                const sourceCompare = String(a.sourceTypes || '').localeCompare(String(b.sourceTypes || ''), 'zh-Hans-CN');
                if (sourceCompare !== 0) return sourceCompare;
                return String(a.companyName || '').localeCompare(String(b.companyName || ''), 'zh-Hans-CN');
            });
            return;
        }

        if (state.dataView === 'bossBlacklist') {
            stats.textContent = `拉黑Boss ${records.length}`;
            renderListItems(panel, filtered, (record) => ({
                titleText: `${record.bossName || '未知Boss'}${record.companyName ? ' · ' + record.companyName : ''}`,
                subText: `账号:${formatAccountLabel(record)}${record.title ? ' · ' + record.title : ''}`
            }), (record) => deleteBlacklistById(STORE_BOSS_BLACKLIST, record.id));
            return;
        }

        const total = records.length;
        const communicated = records.filter((r) => r.statusText === '已沟通').length;
        const delivered = records.filter((r) => r.statusText === '已投递').length;
        const interviewed = records.filter((r) => r.statusText === '已面试').length;
        stats.textContent = `总计 ${total} · 已沟通 ${communicated} · 已投递 ${delivered} · 已面试 ${interviewed}`;
        renderListItems(panel, filtered, (record) => {
            const accountLabel = formatAccountLabel(record);
            const accountInfo = accountLabel ? `账号:${accountLabel} · ` : '';
            const hrLabel = record.hrInfo ? ` · HR:${record.hrInfo}` : '';
            const interviewLabel = record.interviewTime ? ` · 面试:${record.interviewTime}` : '';
            return {
                titleText: `${record.companyName || '未知公司'}${record.jobName ? ' · ' + record.jobName : ''}`,
                subText: `${accountInfo}${record.statusText || '无状态'} · ${record.scope === 'job' ? '岗位记录' : '公司记录'}${hrLabel}${interviewLabel}`
            };
        }, (record) => deleteRecordById(record.id));
    }

    function parseHrefIds(href) {
        if (!href) return {};
        let jobId = '';
        let companyId = '';
        const jobMatch = href.match(/job_detail\/([^.?/]+)/i) || href.match(/job\/(\d+)/i) || href.match(/jobId=([^&]+)/i);
        if (jobMatch) jobId = jobMatch[1];
        const companyMatch = href.match(/gongsi\/(\d+)/i) || href.match(/company\/(\d+)/i) || href.match(/companyId=([^&]+)/i);
        if (companyMatch) companyId = companyMatch[1];
        return { jobId, companyId };
    }

    function extractStatusFromNode(root) {
        if (!root) return { statusText: '', flags: deriveFlags('', null) };
        const tags = root.querySelectorAll('span, em, strong, b, i, .tag, .label, .status, .job-status');
        const hits = [];
        tags.forEach((el) => {
            const text = normalizeText(el.textContent);
            const title = normalizeText(el.getAttribute('title') || '');
            if (/沟通|投递|面试|申请|约面/.test(text)) hits.push(text);
            if (/沟通|投递|面试|申请|约面/.test(title)) hits.push(title);
        });
        const joined = hits.join(' ');
        const flags = deriveFlags(joined, null);
        return { statusText: joined, flags };
    }

    function extractStatusFromDataset(dataset) {
        if (!dataset) return { statusText: '', flags: deriveFlags('', null) };
        const hits = [];
        for (const [key, value] of Object.entries(dataset)) {
            if (!value) continue;
            if (/status|deliver|apply|communicate|interview|chat/i.test(key)) {
                hits.push(String(value));
            }
        }
        const joined = normalizeText(hits.join(' '));
        const flags = deriveFlags(joined, dataset);
        return { statusText: joined, flags };
    }

    function extractHrFromNode(card) {
        if (!card) return '';
        const candidates = [];
        card.querySelectorAll('span, em, strong, b, i, div, p').forEach((el) => {
            const text = normalizeText(el.textContent || '');
            if (!text || text.length > 24) return;
            if (/HR|人事|招聘|猎头/.test(text)) candidates.push(text);
        });
        return candidates[0] || '';
    }

    function extractInterviewTimeFromNode(card) {
        if (!card) return '';
        const container = card.closest('li') || card;
        const nodes = container.querySelectorAll('span, em, div, p');
        for (const el of nodes) {
            const text = normalizeText(el.textContent || '');
            if (!text) continue;
            if (!/面试|约面|面谈/.test(text)) continue;
            const match = text.match(/(\d{4}[./-]\d{1,2}[./-]\d{1,2}[^\s]*)|(\d{1,2}月\d{1,2}日[^\\s]*)/);
            if (match) return match[0];
        }
        return '';
    }

    function extractJobCompanyText(card) {
        if (!card || isInIgnoredArea(card)) return { jobName: '', companyName: '' };
        const jobLink = card.querySelector('a[href*="job_detail"], a[href*="/web/geek/job"], a[href*="job?"], a[href*="job/"]');
        const companyLink = card.querySelector('a[href*="gongsi"], a[href*="company"]');
        let jobName = pickText(card, ['.job-name', '.job-title', '.job-name span', '.job-title span', '.job-card-header .title', '.job-primary .job-name', '.job-primary .job-title', '.job-info .job-name', '.job-info .job-title', '.name', '.title', 'h3', 'h2']);
        if (!isLikelyJobName(jobName)) {
            const altJob = pickJobNameFromText(card);
            if (isLikelyJobName(altJob)) jobName = altJob;
        }
        if (!isLikelyJobName(jobName) && jobLink) {
            const linkTitle = normalizeText(jobLink.getAttribute('title') || jobLink.textContent || '');
            if (isLikelyJobName(linkTitle)) jobName = linkTitle;
        }
        if (!isLikelyJobName(jobName)) jobName = '';

        let companyName = pickCompanyCandidate(pickText(card, ['.company-name', '.company-info .name', '.company-title', '.job-card-company', '.company-info a', '.company-name a', '.company', '.company-info', '.job-company', '.job-primary .company-name', '.job-primary .company-info', '.company-text']), jobName);
        if (!companyName) {
            const fallback = pickText(card, ['.company-info', '.company', '.job-company', '.job-card-company']);
            companyName = pickCompanyCandidate(fallback, jobName);
        }
        if (!companyName && companyLink) {
            const linkText = normalizeText(companyLink.textContent || '');
            companyName = pickCompanyCandidate(linkText, jobName);
        }
        if (!companyName) {
            const logo = card.querySelector('img[alt]');
            const logoAlt = logo ? normalizeText(logo.getAttribute('alt') || '') : '';
            companyName = pickCompanyCandidate(logoAlt, jobName);
        }
        if (!companyName) {
            const candidates = card.querySelectorAll('[class*="company"], [class*="brand"]');
            for (const el of candidates) {
                const text = normalizeText(el.textContent || '');
                const candidate = pickCompanyCandidate(text, jobName);
                if (candidate) {
                    companyName = candidate;
                    break;
                }
            }
        }
        if (!companyName) {
            const blockCompany = pickCompanyFromTextBlock(card.textContent || '');
            companyName = pickCompanyCandidate(blockCompany, jobName);
        }
        if (!companyName) {
            const mixed = cleanCompanyNameFromMix(card.textContent || '', jobName);
            companyName = pickCompanyCandidate(mixed, jobName);
        }
        if (!companyName) companyName = '';
        return { jobName, companyName };
    }

    function collectChatCandidates() {
        const cards = new Set();
        const selectors = [
            '.chat-list li', '.chat-item', '.chat-card', '.message-item', '.dialog-item',
            '.geek-item', '.im-item', '.list-item', '.chat-list-item', '.im-list li',
            '.im-list-item', '.conversation-item', '.conversation-list li', '.contact-item',
            '.chat-list .item', '.dialog-list li', '.dialog-item', '.msg-item',
            '.friend-content-warp', '.friend-content', '.friend-top', 'li[data-v-2e8b9a7b]'
        ];
        document.querySelectorAll(selectors.join(',')).forEach((el) => {
            if (isInIgnoredArea(el)) return;
            const card = el.closest('li[data-v-2e8b9a7b], li') || el;
            if (!isInIgnoredArea(card)) cards.add(card);
        });
        document.querySelectorAll('a[href*="gongsi"], a[href*="company"]').forEach((link) => {
            if (isInIgnoredArea(link)) return;
            const card = link.closest('li, .chat-item, .chat-card, .dialog-item, .geek-item, .im-item, .list-item, .chat-list-item');
            if (card && !isInIgnoredArea(card)) cards.add(card);
        });
        return cards;
    }

    function pickText(root, selectors) {
        for (const sel of selectors) {
            const el = root.querySelector(sel);
            if (el) {
                const text = normalizeText(el.textContent);
                if (text) return text;
            }
        }
        return '';
    }

    function extractRecordFromCard(card, pageHint, options) {
        if (!card || isInIgnoredArea(card)) return null;
        const link = card.querySelector('a[href*="job_detail"], a[href*="/web/geek/job"], a[href*="job?"], a[href*="job/"]');
        const href = link ? link.getAttribute('href') : '';
        const idsFromHref = parseHrefIds(href || '');
        const idContainer = card.closest('[data-jobid], [data-job-id], [data-jid], [data-positionid], [data-position-id], [data-jobencryptid], [data-companyid], [data-company-id], [data-brandid], [data-brand-id], [data-bizid], [data-bossid], [data-company-encrypt-id]') || card;
        const datasetJobId = pickDatasetValue(idContainer, ['jobid', 'jobId', 'jid', 'positionid', 'positionId', 'jobEncryptId', 'encryptJobId']);
        const datasetCompanyId = pickDatasetValue(idContainer, ['companyid', 'companyId', 'brandId', 'brandid', 'bizId', 'bossId', 'companyEncryptId', 'brandEncryptId']);
        const attrJobId = findNestedDataAttribute(idContainer, ['data-jobid', 'data-job-id', 'data-jid', 'data-positionid', 'data-position-id', 'data-jobencryptid', 'data-job-encrypt-id']);
        const attrCompanyId = findNestedDataAttribute(idContainer, ['data-companyid', 'data-company-id', 'data-brandid', 'data-brand-id', 'data-bizid', 'data-bossid', 'data-company-encrypt-id']);
        let jobId = idsFromHref.jobId || datasetJobId || attrJobId;
        let companyId = idsFromHref.companyId || datasetCompanyId || attrCompanyId;

        let jobName = pickText(card, ['.job-name', '.job-title', '.job-name span', '.job-title span', '.job-card-header .title', '.name', '.title', 'h3', 'h2']);
        if (!isLikelyJobName(jobName)) {
            const altJob = pickJobNameFromText(card);
            if (isLikelyJobName(altJob)) jobName = altJob;
        }
        if (!isLikelyJobName(jobName) && link) {
            const linkTitle = normalizeText(link.getAttribute('title') || link.textContent || '');
            if (isLikelyJobName(linkTitle)) jobName = linkTitle;
        }
        if (!isLikelyJobName(jobName)) jobName = '';

        let companyName = pickCompanyCandidate(pickText(card, ['.company-name', '.company-info .name', '.company-title', '.job-card-company', '.company-info a', '.company-name a', '.company', '.company-info', '.job-company']), jobName);
        if (!companyName) {
            const fallback = pickText(card, ['.company-info', '.company', '.job-company', '.job-card-company']);
            companyName = pickCompanyCandidate(fallback, jobName);
        }
        if (!companyName) {
            const logo = card.querySelector('img[alt]');
            const logoAlt = logo ? normalizeText(logo.getAttribute('alt') || '') : '';
            companyName = pickCompanyCandidate(logoAlt, jobName);
        }
        if (!companyName) {
            const candidates = card.querySelectorAll('[class*="company"], [class*="brand"]');
            for (const el of candidates) {
                const text = normalizeText(el.textContent || '');
                const candidate = pickCompanyCandidate(text, jobName);
                if (candidate) {
                    companyName = candidate;
                    break;
                }
            }
        }
        if (!companyName) {
            const mixed = cleanCompanyNameFromMix(card.textContent || '', jobName);
            companyName = pickCompanyCandidate(mixed, jobName);
        }
        if (!companyName) companyName = '';

        const hrInfo = extractHrFromNode(card);
        const interviewTime = extractInterviewTimeFromNode(card);
        const hintFlags = pageHint ? pageHint.flags : {};
        let mergedFlags = { communicated: false, delivered: false, interviewed: false };
        let mergedStatusText = '';
        if (pageHint && (pageHint.source === 'fixed' || pageHint.source === 'map') && isTargetRecommendTabPage()) {
            mergedFlags = {
                communicated: !!hintFlags.communicated,
                delivered: !!hintFlags.delivered,
                interviewed: !!hintFlags.interviewed
            };
            mergedStatusText = pageHint.statusText || '';
        } else {
            const statusInfo = extractStatusFromNode(card);
            const datasetInfo = extractStatusFromDataset((idContainer && idContainer.dataset) || card.dataset || {});
            mergedFlags = {
                communicated: statusInfo.flags.communicated || datasetInfo.flags.communicated,
                delivered: statusInfo.flags.delivered || datasetInfo.flags.delivered,
                interviewed: statusInfo.flags.interviewed || datasetInfo.flags.interviewed
            };
            mergedStatusText = normalizeText(`${statusInfo.statusText || ''} ${datasetInfo.statusText || ''} ${pageHint ? pageHint.statusText : ''}`);
            mergedFlags.communicated = mergedFlags.communicated || hintFlags.communicated;
            mergedFlags.delivered = mergedFlags.delivered || hintFlags.delivered;
            mergedFlags.interviewed = mergedFlags.interviewed || hintFlags.interviewed;
        }

        if (!jobId && jobName) {
            jobId = `text_${hashString(`${jobName}|${companyName || ''}`)}`;
        }
        if (!companyId && companyName) {
            companyId = `text_${hashString(companyName)}`;
        }
        if (!jobId && !companyId) return null;

        const scope = jobName || jobId ? 'job' : 'company';
        const flags = mergedFlags;
        const requireStatus = !(options && options.allowWithoutStatus);
        if (requireStatus && !mergedStatusText && !hasAnyFlag(flags)) return null;
        return {
            accountKey: state.accountKey,
            accountLabel: state.accountLabel,
            scope,
            companyId: sanitizeString(companyId),
            companyName: sanitizeString(companyName),
            jobId: sanitizeString(jobId),
            jobName: sanitizeString(jobName),
            statusText: sanitizeString(mergedStatusText),
            hrInfo: sanitizeString(hrInfo),
            interviewTime: sanitizeString(interviewTime),
            flags,
            source: 'dom',
            updatedAt: Date.now(),
            raw: null
        };
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function setSyncStatus(text) {
        state.syncStatus = text || '';
        renderPanel();
    }

    function isBlacklistCompanyName(text) {
        const value = normalizeText(text);
        if (!value || value.length < 2 || value.length > 45) return false;
        if (/北京华品博睿网络技术有限公司|看准|BOSS直聘/.test(value)) return false;
        if (/查看|更多|解除|屏蔽|隐私|保护|搜索|添加|清空|批量|管理|列表|Boss|BOSS|无法|在线|历史|提醒|账号|筛选|同步|导出|导入|接口采集|投递进度|暂无记录|设置|违法|不良|举报|邮箱|未成年人|渠道|帮助|协议|客服/.test(value)) return false;
        if (/公司地址|地址|办公地址|所在地址|联系地址|详细地址/.test(value)) return false;
        if (/\d+号|\d+楼|\d+层|\d+室|\d+单元|\d+栋|\d+座|号院|大厦|园区|写字楼/.test(value) && !/(公司|有限公司|集团)$/.test(value)) return false;
        if (/^[a-z0-9_\-]+$/i.test(value)) return false;
        return /(公司|集团|科技|网络|信息|有限公司|股份|工作室|研究院|医院|银行|证券|基金|软件|咨询|传媒|物流|教育|医疗|数据|智能|通信|电子|互联|数科|资本|文化|电商|贸易|商务|服务|实业)/.test(value);
    }

    function getDirectText(el) {
        if (!el) return '';
        const texts = [];
        el.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) texts.push(node.textContent || '');
        });
        if (texts.join('').trim()) return normalizeText(texts.join(' '));
        if (!el.children || el.children.length === 0) return normalizeText(el.textContent || '');
        return '';
    }

    function collectCompanyNamesFromRoot(root) {
        const names = new Set();
        if (!root) return [];
        root.querySelectorAll('li, p, span, div').forEach((el) => {
            if (isInIgnoredArea(el)) return;
            if (!isVisible(el)) return;
            const text = getDirectText(el);
            if (isBlacklistCompanyName(text)) names.add(text);
        });
        return Array.from(names);
    }

    function getShieldSourceLabels() {
        return ['简历自动屏蔽', '手动屏蔽', '智能屏蔽'];
    }

    function findShieldHeadings() {
        const headings = [];
        const labels = getShieldSourceLabels();
        Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span,p')).forEach((el) => {
            if (isInIgnoredArea(el) || !isVisible(el)) return;
            const text = normalizeText(el.textContent || '');
            const label = labels.find((item) => text.includes(item));
            if (!label) return;
            const rect = el.getBoundingClientRect();
            if (rect.width > 520 || rect.height > 80) return;
            headings.push({ el, label, top: rect.top, bottom: rect.bottom });
        });
        headings.sort((a, b) => a.top - b.top);
        const unique = [];
        headings.forEach((heading) => {
            const existing = unique.find((item) => item.label === heading.label && Math.abs(item.top - heading.top) < 24);
            if (!existing) unique.push(heading);
        });
        return unique;
    }

    function findShieldSourceByY(y) {
        const ranges = buildShieldSectionRanges();
        let source = '';
        for (const range of ranges) {
            if (y > range.top && y < range.bottom) {
                source = range.label;
                break;
            }
        }
        return source;
    }

    function buildShieldSectionRanges() {
        const headings = findShieldHeadings();
        const viewMoreButtons = findViewMoreButtons()
            .map((el) => {
                const rect = el.getBoundingClientRect();
                return { el, top: rect.top, bottom: rect.bottom, source: '' };
            })
            .filter((item) => item.top > -20);

        return headings.map((heading, index) => {
            const nextHeading = headings[index + 1];
            const nextTop = nextHeading ? nextHeading.top : Number.POSITIVE_INFINITY;
            const viewMore = viewMoreButtons.find((btn) => btn.top > heading.bottom && btn.top < nextTop);
            const bottom = viewMore ? viewMore.bottom + 12 : nextTop;
            return {
                label: heading.label,
                top: heading.bottom,
                bottom
            };
        }).filter((range) => Number.isFinite(range.bottom) && range.bottom > range.top);
    }

    function collectVisibleShieldCompaniesBySource() {
        const ranges = buildShieldSectionRanges();
        const result = new Map();
        if (!ranges.length) return result;
        const candidates = [];
        document.querySelectorAll('li, p, span, div').forEach((el) => {
            if (isInIgnoredArea(el) || !isVisible(el)) return;
            const text = getDirectText(el);
            if (!isBlacklistCompanyName(text)) return;
            const rect = el.getBoundingClientRect();
            candidates.push({ text, y: rect.top + rect.height / 2 });
        });
        candidates.forEach((item) => {
            const range = ranges.find((itemRange) => item.y > itemRange.top && item.y < itemRange.bottom);
            if (!range) return;
            if (!result.has(range.label)) result.set(range.label, new Set());
            result.get(range.label).add(item.text);
        });
        return result;
    }

    function findShieldSourceBefore(el) {
        const rect = el.getBoundingClientRect();
        return findShieldSourceByY(rect.top) || '屏蔽公司';
    }

    function findShieldSourceForAction(el) {
        if (!el) return '屏蔽公司';
        const rect = el.getBoundingClientRect();
        const headings = findShieldHeadings();
        let source = '';
        for (const heading of headings) {
            if (heading.top <= rect.bottom + 24) source = heading.label;
        }
        return source || findShieldSourceBefore(el);
    }

    function getShieldActionText(el) {
        return normalizeText(el && el.textContent ? el.textContent : '');
    }

    function isShieldListActionText(text) {
        const value = normalizeText(text);
        return value.length <= 12 && /^(查看更多|批量管理)/.test(value);
    }

    function findShieldActionElement(target) {
        let el = target && target.nodeType === 1 ? target : target && target.parentElement;
        for (let i = 0; i < 6 && el; i += 1) {
            if (isVisible(el) && isShieldListActionText(getShieldActionText(el))) return el;
            el = el.parentElement;
        }
        return null;
    }

    function rememberShieldDialogSourceFromClick(target) {
        const el = findShieldActionElement(target);
        if (!el) return;
        const sourceType = findShieldSourceForAction(el);
        state.activeShieldDialogSource = sourceType;
        setSyncStatus(`等待${sourceType}列表打开...`);
        [650, 1300, 2200].forEach((delay) => setTimeout(() => scheduleScan(0), delay));
    }

    function findViewMoreButtons() {
        return Array.from(document.querySelectorAll('button,a,span,div'))
            .filter((el) => isVisible(el) && /^查看更多/.test(normalizeText(el.textContent || '')));
    }

    function findShieldListActionButtons() {
        const result = [];
        const seen = new Set();
        Array.from(document.querySelectorAll('button,a,span,div')).forEach((el) => {
            if (!isVisible(el) || !isShieldListActionText(getShieldActionText(el))) return;
            const rect = el.getBoundingClientRect();
            const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${getShieldActionText(el)}`;
            if (seen.has(key)) return;
            seen.add(key);
            result.push(el);
        });
        return result.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    }

    function isLikelyShieldDialogText(text) {
        const value = normalizeText(text);
        return value.includes('屏蔽公司列表')
            || value.includes('解除屏蔽已选公司')
            || (value.includes('解除屏蔽') && value.includes('全选'));
    }

    function expandShieldDialogRoot(el) {
        const modal = el.closest('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="pop"], [class*="Dialog"], [class*="Modal"], [class*="Pop"]');
        if (modal && isVisible(modal) && !isInIgnoredArea(modal)) return modal;
        let current = el;
        while (current && current.parentElement && current.parentElement !== document.body) {
            const parent = current.parentElement;
            if (!isVisible(parent) || isInIgnoredArea(parent)) break;
            const rect = parent.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.92 || rect.height > window.innerHeight * 0.92) break;
            if (!isLikelyShieldDialogText(parent.textContent || '')) break;
            current = parent;
        }
        return current || el;
    }

    function findShieldDialogRoot() {
        const candidates = Array.from(document.querySelectorAll('div,section'))
            .filter((el) => {
                if (!isVisible(el) || isInIgnoredArea(el)) return false;
                if (!isLikelyShieldDialogText(el.textContent || '')) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width < 280 || rect.height < 160) return false;
                if (rect.width > window.innerWidth * 0.96 || rect.height > window.innerHeight * 0.96) return false;
                return true;
            })
            .map((el) => expandShieldDialogRoot(el))
            .filter((el, index, list) => el && list.indexOf(el) === index);
        if (!candidates.length) return null;
        candidates.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (ar.width * ar.height) - (br.width * br.height);
        });
        return candidates[0];
    }

    function findScrollableContainer(root) {
        const candidates = [root, ...Array.from(root ? root.querySelectorAll('*') : [])].filter(Boolean);
        let best = null;
        for (const el of candidates) {
            if (!isVisible(el)) continue;
            if (el.scrollHeight > el.clientHeight + 40) {
                if (!best || el.scrollHeight > best.scrollHeight) best = el;
            }
        }
        return best || document.scrollingElement || document.documentElement;
    }

    async function collectWithScroll(root, collectFn, statusPrefix) {
        const container = findScrollableContainer(root);
        const collected = new Set(collectFn(root || document));
        let stable = 0;
        for (let i = 0; i < 90 && stable < 4; i += 1) {
            const before = collected.size;
            if (container) container.scrollTop = container.scrollHeight;
            await wait(450);
            collectFn(root || document).forEach((value) => collected.add(value));
            if (statusPrefix) setSyncStatus(`${statusPrefix} ${collected.size}`);
            stable = collected.size === before ? stable + 1 : 0;
        }
        return Array.from(collected);
    }

    function closeDialog(root) {
        if (!root) return;
        const close = Array.from(root.querySelectorAll('button,span,i,div'))
            .find((el) => isVisible(el) && /^(×|x|X|关闭)$/.test(normalizeText(el.textContent || el.getAttribute('aria-label') || '')));
        if (close) {
            close.click();
            return;
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    async function syncShieldCompanyPage() {
        await ensureAccount();
        const saved = new Map();
        const sourceCounts = { '简历自动屏蔽': 0, '手动屏蔽': 0, '智能屏蔽': 0, '屏蔽公司': 0 };
        const saveNames = async (names, sourceType) => {
            for (const companyName of names) {
                const companyKey = normalizeKey(companyName);
                if (!companyKey) continue;
                const key = `${companyKey}|${sourceType}`;
                if (saved.has(key)) continue;
                saved.set(key, true);
                sourceCounts[sourceType] = (sourceCounts[sourceType] || 0) + 1;
                await mergeAndSaveCompanyBlacklist({
                    accountKey: state.accountKey,
                    accountLabel: state.accountLabel,
                    companyName,
                    companyKey,
                    sourceType,
                    sourceTypes: sourceType,
                    updatedAt: Date.now()
                });
            }
        };

        setSyncStatus('正在同步屏蔽公司...');
        const visibleBySource = collectVisibleShieldCompaniesBySource();
        for (const [sourceType, names] of visibleBySource.entries()) {
            await saveNames(Array.from(names), sourceType);
        }

        const buttons = findShieldListActionButtons();
        for (const btn of buttons) {
            const sourceType = findShieldSourceForAction(btn);
            state.activeShieldDialogSource = sourceType;
            setSyncStatus(`打开${sourceType}列表...`);
            btn.click();
            await wait(900);
            const dialog = findShieldDialogRoot();
            if (!dialog) continue;
            const names = await collectWithScroll(dialog, collectCompanyNamesFromRoot, `同步${sourceType}`);
            await saveNames(names, sourceType);
            closeDialog(dialog);
            await wait(400);
        }
        setSyncStatus(`屏蔽公司同步完成：自动${sourceCounts['简历自动屏蔽'] || 0} / 手动${sourceCounts['手动屏蔽'] || 0} / 智能${sourceCounts['智能屏蔽'] || 0}`);
        renderPanel();
        applyBadges();
    }

    function findBossCardFromAction(action) {
        let node = action;
        for (let i = 0; i < 8 && node; i += 1) {
            const text = normalizeText(node.textContent || '');
            if (text.includes('解除') && text.length > 8 && text.length < 220) return node;
            node = node.parentElement;
        }
        return action.closest('li, [class*="item"], [class*="row"]') || action.parentElement;
    }

    function extractBossBlacklistFromCard(card) {
        if (!card) return null;
        const texts = Array.from(card.querySelectorAll('span,div,p'))
            .map((el) => normalizeText(el.textContent || ''))
            .filter((text) => text && text.length < 60 && !/^解除$/.test(text));
        const bossText = texts.find((text) => /先生|女士|小姐/.test(text)) || texts[0] || '';
        const bossName = extractBossName(bossText);
        const infoText = texts.find((text) => text !== bossText && /[·|｜\-]/.test(text)) || texts.find((text) => text !== bossText) || '';
        const parts = infoText.split(/[·|｜]/).map((part) => normalizeText(part)).filter(Boolean);
        const companyName = parts[0] || '';
        const title = parts.slice(1).join(' · ') || '';
        if (!bossName) return null;
        return {
            bossName,
            bossKey: normalizeBossName(bossName),
            companyName,
            companyKey: normalizeKey(companyName),
            title
        };
    }

    function collectBossBlacklistFromRoot(root) {
        const result = new Map();
        Array.from((root || document).querySelectorAll('button,a,span,div')).forEach((el) => {
            if (!isVisible(el) || normalizeText(el.textContent || '') !== '解除') return;
            const record = extractBossBlacklistFromCard(findBossCardFromAction(el));
            if (!record || !record.bossKey) return;
            result.set(`${record.companyKey}|${record.bossKey}`, record);
        });
        return Array.from(result.values());
    }

    async function syncBossBlacklistPage() {
        await ensureAccount();
        setSyncStatus('正在同步拉黑Boss...');
        const records = await collectWithScroll(document, collectBossBlacklistFromRoot, '同步拉黑Boss');
        for (const record of records) {
            await mergeAndSaveBossBlacklist({
                ...record,
                accountKey: state.accountKey,
                accountLabel: state.accountLabel,
                updatedAt: Date.now()
            });
        }
        setSyncStatus(`拉黑Boss同步完成：${records.length}`);
        renderPanel();
        applyBadges();
    }

    async function saveVisibleShieldCompanies(silent = false) {
        await ensureAccount();
        const dialog = findShieldDialogRoot();
        if (dialog) {
            const sourceType = state.activeShieldDialogSource || '屏蔽公司';
            const names = collectCompanyNamesFromRoot(dialog);
            let added = 0;
            for (const companyName of names) {
                const companyKey = normalizeKey(companyName);
                if (!companyKey) continue;
                const id = buildCompanyBlacklistId(state.accountKey, companyKey);
                const existing = await getStoreRecord(STORE_COMPANY_BLACKLIST, id);
                const hadSource = existing && String(existing.sourceTypes || '').split(/[、,]/).map((v) => v.trim()).includes(sourceType);
                await mergeAndSaveCompanyBlacklist({
                    accountKey: state.accountKey,
                    accountLabel: state.accountLabel,
                    companyName,
                    companyKey,
                    sourceType,
                    sourceTypes: sourceType,
                    updatedAt: Date.now()
                });
                if (!existing || !hadSource) added += 1;
            }
            const total = (await listStoreByAccount(STORE_COMPANY_BLACKLIST, state.accountKey)).length;
            if (names.length && !silent) state.syncStatus = `已同步${sourceType}弹窗：新增${added}，总${total}`;
            return;
        }
        const visibleBySource = collectVisibleShieldCompaniesBySource();
        let added = 0;
        let seen = 0;
        for (const [sourceType, names] of visibleBySource.entries()) {
            for (const companyName of names.values()) {
                const companyKey = normalizeKey(companyName);
                if (!companyKey) continue;
                const id = buildCompanyBlacklistId(state.accountKey, companyKey);
                const existing = await getStoreRecord(STORE_COMPANY_BLACKLIST, id);
                const hadSource = existing && String(existing.sourceTypes || '').split(/[、,]/).map((v) => v.trim()).includes(sourceType);
                await mergeAndSaveCompanyBlacklist({
                    accountKey: state.accountKey,
                    accountLabel: state.accountLabel,
                    companyName,
                    companyKey,
                    sourceType,
                    sourceTypes: sourceType,
                    updatedAt: Date.now()
                });
                seen += 1;
                if (!existing || !hadSource) added += 1;
            }
        }
        const total = (await listStoreByAccount(STORE_COMPANY_BLACKLIST, state.accountKey)).length;
        if (seen && !silent) state.syncStatus = `已同步当前可见屏蔽公司：新增${added}，总${total}`;
    }

    async function saveVisibleBossBlacklist(silent = false) {
        await ensureAccount();
        const records = collectBossBlacklistFromRoot(document);
        let added = 0;
        for (const record of records) {
            const id = buildBossBlacklistId(state.accountKey, record.companyKey, record.bossKey);
            const existing = await getStoreRecord(STORE_BOSS_BLACKLIST, id);
            await mergeAndSaveBossBlacklist({
                ...record,
                accountKey: state.accountKey,
                accountLabel: state.accountLabel,
                updatedAt: Date.now()
            });
            if (!existing) added += 1;
        }
        const total = (await listStoreByAccount(STORE_BOSS_BLACKLIST, state.accountKey)).length;
        if (records.length && !silent) state.syncStatus = `已同步当前可见拉黑Boss：新增${added}，总${total}`;
    }

    function looksLikeCard(node) {
        if (!node) return false;
        if (isInIgnoredArea(node)) return false;
        const text = normalizeText(node.textContent || '');
        if (!text || text.length < 8) return false;
        const hasSalary = /\\d+\\s*[-~]\\s*\\d+\\s*[kK千万]/.test(text);
        const hasJob = /岗位|职位|开发|工程师|产品|运营|测试|设计|市场|销售|算法|前端|后端|全栈|Java|Python|PHP|Go|C\\+\\+/.test(text);
        const hasCompany = /公司|有限公司|集团|科技|网络|股份|工作室/.test(text);
        if (hasSalary) return true;
        return hasJob && hasCompany;
    }

    function collectCardCandidates() {
        const cards = new Set();
        document.querySelectorAll('a[href*="job_detail"], a[href*="/web/geek/job"], a[href*="job?"], a[href*="job/"]').forEach((link) => {
            if (isInIgnoredArea(link)) return;
            const card = link.closest('li, .job-card-wrapper, .job-card, .job-card-box, .job-card-item, .job-card-list, .job-card-left, .job-card-body, .job-primary, .job-list-box, .job-list-card');
            if (card && !isInIgnoredArea(card)) cards.add(card);
        });
        document.querySelectorAll('[data-jobid], [data-job-id], [data-jid], [data-positionid], [data-position-id], [data-jobencryptid], [data-companyid], [data-company-id], [data-brandid], [data-brand-id]').forEach((el) => {
            if (isInIgnoredArea(el)) return;
            const card = el.closest('li, .job-card-wrapper, .job-card, .job-card-box, .job-card-item, .job-card-list, .job-card-left, .job-item, .job-list-item, .job-card-body, .job-primary, .job-list-box, .job-list-card');
            if (card && !isInIgnoredArea(card)) cards.add(card);
        });
        document.querySelectorAll('.job-item, .job-list li, .job-card, .job-card-wrapper, .job-card-box, .job-card-item, .job-primary, .job-card-body').forEach((el) => {
            if (looksLikeCard(el)) cards.add(el);
        });
        return cards;
    }

    function extractRecordsFromDom(pageHint) {
        const cards = collectCardCandidates();
        const records = [];
        cards.forEach((card) => {
            const record = extractRecordFromCard(card, pageHint, { allowWithoutStatus: false });
            if (record) records.push(record);
        });
        return records;
    }

    function scanGlobals() {
        if (!isTargetRecommendTabPage()) return;
        const candidates = ['__INITIAL_STATE__', '__INITIAL_STATE', '__NUXT__', '__APP_STATE__', '__STATE__', '__zpData__', 'zpData'];
        candidates.forEach((key) => {
            try {
                const value = window[key];
                if (!value) return;
                const records = extractRecordsFromJson(value);
                if (records.length) saveRecords(records);
            } catch (err) {
                // ignore
            }
        });
    }

    function scanEmbeddedJson() {
        if (!isTargetRecommendTabPage()) return;
        document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach((script) => {
            const text = script.textContent || '';
            const data = safeParseJson(text);
            if (!data) return;
            const records = extractRecordsFromJson(data);
            if (records.length) saveRecords(records);
        });
    }

    function collectStatusTextFromNode(node) {
        if (!node || typeof node !== 'object') return '';
        const parts = [];
        for (const [key, value] of Object.entries(node)) {
            if (typeof value !== 'string') continue;
            if (!/status|deliver|apply|communicate|interview|chat/i.test(key)) continue;
            if (/沟通|投递|面试|申请|约面/.test(value)) parts.push(value);
        }
        return normalizeText(parts.join(' '));
    }

    function extractRecordsFromJson(data) {
        const results = [];
        const queue = [{ node: data, depth: 0 }];
        const maxDepth = 8;

        while (queue.length) {
            const { node, depth } = queue.shift();
            if (!node || depth > maxDepth) continue;
            if (typeof node === 'string') {
                const parsed = safeParseJson(node);
                if (parsed) queue.push({ node: parsed, depth: depth + 1 });
                continue;
            }
            if (Array.isArray(node)) {
                for (const item of node) {
                    queue.push({ node: item, depth: depth + 1 });
                }
                continue;
            }

            if (typeof node !== 'object') continue;

            const jobId = pickFirst(node, ['jobId', 'job_id', 'positionId', 'position_id', 'jid', 'encryptJobId', 'jobEncryptId', 'jobEncryptID', 'positionEncryptId']);
            const companyId = pickFirst(node, ['companyId', 'company_id', 'brandId', 'brand_id', 'bizId', 'bossId', 'encryptBrandId', 'brandEncryptId', 'encryptCompanyId', 'companyEncryptId']);
            const jobName = pickFirst(node, ['jobName', 'positionName', 'title', 'job_title', 'jobTitle', 'position_title']);
            const companyName = pickFirst(node, ['companyName', 'brandName', 'company_name', 'brand_name', 'bizName', 'brand']);
            let statusText = pickFirst(node, [
                'statusName',
                'statusDesc',
                'status',
                'applyStatusDesc',
                'applyStatusName',
                'deliverStatusDesc',
                'deliverStatusName',
                'deliveryStatusDesc',
                'communicationStatusDesc',
                'communicateStatusDesc',
                'interviewStatusDesc',
                'interviewStatusName',
                'resumeStatusDesc'
            ]);
            const hrName = pickFirst(node, ['bossName', 'hrName', 'recruiterName', 'userName', 'hunterName', 'contactName']);
            const hrTitle = pickFirst(node, ['bossTitle', 'hrTitle', 'recruiterTitle', 'userTitle', 'hunterTitle', 'contactTitle']);
            const interviewTime = pickFirst(node, ['interviewTime', 'interviewDate', 'interviewAt', 'appointmentTime', 'appointTime', 'arrangeTime', 'scheduleTime']);
            const hrInfo = sanitizeString([hrName, hrTitle].filter(Boolean).join(' '));

            if (jobId || companyId) {
                if (!statusText) statusText = collectStatusTextFromNode(node);
                const flags = deriveFlags(String(statusText || ''), node);
                if (!statusText && !hasAnyFlag(flags)) {
                    continue;
                }
                results.push({
                    accountKey: state.accountKey,
                    accountLabel: state.accountLabel,
                    scope: jobId ? 'job' : 'company',
                    companyId: sanitizeString(companyId),
                    companyName: sanitizeString(companyName),
                    jobId: sanitizeString(jobId),
                    jobName: sanitizeString(jobName),
                    statusText: sanitizeString(statusText),
                    hrInfo,
                    interviewTime: sanitizeString(interviewTime),
                    flags,
                    source: 'api',
                    updatedAt: Date.now(),
                    raw: null
                });
            }

            for (const value of Object.values(node)) {
                if (value && typeof value === 'object') {
                    queue.push({ node: value, depth: depth + 1 });
                } else if (typeof value === 'string') {
                    const parsed = safeParseJson(value);
                    if (parsed) queue.push({ node: parsed, depth: depth + 1 });
                }
            }
        }

        return results;
    }

    async function saveRecords(records) {
        for (const record of records) {
            record.id = buildRecordId(record.accountKey, record.scope, record.companyId, record.jobId);
            await mergeAndSaveRecord(record);
        }
    }

    async function scanDom() {
        const now = Date.now();
        if (now - state.lastScanAt < 800) return;
        state.lastScanAt = now;
        if (isShieldCompanyPage()) {
            state.dataView = 'companyBlacklist';
            await saveVisibleShieldCompanies(true);
            renderPanel();
            applyBadges();
            return;
        }
        if (isBossBlacklistPage()) {
            state.dataView = 'bossBlacklist';
            await saveVisibleBossBlacklist(true);
            renderPanel();
            applyBadges();
            return;
        }
        if (!isTargetRecommendTabPage()) {
            applyBadges();
            return;
        }
        const pageHint = getPageStatusHint();
        const records = extractRecordsFromDom(pageHint);
        if (records.length) {
            saveRecords(records);
        }
        applyBadges();
    }

    function scheduleScan(delay = 180) {
        if (state.scanTimer) {
            clearTimeout(state.scanTimer);
        }
        state.scanTimer = setTimeout(() => {
            state.scanTimer = null;
            scanDom();
        }, delay);
    }

    function isInternalNode(node) {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement;
        if (!el) return false;
        if (el.id === PANEL_ID || el.closest(`#${PANEL_ID}`)) return true;
        if (el.classList && (el.classList.contains(BADGE_CLASS) || el.classList.contains(DETAIL_BADGE_CLASS))) return true;
        if (el.closest(`.${BADGE_CLASS}, .${DETAIL_BADGE_CLASS}`)) return true;
        return false;
    }

    function shouldIgnoreMutations(mutations) {
        if (!mutations || !mutations.length) return false;
        for (const mutation of mutations) {
            if (!isInternalNode(mutation.target)) return false;
            const added = Array.from(mutation.addedNodes || []);
            for (const node of added) {
                if (!isInternalNode(node)) return false;
            }
            const removed = Array.from(mutation.removedNodes || []);
            for (const node of removed) {
                if (!isInternalNode(node)) return false;
            }
        }
        return true;
    }

    function ensurePositioned(node) {
        if (!node) return;
        const style = window.getComputedStyle(node);
        if (style.position === 'static') {
            node.style.position = 'relative';
        }
    }

    function buildCompanyIndexes(records) {
        const companyIndex = new Map();
        const companyJobs = new Map();
        for (const record of records || []) {
            if (!record || !record.companyName) continue;
            const companyKey = normalizeKey(record.companyName);
            if (!companyKey) continue;
            let accountMap = companyIndex.get(companyKey);
            if (!accountMap) {
                accountMap = new Map();
                companyIndex.set(companyKey, accountMap);
            }
            const existing = accountMap.get(record.accountKey);
            if (!existing || statusRank(record.flags || {}) >= statusRank(existing.flags || {})) {
                accountMap.set(record.accountKey, record);
            }
            if (record.jobName) {
                let jobMap = companyJobs.get(companyKey);
                if (!jobMap) {
                    jobMap = new Map();
                    companyJobs.set(companyKey, jobMap);
                }
                let jobSet = jobMap.get(record.accountKey);
                if (!jobSet) {
                    jobSet = new Set();
                    jobMap.set(record.accountKey, jobSet);
                }
                jobSet.add(record.jobName);
            }
        }
        return { companyIndex, companyJobs };
    }

    function buildCompanyJobIndex(records) {
        const companyJobIndex = new Map();
        for (const record of records || []) {
            if (!record || !record.companyName || !record.jobName) continue;
            const companyKey = normalizeKey(record.companyName);
            if (!companyKey) continue;
            const jobExact = normalizeJobKey(record.jobName, false);
            const jobLoose = normalizeJobKey(record.jobName, true);
            const keys = Array.from(new Set([jobExact, jobLoose].filter(Boolean)));
            if (!keys.length) continue;
            let jobMap = companyJobIndex.get(companyKey);
            if (!jobMap) {
                jobMap = new Map();
                companyJobIndex.set(companyKey, jobMap);
            }
            keys.forEach((jobKey) => {
                let accountMap = jobMap.get(jobKey);
                if (!accountMap) {
                    accountMap = new Map();
                    jobMap.set(jobKey, accountMap);
                }
                const existing = accountMap.get(record.accountKey);
                if (!existing || statusRank(record.flags || {}) >= statusRank(existing.flags || {})) {
                    accountMap.set(record.accountKey, record);
                }
            });
        }
        return companyJobIndex;
    }

    async function buildPrivacyIndexes() {
        const companyRecords = await listAllFromStore(STORE_COMPANY_BLACKLIST);
        const bossRecords = await listAllFromStore(STORE_BOSS_BLACKLIST);
        const companyIndex = new Map();
        const bossIndex = new Map();

        for (const record of companyRecords) {
            const companyKey = record.companyKey || normalizeKey(record.companyName);
            if (!companyKey) continue;
            let accountMap = companyIndex.get(companyKey);
            if (!accountMap) {
                accountMap = new Map();
                companyIndex.set(companyKey, accountMap);
            }
            accountMap.set(record.accountKey, record);
        }

        for (const record of bossRecords) {
            const companyKey = record.companyKey || normalizeKey(record.companyName);
            const bossKey = record.bossKey || normalizeBossName(record.bossName);
            if (!companyKey || !bossKey) continue;
            let bossMap = bossIndex.get(companyKey);
            if (!bossMap) {
                bossMap = new Map();
                bossIndex.set(companyKey, bossMap);
            }
            let accountMap = bossMap.get(bossKey);
            if (!accountMap) {
                accountMap = new Map();
                bossMap.set(bossKey, accountMap);
            }
            accountMap.set(record.accountKey, record);
        }
        return { companyIndex, bossIndex };
    }

    function appendPrivacyBadgeBlocks(blocks, titleLines, companyName, hrInfo, privacyIndexes) {
        if (!privacyIndexes || !companyName) return;
        const companyKey = normalizeKey(companyName);
        if (!companyKey) return;
        const companyMap = privacyIndexes.companyIndex.get(companyKey);
        if (companyMap) {
            for (const record of companyMap.values()) {
                const accountLabel = formatAccountLabel(record);
                blocks.push({
                    lines: [
                        { text: formatStatusAccount('屏蔽公司', accountLabel), className: 'bp-badge-line bp-status-company-blacklist' },
                        { text: record.sourceTypes || '屏蔽公司', className: 'bp-badge-sub' }
                    ]
                });
                titleLines.push(`账号:${accountLabel} | 状态:屏蔽公司 | 公司:${record.companyName}\n来源:${record.sourceTypes || '屏蔽公司'}`);
            }
        }

        const bossName = extractBossName(hrInfo || '');
        const bossKey = normalizeBossName(bossName);
        if (!bossKey) return;
        const bossMap = privacyIndexes.bossIndex.get(companyKey);
        const accountMap = bossMap ? bossMap.get(bossKey) : null;
        if (!accountMap) return;
        for (const record of accountMap.values()) {
            const accountLabel = formatAccountLabel(record);
            blocks.push({
                lines: [
                    { text: formatStatusAccount('拉黑Boss', accountLabel), className: 'bp-badge-line bp-status-boss-blacklist' },
                    { text: record.bossName || bossName, className: 'bp-badge-sub' }
                ]
            });
            titleLines.push(`账号:${accountLabel} | 状态:拉黑Boss | 公司:${record.companyName || companyName}\nBoss:${record.bossName || bossName}${record.title ? '\n职位:' + record.title : ''}`);
        }
    }

    function getCompanyJobs(companyJobs, companyKey, accountKey) {
        if (!companyJobs || !companyKey) return [];
        const map = companyJobs.get(companyKey);
        if (!map) return [];
        const set = map.get(accountKey);
        return set ? Array.from(set.values()) : [];
    }

    function renderBadgeBlocks(badge, blocks, titleLines) {
        const parent = badge.parentElement;
        if (parent) {
            parent.classList.add('boss-progress-has-badge');
        }
        badge.textContent = '';
        blocks.forEach((block, blockIndex) => {
            (block.lines || []).forEach((line) => {
                const div = document.createElement('div');
                div.className = line.className || 'bp-badge-line';
                div.textContent = line.text;
                badge.appendChild(div);
            });
            if (blockIndex < blocks.length - 1) {
                const gap = document.createElement('div');
                gap.className = 'bp-badge-gap';
                badge.appendChild(gap);
            }
        });
        if (titleLines && titleLines.length) {
            badge.title = titleLines.join('\n');
        }
    }

    function renderCompanyJobsInline(jobNames, limit) {
        const unique = Array.from(new Set((jobNames || []).filter(Boolean)));
        if (!unique.length) return '';
        if (limit && unique.length > limit) {
            return `${unique[0]}等${unique.length}个`;
        }
        return unique[0];
    }

    async function applyBadgesForJobsPage() {
        const records = await listAllRecords();
        const { companyIndex, companyJobs } = buildCompanyIndexes(records);
        const privacyIndexes = await buildPrivacyIndexes();
        const index = new Map();
        const byCompany = new Map();
        const upsert = (key, record) => {
            if (!key || !record) return;
            let accountMap = index.get(key);
            if (!accountMap) {
                accountMap = new Map();
                index.set(key, accountMap);
            }
            const existing = accountMap.get(record.accountKey);
            if (!existing || statusRank(record.flags || {}) >= statusRank(existing.flags || {})) {
                accountMap.set(record.accountKey, record);
            }
        };
        for (const record of records) {
            if (!record.companyName) continue;
            const exactKey = buildTextKey(record.companyName, record.jobName, false);
            const looseKey = buildTextKey(record.companyName, record.jobName, true);
            const companyKey = normalizeKey(record.companyName);
            const jobExact = normalizeJobKey(record.jobName, false);
            const jobLoose = normalizeJobKey(record.jobName, true);
            if (record.jobName) {
                upsert(exactKey, record);
                upsert(looseKey, record);
            }
            if (companyKey && (jobExact || jobLoose)) {
                if (!byCompany.has(companyKey)) byCompany.set(companyKey, []);
                byCompany.get(companyKey).push({
                    record,
                    jobExact,
                    jobLoose
                });
            }
        }
        if (!index.size && !byCompany.size && !companyIndex.size && !privacyIndexes.companyIndex.size && !privacyIndexes.bossIndex.size) return;
        const cards = collectCardCandidates();
        for (const card of cards) {
            if (!card || isInIgnoredArea(card)) continue;
            const { jobName, companyName } = extractJobCompanyText(card);
            const exactKey = buildTextKey(companyName, jobName, false);
            const looseKey = buildTextKey(companyName, jobName, true);
            const jobMatchesByAccount = new Map();
            if (exactKey && index.has(exactKey)) {
                for (const record of index.get(exactKey).values()) {
                    jobMatchesByAccount.set(record.accountKey, record);
                }
            } else if (looseKey && index.has(looseKey)) {
                for (const record of index.get(looseKey).values()) {
                    jobMatchesByAccount.set(record.accountKey, record);
                }
            } else {
                const companyKey = normalizeKey(companyName);
                const candidates = companyKey ? (byCompany.get(companyKey) || []) : [];
                const jobExact = normalizeJobKey(jobName, false);
                const jobLoose = normalizeJobKey(jobName, true);
                for (const item of candidates) {
                    if (!item || !item.record) continue;
                    let hit = false;
                    if (jobExact && item.jobExact && (jobExact.includes(item.jobExact) || item.jobExact.includes(jobExact))) {
                        hit = true;
                    } else if (jobLoose && item.jobLoose && (jobLoose.includes(item.jobLoose) || item.jobLoose.includes(jobLoose))) {
                        hit = true;
                    }
                    if (!hit) continue;
                    const existing = jobMatchesByAccount.get(item.record.accountKey);
                    if (!existing || statusRank(item.record.flags || {}) >= statusRank(existing.flags || {})) {
                        jobMatchesByAccount.set(item.record.accountKey, item.record);
                    }
                }
            }

            const companyMatchesByAccount = new Map();
            const companyKey = normalizeKey(companyName);
            if (companyKey && companyIndex.has(companyKey)) {
                for (const record of companyIndex.get(companyKey).values()) {
                    if (!jobMatchesByAccount.has(record.accountKey)) {
                        companyMatchesByAccount.set(record.accountKey, record);
                    }
                }
            }

            const matchedItems = [
                ...Array.from(jobMatchesByAccount.values()).map((record) => ({ record, companyOnly: false })),
                ...Array.from(companyMatchesByAccount.values()).map((record) => ({ record, companyOnly: true }))
            ];
            let badge = card.querySelector(`.${BADGE_CLASS}`);
            const titleLines = [];
            const blocks = [];
            matchedItems.sort((a, b) => {
                const rankDiff = statusRank(b.record?.flags || {}) - statusRank(a.record?.flags || {});
                if (rankDiff !== 0) return rankDiff;
                if (a.companyOnly !== b.companyOnly) return a.companyOnly ? 1 : -1;
                return 0;
            });
            matchedItems.forEach((item) => {
                const status = formatStatusWithScope(item.record, item.companyOnly);
                if (!status) return;
                const statusClass = getStatusClass(status);
                const accountLabel = formatAccountLabel(item.record);
                const jobInfo = item.companyOnly
                    ? formatCompanyJobList(getCompanyJobs(companyJobs, companyKey, item.record.accountKey), 3)
                    : { inline: '', full: '' };
                const textBase = formatStatusAccount(status, accountLabel);
                const lines = [{ text: textBase, className: `bp-badge-line ${statusClass}` }];
                if (item.companyOnly && jobInfo.inline) {
                    const compact = renderCompanyJobsInline(getCompanyJobs(companyJobs, companyKey, item.record.accountKey), 1);
                    lines.push({ text: `曾投：${compact || jobInfo.inline}`, className: 'bp-badge-sub' });
                }
                blocks.push({ lines });
                const title = formatBadgeTitle(item.record, item.companyOnly, jobInfo.full);
                if (title) titleLines.push(title);
            });
            appendPrivacyBadgeBlocks(blocks, titleLines, companyName, extractHrFromNode(card), privacyIndexes);
            if (!blocks.length) {
                if (badge) badge.remove();
                continue;
            }
            ensurePositioned(card);
            if (!badge) {
                badge = document.createElement('div');
                badge.className = BADGE_CLASS;
                card.appendChild(badge);
            }
            badge.classList.add('boss-progress-jobs-badge');
            renderBadgeBlocks(badge, blocks, titleLines);
        }
    }

    async function applyBadgesForChatPage() {
        const records = await listAllRecords();
        const { companyIndex, companyJobs } = buildCompanyIndexes(records);
        const companyJobIndex = buildCompanyJobIndex(records);
        const privacyIndexes = await buildPrivacyIndexes();
        if (!companyIndex.size && !privacyIndexes.companyIndex.size && !privacyIndexes.bossIndex.size) return;
        const cards = collectChatCandidates();
        for (const card of cards) {
            if (!card || isInIgnoredArea(card)) continue;
            let { companyName } = extractJobCompanyText(card);
            let jobName = '';
            let hrInfo = '';
            const nameBox = card.querySelector('.name-box');
            if (nameBox) {
                const spans = Array.from(nameBox.querySelectorAll('span')).map((el) => normalizeText(el.textContent || '')).filter(Boolean);
                hrInfo = spans[0] || '';
                if (spans.length >= 2 && isLikelyCompanyName(spans[1])) {
                    companyName = spans[1];
                }
                if (spans.length >= 3 && isLikelyJobName(spans[2])) {
                    jobName = spans[2];
                } else if (spans.length >= 2) {
                    const last = spans[spans.length - 1];
                    if (isLikelyJobName(last)) jobName = last;
                }
            }
            if (!companyName) {
                // no-op
            }
            if (!companyName) {
                const line = card.querySelector('.name, .title, .company, .text, .desc, .content, .name-box');
                const guess = line ? pickCompanyFromTextBlock(line.textContent || '') : '';
                if (isLikelyCompanyName(guess)) companyName = guess;
            }
            if (!companyName) continue;
            const companyKey = normalizeKey(companyName);
            if (!companyKey) continue;
            const accountMap = companyIndex.get(companyKey) || new Map();
            const jobMatchesByAccount = new Map();
            const jobExact = normalizeJobKey(jobName, false);
            const jobLoose = normalizeJobKey(jobName, true);
            const jobMap = companyJobIndex.get(companyKey);
            if (jobMap) {
                const exactMap = jobExact ? jobMap.get(jobExact) : null;
                const looseMap = !exactMap && jobLoose ? jobMap.get(jobLoose) : null;
                const hitMap = exactMap || looseMap;
                if (hitMap) {
                    hitMap.forEach((record, accountKey) => {
                        if (shouldShowChatStatus(record)) {
                            jobMatchesByAccount.set(accountKey, record);
                        }
                    });
                }
            }
            const matchedItems = [
                ...Array.from(jobMatchesByAccount.values()).map((record) => ({ record, companyOnly: false })),
                ...Array.from(accountMap.values())
                    .filter((record) => shouldShowChatStatus(record) && !jobMatchesByAccount.has(record.accountKey))
                    .map((record) => ({ record, companyOnly: true }))
            ];
            ensurePositioned(card);
            matchedItems.sort((a, b) => statusRank(b.record?.flags || {}) - statusRank(a.record?.flags || {}));
            const titleLines = [];
            const blocks = [];
            matchedItems.forEach((item) => {
                const status = formatStatusWithScope(item.record, item.companyOnly);
                if (!status) return;
                const statusClass = getStatusClass(status);
                const accountLabel = formatAccountLabel(item.record);
                const textBase = formatStatusAccount(status, accountLabel);
                const lines = [{ text: textBase, className: `bp-badge-line ${statusClass}` }];
                const jobList = getCompanyJobs(companyJobs, companyKey, item.record.accountKey);
                const jobInfo = formatCompanyJobList(jobList, 2);
                if (jobList.length > 1 && jobInfo.inline) {
                    lines.push({ text: `曾投：${jobInfo.inline}`, className: 'bp-badge-sub' });
                }
                blocks.push({ lines });
                const title = formatBadgeTitle(item.record, true, jobInfo.full);
                if (title) titleLines.push(title);
            });
            appendPrivacyBadgeBlocks(blocks, titleLines, companyName, hrInfo, privacyIndexes);
            if (!blocks.length) continue;
            const existingBadges = card.querySelectorAll(`.${BADGE_CLASS}`);
            if (existingBadges.length > 1) {
                existingBadges.forEach((node, idx) => {
                    if (idx > 0) node.remove();
                });
            }
            let badge = card.querySelector(`.${BADGE_CLASS}`);
            if (!badge) {
                badge = document.createElement('div');
                badge.className = BADGE_CLASS;
                card.appendChild(badge);
            }
            badge.classList.remove('boss-progress-jobs-badge');
            renderBadgeBlocks(badge, blocks, titleLines);
        }
    }

    async function applyBadges() {
        await ensureAccount();
        state.muteObserver = true;
        try {
            if (isJobsPage()) {
                await applyBadgesForJobsPage();
                return;
            }
            if (isChatPage()) {
                await applyBadgesForChatPage();
                return;
            }

            const accountRecords = await listRecordsByAccount(state.accountKey);
            const { companyJobs } = buildCompanyIndexes(accountRecords);
            const cards = collectCardCandidates();
            const pageHint = getPageStatusHint();
            for (const card of cards) {
                if (!card || isInIgnoredArea(card)) continue;
                const record = extractRecordFromCard(card, pageHint, { allowWithoutStatus: true });
                if (!record) continue;
                let best = null;
                let companyOnly = false;
                if (record.jobId) {
                    best = await getRecordByIndex('by_job', [state.accountKey, record.jobId]);
                }
                if (!best && record.companyId) {
                    const companyRecord = await getRecordByIndex('by_company', [state.accountKey, record.companyId]);
                    if (companyRecord) {
                        best = companyRecord;
                        companyOnly = true;
                    }
                }
                if (!best || !best.statusText) continue;
                const status = formatStatusWithScope(best, companyOnly);
                if (!status) continue;
                const statusClass = getStatusClass(status);
                ensurePositioned(card);
                let badge = card.querySelector(`.${BADGE_CLASS}`);
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = BADGE_CLASS;
                    card.appendChild(badge);
                }
                badge.classList.add('boss-progress-jobs-badge');
                const accountLabel = formatAccountLabel(best);
                const badgeText = formatStatusAccount(status, accountLabel);
                const blocks = [{ lines: [{ text: badgeText, className: `bp-badge-line ${statusClass}` }] }];
                let jobListText = best.jobName || '';
                if (companyOnly) {
                    const companyKey = normalizeKey(best.companyName);
                    const jobList = getCompanyJobs(companyJobs, companyKey, best.accountKey);
                    const jobInfo = formatCompanyJobList(jobList, 2);
                    jobListText = jobInfo.full || best.jobName || '';
                    if (jobList.length > 1 && jobInfo.inline) {
                        blocks[0].lines.push({ text: `曾投：${jobInfo.inline}`, className: 'bp-badge-sub' });
                    } else if (best.jobName) {
                        blocks[0].lines.push({ text: `曾投：${best.jobName}`, className: 'bp-badge-sub' });
                    }
                }
                renderBadgeBlocks(badge, blocks, [formatBadgeTitle(best, companyOnly, jobListText)].filter(Boolean));
            }

            const detail = document.querySelector('.job-detail, .job-detail-wrapper, .job-detail-content, .job-detail-header');
            if (detail) {
                const record = extractRecordFromCard(detail, getPageStatusHint(), { allowWithoutStatus: true }) || extractRecordFromCard(document.body, getPageStatusHint(), { allowWithoutStatus: true });
                if (record) {
                    let best = null;
                    let companyOnly = false;
                    if (record.jobId) {
                        best = await getRecordByIndex('by_job', [state.accountKey, record.jobId]);
                    }
                    if (!best && record.companyId) {
                        const companyRecord = await getRecordByIndex('by_company', [state.accountKey, record.companyId]);
                        if (companyRecord) {
                            best = companyRecord;
                            companyOnly = true;
                        }
                    }
                    if (best && best.statusText) {
                        const status = formatStatusWithScope(best, companyOnly);
                        if (!status) {
                            // no-op
                        } else {
                        let target = detail.querySelector('.job-name, .job-title, h1, h2');
                        if (target) {
                            let badge = target.querySelector(`.${DETAIL_BADGE_CLASS}`);
                            if (!badge) {
                                badge = document.createElement('span');
                                badge.className = DETAIL_BADGE_CLASS;
                                target.appendChild(badge);
                            }
                            const statusClass = getStatusClass(status);
                            badge.className = `${DETAIL_BADGE_CLASS} ${statusClass}`.trim();
                            const accountLabel = formatAccountLabel(best);
                            const badgeText = formatStatusAccount(status, accountLabel);
                            badge.textContent = badgeText;
                            let jobListText = best.jobName || '';
                            if (companyOnly) {
                                const companyKey = normalizeKey(best.companyName);
                                const jobList = getCompanyJobs(companyJobs, companyKey, best.accountKey);
                                const jobInfo = formatCompanyJobList(jobList, 3);
                                jobListText = jobInfo.full || best.jobName || '';
                            }
                            const title = formatBadgeTitle(best, companyOnly, jobListText);
                            if (title) {
                                badge.title = title;
                            }
                        }
                        }
                    }
                }
            }
        } finally {
            setTimeout(() => {
                state.muteObserver = false;
            }, 80);
        }
    }

    function observeDom() {
        const observer = new MutationObserver((mutations) => {
            if (state.muteObserver) return;
            if (shouldIgnoreMutations(mutations)) return;
            scheduleScan(420);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('click', (event) => {
            if (isShieldCompanyPage()) rememberShieldDialogSourceFromClick(event.target);
        }, true);
        window.addEventListener('scroll', () => {
            if (isPrivacySetPage()) scheduleScan(500);
        }, true);
        document.addEventListener('scroll', () => {
            if (isPrivacySetPage()) scheduleScan(500);
        }, true);
    }

    function hookHistory() {
        if (history.__bossProgressHooked) return;
        const wrap = (method) => {
            if (!method) return null;
            return function (...args) {
                const result = method.apply(this, args);
                syncDataViewFromPage();
                scheduleScan(200);
                setTimeout(() => scheduleScan(900), 900);
                return result;
            };
        };
        const wrappedPush = wrap(history.pushState);
        if (wrappedPush) history.pushState = wrappedPush;
        const wrappedReplace = wrap(history.replaceState);
        if (wrappedReplace) history.replaceState = wrappedReplace;
        window.addEventListener('popstate', () => {
            syncDataViewFromPage();
            scheduleScan(200);
            setTimeout(() => scheduleScan(900), 900);
        });
        history.__bossProgressHooked = true;
    }

    function shouldParseAsJson(contentType, url) {
        if ((contentType || '').includes('json')) return true;
        if (!url) return false;
        return /wapi|api|geek|recommend|job/i.test(url);
    }

    async function parseResponseBodyAsJson(response, urlHint) {
        const contentType = response.headers.get('content-type') || '';
        if (!shouldParseAsJson(contentType, urlHint)) return null;
        try {
            const text = await response.text();
            return safeParseJson(text);
        } catch (err) {
            return null;
        }
    }

    function hookNetwork() {
        if (!state.enableNetwork) return;
        try {
            if (window.fetch && !window.fetch.__bossProgressHooked) {
                const originalFetch = window.fetch;
                const wrappedFetch = async (...args) => {
                    const response = await originalFetch.apply(window, args);
                    try {
                        if (!isTargetRecommendTabPage()) return response;
                        const clone = response.clone();
                        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
                        const data = await parseResponseBodyAsJson(clone, url);
                        if (data) {
                            const records = extractRecordsFromJson(data);
                            if (records.length) {
                                saveRecords(records);
                            }
                        }
                    } catch (err) {
                        // ignore
                    }
                    return response;
                };
                wrappedFetch.__bossProgressHooked = true;
                window.fetch = wrappedFetch;
            }
        } catch (err) {
            // ignore
        }

        try {
            if (XMLHttpRequest && XMLHttpRequest.prototype && !XMLHttpRequest.prototype.send.__bossProgressHooked) {
                const originalOpen = XMLHttpRequest.prototype.open;
                const originalSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function (...args) {
                    this._bossProgressUrl = args[1] || '';
                    return originalOpen.apply(this, args);
                };
                XMLHttpRequest.prototype.send = function (...args) {
                    this.addEventListener('load', () => {
                        try {
                            if (!isTargetRecommendTabPage()) return;
                            const contentType = this.getResponseHeader('content-type') || '';
                            if (!shouldParseAsJson(contentType, this._bossProgressUrl || '')) return;
                            const data = safeParseJson(this.responseText || '');
                            if (!data) return;
                            const records = extractRecordsFromJson(data);
                            if (records.length) {
                                saveRecords(records);
                            }
                        } catch (err) {
                            // ignore
                        }
                    });
                    return originalSend.apply(this, args);
                };
                XMLHttpRequest.prototype.send.__bossProgressHooked = true;
            }
        } catch (err) {
            // ignore
        }
    }

    async function clearCurrentData() {
        const view = state.dataView || 'progress';
        const storeName = view === 'companyBlacklist'
            ? STORE_COMPANY_BLACKLIST
            : view === 'bossBlacklist'
                ? STORE_BOSS_BLACKLIST
                : STORE_RECORDS;
        const label = getDataViewLabel(view);
        const records = await listStoreByAccount(storeName, state.accountKey);
        const confirmed = confirm(`确认清空当前账号「${state.accountLabel || state.accountKey}」的「${label}」数据？\n将删除 ${records.length} 条本地记录，此操作不可恢复。`);
        if (!confirmed) return;
        await withStore(storeName, 'readwrite', (store) => {
            records.forEach((record) => store.delete(record.id));
        });
        state.syncStatus = `已清空${label}：${records.length}条`;
        renderPanel();
        applyBadges();
    }

    function escapeCsv(value) {
        const text = String(value ?? '');
        if (/[,"\n]/.test(text)) {
            return `"${text.replace(/"/g, '""')}"`;
        }
        return text;
    }

    function downloadCsv(lines, prefix) {
        const csvContent = '\ufeff' + lines.join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const accountPart = sanitizeFilenamePart(state.accountLabel || state.accountKey || 'account');
        const timePart = formatTimestampForFilename(new Date());
        a.download = `${prefix}-${accountPart}-${timePart}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async function exportProgressCsv() {
        const recordsAll = await listRecordsByAccount(state.accountKey);
        const currentLabel = sanitizeString(state.accountLabel || '');
        let records = recordsAll;
        if (currentLabel) {
            const matched = recordsAll.filter((record) => sanitizeString(record.accountLabel || '') === currentLabel);
            if (matched.length) records = matched;
        }
        const header = ['accountKey', 'accountLabel', 'scope', 'companyId', 'jobId', 'companyName', 'jobName', 'hrInfo', 'interviewTime', 'statusText', 'communicated', 'delivered', 'interviewed', 'updatedAt'];
        const lines = [header.join(',')];
        for (const record of records) {
            const row = [
                record.accountKey,
                record.accountLabel,
                record.scope,
                record.companyId,
                record.jobId,
                record.companyName,
                record.jobName,
                record.hrInfo,
                record.interviewTime,
                record.statusText,
                record.flags?.communicated ? 1 : 0,
                record.flags?.delivered ? 1 : 0,
                record.flags?.interviewed ? 1 : 0,
                record.updatedAt || ''
            ].map(escapeCsv);
            lines.push(row.join(','));
        }
        downloadCsv(lines, 'boss-progress');
    }

    async function exportCompanyBlacklistCsv() {
        const records = (await listStoreByAccount(STORE_COMPANY_BLACKLIST, state.accountKey))
            .filter((record) => isBlacklistCompanyName(record.companyName || ''));
        const header = ['accountKey', 'accountLabel', 'companyName', 'companyKey', 'sourceTypes', 'updatedAt'];
        const lines = [header.join(',')];
        for (const record of records) {
            lines.push([
                record.accountKey,
                record.accountLabel,
                record.companyName,
                record.companyKey,
                record.sourceTypes,
                record.updatedAt || ''
            ].map(escapeCsv).join(','));
        }
        downloadCsv(lines, 'boss-company-blacklist');
    }

    async function exportBossBlacklistCsv() {
        const records = await listStoreByAccount(STORE_BOSS_BLACKLIST, state.accountKey);
        const header = ['accountKey', 'accountLabel', 'bossName', 'bossKey', 'companyName', 'companyKey', 'title', 'updatedAt'];
        const lines = [header.join(',')];
        for (const record of records) {
            lines.push([
                record.accountKey,
                record.accountLabel,
                record.bossName,
                record.bossKey,
                record.companyName,
                record.companyKey,
                record.title,
                record.updatedAt || ''
            ].map(escapeCsv).join(','));
        }
        downloadCsv(lines, 'boss-boss-blacklist');
    }

    async function exportCsv() {
        if (state.dataView === 'companyBlacklist') {
            await exportCompanyBlacklistCsv();
            return;
        }
        if (state.dataView === 'bossBlacklist') {
            await exportBossBlacklistCsv();
            return;
        }
        await exportProgressCsv();
    }

    async function importCsv(file) {
        const text = await file.text();
        const rows = text.split(/\r?\n/).filter(Boolean);
        if (rows.length <= 1) return;
        const header = parseCsvLine(rows[0]).map((h) => h.trim());
        if (header[0]) header[0] = header[0].replace(/^\ufeff/, '');
        const headerSet = new Set(header);
        const importType = headerSet.has('bossName')
            ? 'bossBlacklist'
            : headerSet.has('sourceTypes') && headerSet.has('companyKey') && !headerSet.has('jobName')
                ? 'companyBlacklist'
                : 'progress';
        for (let i = 1; i < rows.length; i += 1) {
            const row = parseCsvLine(rows[i]);
            if (!row.length) continue;
            const data = {};
            for (let j = 0; j < header.length; j += 1) {
                data[header[j]] = row[j] || '';
            }
            const incomingAccountKey = data.accountKey || '';
            const shouldRemapAccount = incomingAccountKey && incomingAccountKey !== state.accountKey;
            const accountKey = shouldRemapAccount ? state.accountKey : (incomingAccountKey || state.accountKey);
            if (importType === 'companyBlacklist') {
                await mergeAndSaveCompanyBlacklist({
                    accountKey,
                    accountLabel: data.accountLabel || state.accountLabel,
                    companyName: data.companyName || '',
                    companyKey: data.companyKey || normalizeKey(data.companyName || ''),
                    sourceTypes: data.sourceTypes || '',
                    sourceType: data.sourceTypes || '',
                    updatedAt: Number(data.updatedAt) || Date.now(),
                    sourceAccountKey: shouldRemapAccount ? incomingAccountKey : ''
                });
                continue;
            }
            if (importType === 'bossBlacklist') {
                await mergeAndSaveBossBlacklist({
                    accountKey,
                    accountLabel: data.accountLabel || state.accountLabel,
                    bossName: data.bossName || '',
                    bossKey: data.bossKey || normalizeBossName(data.bossName || ''),
                    companyName: data.companyName || '',
                    companyKey: data.companyKey || normalizeKey(data.companyName || ''),
                    title: data.title || '',
                    updatedAt: Number(data.updatedAt) || Date.now(),
                    sourceAccountKey: shouldRemapAccount ? incomingAccountKey : ''
                });
                continue;
            }
            const record = {
                accountKey,
                accountLabel: data.accountLabel || state.accountLabel,
                scope: data.scope || 'company',
                companyId: data.companyId || '',
                companyName: data.companyName || '',
                jobId: data.jobId || '',
                jobName: data.jobName || '',
                hrInfo: data.hrInfo || '',
                interviewTime: data.interviewTime || '',
                statusText: data.statusText || '',
                flags: {
                    communicated: data.communicated === '1',
                    delivered: data.delivered === '1',
                    interviewed: data.interviewed === '1'
                },
                source: 'import',
                updatedAt: Number(data.updatedAt) || Date.now(),
                sourceAccountKey: shouldRemapAccount ? incomingAccountKey : '',
                raw: null
            };
            record.id = buildRecordId(record.accountKey, record.scope, record.companyId, record.jobId);
            await mergeAndSaveRecord(record);
        }
        renderPanel();
    }

    function parseCsvLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i += 1) {
            const char = line[i];
            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i += 1;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current);
        return result.map((cell) => cell.trim());
    }

    async function init() {
        state.db = await openDB();
        await ensureAccount();
        state.dataView = detectDataViewFromPage();
        if (parseBoolean(await getMeta('enableNetwork'))) {
            await setMeta('enableNetwork', 0);
        }
        state.enableNetwork = false;
        state.tabStatusMap = await getTabStatusMap();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                hookNetwork();
                createPanel();
                renderPanel();
                hookHistory();
                observeDom();
                scanGlobals();
                scanEmbeddedJson();
                scanDom();
                setTimeout(() => {
                    scanGlobals();
                    scanEmbeddedJson();
                }, 1500);
            });
        } else {
            hookNetwork();
            createPanel();
            renderPanel();
            hookHistory();
            observeDom();
            scanGlobals();
            scanEmbeddedJson();
            scanDom();
            setTimeout(() => {
                scanGlobals();
                scanEmbeddedJson();
            }, 1500);
        }
    }

    hookNetwork();
    init().catch((err) => log('init failed', err));
})();
