import type { RemoteActionResultSummary, RemotePageElement, RemotePageState, RemoteTabSummary } from '@extension/shared';
import type { BrowserState } from '../browser/views';
import { DEFAULT_INCLUDE_ATTRIBUTES, DOMElementNode } from '../browser/dom/views';

const MAX_ELEMENTS = 80;
const MAX_SUMMARY_LENGTH = 800;
const MAX_TEXT_LENGTH = 160;
const MAX_SUMMARY_ELEMENTS = 12;

const ROLE_PRIORITIES: Record<string, number> = {
  option: 110,
  listbox: 100,
  menuitem: 95,
  combobox: 90,
  textbox: 85,
  button: 80,
  link: 75,
};

function capText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function inferRole(node: DOMElementNode): string {
  if (node.attributes.role) {
    return node.attributes.role;
  }

  switch (node.tagName) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input': {
      const type = node.attributes.type?.toLowerCase() || 'text';
      if (['submit', 'button', 'reset'].includes(type)) {
        return 'button';
      }
      if (type === 'checkbox') {
        return 'checkbox';
      }
      if (type === 'radio') {
        return 'radio';
      }
      return 'textbox';
    }
    default:
      return node.tagName || 'element';
  }
}

function readElementValue(node: DOMElementNode): string {
  return capText(
    node.attributes.value ||
      node.attributes['aria-valuetext'] ||
      node.attributes['data-value'] ||
      node.attributes.content ||
      '',
  );
}

function readElementUrl(node: DOMElementNode): string {
  return capText(node.attributes.href || node.attributes.src || node.attributes['data-href'] || '');
}

function hasMeaningfulText(node: DOMElementNode): boolean {
  return Boolean(
    node.getAllTextTillNextClickableElement(2).trim() ||
      node.attributes['aria-label'] ||
      node.attributes.placeholder ||
      node.attributes.title ||
      node.attributes.name ||
      node.attributes.value,
  );
}

function scoreElement(node: DOMElementNode): number {
  const role = inferRole(node);
  const tagName = node.tagName?.toLowerCase() || '';
  let score = 0;

  if (node.isVisible) score += 90;
  if (node.isInViewport) score += 120;
  if (node.isTopElement) score += 50;
  if (node.isInteractive) score += 50;
  if (hasMeaningfulText(node)) score += 55;
  if (tagName && ['input', 'textarea', 'button', 'a', 'select'].includes(tagName)) score += 35;
  if (node.attributes['aria-expanded'] === 'true') score += 25;
  if (node.attributes['aria-selected'] === 'true') score += 20;
  if (node.attributes['aria-controls']) score += 20;
  if (node.attributes.role === 'option' || node.attributes.role === 'listbox') score += 45;

  score += ROLE_PRIORITIES[role] || 0;

  return score;
}

function collectPriorityElements(state: BrowserState): Array<[number, DOMElementNode]> {
  return Array.from(state.selectorMap.entries())
    .filter(([, node]) => node instanceof DOMElementNode)
    .sort(([leftIndex, leftNode], [rightIndex, rightNode]) => {
      const scoreDelta = scoreElement(rightNode) - scoreElement(leftNode);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const visibleDelta = Number(rightNode.isVisible) - Number(leftNode.isVisible);
      if (visibleDelta !== 0) {
        return visibleDelta;
      }

      const viewportDelta = Number(rightNode.isInViewport) - Number(leftNode.isInViewport);
      if (viewportDelta !== 0) {
        return viewportDelta;
      }

      return leftIndex - rightIndex;
    })
    .slice(0, MAX_ELEMENTS);
}

function buildElement(node: DOMElementNode, index: number): RemotePageElement {
  const text = capText(node.getAllTextTillNextClickableElement(2));
  const value = readElementValue(node);
  const url = readElementUrl(node);
  const label = capText(
    node.attributes['aria-label'] ||
      node.attributes.placeholder ||
      node.attributes.title ||
      node.attributes.name ||
      value ||
      text,
  );

  return {
    id: `e${index}`,
    role: inferRole(node),
    text,
    label,
    selector: node.getEnhancedCssSelector(),
    visible: node.isVisible && node.isInViewport,
    enabled: node.attributes.disabled !== 'true' && node.attributes['aria-disabled'] !== 'true',
    value: value || undefined,
    url: url || undefined,
    tag_name: node.tagName || undefined,
  };
}

