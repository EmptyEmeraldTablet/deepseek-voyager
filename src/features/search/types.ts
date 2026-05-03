export type ConversationIndexEntry = {
  id: string;
  title: string;
  updatedAt: number;
  snippet?: string;
  url?: string;
};

export type SearchResult = {
  id: string;
  title: string;
  snippet?: string;
  url?: string;
  matchedField: 'title' | 'snippet';
  updatedAt: number;
};

export type SearchIndexSnapshot = {
  version: 1;
  updatedAt: number;
  entries: Record<string, ConversationIndexEntry>;
};
