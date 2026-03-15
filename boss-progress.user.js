// ==UserScript==
// @name         BOSS投递进度助手
// @namespace    https://www.zhipin.com/
// @version      0.4.8
// @description  记录并展示BOSS投递进度，支持本地数据库、搜索、CSV导入导出
// @match        https://www.zhipin.com/web/geek/recommend*
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/web/geek/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const DB_NAME = 'boss_progress_db';
    const DB_VERSION = 1;
    const STORE_RECORDS = 'records';
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

    function isChatPage() {
        return /\/web\/geek\/chat/.test(location.pathname || '');
    }

    function stripBracketText(text) {
        return normalizeText(text)
            .replace(/\s*\[[^\]]+\]/g, '')
            .replace(/\s*\([^\)]+\)/g, '')
            .replace(/\s*（[^）]+）/g, '');
    }

    function buildTextKey(companyName, jobName, loose) {
        if (!companyName || !jobName) return '';
        const companyKey = normalizeKey(companyName);
        const jobKey = loose ? normalizeKey(stripBracketText(jobName)) : normalizeKey(jobName);
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

    function isLikelyCompanyName(text) {
        if (!text) return false;
        if (/^(HR|人事|招聘|猎头)/i.test(text)) return false;
        if (/HR|人事|招聘/.test(text)) return false;
        if (/先生|女士|HRBP/.test(text)) return false;
        if (/^\d/.test(text)) return false;
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

    function formatBadgeTitle(record, companyOnly, jobListText) {
        if (!record) return '';
        const parts = [];
        const account = formatAccountLabel(record);
        const status = formatStatusWithScope(record, companyOnly);
        if (account) parts.push(`账号:${account}`);
        if (status) parts.push(`状态:${status}`);
        if (record.companyName) parts.push(`公司:${record.companyName}`);
        if (record.jobName) parts.push(`岗位:${record.jobName}`);
        if (companyOnly && jobListText) parts.push(`曾投岗位:${jobListText}`);
        return parts.join(' | ');
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
        <div class="bp-title">投递进度</div>
        <button class="bp-toggle" title="收起/展开">≡</button>
      </div>
      <div class="bp-body">
        <div class="bp-account">账号：<span class="bp-account-label"></span> <button class="bp-set-account">设置</button></div>
        <div class="bp-actions">
          <button class="bp-sync">同步页面</button>
          <button class="bp-export">导出CSV</button>
          <button class="bp-import">导入CSV</button>
        </div>
        <div class="bp-actions bp-actions-secondary">
          <button class="bp-clear">清空数据</button>
          <button class="bp-network"></button>
        </div>
        <div class="bp-tip">接口采集可能触发风控，建议必要时手动开启。</div>
        <div class="bp-tab">
          <div class="bp-tab-label">当前页签状态</div>
          <div class="bp-tab-buttons">
            <button class="bp-tab-btn" data-status="auto">自动</button>
            <button class="bp-tab-btn" data-status="已沟通">沟通</button>
            <button class="bp-tab-btn" data-status="已投递">投递</button>
            <button class="bp-tab-btn" data-status="已面试">面试</button>
          </div>
          <div class="bp-tab-hint"></div>
        </div>
        <input class="bp-search" placeholder="搜索 公司 / 岗位 / 状态" />
        <div class="bp-stats"></div>
        <div class="bp-list"></div>
      </div>
      <input class="bp-file" type="file" accept=".csv" style="display:none" />
    `;

        const style = document.createElement('style');
        style.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; bottom: 16px; width: 360px; min-width: 300px; min-height: 260px; max-width: 80vw; max-height: 80vh; resize: none !important; overflow: auto; font-size: 12px; color: #1f2d3d; z-index: 999999; }
      #${PANEL_ID} .bp-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: #0f172a; color: #fff; border-radius: 8px 8px 0 0; }
      #${PANEL_ID} .bp-title { font-weight: 600; }
      #${PANEL_ID} .bp-toggle { background: transparent; border: none; color: #fff; cursor: pointer; font-size: 16px; }
      #${PANEL_ID} .bp-body { background: #ffffff; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; padding: 10px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.15); }
      #${PANEL_ID} .bp-account { margin-bottom: 8px; }
      #${PANEL_ID} .bp-account button { margin-left: 6px; }
      #${PANEL_ID} .bp-actions { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
      #${PANEL_ID} .bp-actions button { flex: 1; }
      #${PANEL_ID} .bp-actions-secondary { margin-top: -2px; }
      #${PANEL_ID} .bp-actions-secondary button { flex: 1; }
      #${PANEL_ID} .bp-tip { color: #94a3b8; margin-bottom: 8px; }
      #${PANEL_ID} .bp-tab { margin-bottom: 8px; }
      #${PANEL_ID} .bp-tab-label { color: #64748b; margin-bottom: 4px; }
      #${PANEL_ID} .bp-tab-buttons { display: flex; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
      #${PANEL_ID} .bp-tab-buttons button { flex: 1; min-width: 64px; }
      #${PANEL_ID} .bp-tab-hint { color: #94a3b8; }
      #${PANEL_ID} button { border: 1px solid #cbd5f5; background: #f8fafc; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
      #${PANEL_ID} button:hover { background: #eef2ff; }
      #${PANEL_ID} .bp-search { width: 100%; padding: 6px; border: 1px solid #cbd5f5; border-radius: 4px; margin-bottom: 8px; }
      #${PANEL_ID} .bp-stats { margin-bottom: 8px; color: #475569; }
      #${PANEL_ID} .bp-list { max-height: 45vh; overflow: auto; border-top: 1px dashed #e2e8f0; padding-top: 8px; }
      #${PANEL_ID} .bp-item { margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #f1f5f9; }
      #${PANEL_ID} .bp-item:last-child { border-bottom: none; }
      #${PANEL_ID} .bp-item-title { font-weight: 600; }
      #${PANEL_ID} .bp-item-sub { color: #64748b; }
      #${PANEL_ID}.collapsed .bp-body { display: none; }
      .${BADGE_CLASS} { position: absolute; top: 8px; right: 8px; background: #ffedd5; color: #9a3412; padding: 2px 6px; font-size: 12px; border-radius: 10px; z-index: 20; max-width: 140px; }
      .${BADGE_CLASS} .bp-badge-line { display: block; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
      .${BADGE_CLASS} .bp-badge-sub { display: block; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: #92400e; }
      .${BADGE_CLASS} .bp-badge-gap { height: 2px; }
      .boss-progress-has-badge::before,
      .boss-progress-has-badge::after,
      .boss-progress-has-badge .${BADGE_CLASS}::before,
      .boss-progress-has-badge .${BADGE_CLASS}::after { content: none !important; }
      .${DETAIL_BADGE_CLASS} { display: inline-block; margin-left: 8px; background: #dbeafe; color: #1d4ed8; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
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
        panel.querySelector('.bp-sync').addEventListener('click', () => {
            if (!isTargetRecommendTabPage()) {
                alert('仅支持在投递进度页（recommend?tab=1-4）同步。');
                return;
            }
            scanDom();
        });
        panel.querySelector('.bp-export').addEventListener('click', exportCsv);
        panel.querySelector('.bp-import').addEventListener('click', () => {
            panel.querySelector('.bp-file').click();
        });
        panel.querySelector('.bp-clear').addEventListener('click', clearDatabase);
        panel.querySelector('.bp-network').addEventListener('click', async () => {
            const next = !state.enableNetwork;
            const message = next
                ? '开启接口采集会尝试拦截接口响应，可能触发风控并导致页面异常。确认开启并刷新页面？'
                : '关闭接口采集将停止拦截接口响应。确认关闭并刷新页面？';
            if (!confirm(message)) return;
            state.enableNetwork = next;
            await setMeta('enableNetwork', state.enableNetwork ? 1 : 0);
            location.reload();
        });
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
            renderPanel();
        });
        panel.querySelector('.bp-file').addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                importCsv(file);
            }
            event.target.value = '';
        });
    }

    async function renderPanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelector('.bp-account-label').textContent = state.accountLabel || '未命名账号';
        const networkBtn = panel.querySelector('.bp-network');
        if (networkBtn) {
            networkBtn.textContent = state.enableNetwork ? '接口采集：开' : '接口采集：关';
        }
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

        const records = await listRecordsByAccount(state.accountKey);
        const filtered = state.searchQuery
            ? records.filter((record) => (record.searchText || '').toLowerCase().includes(state.searchQuery))
            : records;

        const total = records.length;
        const communicated = records.filter((r) => r.statusText === '已沟通').length;
        const delivered = records.filter((r) => r.statusText === '已投递').length;
        const interviewed = records.filter((r) => r.statusText === '已面试').length;

        const stats = panel.querySelector('.bp-stats');
        stats.textContent = `总计 ${total} · 已沟通 ${communicated} · 已投递 ${delivered} · 已面试 ${interviewed}`;

        const list = panel.querySelector('.bp-list');
        list.innerHTML = '';
        const sorted = filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const visible = sorted.slice(0, 30);
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
            const title = document.createElement('div');
            title.className = 'bp-item-title';
            title.textContent = `${record.companyName || '未知公司'}${record.jobName ? ' · ' + record.jobName : ''}`;
            const sub = document.createElement('div');
            sub.className = 'bp-item-sub';
            const accountLabel = formatAccountLabel(record);
            const accountInfo = accountLabel ? `账号:${accountLabel} · ` : '';
            const hrLabel = record.hrInfo ? ` · HR:${record.hrInfo}` : '';
            const interviewLabel = record.interviewTime ? ` · 面试:${record.interviewTime}` : '';
            sub.textContent = `${accountInfo}${record.statusText || '无状态'} · ${record.scope === 'job' ? '岗位记录' : '公司记录'}${hrLabel}${interviewLabel}`;
            item.appendChild(title);
            item.appendChild(sub);
            list.appendChild(item);
        }
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

        let companyName = pickText(card, ['.company-name', '.company-info .name', '.company-title', '.job-card-company', '.company-info a', '.company-name a', '.company', '.company-info', '.job-company', '.job-primary .company-name', '.job-primary .company-info', '.company-text']);
        if (!isLikelyCompanyName(companyName)) {
            const fallback = pickText(card, ['.company-info', '.company', '.job-company', '.job-card-company']);
            if (isLikelyCompanyName(fallback)) companyName = fallback;
        }
        if (!isLikelyCompanyName(companyName) && companyLink) {
            const linkText = normalizeText(companyLink.textContent || '');
            if (isLikelyCompanyName(linkText)) companyName = linkText;
        }
        if (!isLikelyCompanyName(companyName)) {
            const logo = card.querySelector('img[alt]');
            const logoAlt = logo ? normalizeText(logo.getAttribute('alt') || '') : '';
            if (isLikelyCompanyName(logoAlt)) companyName = logoAlt;
        }
        if (!isLikelyCompanyName(companyName)) {
            const candidates = card.querySelectorAll('[class*="company"], [class*="brand"]');
            for (const el of candidates) {
                const text = normalizeText(el.textContent || '');
                if (isLikelyCompanyName(text)) {
                    companyName = text;
                    break;
                }
            }
        }
        if (!isLikelyCompanyName(companyName)) {
            const blockCompany = pickCompanyFromTextBlock(card.textContent || '');
            if (isLikelyCompanyName(blockCompany)) companyName = blockCompany;
        }
        if (!isLikelyCompanyName(companyName)) companyName = '';
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

        let companyName = pickText(card, ['.company-name', '.company-info .name', '.company-title', '.job-card-company', '.company-info a', '.company-name a', '.company', '.company-info', '.job-company']);
        if (!isLikelyCompanyName(companyName)) {
            const fallback = pickText(card, ['.company-info', '.company', '.job-company', '.job-card-company']);
            if (isLikelyCompanyName(fallback)) companyName = fallback;
        }
        if (!isLikelyCompanyName(companyName)) {
            const logo = card.querySelector('img[alt]');
            const logoAlt = logo ? normalizeText(logo.getAttribute('alt') || '') : '';
            if (isLikelyCompanyName(logoAlt)) companyName = logoAlt;
        }
        if (!isLikelyCompanyName(companyName)) {
            const candidates = card.querySelectorAll('[class*="company"], [class*="brand"]');
            for (const el of candidates) {
                const text = normalizeText(el.textContent || '');
                if (isLikelyCompanyName(text)) {
                    companyName = text;
                    break;
                }
            }
        }
        if (!isLikelyCompanyName(companyName)) companyName = '';

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

    function scanDom() {
        const now = Date.now();
        if (now - state.lastScanAt < 800) return;
        state.lastScanAt = now;
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
            const jobExact = normalizeKey(record.jobName);
            const jobLoose = normalizeKey(stripBracketText(record.jobName));
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
        if (!index.size && !byCompany.size && !companyIndex.size) return;
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
                const jobExact = normalizeKey(jobName);
                const jobLoose = normalizeKey(stripBracketText(jobName));
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
            if (!matchedItems.length) {
                if (badge) badge.remove();
                continue;
            }
            ensurePositioned(card);
            matchedItems.sort((a, b) => {
                const rankDiff = statusRank(b.record?.flags || {}) - statusRank(a.record?.flags || {});
                if (rankDiff !== 0) return rankDiff;
                if (a.companyOnly !== b.companyOnly) return a.companyOnly ? 1 : -1;
                return 0;
            });
            const titleLines = [];
            const blocks = [];
            matchedItems.forEach((item) => {
                const status = formatStatusWithScope(item.record, item.companyOnly);
                if (!status) return;
                const accountLabel = formatAccountLabel(item.record);
                const jobInfo = item.companyOnly
                    ? formatCompanyJobList(getCompanyJobs(companyJobs, companyKey, item.record.accountKey), 3)
                    : { inline: '', full: '' };
                const textBase = formatStatusAccount(status, accountLabel);
                const lines = [{ text: textBase, className: 'bp-badge-line' }];
                if (item.companyOnly && jobInfo.inline) {
                    const compact = renderCompanyJobsInline(getCompanyJobs(companyJobs, companyKey, item.record.accountKey), 1);
                    lines.push({ text: `曾投：${compact || jobInfo.inline}`, className: 'bp-badge-sub' });
                }
                blocks.push({ lines });
                const title = formatBadgeTitle(item.record, item.companyOnly, jobInfo.full);
                if (title) titleLines.push(title);
            });
            if (!blocks.length) {
                if (badge) badge.remove();
                continue;
            }
            if (!badge) {
                badge = document.createElement('div');
                badge.className = BADGE_CLASS;
                card.appendChild(badge);
            }
            renderBadgeBlocks(badge, blocks, titleLines);
        }
    }

    async function applyBadgesForChatPage() {
        const records = await listAllRecords();
        const { companyIndex, companyJobs } = buildCompanyIndexes(records);
        if (!companyIndex.size) return;
        const cards = collectChatCandidates();
        for (const card of cards) {
            if (!card || isInIgnoredArea(card)) continue;
            let { companyName } = extractJobCompanyText(card);
            if (!companyName) {
                const nameBox = card.querySelector('.name-box');
                if (nameBox) {
                    const spans = Array.from(nameBox.querySelectorAll('span')).map((el) => normalizeText(el.textContent || '')).filter(Boolean);
                    const candidate = spans.length >= 2 ? spans[1] : '';
                    if (isLikelyCompanyName(candidate)) companyName = candidate;
                }
            }
            if (!companyName) {
                const line = card.querySelector('.name, .title, .company, .text, .desc, .content, .name-box');
                const guess = line ? pickCompanyFromTextBlock(line.textContent || '') : '';
                if (isLikelyCompanyName(guess)) companyName = guess;
            }
            if (!companyName) continue;
            const companyKey = normalizeKey(companyName);
            if (!companyKey || !companyIndex.has(companyKey)) continue;
            const accountMap = companyIndex.get(companyKey);
            const matchedItems = Array.from(accountMap.values())
                .filter((record) => shouldShowChatStatus(record))
                .map((record) => ({ record, companyOnly: true }));
            if (!matchedItems.length) continue;
            ensurePositioned(card);
            matchedItems.sort((a, b) => statusRank(b.record?.flags || {}) - statusRank(a.record?.flags || {}));
            const titleLines = [];
            const blocks = [];
            matchedItems.forEach((item) => {
                const status = formatStatusWithScope(item.record, true);
                if (!status) return;
                const accountLabel = formatAccountLabel(item.record);
                const textBase = formatStatusAccount(status, accountLabel);
                const lines = [{ text: textBase, className: 'bp-badge-line' }];
                blocks.push({ lines });
                const title = formatBadgeTitle(item.record, true, '');
                if (title) titleLines.push(title);
            });
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
                ensurePositioned(card);
                let badge = card.querySelector(`.${BADGE_CLASS}`);
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = BADGE_CLASS;
                    card.appendChild(badge);
                }
                const accountLabel = formatAccountLabel(best);
                const badgeText = formatStatusAccount(status, accountLabel);
                const blocks = [{ lines: [{ text: badgeText, className: 'bp-badge-line' }] }];
                if (companyOnly && best.jobName) {
                    blocks[0].lines.push({ text: `曾投：${best.jobName}`, className: 'bp-badge-sub' });
                }
                renderBadgeBlocks(badge, blocks, [formatBadgeTitle(best, companyOnly, best.jobName || '')].filter(Boolean));
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
                            const accountLabel = formatAccountLabel(best);
                            const badgeText = formatStatusAccount(status, accountLabel);
                            badge.textContent = badgeText;
                            const title = formatBadgeTitle(best, companyOnly, best.jobName || '');
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
    }

    function hookHistory() {
        if (history.__bossProgressHooked) return;
        const wrap = (method) => {
            if (!method) return null;
            return function (...args) {
                const result = method.apply(this, args);
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

    async function clearDatabase() {
        const confirmed = confirm('确认清空本地数据库？此操作不可恢复。');
        if (!confirmed) return;
        if (state.db) {
            try {
                state.db.close();
            } catch (err) {
                // ignore
            }
        }
        await new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve();
        });
        state.db = await openDB();
        state.accountLabel = '未命名账号';
        state.enableNetwork = false;
        state.tabStatusMap = {};
        await setTabStatusMap({});
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

    async function exportCsv() {
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
        const csvContent = '\ufeff' + lines.join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const accountPart = sanitizeFilenamePart(state.accountLabel || state.accountKey || 'account');
        const timePart = formatTimestampForFilename(new Date());
        a.download = `boss-progress-${accountPart}-${timePart}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async function importCsv(file) {
        const text = await file.text();
        const rows = text.split(/\r?\n/).filter(Boolean);
        if (rows.length <= 1) return;
        const header = parseCsvLine(rows[0]).map((h) => h.trim());
        if (header[0]) header[0] = header[0].replace(/^\ufeff/, '');
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
        state.enableNetwork = parseBoolean(await getMeta('enableNetwork'));
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
