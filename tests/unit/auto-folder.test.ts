import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClassifierIndex,
  classifyPayloadToFolder,
  classifyPayloadWithIndex,
  matchesBoundaryKeyword,
  tokenizeForClassification,
} from '../../src/classify/auto-folder.ts';
import type { CapturedPayload } from '../../src/types/adapter.ts';
import {
  SCHEMA_VERSION,
  type CollectionItemRecord,
  type FolderAutoRule,
  type FolderNode,
  type PlatformId,
} from '../../src/types/schema.ts';

function makeFolder(
  id: string,
  name: string,
  parentId: string | null = null,
  autoRule?: FolderAutoRule,
): FolderNode {
  const now = 1_700_000_000_000;
  return {
    id,
    parentId,
    name,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...(autoRule ? { autoRule } : {}),
  };
}

function makePayload(overrides: Partial<CapturedPayload> = {}): CapturedPayload {
  return {
    platform: 'bilibili',
    sourceId: 'BV1test',
    sourceUrl: 'https://www.bilibili.com/video/BV1test',
    kind: 'video',
    title: '默认测试标题',
    description: '',
    author: { id: 'author-default', name: '默认作者' },
    hashtags: [],
    assets: [],
    triggerSource: 'native_collect',
    ...overrides,
  };
}

function makeHistoryItem(
  overrides: Partial<CollectionItemRecord> & {
    id: string;
    title: string;
    folderIds: string[];
  },
): CollectionItemRecord {
  const now = 1_700_000_000_000;
  const platform: PlatformId = overrides.platform ?? 'bilibili';
  const sourceId = overrides.sourceId ?? overrides.id;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: overrides.id,
    dedupeKey: `${platform}:${sourceId}`,
    platform,
    sourceId,
    sourceUrl: `https://example.com/${platform}/${sourceId}`,
    kind: overrides.kind ?? 'video',
    title: overrides.title,
    description: overrides.description ?? '',
    author: overrides.author ?? { id: `author-${overrides.id}`, name: '作者' },
    collectedAt: now,
    updatedAt: now,
    folderId: overrides.folderIds[0] ?? null,
    folderIds: overrides.folderIds,
    ...(overrides.folderAssignedBy
      ? { folderAssignedBy: overrides.folderAssignedBy }
      : {}),
    tags: overrides.tags ?? [],
    note: '',
    relativeDir: `items/${platform}/2026-11/${overrides.id}`,
    assets: [],
    syncStatus: 'vault_synced',
    totalSizeBytes: 0,
    deletedAt: overrides.deletedAt ?? null,
    autoSyncExclusion: overrides.autoSyncExclusion ?? null,
  };
}

test('分词与词边界：英文防子串误伤，过滤中文单字与高频水词', () => {
  assert.equal(matchesBoundaryKeyword('send me an email daily', 'ai'), false);
  assert.equal(matchesBoundaryKeyword('最新 ai 编程助手实战', 'ai'), true);
  assert.equal(matchesBoundaryKeyword('google search tips', 'go'), false);
  assert.equal(matchesBoundaryKeyword('用 go 语言写高并发服务', 'go'), true);
  assert.equal(matchesBoundaryKeyword('学习 c++ 现代模板元编程', 'c++'), true);

  const tokens = tokenizeForClassification('推荐一个超级棒的 React19 前端开发视频教程');
  assert.ok(tokens.includes('react19'));
  assert.ok(tokens.includes('react'));
  assert.ok(tokens.includes('前端'));
  assert.ok(!tokens.includes('视频'));
  assert.ok(!tokens.includes('教程'));
  assert.ok(!tokens.includes('推荐'));
});

test('Tier 1 显式微规则：抽象命名文件夹精准命中、支持平台前置与深层优先', () => {
  const folders = [
    makeFolder('f-life', '精神食粮', null, {
      keywords: ['纪录片', '书单'],
    }),
    makeFolder('f-tech', '技术', null, {
      keywords: ['typescript'],
    }),
    makeFolder('f-fe', '前端', 'f-tech', {
      keywords: ['typescript', 'react'],
      platforms: ['bilibili', 'zhihu'],
    }),
  ];

  // 抽象名称靠关键词精准命中
  const docRes = classifyPayloadToFolder(
    makePayload({ title: '年度高分纪录片盘点，值得反复观看' }),
    folders,
    [],
  );
  assert.equal(docRes.folderId, 'f-life');
  assert.equal(docRes.reason, 'explicit_rule');

  // 父子规则同时命中时优先更深的子文件夹
  const feRes = classifyPayloadToFolder(
    makePayload({
      platform: 'bilibili',
      title: 'TypeScript 7 类型系统深入剖析',
    }),
    folders,
    [],
  );
  assert.equal(feRes.folderId, 'f-fe');
  assert.equal(feRes.reason, 'explicit_rule');

  // 子文件夹受 platforms 限制不匹配抖音时，父文件夹规则生效
  const dyRes = classifyPayloadToFolder(
    makePayload({
      platform: 'douyin',
      title: 'TypeScript 7 类型系统深入剖析',
    }),
    folders,
    [],
  );
  assert.equal(dyRes.folderId, 'f-tech');
  assert.equal(dyRes.reason, 'explicit_rule');
});

