export const FULL_CHINESE_BODY_CHARS = 120;
export const FULL_TOTAL_BODY_CHARS = 200;

const XIAOHONGSHU_HOST_RE = /(^|\.)xiaohongshu\.com$/i;
const XIAOHONGSHU_DETAIL_PATH_RE = /\/(explore|discovery\/item|search_result\/)[^/?#]+/i;
const XIAOHONGSHU_TITLE_SUFFIX_RE = /\s*-\s*小红书\s*$/;
const SAFE_EXPAND_LABELS = ['展开', '更多', '阅读全文'];
const BODY_NOISE_PATTERNS = [
  /^打开小红书/i,
  /^下载小红书/i,
  /^小红书$/i,
  /^赞$/i,
  /^评论$/i,
  /^收藏$/i,
  /^分享$/i,
  /^相关推荐/i,
  /^大家都在搜/i,
  /^更多评论/i,
  /^查看全部评论/i,
  /^登录后查看更多/i,
];

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = toTrimmedString(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeComparableText(value) {
  return toTrimmedString(value).replace(/\s+/g, '').replace(/^#+/, '').toLowerCase();
}

export function countChineseChars(value) {
  return (toTrimmedString(value).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
}

export function stripXiaohongshuTitleSuffix(title) {
  return toTrimmedString(title).replace(XIAOHONGSHU_TITLE_SUFFIX_RE, '').trim();
}

export function normalizeExtractedBody(value, options = {}) {
  const title = toTrimmedString(options.title);
  const author = toTrimmedString(options.author);
  const text = typeof value === 'string' ? value : '';

  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t\u3000]+/g, ' ').trim());

  const normalized = [];
  for (const line of lines) {
    if (!line) {
      if (normalized[normalized.length - 1] !== '') {
        normalized.push('');
      }
      continue;
    }

    if (BODY_NOISE_PATTERNS.some(pattern => pattern.test(line))) {
      continue;
    }

    const comparable = normalizeComparableText(line);
    if (!normalized.length && title && comparable === normalizeComparableText(title)) {
      continue;
    }
    if (!normalized.length && author && comparable === normalizeComparableText(author)) {
      continue;
    }

    normalized.push(line);
  }

  while (normalized[0] === '') normalized.shift();
  while (normalized[normalized.length - 1] === '') normalized.pop();

  return normalized.join('\n');
}

export function bodyMeetsFullThreshold(value) {
  const text = toTrimmedString(value);
  if (!text) return false;
  return countChineseChars(text) >= FULL_CHINESE_BODY_CHARS || text.length >= FULL_TOTAL_BODY_CHARS;
}

export function classifyBody(value, options = {}) {
  const body = normalizeExtractedBody(value, options);
  const bodyChars = body.length;

  if (!bodyChars) {
    return {
      body,
      bodyChars,
      completeness: 'failed',
      reason: 'body_not_found',
    };
  }

  if (bodyMeetsFullThreshold(body)) {
    return {
      body,
      bodyChars,
      completeness: 'full',
    };
  }

  return {
    body,
    bodyChars,
    completeness: 'partial',
    reason: 'body_too_short',
  };
}

export function parseCountValue(value) {
  const raw = toTrimmedString(value).replace(/,/g, '');
  if (!raw) return undefined;

  const match = raw.match(/^(-?\d+(?:\.\d+)?)(万|w|k|千)?$/i);
  if (!match) return undefined;

  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric)) return undefined;

  const unit = (match[2] || '').toLowerCase();
  if (unit === '万' || unit === 'w') {
    return Math.round(numeric * 10000);
  }
  if (unit === 'k' || unit === '千') {
    return Math.round(numeric * 1000);
  }
  return Math.round(numeric);
}

export function normalizeStats(stats = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(stats)) {
    const parsed =
      typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : parseCountValue(String(value || ''));
    if (Number.isFinite(parsed)) {
      normalized[key] = parsed;
    }
  }
  return normalized;
}

