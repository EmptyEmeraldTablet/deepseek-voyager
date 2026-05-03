import browser from 'webextension-polyfill';

import type { ConversationIndexEntry, SearchIndexSnapshot, SearchResult } from '../types';

const STORAGE_KEY = 'gvSearchIndex';
const STORAGE_VERSION: SearchIndexSnapshot['version'] = 1;
const MAX_ENTRIES = 2000; // Limit index size to keep storage usage and search performance bounded.
const SAVE_DEBOUNCE_MS = 800;

type Listener = () => void;

function safeParseJSON<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeEntry(entry: ConversationIndexEntry): ConversationIndexEntry {
  return {
    ...entry,
    title: normalizeText(entry.title),
    snippet: entry.snippet ? normalizeText(entry.snippet) : undefined,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
  };
}

export class SearchIndexService {
  private entries = new Map<string, ConversationIndexEntry>();
  private saveTimer: number | null = null;
  private loaded = false;
  private listeners = new Set<Listener>();

  async load(): Promise<void> {
    if (this.loaded) return;
    const fallback: SearchIndexSnapshot = {
      version: STORAGE_VERSION,
      updatedAt: Date.now(),
      entries: {},
    };

    let snapshot: SearchIndexSnapshot = fallback;
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      if (stored && stored[STORAGE_KEY]) {
        snapshot = stored[STORAGE_KEY] as SearchIndexSnapshot;
      }
    } catch {
      const raw = safeParseJSON<SearchIndexSnapshot>(
        typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null,
        fallback
      );
      snapshot = raw;
    }

    if (snapshot?.version !== STORAGE_VERSION || !snapshot?.entries) {
      this.entries.clear();
      this.loaded = true;
      return;
    }
    Object.entries(snapshot.entries).forEach(([id, entry]) => {
      if (!id || !entry) return;
      this.entries.set(id, normalizeEntry(entry));
    });
    this.loaded = true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.entries.size;
  }

  upsert(entries: ConversationIndexEntry[]): boolean {
    if (!entries || entries.length === 0) return false;
    let changed = false;
    entries.forEach((raw) => {
      if (!raw?.id) return;
      const entry = normalizeEntry(raw);
      if (!entry.title) return;
      const existing = this.entries.get(entry.id);
      if (!existing) {
        this.entries.set(entry.id, entry);
        changed = true;
        return;
      }
      if (
        existing.title !== entry.title ||
        existing.snippet !== entry.snippet ||
        existing.updatedAt !== entry.updatedAt ||
        existing.url !== entry.url
      ) {
        this.entries.set(entry.id, {
          ...existing,
          ...entry,
          updatedAt: Math.max(existing.updatedAt || 0, entry.updatedAt || 0),
        });
        changed = true;
      }
    });

    if (!changed) return false;
    this.pruneIfNeeded();
    this.scheduleSave();
    this.notify();
    return true;
  }

  search(query: string, limit = 50): SearchResult[] {
    const q = normalizeText(query).toLowerCase();
    if (!q) return [];
    const results: SearchResult[] = [];
    this.entries.forEach((entry) => {
      const title = entry.title.toLowerCase();
      if (title.includes(q)) {
        results.push({
          id: entry.id,
          title: entry.title,
          snippet: entry.snippet,
          url: entry.url,
          matchedField: 'title',
          updatedAt: entry.updatedAt,
        });
        return;
      }
      if (entry.snippet && entry.snippet.toLowerCase().includes(q)) {
        results.push({
          id: entry.id,
          title: entry.title,
          snippet: entry.snippet,
          url: entry.url,
          matchedField: 'snippet',
          updatedAt: entry.updatedAt,
        });
      }
    });
    return results
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }

  private pruneIfNeeded(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
    );
    const trimmed = sorted.slice(0, MAX_ENTRIES);
    this.entries = new Map(trimmed.map((entry) => [entry.id, entry]));
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    // Debounce saves to batch rapid updates; latest map state is persisted on flush.
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    const snapshot: SearchIndexSnapshot = {
      version: STORAGE_VERSION,
      updatedAt: Date.now(),
      entries: Object.fromEntries(this.entries),
    };
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: snapshot });
      return;
    } catch {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        }
      } catch {
        // ignore storage failures
      }
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    });
  }
}
