# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Conversation search** now uses pure DOM-based indexing — removed network interception due to Chrome extension security restrictions
  - Conversations are indexed automatically from sidebar DOM
  - To index more history, scroll the sidebar; DeepSeek loads more as you scroll
  - Removed manual "Index history" button (auto-indexing on DOM changes)
- **Extension name** fixed to "DeepSeek Voyager" in all locales and popup

### Added
- **Conversation search** 🔍
  - Full-text search across conversation history (title + content)
  - Local search index built from DeepSeek's history API
  - Real-time search results with highlighted keyword matches
  - Index progress indicator with start/stop control
  - Supports dark/light theme
  - Bounded index size (up to 2000 entries) for efficient storage

- **Safari browser support** 🎉
  - Safari build configuration and development mode
  - Installation guide ([EN](safari/INSTALLATION.md) | [中文](safari/INSTALLATION_ZH.md))
  - Development guide ([EN](.../../../safari/README.md) | [中文](.../../../safari/README_ZH.md))
  - New commands: `build:safari`, `dev:safari`, `build:all`
  
- **Conversation export (Markdown/PDF)**
  - Rich Markdown export with formulas, code blocks, tables, lists, headings
  - Auto-package images: if a chat contains user-uploaded images, export a ZIP with `chat.md` and `assets/` (images rewritten to relative paths)
  - PDF export: inline images (best-effort) and print-optimized styles
  - Background service worker for cross-origin image fetch; added host permissions for Google image domains

### Changed
- **Cross-browser compatibility**
  - Migrated to `browser.*` API via `webextension-polyfill` for better compatibility
  - All storage APIs now use async/await pattern
  
- **Export robustness**
  - More resilient DOM extraction (supports Angular/custom elements; better selectors)
  - Reduced noisy logs; cleaner fallback paths
  - PDF images constrained (max-width ~60%) to avoid oversized visuals

### Fixed
- **Dependencies**
  - Downgraded `marked` to v11 for compatibility
  - Upgraded `@typescript-eslint/eslint-plugin` to v8
  - Resolved peer dependency conflicts
  
- **Export correctness**
  - Fixed duplicate inclusion of code blocks/tables in Markdown
  - Fixed export button causing navigation back to `/app` on Gemini
  - Addressed missing assistant content by adding last-chance plaintext fallback
  - Avoid CORS failures for images in Markdown by packaging images into ZIP (with relative paths)

### Supported Browsers
- **Chromium** (Chrome, Edge, Opera, Brave, Vivaldi, Arc)
- **Gecko** (Firefox)
- **WebKit** (Safari) ⭐ NEW

## [0.6.1] - Previous Release

### Features
- Interactive conversation timeline
- Folder management
- Prompt library with search
- Chat export to JSON
- Cross-tab star sync
- Markdown/KaTeX rendering
- Multi-language (EN, 中文)

---

## Migration Notes

### Users
- Chrome/Firefox: No changes needed
- Safari: See [installation guide](.github/docs/safari/INSTALLATION.md)

### Developers
- API changed from `chrome.*` to `browser.*`
- Storage now uses Promises (async/await)
- New Safari build commands available