export function detectXiaohongshuNoteDetail(pageState, domainHint = '') {
  const url = toTrimmedString(pageState?.url);
  const title = stripXiaohongshuTitleSuffix(pageState?.title);
  const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];

  try {
    const parsed = new URL(url);
    if (!XIAOHONGSHU_HOST_RE.test(parsed.hostname)) {
      return false;
    }
    if (parsed.pathname === '/search_result' || parsed.pathname === '/search_result/') {
      return false;
    }
    if (XIAOHONGSHU_DETAIL_PATH_RE.test(parsed.pathname)) {
      return true;
    }
  } catch {
    return false;
  }

  if (!title) {
    return false;
  }
  if (/搜索$/i.test(title) || title.includes('搜索结果')) {
    return false;
  }

  const hasAuthor = elements.some(element => {
    const urlValue = toTrimmedString(element?.url);
    const text = toTrimmedString(element?.label || element?.text);
    return Boolean(text) && /\/user\/profile\//.test(urlValue) && !text.startsWith('#');
  });
  const hasStats = elements.filter(element => parseCountValue(element?.text || element?.label || '') !== undefined).length >= 3;
  return hasAuthor || hasStats;
}

export function deriveMetadataFromPageState(pageState) {
  const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];
  const title = stripXiaohongshuTitleSuffix(pageState?.title);
  const hashtags = uniqueStrings(
    elements
      .map(element => toTrimmedString(element?.label || element?.text))
      .filter(text => text.startsWith('#')),
  );

  const author = uniqueStrings(
    elements
      .filter(element => /\/user\/profile\//.test(toTrimmedString(element?.url)))
      .map(element => toTrimmedString(element?.label || element?.text))
      .filter(text => text && !text.startsWith('#') && text !== '关注'),
  )[0] || null;

  const numericElements = elements
    .filter(element => element?.visible !== false)
    .map(element => ({
      text: toTrimmedString(element?.text || element?.label),
      selector: toTrimmedString(element?.selector),
      value: parseCountValue(element?.text || element?.label || ''),
    }))
    .filter(entry => Number.isFinite(entry.value));

  const stats = {};
  if (numericElements.length >= 3) {
    const firstThree = numericElements.slice(0, 3);
    stats.favorites = firstThree[0].value;
    stats.likes = firstThree[1].value;
    stats.comments = firstThree[2].value;
  }

  return {
    title: title || null,
    author,
    hashtags,
    stats: normalizeStats(stats),
    body: normalizeExtractedBody(pageState?.page_text_summary || '', { title, author }),
  };
}

