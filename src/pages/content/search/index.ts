import {
  extractConversationId,
  buildConversationUrl,
} from '../deepseek/selectors';

import { SearchIndexService } from '@/features/search/services/SearchIndexService';
import type { ConversationIndexEntry } from '@/features/search/types';
import { initI18n, getTranslationSync } from '@/utils/i18n';


type IndexStatus = 'idle' | 'indexing' | 'done';

type StatusPayload = {
  status: IndexStatus;
  message?: string;
};

const SCAN_DEBOUNCE_MS = 300;
const SIDEBAR_WAIT_TIMEOUT_MS = 20000;
const SIDEBAR_POLL_INTERVAL_MS = 500;
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';

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

class HistoryCollector {
  private readonly indexService: SearchIndexService;
  private statusCallback: ((payload: StatusPayload) => void) | null = null;
  private updateCallback: (() => void) | null = null;
  private sidebarObserver: MutationObserver | null = null;
  private sidebarScanTimer: number | null = null;
  private isActive = false;
  private started = false;

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
    waitForSidebarContainer()
      .then((sidebar) => {
        if (!sidebar) return;
        this.setupSidebarObserver(sidebar);
        this.scanSidebar();
      })
      .catch(() => undefined);
  }

  stop(): void {
    this.started = false;
    if (this.sidebarObserver) {
      this.sidebarObserver.disconnect();
      this.sidebarObserver = null;
    }
    if (this.sidebarScanTimer) {
      window.clearTimeout(this.sidebarScanTimer);
      this.sidebarScanTimer = null;
    }
  }

  toggleActive(): void {
    if (this.isActive) {
      this.isActive = false;
      this.notifyStatus({ status: 'idle' });
    } else {
      // Index mode: scan sidebar DOM for all conversation items, then mark done.
      this.isActive = true;
      this.notifyStatus({ status: 'indexing' });
      this.scanSidebar();
      this.notifyStatus({ status: 'done' });
      this.updateCallback?.();
    }
  }

  getActiveState(): boolean {
    return this.isActive;
  }

  private notifyStatus(payload: StatusPayload): void {
    if (this.statusCallback) this.statusCallback(payload);
  }

  private setupSidebarObserver(sidebar: HTMLElement): void {
    if (this.sidebarObserver) this.sidebarObserver.disconnect();
    this.sidebarObserver = new MutationObserver(() => this.scheduleSidebarScan());
    // Watch for conversation items being added to the sidebar.
    // subtree: true is needed because items are added deep inside the sidebar DOM.
    this.sidebarObserver.observe(sidebar, { childList: true, subtree: true });
  }

  private scheduleSidebarScan(): void {
    if (this.sidebarScanTimer) window.clearTimeout(this.sidebarScanTimer);
    this.sidebarScanTimer = window.setTimeout(() => {
      this.sidebarScanTimer = null;
      this.scanSidebar();
    }, SCAN_DEBOUNCE_MS);
  }

  private scanSidebar(): void {
    // Direct DOM query — no tryFindElements to avoid console noise when empty.
    // The sidebar conversation links use <a href="/a/chat/s/{uuid}"> (verified via DOM inspection).
    const items = document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]');
    if (items.length === 0) return;

    const entries: ConversationIndexEntry[] = [];
    items.forEach((anchor) => {
      const href = anchor.getAttribute('href') || '';
      const id = extractConversationId(href);
      if (!id) return;
      const titleCandidate =
        normalizeText(anchor.querySelector('div, span')?.textContent || '') ||
        normalizeText(anchor.textContent || '');
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

  // Strategy 3: Fall back to any .ds-scroll-area (may be the chat area, but
  // we've already exhausted better strategies)
  const fallback = document.querySelector<HTMLElement>('.ds-scroll-area');
  if (fallback) return fallback;

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
      case 'indexing':
        status.textContent = t('search_indexing');
        break;
      case 'done':
        status.textContent = t('search_index_done');
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