test('Tier 2 同作者亲和度：需满足 >=2 样本与高纯度，过滤杂食作者与单条偶发', () => {
  const folders = [
    makeFolder('f-photo', '摄影'),
    makeFolder('f-cook', '做饭'),
  ];

  const history = [
    // 高纯度摄影 UP 主（2/2）
    makeHistoryItem({
      id: 'h1',
      platform: 'bilibili',
      title: '索尼微单调色心得',
      author: { id: 'up-photo', name: '光影小王' },
      folderIds: ['f-photo'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'h2',
      platform: 'bilibili',
      title: '人像构图技巧',
      author: { id: 'up-photo', name: '光影小王' },
      folderIds: ['f-photo'],
      folderAssignedBy: 'manual',
    }),
    // 只有 1 条样本的新作者（不触发短路）
    makeHistoryItem({
      id: 'h3',
      platform: 'bilibili',
      title: '番茄炒蛋秘诀',
      author: { id: 'up-one', name: '厨师甲' },
      folderIds: ['f-cook'],
      folderAssignedBy: 'manual',
    }),
    // 杂食搬运号（2 条摄影 + 1 条做饭，纯度 66.7% < 80%，不触发短路）
    makeHistoryItem({
      id: 'h4',
      platform: 'bilibili',
      title: '镜头开箱',
      author: { id: 'up-mixed', name: '搬运君' },
      folderIds: ['f-photo'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'h5',
      platform: 'bilibili',
      title: '三脚架对比',
      author: { id: 'up-mixed', name: '搬运君' },
      folderIds: ['f-photo'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'h6',
      platform: 'bilibili',
      title: '红烧肉做法',
      author: { id: 'up-mixed', name: '搬运君' },
      folderIds: ['f-cook'],
      folderAssignedBy: 'manual',
    }),
  ];

  const index = buildClassifierIndex(folders, history);

  // 高纯度摄影作者发了一条无明显关键词的新视频仍能精准归类
  const pureRes = classifyPayloadWithIndex(
    makePayload({
      platform: 'bilibili',
      title: '周末出门拍了一组片子',
      author: { id: 'up-photo', name: '光影小王' },
    }),
    index,
  );
  assert.equal(pureRes.folderId, 'f-photo');
  assert.equal(pureRes.reason, 'author_affinity');

  // 单条样本作者不触发短路，无关内容兜底未分类
  const oneRes = classifyPayloadWithIndex(
    makePayload({
      platform: 'bilibili',
      title: '今天出去散步随拍',
      author: { id: 'up-one', name: '厨师甲' },
    }),
    index,
  );
  assert.equal(oneRes.folderId, null);

  // 杂食作者发无关标题不触发作者短路
  const mixedRes = classifyPayloadWithIndex(
    makePayload({
      platform: 'bilibili',
      title: '随手发个日常动态',
      author: { id: 'up-mixed', name: '搬运君' },
    }),
    index,
  );
  assert.equal(mixedRes.folderId, null);
});

test('防漂移与防污染：排除 auto 未确认样本、回收站与不自动同步条目，且忽略原站收藏夹名', () => {
  const folders = [
    makeFolder('f-ai', '人工智能'),
    makeFolder('f-music', '音乐'),
  ];

  const history = [
    // 3 条自动归类未人工确认的错误样本（不能参与训练）
    makeHistoryItem({
      id: 'auto-1',
      title: '吉他指弹和弦练习',
      tags: ['吉他', '指弹'],
      author: { id: 'musician-1', name: '吉他手' },
      folderIds: ['f-ai'],
      folderAssignedBy: 'auto',
    }),
    makeHistoryItem({
      id: 'auto-2',
      title: '木吉他扫弦节奏入门',
      tags: ['吉他'],
      author: { id: 'musician-1', name: '吉他手' },
      folderIds: ['f-ai'],
      folderAssignedBy: 'auto',
    }),
    // 回收站样本与不自动同步样本（不能参与训练）
    makeHistoryItem({
      id: 'trash-1',
      title: '古典钢琴曲谱解析',
      author: { id: 'musician-1', name: '吉他手' },
      folderIds: ['f-ai'],
      folderAssignedBy: 'manual',
      deletedAt: 1_700_000_001_000,
    }),
    makeHistoryItem({
      id: 'excl-1',
      title: '吉他调音指南',
      author: { id: 'musician-1', name: '吉他手' },
      folderIds: ['f-ai'],
      folderAssignedBy: 'manual',
      autoSyncExclusion: {
        reason: 'watch_later',
        excludedAt: 1_700_000_001_000,
      },
    }),
  ];

  // 新吉他视频：不能被 auto/trash/excluded 错样本吸进「人工智能」；且 platformExtra 里的原站收藏夹名必须被完全忽略
  const res = classifyPayloadToFolder(
    makePayload({
      title: '民谣吉他指弹编配技巧',
      hashtags: ['吉他'],
      author: { id: 'musician-1', name: '吉他手' },
      platformExtra: {
        favoriteFolderTitle: '人工智能',
        favFolderName: '音乐',
      },
    }),
    folders,
    history,
  );
  assert.equal(res.folderId, null);
});

test('Tier 3 TF-IDF L2 余弦：小文件夹不被大文件夹碾压，且解决词汇鸿沟', () => {
  const folders = [
    makeFolder('f-big', '日常综合'),
    makeFolder('f-fe', '前端'),
  ];

  const history: CollectionItemRecord[] = [];
  // 构造 30 条杂乱大文件夹样本
  for (let i = 0; i < 30; i += 1) {
    history.push(
      makeHistoryItem({
        id: `big-${i}`,
        title: `城市探店美食打卡第 ${i} 期 好吃的咖啡馆与街景`,
        tags: ['探店', '生活'],
        folderIds: ['f-big'],
        folderAssignedBy: 'manual',
      }),
    );
  }
  // 小文件夹仅有 3 条精准手动样本（名字叫「前端」，样本教它学会 vite/tailwind/webpack）
  history.push(
    makeHistoryItem({
      id: 'fe-1',
      title: 'Vite 打包体积优化与 Tree Shaking 实战',
      tags: ['Vite', '工程化'],
      folderIds: ['f-fe'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'fe-2',
      title: 'Tailwind CSS v4 主题变量架构实践',
      tags: ['Tailwind', 'CSS'],
      folderIds: ['f-fe'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'fe-3',
      title: 'React 编译器自动记忆化原理解析',
      tags: ['React'],
      folderIds: ['f-fe'],
      folderAssignedBy: 'manual',
    }),
  );

  const index = buildClassifierIndex(folders, history);

  // 新条目标题不含「前端」二字，但含 Vite + Tailwind，应精准归入小文件夹「前端」
  const hit = classifyPayloadWithIndex(
    makePayload({
      title: '用 Vite 和 Tailwind 搭建零配置组件库',
      hashtags: ['Vite'],
    }),
    index,
  );
  assert.equal(hit.folderId, 'f-fe');
  assert.equal(hit.reason, 'tfidf_cosine');

  // 完全无关内容（如量子力学）必须安全兜底进未分类
  const unrelated = classifyPayloadWithIndex(
    makePayload({
      title: '量子纠缠与贝尔不等式通俗解读',
      hashtags: ['物理'],
    }),
    index,
  );
  assert.equal(unrelated.folderId, null);
});

test('Tier 4 冷启动防误伤 & 同父兄弟胶着上浮父文件夹 & 跨分支歧义兜底未分类', () => {
  const folders = [
    makeFolder('f-tech', '技术'),
    makeFolder('f-fe', '前端', 'f-tech'),
    makeFolder('f-be', '后端', 'f-tech'),
    makeFolder('f-empty', '前端工程化'),
    makeFolder('f-travel', '旅行'),
  ];

  const history = [
    makeHistoryItem({
      id: 'fe-a',
      title: 'TypeScript 浏览器组件渲染优化',
      tags: ['React', 'CSS'],
      folderIds: ['f-fe'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'be-a',
      title: 'TypeScript 服务端数据库并发优化',
      tags: ['PostgreSQL', 'Redis'],
      folderIds: ['f-be'],
      folderAssignedBy: 'manual',
    }),
    makeHistoryItem({
      id: 'tr-a',
      title: '川西自驾游攻略与高原露营装备',
      tags: ['自驾', '露营'],
      folderIds: ['f-travel'],
      folderAssignedBy: 'manual',
    }),
  ];

  const index = buildClassifierIndex(folders, history);

  // 1. 空文件夹「前端工程化」不会被仅含「工程」的水利文章误命中
  const emptyNoise = classifyPayloadWithIndex(
    makePayload({ title: '三峡水利工程混凝土施工记录' }),
    index,
  );
  assert.equal(emptyNoise.folderId, null);

  // 2. 空文件夹完整命中文件夹名时可冷启动命中
  const emptyHit = classifyPayloadWithIndex(
    makePayload({ title: '大型项目前端工程化落地指南' }),
    index,
  );
  assert.equal(emptyHit.folderId, 'f-empty');
  assert.equal(emptyHit.reason, 'cold_start_name');

  // 3. 同父兄弟「前端」与「后端」同时高分胶着 -> 上浮归入共同父目录「技术」
  const siblingTie = classifyPayloadWithIndex(
    makePayload({
      title: 'TypeScript 全栈架构：前端 React 与后端 PostgreSQL 协同实践',
    }),
    index,
  );
  assert.equal(siblingTie.folderId, 'f-tech');
  assert.equal(siblingTie.reason, 'parent_fallback');

  // 4. 跨分支歧义（同时命中旅行露营与前端组件）-> 宁缺毋滥，兜底未分类
  const crossBranchTie = classifyPayloadWithIndex(
    makePayload({
      title: '一边川西自驾露营一边写 React 组件渲染优化',
    }),
    index,
  );
  assert.equal(crossBranchTie.folderId, null);
});