function buildProbeScript({ preferredSelectors = [], noteKeywords = [], safeExpandLabels = [] } = {}) {
  const selectorsJson = JSON.stringify(preferredSelectors);
  const noteKeywordsJson = JSON.stringify(noteKeywords);
  const safeExpandLabelsJson = JSON.stringify(safeExpandLabels);

  return `(() => {
    const preferredSelectors = ${selectorsJson};
    const noteKeywords = ${noteKeywordsJson};
    const safeExpandLabels = ${safeExpandLabelsJson};
    const noiseTokens = ['评论', '推荐', '相关', '猜你喜欢', '下载', '打开app', '打开小红书', '登录', '关注', '赞', '收藏', '分享'];

    const textOf = node => (node?.innerText || node?.textContent || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const normalize = value => (value || '').replace(/\\s+/g, '').trim().toLowerCase();
    const isVisible = node => {
      if (!(node instanceof Element)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const cssEscape = value => {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
    };
    const selectorOf = node => {
      if (!(node instanceof Element)) return '';
      if (node.id) return '#' + cssEscape(node.id);
      const parts = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        const tag = (current.tagName || 'div').toLowerCase();
        let part = tag;
        if (current.classList && current.classList.length) {
          const stableClass = Array.from(current.classList).find(name => !/^css-|^jsx-|^sc-/.test(name));
          if (stableClass) {
            part += '.' + cssEscape(stableClass);
            parts.unshift(part);
            break;
          }
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(sibling => sibling.tagName === current.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            part += ':nth-of-type(' + index + ')';
          }
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const firstVisible = selectors => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node instanceof Element && isVisible(node) && textOf(node)) return node;
      }
      return null;
    };
    const titleEl = firstVisible(['h1', '[class*="title"]', '[data-testid*="title"]']);
    const authorEl =
      firstVisible(['a[href*="/user/profile/"]', '[class*="author"] a', '[class*="user"] a']) ||
      Array.from(document.querySelectorAll('a[href*="/user/profile/"]')).find(node => isVisible(node) && textOf(node));
    const hashtags = Array.from(document.querySelectorAll('a, span, div'))
      .filter(node => node instanceof Element && isVisible(node))
      .map(node => textOf(node))
      .filter(text => text.startsWith('#'))
      .filter((text, index, list) => text.length > 1 && list.indexOf(text) === index)
      .slice(0, 20);
    const structuredCandidates = preferredSelectors
      .map(selector => document.querySelector(selector))
      .filter(node => node instanceof Element && isVisible(node) && textOf(node).length >= 40);

    const allCandidates = Array.from(document.querySelectorAll('article, main, section, div'))
      .filter(node => node instanceof Element && isVisible(node))
      .filter(node => {
        const text = textOf(node);
        if (text.length < 60) return false;
        if (node.querySelector('input, textarea')) return false;
        return true;
      });

    const titleTop = titleEl instanceof Element ? titleEl.getBoundingClientRect().top : 0;
    const authorTop = authorEl instanceof Element ? authorEl.getBoundingClientRect().top : titleTop;

    const scoreCandidate = node => {
      const text = textOf(node);
      const rect = node.getBoundingClientRect();
      const paragraphs = text.split(/\\n+/).filter(Boolean).length;
      const links = node.querySelectorAll('a').length;
      const buttons = node.querySelectorAll('button,[role="button"]').length;
      const normalized = normalize(text);
      let score = 0;

      score += Math.min(text.length, 240);
      score += Math.min(paragraphs * 12, 120);
      score += Math.max(0, 160 - Math.abs(rect.top - (authorTop || titleTop || rect.top)));
      if (preferredSelectors.some(selector => node.matches(selector))) score += 220;
      if (noteKeywords.some(keyword => normalized.includes(normalize(keyword)))) score += 80;
      if (text.includes('#')) score += 30;
      if (links > 12) score -= links * 4;
      if (buttons > 6) score -= buttons * 8;
      if (noiseTokens.some(token => normalized.includes(normalize(token)))) score -= 160;
      if (rect.top < (titleTop - 120)) score -= 120;
      if (rect.height < 48) score -= 80;
      return score;
    };

    const scored = [...new Set([...structuredCandidates, ...allCandidates])]
      .map(node => ({ node, score: scoreCandidate(node), text: textOf(node) }))
      .sort((left, right) => right.score - left.score);

    const best = scored[0] || null;
    const bestText = best ? best.text : '';

    const numericTexts = Array.from(document.querySelectorAll('span, div, button'))
      .filter(node => node instanceof Element && isVisible(node))
      .map(node => textOf(node))
      .filter(text => /^\\d+(?:\\.\\d+)?(?:万|w|k|千)?$/i.test(text))
      .slice(0, 3);

    return {
      pageKind: noteKeywords.length ? 'xiaohongshu_note_detail' : 'unknown',
      title: titleEl ? textOf(titleEl) : document.title || '',
      author: authorEl ? textOf(authorEl) : '',
      hashtags,
      statsTexts: numericTexts,
      body: bestText,
      visibleBodyChars: bestText.length,
      containerSelector: best ? selectorOf(best.node) : '',
      safeExpandLabels,
    };
  })`;
}

