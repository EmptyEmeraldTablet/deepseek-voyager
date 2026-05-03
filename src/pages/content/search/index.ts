import {
  DEEPSEEK_SELECTORS,
  tryFindElement,
  tryFindElements,
  extractConversationId,
  buildConversationUrl,
} from '../deepseek/selectors';

import { SearchIndexService } from '@/features/search/services/SearchIndexService';
import type { ConversationIndexEntry } from '@/features/search/types';
import { initI18n, getTranslationSync } from '@/utils/i18n';


type HistoryRequestInfo = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
};

type HistoryResponseDetail = {
  url: string;
  request: HistoryRequestInfo;
  data: unknown;
};

type PaginationState = {
  key?: string;
  value?: string | number | null;
  hasMore?: boolean;
  limit?: number;
  lastRequestValue?: string | number | null;
};

type IndexStatus = 'idle' | 'waiting' | 'indexing' | 'done' | 'error';

type StatusPayload = {
  status: IndexStatus;
  message?: string;
};

const HISTORY_EVENT = 'gv:historyResponse';
const INTERCEPTOR_ID = 'gv-history-interceptor';
// Product requirement: active indexing polls every 30 seconds to reduce rate-limit risk.
const ACTIVE_POLL_INTERVAL_MS = 30000;
// Maximum empty sidebar scans before the observer auto-disconnects.
// This prevents infinite thrashing when the selector doesn't match the DOM.
const MAX_EMPTY_SCANS = 10;
const SCAN_DEBOUNCE_MS = 300;
const SIDEBAR_WAIT_TIMEOUT_MS = 20000;
const SIDEBAR_POLL_INTERVAL_MS = 500;
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
const TRACK_URL_PATTERN = 'chat|history|session|conversation';

