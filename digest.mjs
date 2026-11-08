#!/usr/bin/env node
/**
 * ai-news-digest
 * 每天抓取几个 AI 新闻源，挑出最新的 5 条，用 Gmail 发一封邮件。
 *
 * 用法:
 *   node digest.mjs              # 抓取并发送
 *   node digest.mjs --dry-run    # 只抓取和渲染，不发送、不写 seen.json
 *   node digest.mjs --no-llm     # 忽略 DeepSeek，按时间挑选
 *
 * 环境变量:
 *   GMAIL_USER           发件 Gmail 地址
 *   GMAIL_APP_PASSWORD   Gmail 应用专用密码（16 位，不是账号密码）
 *   GMAIL_TO             收件地址，缺省等于 GMAIL_USER，可逗号分隔
 *   DEEPSEEK_API_KEY     可选；配置后由 DeepSeek 筛选并写中文摘要
 *   DEEPSEEK_MODEL       可选；默认 deepseek-chat
 *   DEEPSEEK_BASE_URL    可选；默认 https://api.deepseek.com
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';
import nodemailer from 'nodemailer';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = path.join(ROOT, 'seen.json');
const PREVIEW_FILE = path.join(ROOT, 'preview.html');
const DRY_RUN = process.argv.includes('--dry-run');

const TIME_ZONE = 'Asia/Shanghai';
const MAX_ITEMS = 5;
const MAX_PER_SOURCE = 3;
const PRIMARY_WINDOW_HOURS = 24;
const FALLBACK_WINDOW_HOURS = 72;
const MAX_SEEN = 500;

// DeepSeek 筛选层：没配 API key 就自动退回到“按时间挑”
const LLM_CANDIDATES = 30;
const LLM_PROMPT = `你是一名中文科技媒体的值班编辑，负责从候选新闻里挑出今天最值得看的 5 条。

规则：
1. 只从候选里选，不要编造新闻，也不要用候选之外的信息。
2. 优先：模型或产品发布、重要公司动态、开源项目、融资并购、监管与安全事件、有分量的研究进展。
3. 排除：纯产品评测、使用教程、促销与软文、纯观点专栏、招聘信息、与 AI 关系不大的内容。
4. 同一事件被多家媒体报道时只保留一条（选信息最完整的那条），摘要里体现关键事实。
5. 按重要性从高到低排序，恰好返回 5 条。
6. 每条写一个不超过 30 字的中文标题，和一句不超过 50 字、客观陈述事实的中文摘要，不要用“震惊”“炸裂”这类词。

只输出如下 JSON，不要输出任何其他文字：
{"picks":[{"id":候选编号,"title_zh":"中文标题","summary_zh":"中文摘要"}]}`;

const FEEDS = [
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: '量子位', url: 'https://www.qbitai.com/feed' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
];

// ---------------------------------------------------------------- env helper

async function loadDotEnv() {
  try {
    const text = await readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, raw] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  } catch {
    // 没有 .env 就直接用进程环境变量
  }
}

// ---------------------------------------------------------------- utilities

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

const normalizeTitle = (title) =>
  title.toLowerCase().replace(/\s+/g, ' ').replace(/[“”"']/g, '').trim();

const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  month: 'long',
  day: 'numeric',
});

const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dayKey = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date); // YYYY-MM-DD

// ---------------------------------------------------------------- fetch feeds

async function collectItems() {
  const parser = new Parser({
    timeout: 20_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-news-digest/1.0)' },
  });

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items ?? []).map((item) => {
        const title = (item.title ?? '').trim();
        const time = Date.parse(item.isoDate ?? item.pubDate ?? '');
        const rawSnippet = (item.contentSnippet ?? '').replace(/\s+/g, ' ').trim();
        const snippet =
          rawSnippet.length > 160 ? `${rawSnippet.slice(0, 160)}…` : rawSnippet;
        return {
          source: feed.name,
          title,
          link: item.link,
          time,
          snippet,
        };
      });
    }),
  );

  const items = [];
  results.forEach((result, index) => {
    const { name } = FEEDS[index];
    if (result.status === 'rejected') {
      console.error(`[skip] ${name}: ${result.reason?.message ?? result.reason}`);
      return;
    }
    for (const item of result.value) {
      if (!item.title || !item.link || !Number.isFinite(item.time)) continue;
      items.push(item);
    }
    console.log(`[ok]   ${name}: ${result.value.length} 条`);
  });
  return items;
}

async function readSeen() {
  try {
    const parsed = JSON.parse(await readFile(SEEN_FILE, 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * 先按“每源最多 3 条”挑，保证来源多样；不够 5 条再放宽限制补满。
 */
