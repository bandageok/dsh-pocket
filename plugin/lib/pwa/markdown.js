/**
 * 极简 Markdown 渲染 —— 只为了让对话气泡里的答案看起来是「排过版的」。
 *
 * 为什么不用现成库：
 *   1. 这个 PWA 的卖点之一是**零依赖**（插件里没有 node_modules，浏览器里也不该多 30 KB 的库）；
 *   2. 安全约束更硬：全站禁 `innerHTML`（tools/pwa-smoke.mjs 会断言这一点），
 *      所以必须**用 DOM 节点拼**，而绝大多数 Markdown 库的输出都是 HTML 字符串。
 *
 * 支持的范围（够覆盖 dsh 的回答）：标题、无序/有序列表、引用、围栏代码块、行内代码、
 * 粗体、斜体、删除线、链接、水平线、管道表格。其余按纯文本处理。
 *
 * 边界：不解析 HTML（`<script>` 会原样当文字），不解析嵌套列表的深层缩进，
 * 链接只允许 http/https（其它协议降级成纯文本，避免 `javascript:` 之类的坑）。
 */

const MD_LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/** 行内解析：把一行拆成 文本 / 粗体 / 斜体 / 行内代码 / 链接 / 删除线 的节点序列。 */
function inlineNodes(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(document.createTextNode(buf));
      buf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // 行内代码：`code`（优先级最高，里面的星号不该被当成粗体）
    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1);
      if (end > 0) {
        flush();
        out.push(el('code', { text: rest.slice(1, end) }));
        i += end + 1;
        continue;
      }
    }

    // 链接 [文本](url)
    if (rest[0] === '[') {
      const m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        const href = m[2];
        if (/^https?:\/\//i.test(href)) {
          flush();
          out.push(el('a', { href, target: '_blank', rel: 'noreferrer noopener', text: m[1] }));
        } else {
          buf += m[1];
        }
        i += m[0].length;
        continue;
      }
    }

    // 粗体 **x** / 斜体 *x* / 删除线 ~~x~~
    if (rest.startsWith('**') || rest.startsWith('~~') || rest[0] === '*' || rest[0] === '_') {
      const patterns = [
        { re: /^\*\*([^*]+)\*\*/, tag: 'strong' },
        { re: /^~~([^~]+)~~/, tag: 'del' },
        { re: /^\*([^*\n]+)\*/, tag: 'em' },
        { re: /^_([^_\n]+)_/, tag: 'em' },
      ];
      let matched = false;
      for (const p of patterns) {
        const m = rest.match(p.re);
        if (m && m[1].trim()) {
          flush();
          out.push(el(p.tag, { text: m[1] }));
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** 把一段文本按行解析成块级节点。 */
function renderMarkdown(source) {
  const frag = document.createDocumentFragment();
  const lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');

  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = el('p', { class: 'md-p' });
    paragraph.forEach((line, idx) => {
      if (idx > 0) p.append(el('br'));
      for (const node of inlineNodes(line)) p.append(node);
    });
    frag.append(p);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      const lang = fence[1] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾的 ```
      const pre = el('pre', { class: 'md-pre' }, el('code', { text: body.join('\n') }));
      if (lang) pre.dataset.lang = lang;
      frag.append(pre);
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1].length);
      const node = el('div', { class: 'md-h md-h' + level });
      for (const child of inlineNodes(heading[2])) node.append(child);
      frag.append(node);
      i += 1;
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      frag.append(el('hr', { class: 'md-hr' }));
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const quote = el('blockquote', { class: 'md-quote' });
      for (const child of inlineNodes(body.join(' '))) quote.append(child);
      frag.append(quote);
      continue;
    }

    // 管道表格：至少两行，第二行是 |---|---|
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      flushParagraph();
      const splitRow = (row) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const table = el('table', { class: 'md-table' });
      const thead = el('thead');
      const htr = el('tr');
      for (const cell of header) htr.append(el('th', { text: cell }));
      thead.append(htr);
      table.append(thead);
      const tbody = el('tbody');
      for (const row of rows) {
        const tr = el('tr');
        for (let c = 0; c < header.length; c += 1) {
          const td = el('td');
          for (const node2 of inlineNodes(row[c] || '')) td.append(node2);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      frag.append(el('div', { class: 'md-table-wrap' }, table));
      continue;
    }

    // 列表（无序 / 有序；同级缩进不嵌套，够用）
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const list = el(isOrdered ? 'ol' : 'ul', { class: 'md-list' });
      if (isOrdered) list.setAttribute('start', ordered[1]);
      while (i < lines.length) {
        const b = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const o = lines[i].match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (isOrdered ? !o : !b) break;
        const item = el('li');
        for (const node3 of inlineNodes(isOrdered ? o[2] : b[1])) item.append(node3);
        list.append(item);
        i += 1;
      }
      frag.append(list);
      continue;
    }

    // 空行 = 段落结束
    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return frag;
}

/** 气泡内容：助手消息走 Markdown，用户消息保持纯文本（他打什么就显示什么）。 */
function bubbleContent(message) {
  const wrap = el('div', { class: 'bubble' });
  if (message.role === 'user') {
    wrap.textContent = message.text;
    return wrap;
  }
  // 短消息（一行、没有 Markdown 记号）直接纯文本，省掉一层 <p>，行高更贴
  const text = String(message.text == null ? '' : message.text);
  const looksPlain = text.length < 120 && !/[*`#|>\-\n]/.test(text);
  if (looksPlain) {
    wrap.textContent = text;
    return wrap;
  }
  wrap.append(renderMarkdown(text));
  return wrap;
}