function normalizeText(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(text: string, query: string): string {
  const safeText = escapeHtml(text);
  if (!query) return safeText;
  const safeQuery = escapeRegExp(query);
  try {
    const regex = new RegExp(`(${safeQuery})`, 'ig');
    return safeText.replace(regex, '<mark>$1</mark>');
  } catch {
    return safeText;
  }
}

function isLikelyConversationId(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (/^[a-f0-9-]{32,}$/i.test(value)) return true;
  if (/^[a-z0-9_-]{12,}$/i.test(value)) return true;
  return false;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return parseTimestamp(asNumber);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function findValueByKeys(
  value: unknown,
  keys: string[],
  depth = 0,
  maxDepth = 4
): unknown {
  if (depth > maxDepth || !value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueByKeys(item, keys, depth + 1, maxDepth);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of keys) {
      if (obj[key] !== undefined) return obj[key];
    }
    for (const child of Object.values(obj)) {
      const found = findValueByKeys(child, keys, depth + 1, maxDepth);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

function extractEntriesFromPayload(payload: unknown): ConversationIndexEntry[] {
  const idKeys = [
    'id',
    'conversation_id',
    'conversationId',
    'session_id',
    'sessionId',
    'chat_id',
    'chatId',
    'uuid',
    'cid',
  ];
  const titleKeys = ['title', 'name', 'subject', 'topic'];
  const snippetKeys = ['snippet', 'summary', 'last_message', 'lastMessage', 'abstract'];
  const updatedKeys = [
    'updated_at',
    'updatedAt',
    'update_time',
    'updateTime',
    'last_message_at',
    'lastMessageAt',
    'modified_at',
    'modifiedAt',
    'mtime',
  ];

  const entries = new Map<string, ConversationIndexEntry>();
  const visited = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (!value || depth > 6) return;
    if (visited.has(value)) return;
    if (typeof value === 'object') visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const idRaw = readStringField(obj, idKeys);
      if (idRaw && isLikelyConversationId(idRaw)) {
        const titleRaw = readStringField(obj, titleKeys) || '';
        const snippetRaw = readStringField(obj, snippetKeys) || undefined;
        const updatedRaw =
          updatedKeys.map((key) => parseTimestamp(obj[key])).find((v) => v !== null) || null;
        const title = normalizeText(titleRaw || snippetRaw || '');
        if (title) {
          entries.set(idRaw, {
            id: idRaw,
            title,
            snippet: snippetRaw ? normalizeText(snippetRaw) : undefined,
            updatedAt: updatedRaw ?? 0,
          });
        }
      }
      Object.values(obj).forEach((child) => visit(child, depth + 1));
    }
  };

  visit(payload, 0);
  return Array.from(entries.values());
}

function extractPagination(payload: unknown, request: HistoryRequestInfo): PaginationState {
  const hasMoreValue = findValueByKeys(payload, ['has_more', 'hasMore', 'has_next', 'hasNext', 'more']);
  const nextCursorValue = findValueByKeys(payload, [
    'next_cursor',
    'nextCursor',
    'next_token',
    'nextToken',
    'next_page_token',
    'nextPageToken',
  ]);
  const nextOffsetValue = findValueByKeys(payload, ['next_offset', 'nextOffset']);
  const nextPageValue = findValueByKeys(payload, ['next_page', 'nextPage']);

  const requestInfo = extractRequestPagination(request);
  const pagination: PaginationState = {
    key: requestInfo.key,
    value: requestInfo.value ?? null,
    limit: requestInfo.limit ?? undefined,
    lastRequestValue: requestInfo.value ?? null,
  };

  if (typeof hasMoreValue === 'boolean') pagination.hasMore = hasMoreValue;

  if (nextCursorValue !== null && nextCursorValue !== undefined) {
    pagination.key = requestInfo.key || 'cursor';
    pagination.value = typeof nextCursorValue === 'number' ? nextCursorValue : String(nextCursorValue);
    return pagination;
  }
  if (nextOffsetValue !== null && nextOffsetValue !== undefined) {
    pagination.key = requestInfo.key || 'offset';
    pagination.value = Number(nextOffsetValue);
    return pagination;
  }
  if (nextPageValue !== null && nextPageValue !== undefined) {
    pagination.key = requestInfo.key || 'page';
    pagination.value = Number(nextPageValue);
    return pagination;
  }

  return pagination;
}

function extractRequestPagination(request: HistoryRequestInfo): {
  key?: string;
  value?: string | number | null;
  limit?: number | null;
} {
  const paginationKeys = ['cursor', 'offset', 'page', 'page_index', 'pageIndex', 'last_id', 'lastId'];
  const limitKeys = ['limit', 'page_size', 'pageSize', 'count', 'per_page', 'perPage'];
  let key: string | undefined;
  let value: string | number | null = null;
  let limit: number | null = null;

  try {
    const url = new URL(request.url, location.origin);
    paginationKeys.forEach((candidate) => {
      if (key) return;
      if (url.searchParams.has(candidate)) {
        key = candidate;
        value = url.searchParams.get(candidate);
      }
    });
    limitKeys.forEach((candidate) => {
      if (limit !== null) return;
      const raw = url.searchParams.get(candidate);
      if (raw && Number.isFinite(Number(raw))) {
        limit = Number(raw);
      }
    });
  } catch {
    // ignore
  }

  if (request.body && !key) {
    try {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      paginationKeys.forEach((candidate) => {
        if (key) return;
        if (body[candidate] !== undefined) {
          key = candidate;
          value = body[candidate] as string | number;
        }
      });
      limitKeys.forEach((candidate) => {
        if (limit !== null) return;
        if (body[candidate] !== undefined && Number.isFinite(Number(body[candidate]))) {
          limit = Number(body[candidate]);
        }
      });
    } catch {
      // ignore
    }
  }

  return { key, value, limit };
}

function buildNextRequest(
  base: HistoryRequestInfo,
  pagination: PaginationState,
  entriesCount: number
): HistoryRequestInfo | null {
  if (!pagination.key) return null;
  let nextValue = pagination.value ?? null;

  if ((nextValue === null || nextValue === undefined) && pagination.hasMore) {
    const lastValue = pagination.lastRequestValue;
    if (typeof lastValue === 'number') {
      if (pagination.key.toLowerCase().includes('page')) {
        nextValue = lastValue + 1;
      } else if (pagination.key.toLowerCase().includes('offset')) {
        const increment = pagination.limit || entriesCount || 0;
        nextValue = lastValue + increment;
      }
    }
  }

  if (nextValue === null || nextValue === undefined) return null;
  const url = new URL(base.url, location.origin);
  let body = base.body || null;

  if (base.method.toUpperCase() === 'GET' || url.searchParams.has(pagination.key)) {
    url.searchParams.set(pagination.key, String(nextValue));
  } else if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      parsed[pagination.key] = nextValue;
      body = JSON.stringify(parsed);
    } catch {
      url.searchParams.set(pagination.key, String(nextValue));
    }
  } else {
    url.searchParams.set(pagination.key, String(nextValue));
  }

  return {
    ...base,
    url: url.toString(),
    body,
  };
}