function pickItems(items, limit) {
  const picked = [];
  const perSource = new Map();

  for (const item of items) {
    if (picked.length >= limit) break;
    const used = perSource.get(item.source) ?? 0;
    if (used >= MAX_PER_SOURCE) continue;
    perSource.set(item.source, used + 1);
    picked.push(item);
  }

  for (const item of items) {
    if (picked.length >= limit) break;
    if (!picked.includes(item)) picked.push(item);
  }

  return picked.slice(0, limit);
}

function selectCandidates(all, seen) {
  const now = Date.now();
  const primaryFrom = now - PRIMARY_WINDOW_HOURS * 3600_000;
  const fallbackFrom = now - FALLBACK_WINDOW_HOURS * 3600_000;

  const unseen = all
    .filter((item) => !seen.has(normalizeTitle(item.title)))
    .sort((a, b) => b.time - a.time);

  const primary = unseen.filter((item) => item.time >= primaryFrom);
  const fallback = unseen.filter(
    (item) => item.time < primaryFrom && item.time >= fallbackFrom,
  );

  // 24 小时内优先，不够时用 24–72 小时内的补齐
  return [...primary, ...fallback];
}

// ------------------------------------------------------------ DeepSeek 筛选

const llmEnabled = () =>
  Boolean(process.env.DEEPSEEK_API_KEY) && !process.argv.includes('--no-llm');

