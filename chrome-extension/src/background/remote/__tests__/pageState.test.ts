import { describe, expect, it } from 'vitest';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import type { BrowserState } from '@src/background/browser/views';
import { buildRemotePageState, parseRemoteElementId } from '../pageState';

function createMockBrowserState(): BrowserState {
  const buttonNode = new DOMElementNode({
    tagName: 'button',
    xpath: '/html/body/button[1]',
    attributes: {
      role: 'button',
      'aria-label': 'Submit',
    },
    children: [new DOMTextNode('Submit', true)],
    isVisible: true,
    isInteractive: true,
    isTopElement: true,
    isInViewport: true,
    highlightIndex: 12,
  });

  const root = new DOMElementNode({
    tagName: 'root',
    xpath: '',
    attributes: {},
    children: [buttonNode],
    isVisible: true,
  });
  buttonNode.parent = root;

  return {
    elementTree: root,
    selectorMap: new Map([[12, buttonNode]]),
    tabId: 321,
    url: 'https://example.com/form',
    title: 'Demo Form',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 900,
    tabs: [
      {
        id: 321,
        url: 'https://example.com/form',
        title: 'Demo Form',
      },
    ],
  };
}

function createPriorityMockBrowserState(): BrowserState {
  const hiddenLink = new DOMElementNode({
    tagName: 'a',
    xpath: '/html/body/a[1]',
    attributes: {
      href: 'https://example.com/old',
      title: 'Older result',
    },
    children: [new DOMTextNode('Older result', true)],
    isVisible: true,
    isInteractive: true,
    isTopElement: false,
    isInViewport: false,
    highlightIndex: 3,
  });

  const searchOption = new DOMElementNode({
    tagName: 'div',
    xpath: '/html/body/div[1]',
    attributes: {
      role: 'option',
      'aria-label': '杭州 周末 徒步攻略',
      'aria-selected': 'true',
    },
    children: [new DOMTextNode('杭州 周末 徒步攻略', true)],
    isVisible: true,
    isInteractive: true,
    isTopElement: true,
    isInViewport: true,
    highlightIndex: 28,
  });

  const root = new DOMElementNode({
    tagName: 'root',
    xpath: '',
    attributes: {},
    children: [hiddenLink, searchOption],
    isVisible: true,
  });
  hiddenLink.parent = root;
  searchOption.parent = root;

  return {
    elementTree: root,
    selectorMap: new Map([
      [3, hiddenLink],
      [28, searchOption],
    ]),
    tabId: 101,
    url: 'https://www.xiaohongshu.com/search_result',
    title: 'Search Result',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 900,
    tabs: [
      {
        id: 101,
        url: 'https://www.xiaohongshu.com/search_result',
        title: 'Search Result',
      },
    ],
  };
}

describe('buildRemotePageState', () => {
  it('maps browser state into compact remote page state', () => {
    const state = buildRemotePageState(createMockBrowserState(), 'sess_demo', null, null);

    expect(state.session_id).toBe('sess_demo');
    expect(state.tab_id).toBe(321);
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0]).toMatchObject({
      id: 'e12',
      role: 'button',
      label: 'Submit',
      visible: true,
      enabled: true,
    });
  });

  it('prioritizes visible in-viewport suggestion elements for remote RPA', () => {
    const state = buildRemotePageState(createPriorityMockBrowserState(), 'sess_priority', null, null);

    expect(state.elements[0]).toMatchObject({
      id: 'e28',
      role: 'option',
      label: '杭州 周末 徒步攻略',
    });
    expect(state.page_text_summary).toContain('[e28]');
  });
});

describe('parseRemoteElementId', () => {
  it('parses a prefixed element id', () => {
    expect(parseRemoteElementId('e12')).toBe(12);
  });

  it('rejects malformed ids', () => {
    expect(() => parseRemoteElementId('button-12')).toThrow('Invalid element_id');
  });
});