function injectHistoryInterceptor(): void {
  if (document.getElementById(INTERCEPTOR_ID)) return;
  const script = document.createElement('script');
  script.id = INTERCEPTOR_ID;
  // Execute in page context and clean up the script element afterward.
  script.textContent = `
(() => {
  if (window.__deepseekVoyagerHistoryInterceptor) return;
  window.__deepseekVoyagerHistoryInterceptor = true;
  const EVENT_NAME = '${HISTORY_EVENT}';
  const TRACK_REGEX = new RegExp('${TRACK_URL_PATTERN}', 'i');
  const shouldTrack = (rawUrl) => {
    try {
      const u = new URL(rawUrl, location.origin);
      if (u.origin !== location.origin) return false;
      return TRACK_REGEX.test(u.pathname + u.search);
    } catch {
      return false;
    }
  };
  const toHeaders = (headers) => {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
        return out;
      }
      if (Array.isArray(headers)) {
        headers.forEach((pair) => {
          if (!pair) return;
          const [key, value] = pair;
          if (key) out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }
      if (typeof headers === 'object') {
        Object.keys(headers).forEach((key) => { out[String(key).toLowerCase()] = String(headers[key]); });
      }
    } catch {}
    return out;
  };
  const dispatch = (detail) => {
    try { window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail })); } catch {}
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function(input, init) {
      const response = await origFetch.apply(this, arguments);
      try {
        const req = input && input.url ? input : null;
        const url = req ? req.url : String(input);
        const method = (init && init.method) || (req && req.method) || 'GET';
        const headers = toHeaders((init && init.headers) || (req && req.headers));
        const body = init && typeof init.body === 'string' ? init.body : null;
        const clone = response.clone();
        clone.json().then((data) => {
          if (!shouldTrack(url)) return;
          dispatch({ url, request: { url, method, headers, body }, data });
        }).catch(() => { /* ignore non-JSON responses */ });
      } catch {}
      return response;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__gvMethod = method;
    this.__gvUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    this.__gvBody = body;
    const xhr = this;
    const onReady = () => {
      if (xhr.readyState !== 4) return;
      try {
        const text = xhr.responseText;
        const data = JSON.parse(text);
        if (!shouldTrack(xhr.__gvUrl)) return;
        dispatch({
          url: xhr.__gvUrl,
          request: { url: xhr.__gvUrl, method: xhr.__gvMethod || 'GET', headers: {}, body: typeof body === 'string' ? body : null },
          data,
        });
      } catch {}
    };
    try { xhr.addEventListener('readystatechange', onReady); } catch {}
    return origSend.apply(this, arguments);
  };
})();
`;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

class HistoryCollector {
  private readonly indexService: SearchIndexService;
  private statusCallback: ((payload: StatusPayload) => void) | null = null;
  private updateCallback: (() => void) | null = null;
  private sidebarObserver: MutationObserver | null = null;
  private sidebarScanTimer: number | null = null;
  private lastRequest: HistoryRequestInfo | null = null;
  private pagination: PaginationState | null = null;
  private activeTimer: number | null = null;
  private activeInFlight = false;
  private isActive = false;
  private lastEntriesCount = 0;
  private started = false;
  private visibilityHandler: (() => void) | null = null;
  private emptyScanCount = 0;

  constructor(indexService: SearchIndexService) {
    this.indexService = indexService;
  }

  onStatusChange(callback: (payload: StatusPayload) => void): void {
    this.statusCallback = callback;
  }

  onIndexUpdate(callback: () => void): void {
    this.updateCallback = callback;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    injectHistoryInterceptor();
    window.addEventListener(HISTORY_EVENT, this.handleHistoryResponse as EventListener);
    if (!this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (this.isActive && !document.hidden) {
          this.fetchNextPage();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    waitForSidebarContainer()
      .then((sidebar) => {
        if (!sidebar) return;
        this.setupSidebarObserver(sidebar);
        this.scanSidebar();
      })
      .catch(() => undefined);
  }

  stop(): void {
    window.removeEventListener(HISTORY_EVENT, this.handleHistoryResponse as EventListener);
    this.started = false;
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.sidebarObserver) {
      this.sidebarObserver.disconnect();
      this.sidebarObserver = null;
    }
    if (this.sidebarScanTimer) {
      window.clearTimeout(this.sidebarScanTimer);
      this.sidebarScanTimer = null;
    }
    this.stopActive(true);
  }

  toggleActive(): void {
    if (this.isActive) {
      this.stopActive(true);
    } else {
      this.startActive();
    }
  }

  getActiveState(): boolean {
    return this.isActive;
  }

  private startActive(): void {
    this.isActive = true;
    this.notifyStatus({ status: 'indexing' });
    this.fetchNextPage();
    if (this.activeTimer) window.clearInterval(this.activeTimer);
    this.activeTimer = window.setInterval(() => this.fetchNextPage(), ACTIVE_POLL_INTERVAL_MS);
  }

  private stopActive(resetStatus: boolean): void {
    this.isActive = false;
    if (this.activeTimer) {
      window.clearInterval(this.activeTimer);
      this.activeTimer = null;
    }
    if (resetStatus) {
      this.notifyStatus({ status: 'idle' });
    }
  }

  private notifyStatus(payload: StatusPayload): void {
    if (this.statusCallback) this.statusCallback(payload);
  }

  private setupSidebarObserver(sidebar: HTMLElement): void {
    if (this.sidebarObserver) this.sidebarObserver.disconnect();
    this.emptyScanCount = 0;
    this.sidebarObserver = new MutationObserver(() => this.scheduleSidebarScan());
    // Use childList only (not subtree) to reduce noise from deep DOM changes.
    // The conversation list is a direct child of the sidebar, so childList is sufficient.
    this.sidebarObserver.observe(sidebar, { childList: true, subtree: false });
  }

  private scheduleSidebarScan(): void {
    if (this.sidebarScanTimer) window.clearTimeout(this.sidebarScanTimer);
    this.sidebarScanTimer = window.setTimeout(() => {
      this.sidebarScanTimer = null;
      this.scanSidebar();
    }, SCAN_DEBOUNCE_MS);
  }

  private scanSidebar(): void {
    const items = tryFindElements(DEEPSEEK_SELECTORS.conversationItem) as Element[];
    if (!items || items.length === 0) {
      this.emptyScanCount++;
      // Auto-disconnect observer after too many empty scans to prevent thrashing.
      // This happens when the selector doesn't match the current DOM structure.
      if (this.emptyScanCount >= MAX_EMPTY_SCANS && this.sidebarObserver) {
        this.sidebarObserver.disconnect();
        this.sidebarObserver = null;
      }
      return;
    }
    // Reset counter on successful scan
    this.emptyScanCount = 0;
    const entries: ConversationIndexEntry[] = [];
    items.forEach((item) => {
      // Try to get href from the item itself (if it's an <a>), or from a child <a>
      let anchorEl = item.tagName === 'A' ? (item as HTMLAnchorElement) : null;
      if (!anchorEl) {
        anchorEl = item.querySelector<HTMLAnchorElement>('a');
      }
      const href = anchorEl?.getAttribute('href') || '';
      let id = extractConversationId(href);
      // If href-based extraction failed, try data attributes (for non-<a> items like div/button)
      if (!id && item.tagName !== 'A') {
        const dataId = item.getAttribute('data-conversation-id') ||
                       item.getAttribute('data-id') ||
                       item.getAttribute('data-session-id') ||
                       '';
        if (dataId) id = dataId;
      }
      if (!id) return;
      const titleCandidate =
        normalizeText(item.querySelector('div, span')?.textContent || '') ||
        normalizeText(item.textContent || '');
      if (!titleCandidate) return;
      entries.push({
        id,
        title: titleCandidate,
        updatedAt: Date.now(),
        url: href.startsWith('http') ? href : `${DEEPSEEK_ORIGIN}${href}`,
      });
    });
    if (this.indexService.upsert(entries)) {
      this.updateCallback?.();
    }
  }

  private handleHistoryResponse = (event: CustomEvent<HistoryResponseDetail>): void => {
    const detail = event?.detail;
    if (!detail?.data || !detail?.url) return;
    const entries = extractEntriesFromPayload(detail.data);
    if (entries.length === 0) return;
    this.lastEntriesCount = entries.length;
    this.lastRequest = detail.request?.url ? detail.request : { ...detail.request, url: detail.url };
    this.pagination = extractPagination(detail.data, this.lastRequest);
    if (this.indexService.upsert(entries)) {
      this.updateCallback?.();
    }
    if (this.isActive && this.pagination?.hasMore === false) {
      this.notifyStatus({ status: 'done' });
      this.stopActive(false);
    }
  };

  private async fetchNextPage(): Promise<void> {
    if (!this.isActive || this.activeInFlight) return;
    if (document.hidden) return;
    if (!this.lastRequest || !this.pagination) {
      this.notifyStatus({ status: 'waiting' });
      return;
    }
    const nextRequest = buildNextRequest(this.lastRequest, this.pagination, this.lastEntriesCount);
    if (!nextRequest) {
      this.notifyStatus({ status: 'done' });
      this.stopActive(false);
      return;
    }
    this.activeInFlight = true;
    this.notifyStatus({ status: 'indexing' });
    try {
      const response = await fetch(nextRequest.url, {
        method: nextRequest.method,
        headers: nextRequest.headers,
        body: nextRequest.body ?? undefined,
        credentials: 'include',
      });
      const data = await response.json();
      const entries = extractEntriesFromPayload(data);
      this.lastEntriesCount = entries.length;
      this.lastRequest = nextRequest;
      this.pagination = extractPagination(data, nextRequest);
      if (this.indexService.upsert(entries)) {
        this.updateCallback?.();
      }
      if (entries.length === 0 || this.pagination?.hasMore === false) {
        this.notifyStatus({ status: 'done' });
        this.stopActive(false);
      }
    } catch {
      this.notifyStatus({ status: 'error' });
      this.stopActive(false);
    } finally {
      this.activeInFlight = false;
    }
  }
}

async function waitForSidebarContainer(): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const attempt = () => {
      // Try to find a container that looks like the sidebar (not the main chat area).
      // The sidebar typically contains conversation links/data, while the main chat area
      // contains message turns. We prefer containers that have conversation-like elements.
      const sidebar = findSidebarContainer();
      if (sidebar) {
        resolve(sidebar);
        return;
      }
      if (Date.now() - startedAt > SIDEBAR_WAIT_TIMEOUT_MS) {
        resolve(null);
      } else {
        setTimeout(attempt, SIDEBAR_POLL_INTERVAL_MS);
      }
    };
    attempt();
  });
}