const llmModel = () => process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const llmBaseUrl = () =>
  (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

/**
 * 让 DeepSeek 从候选里挑 5 条，并写中文标题/摘要。
 * 返回 [{ id, title_zh, summary_zh }]，id 是在 candidates 里的下标。
 */
async function curateWithDeepSeek(candidates) {
  const list = candidates.map((item, index) => ({
    id: index,
    source: item.source,
    time: clockFormatter.format(new Date(item.time)),
    title: item.title,
    snippet: item.snippet.slice(0, 120),
  }));

  const response = await fetch(`${llmBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: llmModel(),
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LLM_PROMPT },
        {
          role: 'user',
          content: `候选新闻（JSON 数组）：\n${JSON.stringify(list)}\n\n请输出 JSON。`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const data = await response.json();
  const usage = data.usage;
  if (usage) {
    console.log(`[llm] tokens: 输入 ${usage.prompt_tokens} / 输出 ${usage.completion_tokens}`);
  }

  const raw = data.choices?.[0]?.message?.content ?? '';
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`返回内容不是合法 JSON: ${cleaned.slice(0, 200)}`);
  }

  const picks = [];
  const used = new Set();
  for (const pick of Array.isArray(parsed.picks) ? parsed.picks : []) {
    const id = Number(pick?.id);
    if (!Number.isInteger(id) || id < 0 || id >= candidates.length) continue;
    if (used.has(id)) continue;
    used.add(id);
    picks.push({
      id,
      title_zh: String(pick.title_zh ?? '').trim(),
      summary_zh: String(pick.summary_zh ?? '').trim(),
    });
    if (picks.length === MAX_ITEMS) break;
  }

  if (!picks.length) throw new Error('模型没有返回可用的 picks');
  return picks;
}

/**
 * 有 key 时用模型挑；任何失败都退回“按时间挑”，不让日报断掉。
 */
async function chooseItems(candidates) {
  if (!llmEnabled()) {
    console.log('[llm] 未配置 DEEPSEEK_API_KEY，按时间挑选');
    return pickItems(candidates, MAX_ITEMS);
  }

  const input = pickItems(candidates, LLM_CANDIDATES);
  try {
    const picks = await curateWithDeepSeek(input);
    const chosen = picks.map((pick) => ({
      ...input[pick.id],
      titleZh: pick.title_zh,
      summaryZh: pick.summary_zh,
    }));

    // 模型给不满 5 条时，用按时间挑的补齐
    for (const item of pickItems(candidates, MAX_ITEMS)) {
      if (chosen.length >= MAX_ITEMS) break;
      if (!chosen.some((entry) => entry.link === item.link)) chosen.push(item);
    }

    console.log(`[llm] DeepSeek 选出 ${picks.length} 条（候选 ${input.length} 条）`);
    return chosen.slice(0, MAX_ITEMS);
  } catch (error) {
    console.error(`[llm] 调用失败，回退到按时间挑选：${error.message}`);
    return pickItems(candidates, MAX_ITEMS);
  }
}

// ---------------------------------------------------------------- rendering

function buildContent(items, { curated = false } = {}) {
  const today = formatter.format(new Date());
  const subject = `AI 日报 · ${today}${items.length ? `（${items.length} 条）` : ''}`;
  const sources = [...new Set(items.map((item) => item.source))];

  const headlineOf = (item) => item.titleZh || item.title;
  const summaryOf = (item) => item.summaryZh || item.snippet;

  const text = items
    .map((item, index) => {
      const time = clockFormatter.format(new Date(item.time));
      const original = item.titleZh && item.titleZh !== item.title ? item.title : '';
      return [
        `${index + 1}. ${headlineOf(item)}`,
        original ? `   原文：${original}` : '',
        `   ${item.source} · ${time}`,
        summaryOf(item) ? `   ${summaryOf(item)}` : '',
        `   ${item.link}`,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const itemsHtml = items
    .map((item) => {
      const time = clockFormatter.format(new Date(item.time));
      const original = item.titleZh && item.titleZh !== item.title ? item.title : '';
      const summary = summaryOf(item);
      return `
      <tr>
        <td style="padding:18px 0;border-bottom:1px solid #efefef">
          <a href="${escapeHtml(item.link)}" style="font-size:16px;line-height:1.5;font-weight:600;color:#111;text-decoration:none">${escapeHtml(headlineOf(item))}</a>
          ${original ? `<div style="margin-top:4px;font-size:12px;line-height:1.5;color:#8a8a8a">${escapeHtml(original)}</div>` : ''}
          <div style="margin-top:6px;font-size:12px;color:#9b9b9b">${escapeHtml(item.source)} · ${escapeHtml(time)}</div>
          ${summary ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.65;color:#555">${escapeHtml(summary)}</p>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:24px 12px;background:#f6f6f7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <tr>
      <td style="padding:28px 28px 8px">
        <div style="font-size:11px;letter-spacing:.18em;color:#a0a0a0;text-transform:uppercase">AI 日报</div>
        <h1 style="margin:8px 0 4px;font-size:22px;font-weight:700;color:#111">${escapeHtml(today)}</h1>
        <p style="margin:0;font-size:13px;color:#9b9b9b">北京时间 10:00 自动发送 · ${items.length} 条</p>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 28px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemsHtml}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px 28px">
        <p style="margin:0;font-size:12px;line-height:1.7;color:#a0a0a0">
          来源：${escapeHtml(sources.join('、'))}<br>
          由 ai-news-digest 自动生成${curated ? ' · DeepSeek 筛选与摘要' : ''}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text: `AI 日报 · ${today}\n\n${text}\n\n来源：${sources.join('、')}\n`, html };
}

// ---------------------------------------------------------------- sending

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function sendMail({ subject, text, html }) {
  const user = requireEnv('GMAIL_USER');
  const pass = requireEnv('GMAIL_APP_PASSWORD');
  const to = (process.env.GMAIL_TO || user)
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);

  const message = {
    from: `"AI 日报" <${user}>`,
    to,
    subject,
    text,
    html,
  };

  // Gmail 同时支持 465(SSL) 和 587(STARTTLS)，前者失败时自动回退。
  const transports = [
    { host: 'smtp.gmail.com', port: 465, secure: true },
    { host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true },
  ];

  let lastError;
  for (const options of transports) {
    const transporter = nodemailer.createTransport({
      ...options,
      auth: { user, pass },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
    });
    try {
      const info = await transporter.sendMail(message);
      console.log(`[sent] ${options.port} → ${to.join(', ')} · ${info.messageId}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`[fail] ${options.port}: ${error.message}`);
    } finally {
      transporter.close();
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------- main

async function main() {
  await loadDotEnv();

  console.log(`[run] ${DRY_RUN ? 'dry-run' : 'send'} · ${dayKey()} · ${TIME_ZONE}`);

  const all = await collectItems();
  const seen = await readSeen();
  const candidates = selectCandidates(all, seen);

  if (!candidates.length) {
    console.log('[done] 没有新内容，跳过发送');
    return;
  }

  const items = await chooseItems(candidates);
  if (!items.length) {
    console.log('[done] 没有选出内容，跳过发送');
    return;
  }

  const curated = items.some((item) => item.titleZh);
  const content = buildContent(items, { curated });
  console.log(`[pick] ${items.map((item) => item.titleZh || item.title).join(' | ')}`);

  if (DRY_RUN) {
    await writeFile(PREVIEW_FILE, content.html, 'utf8');
    console.log(`[dry-run] 预览已写入 ${PREVIEW_FILE}`);
    console.log(`[dry-run] 标题：${content.subject}`);
    console.log(content.text);
    return;
  }

  await sendMail(content);

  const nextSeen = [
    ...seen,
    ...items.map((item) => normalizeTitle(item.title)),
  ].slice(-MAX_SEEN);
  await writeFile(SEEN_FILE, `${JSON.stringify(nextSeen, null, 2)}\n`, 'utf8');
  console.log(`[done] 已发送 ${items.length} 条，seen.json 现有 ${nextSeen.length} 条记录`);
}

// 抓取用的 keep-alive socket 会让事件循环不退出，这里显式结束进程。
main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[error] ${error.stack ?? error.message}`);
    process.exit(1);
  },
);