export function buildXiaohongshuExpandScript() {
  const labelsJson = JSON.stringify(SAFE_EXPAND_LABELS);
  return `(() => {
    const safeLabels = ${labelsJson};
    const dangerTokens = ['关注', '点赞', '收藏', '评论', '私信', '发布', '下载', '打开app', '打开小红书'];
    const textOf = node => (node?.innerText || node?.textContent || '').replace(/\\s+/g, ' ').trim();
    const normalize = value => (value || '').replace(/\\s+/g, '').trim().toLowerCase();
    const isVisible = node => {
      if (!(node instanceof Element)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const selectorOf = node => {
      if (!(node instanceof Element)) return '';
      if (node.id) return '#' + node.id;
      const tag = (node.tagName || 'div').toLowerCase();
      return tag;
    };

    const candidates = Array.from(document.querySelectorAll('button, a, span, div'))
      .filter(node => node instanceof Element && isVisible(node))
      .map(node => ({
        node,
        label: textOf(node) || (node.getAttribute('aria-label') || '').trim(),
      }))
      .filter(entry => safeLabels.includes(entry.label))
      .filter(entry => {
        const ancestorText = textOf(entry.node.closest('main, article, section, div') || entry.node);
        return !dangerTokens.some(token => normalize(ancestorText).includes(normalize(token)));
      });

    const chosen = candidates[0];
    if (!chosen) {
      return { attempted: true, clicked: false, reason: 'not_found' };
    }

    chosen.node.click();
    return {
      attempted: true,
      clicked: true,
      label: chosen.label,
      selector: selectorOf(chosen.node),
    };
  })`;
}

export function buildXiaohongshuProbeScript() {
  return buildProbeScript({
    preferredSelectors: [
      'main article',
      'article',
      '[class*="note-content"]',
      '[class*="noteContent"]',
      '[class*="content"]',
      '[class*="desc"]',
      '[class*="detail"] [class*="content"]',
      '[class*="detail"] [class*="desc"]',
    ],
    noteKeywords: ['小红书', '笔记', '话题', '评论'],
    safeExpandLabels: SAFE_EXPAND_LABELS,
  });
}

export function buildDefaultProbeScript() {
  return buildProbeScript({
    preferredSelectors: ['article', 'main article', 'main', '[role="main"]'],
  });
}

export function createContentExtractResponse({
  pageState,
  pageKind = 'unknown',
  title = null,
  author = null,
  hashtags = [],
  stats = {},
  body = '',
  extractedBy = 'page_state_only',
  reason,
  containerSelector = '',
  visibleBodyChars = 0,
} = {}) {
  const normalizedTitle =
    pageKind === 'xiaohongshu_note_detail' ? stripXiaohongshuTitleSuffix(title || pageState?.title) : toTrimmedString(title || pageState?.title);
  const normalizedAuthor = toTrimmedString(author) || null;
  const normalizedHashtags = uniqueStrings(hashtags);
  const bodyResult = classifyBody(body, {
    title: normalizedTitle,
    author: normalizedAuthor,
  });

  return {
    ok: true,
    url: toTrimmedString(pageState?.url),
    pageKind,
    title: normalizedTitle || null,
    author: normalizedAuthor,
    hashtags: normalizedHashtags,
    stats: normalizeStats(stats),
    body: bodyResult.body,
    bodyChars: bodyResult.bodyChars,
    extractedBy,
    completeness: bodyResult.completeness,
    reason: bodyResult.completeness === 'full' ? undefined : reason || bodyResult.reason,
    containerSelector: toTrimmedString(containerSelector) || undefined,
    visibleBodyChars: Number.isFinite(visibleBodyChars) ? visibleBodyChars : bodyResult.bodyChars,
  };
}

export function buildContentExtractMessage(result) {
  if (!result || result.completeness === 'full') {
    return undefined;
  }

  if (result.reason === 'not_detail_page') {
    return '当前页面不是小红书笔记详情页，未执行正文抽取。';
  }

  if (result.reason === 'expand_failed') {
    return '当前页面已渲染，但展开正文失败，已返回可见的结构化信息。';
  }

  if (result.reason === 'extract_text_error' || result.reason === 'evaluate_error') {
    return `当前页面已渲染，但默认快照未包含正文，已尝试 DOM 抽取；本次失败原因是 ${result.reason}。`;
  }

  if (result.reason === 'body_too_short' || result.reason === 'body_not_found') {
    return `当前页面已渲染，但默认快照未包含正文，已尝试 DOM 抽取；本次失败原因是 ${result.reason}。`;
  }

  return undefined;
}