function buildSummary(state: BrowserState, prioritizedElements: Array<[number, DOMElementNode]>): string {
  const prioritizedSummary = prioritizedElements
    .slice(0, MAX_SUMMARY_ELEMENTS)
    .map(([index, node]) => {
      const element = buildElement(node, index);
      const parts = [`[${element.id}]`, element.role];
      if (element.label) parts.push(`label="${element.label}"`);
      if (element.text && element.text !== element.label) parts.push(`text="${element.text}"`);
      if (element.value) parts.push(`value="${element.value}"`);
      return parts.join(' ');
    })
    .join('\n');

  const summary = prioritizedSummary
    ? prioritizedSummary
    : state.elementTree.clickableElementsToString(DEFAULT_INCLUDE_ATTRIBUTES).replace(/\s+\n/g, '\n').trim();

  return capText(summary, MAX_SUMMARY_LENGTH);
}

function buildTabs(state: BrowserState): RemoteTabSummary[] {
  return (state.tabs || []).map(tab => ({
    tab_id: tab.id,
    target_id: `tab_${tab.id}`,
    url: tab.url,
    title: tab.title,
    active: tab.id === state.tabId,
  }));
}

export function buildSnapshotSlice(
  pageState: RemotePageState,
  opts: {
    limit?: number;
    maxChars?: number;
    selector?: string;
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
  } = {},
): {
  elements: RemotePageElement[];
  refs: Record<string, string>;
  summary: string;
  truncated: boolean;
  stats: { total: number; returned: number };
} {
  const selectorFilter = typeof opts.selector === 'string' ? opts.selector.trim() : '';
  let elements = Array.isArray(pageState.elements) ? [...pageState.elements] : [];

  if (selectorFilter) {
    elements = elements.filter(element => typeof element.selector === 'string' && element.selector.includes(selectorFilter));
  }

  if (opts.interactive) {
    elements = elements.filter(element => element.visible !== false && element.enabled !== false);
  }

  const total = elements.length;
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : total;
  elements = elements.slice(0, limit);

  const lines = elements.map(element => {
    const parts = [compactElementPrefix(element, opts.compact !== false)];
    if (element.label) parts.push(`label="${element.label}"`);
    if (element.text && element.text !== element.label) parts.push(`text="${element.text}"`);
    if (element.value) parts.push(`value="${element.value}"`);
    return parts.join(' ');
  });

  const combined = lines.join('\n');
  const maxChars =
    typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars) && opts.maxChars > 0
      ? Math.floor(opts.maxChars)
      : Infinity;
  const summary = capText(combined || pageState.page_text_summary || '', maxChars);

  return {
    elements,
    refs: Object.fromEntries(elements.map(element => [element.id, element.role || 'element'])),
    summary,
    truncated: summary.length < combined.length,
    stats: {
      total,
      returned: elements.length,
    },
  };
}

function compactElementPrefix(element: RemotePageElement, compact: boolean): string {
  if (!compact) {
    return `[${element.id}] ${element.role || 'element'}`;
  }

  return `[${element.id}] ${element.role || 'element'} ${element.visible === false ? 'hidden' : 'visible'} ${
    element.enabled === false ? 'disabled' : 'enabled'
  }`;
}

export function buildRemotePageState(
  state: BrowserState,
  sessionId: string,
  lastActionResult: RemoteActionResultSummary | null,
  screenshotRef: string | null,
): RemotePageState {
  const prioritizedElements = collectPriorityElements(state);
  const elements = prioritizedElements.map(([index, node]) => buildElement(node, index));

  return {
    session_id: sessionId,
    tab_id: state.tabId,
    url: state.url,
    title: state.title,
    viewport: {
      width: 1280,
      height: state.visualViewportHeight || 1100,
    },
    page_text_summary: buildSummary(state, prioritizedElements),
    elements,
    tabs: buildTabs(state),
    last_action_result: lastActionResult,
    screenshot_ref: screenshotRef,
  };
}

export function parseRemoteElementId(elementId: string): number {
  if (!/^e\d+$/.test(elementId)) {
    throw new Error(`Invalid element_id: ${elementId}`);
  }

  return Number.parseInt(elementId.slice(1), 10);
}
