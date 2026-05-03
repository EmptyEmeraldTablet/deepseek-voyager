/**
 * DeepSeek Selectors Configuration
 * 
 * 重要提示：DeepSeek 使用混淆类名（如 _a1b2c3d），这些类名在每次部署时都会改变。
 * 因此我们采用多层级后备策略，优先使用稳定的选择器。
 */

export interface SelectorConfig {
  primary: string;           // 主选择器（最稳定）
  fallbacks: string[];       // 后备选择器列表
  description: string;       // 描述
}

/**
 * 选择器配置
 */
export const DEEPSEEK_SELECTORS = {
  /**
   * 用户消息选择器
   * DeepSeek 的用户消息有固定类名 d29f3d7d（根据实际测试）
   * 用户消息格式：<div class="d29f3d7d ds-message _63c77b1">
   * 助手消息格式：<div class="ds-message _63c77b1">
   */
  userMessage: {
    primary: '.d29f3d7d.ds-message',  // 用户消息的固定类名组合
    fallbacks: [
      '.ds-message',  // 如果上面失效，回退到通用选择器
      '[class*="ds-message"]',
    ],
    description: '用户消息元素',
  } as SelectorConfig,

  /**
   * 侧边栏容器选择器
   *
   * 实际 DOM 结构（已验证）：
   *   - 侧边栏：    left ~10-12px,  width ~236-240px  (class: _3586175 ds-scroll-area)
   *   - 聊天区域：   left ~261px,    width ~775px       (class: _765a5cd ds-scroll-area)
   *
   * 注意：.ds-scroll-area 在主聊天区域也存在，因此实际查找时
   * 使用 findSidebarContainer() 通过位置启发式区分。
   * 此配置仅在位置启发式失败时作为后备使用。
   */
  sidebarContainer: {
    primary: '.ds-scroll-area',
    fallbacks: [
      '[class*="ds-scroll"]',
      '[class*="sidebar"]',
      'nav',
      'aside',
    ],
    description: '侧边栏容器',
  } as SelectorConfig,

  /**
   * 对话项选择器
   *
   * 实际 DOM 结构（已验证）：
   *   <a class="_546d736 b64fb9ae" href="/a/chat/s/{uuid}">
   *     <div class="c08e6e93">对话标题</div>
   *   </a>
   *
   * 主选择器 a[href*="/a/chat/s/"] 可匹配侧边栏对话链接。
   * 注意：首次页面加载时对话列表可能尚未通过 API 加载，
   * 因此扫描需要等待 DOM 更新。
   */
  conversationItem: {
    primary: 'a[href*="/a/chat/s/"]',  // <a href="/a/chat/s/{uuid}"> 已验证
    fallbacks: [
      'a[href*="/chat/"]',
      'a[href*="/s/"]',
      '[class*="conversation"]',
      '[class*="chat-item"]',
      '[class*="session-item"]',
      '[data-test-id="conversation"]',
      '[role="listitem"]',
      'button[class*="conversation"]',
    ],
    description: '侧边栏对话项',
  } as SelectorConfig,

  /**
   * 对话标题选择器
   */
  conversationTitle: {
    primary: 'a[href*="/a/chat/s/"] div',  // 对话链接内的第一个 div
    fallbacks: [
      'a[href*="/a/chat/s/"] span',
      '[class*="title"]',
      '[class*="name"]',
    ],
    description: '对话标题',
  } as SelectorConfig,

  /**
   * 主滚动容器选择器
   */
  scrollContainer: {
    primary: '.ds-scroll-area',
    fallbacks: [
      '[class*="scroll"]',
      'main',
      '#root',
    ],
    description: '主对话区域滚动容器',
  } as SelectorConfig,
};

/**
 * 尝试使用选择器配置查找元素
 * @param config 选择器配置
 * @param parent 父元素，默认为 document
 * @returns 找到的元素或 null
 */
export function tryFindElement(
  config: SelectorConfig,
  parent: Element | Document = document,
  quiet = false
): Element | null {
  // 先尝试主选择器
  let element = parent.querySelector(config.primary);
  if (element) return element;

  // 尝试后备选择器
  for (const fallback of config.fallbacks) {
    try {
      element = parent.querySelector(fallback);
      if (element) {
        if (!quiet) {
          console.warn(
            `[DeepSeek Voyager] ${config.description} 使用后备选择器: ${fallback}`
          );
        }
        return element;
      }
    } catch (e) {
      // 某些选择器可能无效，忽略错误
      continue;
    }
  }

  if (!quiet) {
    console.warn(`[DeepSeek Voyager] 无法找到 ${config.description}`);
  }
  return null;
}

/**
 * 尝试使用选择器配置查找所有元素
 */
export function tryFindElements(
  config: SelectorConfig,
  parent: Element | Document = document,
  quiet = false
): NodeListOf<Element> | Element[] {
  // 先尝试主选择器
  let elements = parent.querySelectorAll(config.primary);
  if (elements.length > 0) return elements;

  // 尝试后备选择器
  for (const fallback of config.fallbacks) {
    try {
      elements = parent.querySelectorAll(fallback);
      if (elements.length > 0) {
        if (!quiet) {
          console.warn(
            `[DeepSeek Voyager] ${config.description} 使用后备选择器: ${fallback}`
          );
        }
        return elements;
      }
    } catch (e) {
      continue;
    }
  }

  if (!quiet) {
    console.warn(`[DeepSeek Voyager] 无法找到 ${config.description}`);
  }
  return [];
}

/**
 * 从 href 属性中提取对话 ID
 * @param href URL 或路径
 * @returns UUID 格式的对话 ID
 */
export function extractConversationId(href: string): string | null {
  // DeepSeek 的对话 URL 格式: /a/chat/s/[UUID]
  const match = href.match(/\/a\/chat\/s\/([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

/**
 * 构建对话 URL
 * @param conversationId UUID 格式的对话 ID
 * @returns 完整的对话 URL
 */
export function buildConversationUrl(conversationId: string): string {
  return `https://chat.deepseek.com/a/chat/s/${conversationId}`;
}

/**
 * 检测当前是否在对话页面
 */
export function isConversationRoute(pathname = location.pathname): boolean {
  return /^\/a\/chat\/s\/[a-f0-9-]{36}/i.test(pathname);
}

/**
 * 从当前 URL 获取对话 ID
 */
export function getCurrentConversationId(): string | null {
  return extractConversationId(location.pathname);
}