/**
 * Find the sidebar container, preferring the actual sidebar over the main chat area.
 * Both can match .ds-scroll-area, so we disambiguate by position and width.
 *
 * DeepSeek layout (verified via DOM inspection):
 *   - Sidebar:   left ~10-12px,  width ~236-240px  (class: _3586175 ds-scroll-area)
 *   - Chat area:  left ~261px,    width ~775px       (class: _765a5cd ds-scroll-area)
 *   - Text input: left ~294px,    width ~709px       (class: _27c9245 ds-scroll-area)
 */
function findSidebarContainer(): HTMLElement | null {
  // Strategy 1: Positional heuristic — find .ds-scroll-area on the left (sidebar)
  const areas = document.querySelectorAll<HTMLElement>('.ds-scroll-area');
  let bestMatch: HTMLElement | null = null;
  for (const area of areas) {
    const rect = area.getBoundingClientRect();
    if (rect.left < 50 && rect.width > 100 && rect.width < 300 && !bestMatch) {
      bestMatch = area;
    }
  }
  if (bestMatch) return bestMatch;

  // Strategy 2: Find the element containing the most conversation links
  const candidates = document.querySelectorAll<HTMLElement>(
    '.ds-scroll-area, [class*="sidebar"], nav, aside'
  );
  let bestScore = -1;
  candidates.forEach((el) => {
    const links = el.querySelectorAll('a[href*="/a/chat/s/"], a[href*="/chat/"]');
    if (links.length > bestScore) {
      bestScore = links.length;
      bestMatch = el;
    }
  });
  if (bestMatch) return bestMatch;

  // Strategy 3: Fall back to the original selector
  const container = tryFindElement(DEEPSEEK_SELECTORS.sidebarContainer);
  if (container) return container as HTMLElement;

  return null;
}

