import { describe, expect, it } from 'vitest';
import {
  buildContentExtractMessage,
  classifyBody,
  createContentExtractResponse,
  deriveMetadataFromPageState,
  detectXiaohongshuNoteDetail,
  normalizeExtractedBody,
  parseCountValue,
} from '../../../../../packages/hmr/lib/remote-bridge/content-extract-utils.mjs';

function createDetailPageState() {
  return {
    url: 'https://www.xiaohongshu.com/explore/697b1fbf000000002203a11f?xsec_source=pc_search',
    title: '🌲北京徒步天花板！吐血整理100条路线 - 小红书',
    page_text_summary:
      '[e3] link label="潮尚旅行北京站" [e6] link label="#北京徒步" [e7] link label="#周末去山里" [e19] span label="168" [e20] span label="368" [e21] span label="8"',
    elements: [
      {
        id: 'e3',
        role: 'link',
        label: '潮尚旅行北京站',
        text: '潮尚旅行北京站',
        url: '/user/profile/60642b420000000001005c2b',
        visible: true,
        enabled: true,
      },
      {
        id: 'e6',
        role: 'link',
        label: '#北京徒步',
        text: '#北京徒步',
        visible: true,
        enabled: true,
      },
      {
        id: 'e7',
        role: 'link',
        label: '#周末去山里',
        text: '#周末去山里',
        visible: true,
        enabled: true,
      },
      {
        id: 'e19',
        role: 'span',
        label: '168',
        text: '168',
        visible: true,
        enabled: true,
      },
      {
        id: 'e20',
        role: 'span',
        label: '368',
        text: '368',
        visible: true,
        enabled: true,
      },
      {
        id: 'e21',
        role: 'span',
        label: '8',
        text: '8',
        visible: true,
        enabled: true,
      },
    ],
  };
}

describe('content-extract utils', () => {
  it('normalizes extracted body and strips obvious noise/title lines', () => {
    const body = normalizeExtractedBody(
      [
        '🌲北京徒步天花板！吐血整理100条路线',
        '潮尚旅行北京站',
        '',
        '打开小红书查看更多',
        '这是一条真正的正文内容。',
        '',
        '相关推荐',
        '第二段保留。',
      ].join('\n'),
      {
        title: '🌲北京徒步天花板！吐血整理100条路线',
        author: '潮尚旅行北京站',
      },
    );

    expect(body).toBe('这是一条真正的正文内容。\n\n第二段保留。');
  });

  it('classifies body completeness using the agreed thresholds', () => {
    const shortBody = classifyBody('这是一条比较短的正文。', {});
    const longBody = classifyBody('徒步'.repeat(80), {});

    expect(shortBody.completeness).toBe('partial');
    expect(shortBody.reason).toBe('body_too_short');
    expect(longBody.completeness).toBe('full');
    expect(longBody.reason).toBeUndefined();
  });

  it('parses social counts including Chinese units', () => {
    expect(parseCountValue('168')).toBe(168);
    expect(parseCountValue('2.5万')).toBe(25000);
    expect(parseCountValue('3k')).toBe(3000);
  });

  it('detects xiaohongshu detail pages without treating search pages as details', () => {
    expect(detectXiaohongshuNoteDetail(createDetailPageState())).toBe(true);
    expect(
      detectXiaohongshuNoteDetail({
        ...createDetailPageState(),
        url: 'https://www.xiaohongshu.com/search_result?keyword=北京%20徒步&type=51',
        title: '北京 徒步 - 小红书搜索',
      }),
    ).toBe(false);
  });

  it('derives title, author, hashtags, and stats from page state fallback data', () => {
    const metadata = deriveMetadataFromPageState(createDetailPageState());

    expect(metadata.title).toBe('🌲北京徒步天花板！吐血整理100条路线');
    expect(metadata.author).toBe('潮尚旅行北京站');
    expect(metadata.hashtags).toEqual(['#北京徒步', '#周末去山里']);
    expect(metadata.stats).toEqual({
      favorites: 168,
      likes: 368,
      comments: 8,
    });
  });

  it('builds a precise partial-failure message instead of blaming JavaScript rendering', () => {
    const result = createContentExtractResponse({
      pageState: createDetailPageState(),
      pageKind: 'xiaohongshu_note_detail',
      title: '🌲北京徒步天花板！吐血整理100条路线',
      author: '潮尚旅行北京站',
      hashtags: ['#北京徒步'],
      stats: { favorites: 168, likes: 368, comments: 8 },
      body: '正文太短',
      extractedBy: 'page_state_only',
      reason: 'body_too_short',
    } as any);

    expect(buildContentExtractMessage(result)).toContain('当前页面已渲染');
    expect(buildContentExtractMessage(result)).not.toContain('JavaScript');
  });
});
