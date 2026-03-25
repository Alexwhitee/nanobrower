import type { RemoteActionResultSummary, RemotePageElement, RemotePageState } from '@extension/shared';
import type { BrowserState } from '../browser/views';
import { DEFAULT_INCLUDE_ATTRIBUTES, DOMElementNode } from '../browser/dom/views';

const MAX_ELEMENTS = 40;
const MAX_SUMMARY_LENGTH = 1200;
const MAX_TEXT_LENGTH = 160;

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

function buildElement(node: DOMElementNode, index: number): RemotePageElement {
  const text = capText(node.getAllTextTillNextClickableElement(2));
  const label = capText(
    node.attributes['aria-label'] ||
      node.attributes.placeholder ||
      node.attributes.title ||
      node.attributes.name ||
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
    tag_name: node.tagName || undefined,
  };
}

function buildSummary(state: BrowserState): string {
  const summary = state.elementTree
    .clickableElementsToString(DEFAULT_INCLUDE_ATTRIBUTES)
    .replace(/\s+\n/g, '\n')
    .trim();

  return capText(summary, MAX_SUMMARY_LENGTH);
}

export function buildRemotePageState(
  state: BrowserState,
  sessionId: string,
  lastActionResult: RemoteActionResultSummary | null,
  screenshotRef: string | null,
): RemotePageState {
  const elements = Array.from(state.selectorMap.entries())
    .filter(([, node]) => node instanceof DOMElementNode)
    .slice(0, MAX_ELEMENTS)
    .map(([index, node]) => buildElement(node, index));

  return {
    session_id: sessionId,
    tab_id: state.tabId,
    url: state.url,
    title: state.title,
    viewport: {
      width: 1280,
      height: state.visualViewportHeight || 1100,
    },
    page_text_summary: buildSummary(state),
    elements,
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