function renderResults(
  container: HTMLElement,
  results: ReturnType<SearchIndexService['search']>,
  query: string,
  t: (key: string, vars?: Record<string, string>) => string
): void {
  container.innerHTML = '';
  if (!query) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';

  const header = document.createElement('div');
  header.className = 'gv-search-results-header';
  header.textContent = t('search_results_count', { count: String(results.length) });
  container.appendChild(header);

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gv-search-results-empty';
    empty.textContent = t('search_no_results');
    container.appendChild(empty);
    return;
  }

  results.forEach((result) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'gv-search-result';
    const title = document.createElement('div');
    title.className = 'gv-search-result-title';
    title.innerHTML = highlightText(result.title, query);
    item.appendChild(title);

    if (result.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'gv-search-result-snippet';
      snippet.innerHTML = highlightText(result.snippet, query);
      item.appendChild(snippet);
    }

    item.addEventListener('click', () => {
      const url = result.url || buildConversationUrl(result.id);
      window.location.href = url;
    });
    container.appendChild(item);
  });
}

export async function startSearch(): Promise<void> {
  try {
    await initI18n();
  } catch {
    // ignore
  }
  const t = (key: string, vars?: Record<string, string>) => {
    const template = getTranslationSync(key);
    if (!vars) return template;
    return Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), template);
  };

  const sidebar = await waitForSidebarContainer();
  if (!sidebar) return;
  if (document.querySelector('.gv-search-container')) return;

  const container = document.createElement('div');
  container.className = 'gv-search-container';

  const bar = document.createElement('div');
  bar.className = 'gv-search-bar';

  const input = document.createElement('input');
  input.className = 'gv-search-input';
  input.type = 'search';
  input.placeholder = t('search_placeholder');

  const button = document.createElement('button');
  button.className = 'gv-search-index-btn';
  button.type = 'button';
  button.textContent = t('search_index_start');

  const status = document.createElement('span');
  status.className = 'gv-search-status';

  bar.appendChild(input);
  bar.appendChild(button);
  container.appendChild(bar);
  container.appendChild(status);

  const results = document.createElement('div');
  results.className = 'gv-search-results';
  container.appendChild(results);

  sidebar.insertBefore(container, sidebar.firstChild);

  const indexService = new SearchIndexService();
  await indexService.load();
  const historyCollector = new HistoryCollector(indexService);

  const updateStatus = (payload: StatusPayload) => {
    switch (payload.status) {
      case 'waiting':
        status.textContent = t('search_index_waiting');
        break;
      case 'indexing':
        status.textContent = t('search_indexing');
        break;
      case 'done':
        status.textContent = t('search_index_done');
        break;
      case 'error':
        status.textContent = t('search_index_error');
        break;
      default:
        status.textContent = '';
    }
  };

  historyCollector.onStatusChange((payload) => {
    updateStatus(payload);
    button.textContent = historyCollector.getActiveState()
      ? t('search_index_stop')
      : t('search_index_start');
  });
  historyCollector.onIndexUpdate(() => {
    if (input.value) {
      renderResults(results, indexService.search(input.value), input.value, t);
    }
  });
  historyCollector.start();

  let searchTimer: number | null = null;
  input.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      renderResults(results, indexService.search(input.value), input.value, t);
    }, 200);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      renderResults(results, [], '', t);
    }
  });

  button.addEventListener('click', () => {
    historyCollector.toggleActive();
    button.textContent = historyCollector.getActiveState()
      ? t('search_index_stop')
      : t('search_index_start');
  });
}

export default { startSearch };
