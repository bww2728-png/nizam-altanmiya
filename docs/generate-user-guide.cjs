const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { parseDocument } = require('htmlparser2');
const { ArabicShaper } = require('arabic-persian-reshaper');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(__dirname, 'دليل-المستخدم.html');
const OUTPUT = path.join(__dirname, 'دليل-المستخدم.pdf');
const FONT = '/usr/share/fonts/truetype/freefont/FreeSerif.ttf';
const BOLD = '/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf';
const LOGO = path.join(ROOT, 'desktop-app/src/renderer/assets/logo-badge.png');
const COLOR = {
  navy: '#14334b', navy2: '#204d67', gold: '#c5a04d', goldPale: '#f5eedc', teal: '#277b78',
  ink: '#243746', muted: '#637582', line: '#d9e1e6', pale: '#f2f6f7', red: '#a7463f',
  redPale: '#faefed', green: '#286853', greenPale: '#edf6f1', bluePale: '#edf4f8', white: '#ffffff',
};
const PAGE = { width: 595.28, height: 841.89, left: 49, right: 49, top: 56, bottom: 54 };
const CONTENT_WIDTH = PAGE.width - PAGE.left - PAGE.right;
const parsed = parseDocument(fs.readFileSync(SOURCE, 'utf8'));
const html = parsed.children.find(node => node.name === 'html');
const body = html.children.find(node => node.name === 'body');

function children(node) { return (node?.children ?? []).filter(child => child.type !== 'comment'); }
function textContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data;
  return children(node).map(textContent).join('');
}
function visualText(value) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const runs = [];
  for (const word of normalized.split(' ')) {
    const rtl = /[\u0590-\u08ff]/u.test(word);
    const previous = runs[runs.length - 1];
    if (previous?.rtl === rtl) previous.words.push(word);
    else runs.push({ rtl, words: [word] });
  }
  const visualWords = runs.reverse().flatMap(run => run.rtl ? run.words.reverse() : run.words);
  return ArabicShaper.convertArabic(visualWords.join(' '));
}
function nodes(node, name) {
  if (!node) return [];
  return children(node).filter(child => child.name === name);
}

const doc = new PDFDocument({
  size: 'A4', margin: { top: PAGE.top, bottom: 20, left: PAGE.left, right: PAGE.right }, bufferPages: true, compress: true,
  info: {
    Title: 'دليل المستخدم الشامل - نظام التنمية المحلية',
    Author: 'نظام التنمية المحلية',
    Subject: 'الدليل التشغيلي للمستخدمين',
    Keywords: 'التنمية المحلية، دليل المستخدم، البيانات، المؤشرات، ترتيب الأولويات',
    Creator: 'Local Development System User Guide',
  },
});
doc.registerFont('Arabic', FONT);
doc.registerFont('ArabicBold', BOLD);
doc.font('Arabic').fontSize(10.4).fillColor(COLOR.ink);
const output = fs.createWriteStream(OUTPUT);
doc.pipe(output);

let pageKind = 'body';
let pageHeading = 'نظام التنمية المحلية';
let chapterIndex = 0;
let renderedWords = 0;
const anchors = [];

function shape(text) { return visualText(text); }
function setFont(size, bold = false, color = COLOR.ink) {
  doc.font(bold ? 'ArabicBold' : 'Arabic').fontSize(size).fillColor(color);
}
function newBodyPage() {
  doc.addPage({ size: 'A4', margin: { top: PAGE.top, bottom: 20, left: PAGE.left, right: PAGE.right } });
  pageKind = 'body';
  doc.x = PAGE.left;
  doc.y = PAGE.top + 3;
}
function ensureSpace(height) {
  if (doc.y + height > PAGE.height - PAGE.bottom) newBodyPage();
}
function wrappedLines(text, width, size, bold = false) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  setFont(size, bold);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || doc.widthOfString(shape(candidate)) <= width) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}
function writeParagraph(text, options = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return;
  const x = options.x ?? PAGE.left;
  const width = options.width ?? CONTENT_WIDTH;
  const size = options.size ?? 10.25;
  const lineHeight = options.lineHeight ?? size * 1.67;
  const lines = wrappedLines(value, width, size, options.bold);
  ensureSpace(lines.length * lineHeight + (options.before ?? 0) + (options.after ?? 5));
  doc.y += options.before ?? 0;
  setFont(size, options.bold, options.color ?? COLOR.ink);
  for (const line of lines) {
    doc.text(shape(line), x, doc.y, { width, height: lineHeight + 2, align: options.align ?? 'right', lineBreak: false });
    doc.y += lineHeight;
  }
  doc.y += options.after ?? 5;
  renderedWords += value.split(/\s+/).length;
}
function sectionHeading(text, level = 3) {
  const size = level === 2 ? 17 : level === 3 ? 12.6 : 10.8;
  const lines = wrappedLines(text, CONTENT_WIDTH - 10, size, true);
  const height = lines.length * size * 1.44 + 12;
  ensureSpace(height);
  doc.y += level === 2 ? 9 : 7;
  doc.save().fillColor(level === 2 ? COLOR.gold : COLOR.teal).rect(PAGE.left + CONTENT_WIDTH - 3, doc.y + 1, 3, Math.max(17, lines.length * size * 1.35), 0).fill().restore();
  setFont(size, true, COLOR.navy);
  for (const line of lines) {
    doc.text(shape(line), PAGE.left + 10, doc.y, { width: CONTENT_WIDTH - 12, height: size * 1.48, align: 'right', lineBreak: false });
    doc.y += size * 1.43;
  }
  doc.y += 5;
}
function drawCallout(node, kind) {
  const value = textContent(node).replace(/\s+/g, ' ').trim();
  if (!value) return;
  const styles = {
    warning: [COLOR.goldPale, COLOR.gold], danger: [COLOR.redPale, COLOR.red],
    success: [COLOR.greenPale, COLOR.green], note: [COLOR.bluePale, COLOR.teal],
  };
  const [background, accent] = styles[kind] ?? styles.note;
  const lines = wrappedLines(value, CONTENT_WIDTH - 29, 9.6);
  const lineHeight = 14.9;
  const height = Math.max(33, lines.length * lineHeight + 17);
  ensureSpace(height + 8);
  const top = doc.y;
  doc.save().fillColor(background).roundedRect(PAGE.left, top, CONTENT_WIDTH, height, 3).fill().fillColor(accent).rect(PAGE.left + CONTENT_WIDTH - 3, top, 3, height).fill().restore();
  setFont(9.6, false, COLOR.ink);
  let y = top + 9;
  for (const line of lines) {
    doc.text(shape(line), PAGE.left + 10, y, { width: CONTENT_WIDTH - 21, height: lineHeight + 2, align: 'right', lineBreak: false });
    y += lineHeight;
  }
  doc.y = top + height + 9;
}
function drawList(node, ordered) {
  const items = nodes(node, 'li');
  items.forEach((item, index) => {
    const value = textContent(item).replace(/\s+/g, ' ').trim();
    const prefix = ordered ? `${index + 1}.` : '•';
    writeParagraph(`${prefix}  ${value}`, { x: PAGE.left + 2, width: CONTENT_WIDTH - 4, size: 9.7, lineHeight: 14.8, after: 2 });
  });
  doc.y += 2;
}
function cellWidths(count) {
  const profiles = {
    2: [0.36, 0.64],
    3: [0.24, 0.31, 0.45],
    4: [0.20, 0.25, 0.27, 0.28],
  };
  const values = profiles[count] ?? Array(count).fill(1 / count);
  return values.map(value => value * CONTENT_WIDTH);
}
function drawTable(tableNode) {
  const rows = children(tableNode).flatMap(group => group.name === 'tr' ? [group] : ['thead', 'tbody', 'tfoot'].includes(group.name) ? nodes(group, 'tr') : []).map(row => children(row).filter(cell => ['th', 'td'].includes(cell.name)));
  if (!rows.length) return;
  const columnCount = Math.max(...rows.map(row => row.length));
  const widths = cellWidths(columnCount);
  const padding = 5;
  const fontSize = columnCount >= 4 ? 7.3 : columnCount === 3 ? 7.9 : 8.4;
  const lineHeight = fontSize * 1.48;
  const drawRow = (row, index) => {
    const isHeader = index === 0 && rows[0].some(cell => cell.name === 'th');
    const values = widths.map((width, cellIndex) => {
      const cell = row[cellIndex];
      return cell ? textContent(cell).replace(/\s+/g, ' ').trim() : '';
    });
    const lines = values.map((value, cellIndex) => wrappedLines(value, widths[cellIndex] - padding * 2, fontSize, isHeader));
    const height = Math.max(lineHeight + padding * 2, ...lines.map(parts => parts.length * lineHeight + padding * 2));
    if (doc.y + height > PAGE.height - PAGE.bottom) {
      newBodyPage();
      if (index > 0) drawRow(rows[0], 0);
    }
    const top = doc.y;
    let right = PAGE.left + CONTENT_WIDTH;
    for (let cellIndex = 0; cellIndex < columnCount; cellIndex += 1) {
      const width = widths[cellIndex];
      const x = right - width;
      const fill = isHeader ? COLOR.navy : index % 2 ? '#f5f8f9' : COLOR.white;
      doc.save().fillColor(fill).rect(x, top, width, height).fill().lineWidth(0.45).strokeColor(isHeader ? COLOR.navy2 : COLOR.line).rect(x, top, width, height).stroke().restore();
      setFont(fontSize, isHeader, isHeader ? COLOR.white : COLOR.ink);
      let y = top + padding;
      for (const line of lines[cellIndex]) {
        doc.text(shape(line), x + padding, y, { width: width - padding * 2, height: lineHeight + 1, align: 'right', lineBreak: false });
        y += lineHeight;
      }
      right = x;
    }
    doc.y = top + height;
  };
  rows.forEach(drawRow);
  doc.y += 8;
}
function drawFlow(node) {
  const cards = nodes(node, 'div').filter(card => !card.attribs?.class?.includes('arrow'));
  const usable = cards.slice(0, 5);
  if (!usable.length) return;
  const gap = 5;
  const width = (CONTENT_WIDTH - gap * (usable.length - 1)) / usable.length;
  const cardParts = usable.map(card => {
    const title = nodes(card, 'b').map(textContent).join('');
    const bodyText = children(card).filter(child => child.name !== 'b').map(textContent).join(' ').replace(/\s+/g, ' ').trim();
    const titleLines = wrappedLines(title, width - 10, 8.6, true);
    const bodyLines = wrappedLines(bodyText, width - 10, 7.7, false);
    return { titleLines, bodyLines, height: (titleLines.length + bodyLines.length) * 11 + 18 };
  });
  const height = Math.max(42, ...cardParts.map(item => item.height));
  ensureSpace(height + 12);
  let right = PAGE.left + CONTENT_WIDTH;
  cardParts.forEach((card, index) => {
    const x = right - width;
    doc.save().fillColor(COLOR.pale).roundedRect(x, doc.y, width, height, 3).fill().lineWidth(0.5).strokeColor(COLOR.line).roundedRect(x, doc.y, width, height, 3).stroke().restore();
    let y = doc.y + 7;
    setFont(8.5, true, COLOR.navy);
    for (const line of card.titleLines) { doc.text(shape(line), x + 4, y, { width: width - 8, align: 'center', lineBreak: false }); y += 11; }
    setFont(7.6, false, COLOR.ink);
    for (const line of card.bodyLines) { doc.text(shape(line), x + 4, y, { width: width - 8, align: 'center', lineBreak: false }); y += 10; }
    right = x - gap;
    if (index < cardParts.length - 1) {
      setFont(11, true, COLOR.gold);
      doc.text('←', right + 1, doc.y + height / 2 - 8, { width: gap + 2, align: 'center', lineBreak: false });
      right -= gap;
    }
  });
  doc.y += height + 12;
}
function drawTile(node) {
  const title = nodes(node, 'h4').map(textContent).join(' ').trim();
  const bodyParts = children(node).filter(child => !['h4'].includes(child.name) && child.attribs?.class !== 'small').map(textContent).join(' ').replace(/\s+/g, ' ').trim();
  const titleLines = wrappedLines(title, CONTENT_WIDTH - 20, 10.2, true);
  const bodyLines = wrappedLines(bodyParts, CONTENT_WIDTH - 20, 9.1);
  const height = titleLines.length * 14 + bodyLines.length * 13.8 + 20;
  ensureSpace(height + 6);
  const top = doc.y;
  doc.save().fillColor(COLOR.white).roundedRect(PAGE.left, top, CONTENT_WIDTH, height, 3).fill().lineWidth(0.7).strokeColor(COLOR.line).roundedRect(PAGE.left, top, CONTENT_WIDTH, height, 3).stroke().restore();
  let y = top + 8;
  setFont(10.2, true, COLOR.teal);
  for (const line of titleLines) { doc.text(shape(line), PAGE.left + 10, y, { width: CONTENT_WIDTH - 20, align: 'right', lineBreak: false }); y += 14; }
  setFont(9.1, false, COLOR.ink);
  for (const line of bodyLines) { doc.text(shape(line), PAGE.left + 10, y, { width: CONTENT_WIDTH - 20, align: 'right', lineBreak: false }); y += 13.8; }
  doc.y = top + height + 8;
}
function renderOrderedList(node) {
  if (node.name === 'ol' || node.name === 'ul') return drawList(node, node.name === 'ol');
}
function renderNode(node) {
  if (!node || !node.name) return;
  const name = node.name;
  const cls = node.attribs?.class ?? '';
  if (['style', 'script', 'meta', 'link', 'title', 'head'].includes(name)) return;
  if (name === 'section' && cls.includes('cover')) return;
  if (name === 'section' && node.attribs?.id === 'welcome') {
    for (const child of children(node)) renderNode(child);
    return;
  }
  if (name === 'section' && cls.includes('chapter')) {
    if (chapterIndex > 0 || doc.pageNumber > 1) newBodyPage();
    chapterIndex += 1;
    const chapter = chapterHead(node);
    pageHeading = chapter || 'نظام التنمية المحلية';
    const id = node.attribs?.id;
    if (id) {
      doc.addNamedDestination(id, 'XYZ', 0, doc.y, null);
      anchors.push(id);
    }
    if (doc.outline) doc.outline.addItem(pageHeading);
    for (const child of children(node)) renderNode(child);
    return;
  }
  if (name === 'div' && cls.includes('chapter-title')) {
    const no = nodes(node, 'span').map(textContent).join(' ').trim();
    const title = nodes(node, 'h2').map(textContent).join(' ').trim();
    writeParagraph(no, { size: 8.8, bold: true, color: COLOR.teal, after: 2 });
    sectionHeading(title || no, 2);
    return;
  }
  if (name === 'h1') { sectionHeading(textContent(node), 2); return; }
  if (name === 'h2') { sectionHeading(textContent(node), 2); return; }
  if (name === 'h3') { sectionHeading(textContent(node), 3); return; }
  if (name === 'h4') { sectionHeading(textContent(node), 4); return; }
  if (name === 'p') {
    const clsName = node.attribs?.class ?? '';
    writeParagraph(textContent(node), { size: clsName.includes('lead') ? 11.2 : clsName.includes('smallprint') ? 8.1 : 9.9, color: clsName.includes('lead') ? COLOR.navy2 : clsName.includes('smallprint') ? COLOR.muted : COLOR.ink, after: 6 });
    return;
  }
  if (name === 'ol' || name === 'ul') { drawList(node, name === 'ol'); return; }
  if (name === 'table') { drawTable(node); return; }
  if (name === 'div' && cls.includes('flow')) { drawFlow(node); return; }
  if (name === 'div' && cls.includes('tile')) { drawTile(node); return; }
  if (name === 'div' && cls.includes('grid')) {
    children(node).forEach(renderNode);
    return;
  }
  if (name === 'div' && cls.includes('front-note')) { drawCallout(node, 'note'); return; }
  if (name === 'div' && cls.includes('warning')) { drawCallout(node, 'warning'); return; }
  if (name === 'div' && cls.includes('danger')) { drawCallout(node, 'danger'); return; }
  if (name === 'div' && cls.includes('success')) { drawCallout(node, 'success'); return; }
  if (name === 'div' && cls.includes('end-card')) {
    drawCallout(node, 'success');
    return;
  }
  if (name === 'div' && cls.includes('step')) {
    const number = nodes(node, 'span').map(textContent).join('');
    const bodyNode = children(node).find(child => child.name === 'p');
    const bodyText = textContent(bodyNode ?? node).replace(/\s+/g, ' ').trim();
    const marker = number ? `${number}. ` : '';
    writeParagraph(marker + bodyText, { size: 9.7, lineHeight: 14.8, after: 4 });
    return;
  }
  if (name === 'div' && cls.includes('definition-list')) {
    const entries = children(node).filter(child => child.name === 'dt' || child.name === 'dd');
    for (let index = 0; index < entries.length; index += 2) {
      const term = textContent(entries[index]);
      const definition = textContent(entries[index + 1]);
      const termLines = wrappedLines(term, 113, 8.5, true);
      const defLines = wrappedLines(definition, CONTENT_WIDTH - 132, 8.4);
      const height = Math.max(termLines.length * 12 + 10, defLines.length * 12 + 10);
      ensureSpace(height);
      doc.save().fillColor(COLOR.pale).rect(PAGE.left, doc.y, 116, height).fill().lineWidth(0.5).strokeColor(COLOR.line).rect(PAGE.left, doc.y, 116, height).stroke().restore();
      doc.save().fillColor(COLOR.white).rect(PAGE.left + 116, doc.y, CONTENT_WIDTH - 116, height).fill().lineWidth(0.5).strokeColor(COLOR.line).rect(PAGE.left + 116, doc.y, CONTENT_WIDTH - 116, height).stroke().restore();
      setFont(8.4, true, COLOR.navy);
      termLines.forEach((line, lineIndex) => doc.text(shape(line), PAGE.left + 5, doc.y + 5 + lineIndex * 12, { width: 106, lineBreak: false, align: 'right' }));
      setFont(8.3, false, COLOR.ink);
      defLines.forEach((line, lineIndex) => doc.text(shape(line), PAGE.left + 122, doc.y + 5 + lineIndex * 12, { width: CONTENT_WIDTH - 128, lineBreak: false, align: 'right' }));
      doc.y += height;
    }
    doc.y += 9;
    return;
  }
  if (name === 'li') return;
  if (name === 'div' && (cls.includes('cover-band') || cls.includes('cover-foot'))) return;
  if (['div', 'section', 'article', 'dl'].includes(name)) {
    for (const child of children(node)) renderNode(child);
    return;
  }
  if (!children(node).length) {
    const value = textContent(node).trim();
    if (value) writeParagraph(value, { size: 9.7 });
    return;
  }
  for (const child of children(node)) renderNode(child);
}
function chapterHead(section) {
  const heading = children(section).find(node => node.name === 'div' && node.attribs?.class?.includes('chapter-title'));
  return nodes(heading, 'h2').map(textContent).join(' ').trim();
}
function renderCover() {
  pageKind = 'cover';
  const pageWidth = PAGE.width;
  const pageHeight = PAGE.height;
  doc.save().fillColor(COLOR.navy).rect(0, 0, pageWidth, 22).fill().restore();
  doc.save().fillColor(COLOR.teal).rect(0, 22, pageWidth, 3).fill().restore();
  if (fs.existsSync(LOGO)) doc.image(LOGO, PAGE.width - PAGE.right - 86, 83, { width: 69, height: 69 });
  setFont(11, false, COLOR.muted);
  doc.text(shape('الجمهورية اليمنية'), PAGE.left, 94, { width: CONTENT_WIDTH - 96, align: 'right', lineBreak: false });
  setFont(12, true, COLOR.navy);
  doc.text(shape('نظام التنمية المحلية'), PAGE.left, 115, { width: CONTENT_WIDTH - 96, align: 'right', lineBreak: false });
  setFont(9.5, false, COLOR.muted);
  doc.text(shape('مركز إدارة البيانات المحلية'), PAGE.left, 138, { width: CONTENT_WIDTH - 96, align: 'right', lineBreak: false });
  doc.save().fillColor(COLOR.gold).rect(PAGE.left + CONTENT_WIDTH - 4, 244, 4, 163).fill().restore();
  setFont(11, true, COLOR.teal);
  doc.text(shape('المرجع التشغيلي للمستخدمين'), PAGE.left, 251, { width: CONTENT_WIDTH - 24, align: 'right', lineBreak: false });
  setFont(29, true, COLOR.navy);
  doc.text(shape('دليل المستخدم'), PAGE.left, 282, { width: CONTENT_WIDTH - 24, align: 'right', lineBreak: false });
  doc.text(shape('الشامل'), PAGE.left, 325, { width: CONTENT_WIDTH - 24, align: 'right', lineBreak: false });
  setFont(15, false, COLOR.navy2);
  doc.text(shape('من استقبال البيانات إلى قراءة الأولويات'), PAGE.left, 392, { width: CONTENT_WIDTH - 24, align: 'right', lineBreak: false });
  writeParagraph('مرجع عملي يشرح الاستخدام المسؤول للنظام: إدخال البيانات، استيراد الملفات، المراجعة والاعتماد، متابعة الجودة، فهم المؤشرات، وقراءة التقارير مع معرفة حدودها.', { x: PAGE.left, width: CONTENT_WIDTH - 22, size: 11, lineHeight: 19, color: '#4c6270', after: 0 });
  const bandY = 621;
  doc.save().fillColor(COLOR.navy).roundedRect(PAGE.left, bandY, CONTENT_WIDTH, 71, 5).fill().restore();
  const cols = [PAGE.left + CONTENT_WIDTH * 0.16, PAGE.left + CONTENT_WIDTH * 0.5, PAGE.left + CONTENT_WIDTH * 0.84];
  [['محلي','البيانات ضمن مساحة الجهاز'],['موثّق','المصدر والتغييرات قابلان للتتبع'],['مراجع','لا اعتماد آلي للتخمينات']].forEach((item, index) => {
    setFont(11.4, true, COLOR.white);
    doc.text(shape(item[0]), cols[index] - 54, bandY + 14, { width: 108, align: 'center', lineBreak: false });
    setFont(8.4, false, '#dce8ed');
    doc.text(shape(item[1]), cols[index] - 86, bandY + 39, { width: 172, align: 'center', lineBreak: false });
  });
  doc.save().strokeColor(COLOR.line).lineWidth(0.7).moveTo(PAGE.left, 726).lineTo(PAGE.width - PAGE.right, 726).stroke().restore();
  setFont(8.7, false, COLOR.muted);
  doc.text(shape('الإصدار المستهدف: 0.6.0'), PAGE.left, 739, { width: CONTENT_WIDTH / 2, align: 'right', lineBreak: false });
  doc.text(shape('طبعة تشغيلية عربية · ١٢ نوفمبر ٢٠٢٦'), PAGE.left + CONTENT_WIDTH / 2, 739, { width: CONTENT_WIDTH / 2, align: 'left', lineBreak: false });
  newBodyPage();
}

function renderTOC() {
  const section = children(body).find(node => node.name === 'section' && node.attribs?.id === 'welcome');
  const toc = section && children(section).find(node => node.name === 'ol' && node.attribs?.class === 'toc');
  if (!toc) return;
  sectionHeading('محتويات الدليل', 3);
  for (const item of nodes(toc, 'li')) {
    const anchor = nodes(item, 'a')[0];
    const href = anchor?.attribs?.href ?? '';
    const target = href.replace(/^#/, '');
    const label = textContent(anchor).replace(/^\s*\d+\s*/, '').trim();
    const y = doc.y;
    writeParagraph(label, { size: 9.4, lineHeight: 15, after: 0 });
    const height = Math.max(14, doc.y - y);
    doc.goTo(PAGE.left, y, CONTENT_WIDTH, height, target);
    doc.save().strokeColor(COLOR.line).lineWidth(0.35).dash(1, { space: 2 }).moveTo(PAGE.left, doc.y + 2).lineTo(PAGE.left + CONTENT_WIDTH, doc.y + 2).stroke().undash().restore();
    doc.y += 4;
  }
}

function footerPages() {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    if (index === 0) continue;
    const y = PAGE.height - 36;
    doc.save().strokeColor(COLOR.line).lineWidth(0.6).moveTo(PAGE.left, y - 7).lineTo(PAGE.width - PAGE.right, y - 7).stroke().restore();
    setFont(7.7, false, COLOR.muted);
    const pageLabel = `صفحة ${index + 1} من ${total}`;
    doc.text(shape(pageLabel), PAGE.left, y, { width: CONTENT_WIDTH, align: 'center', lineBreak: false });
    const rightLabel = 'دليل المستخدم · نظام التنمية المحلية';
    doc.text(shape(rightLabel), PAGE.left, y, { width: CONTENT_WIDTH, align: 'right', lineBreak: false });
  }
}

async function main() {
  if (!fs.existsSync(FONT) || !fs.existsSync(BOLD)) throw new Error('خط FreeSerif العربي غير متاح.');
  if (!fs.existsSync(SOURCE) || !fs.existsSync(LOGO)) throw new Error('ملف المصدر أو الشعار غير موجود.');
  renderCover();
  const welcome = children(body).find(node => node.name === 'section' && node.attribs?.id === 'welcome');
  if (welcome) {
    for (const child of children(welcome)) {
      if (child.name === 'h3' && child.attribs?.class?.includes('section')) continue;
      if (child.name === 'ol' && child.attribs?.class === 'toc') continue;
      renderNode(child);
    }
    renderTOC();
  }
  for (const section of children(body).filter(node => node.name === 'section' && node.attribs?.class?.includes('chapter'))) renderNode(section);
  footerPages();
  const pageCount = doc.bufferedPageRange().count;
  doc.end();
  await new Promise((resolve, reject) => output.on('finish', resolve).on('error', reject));
  const pdf = fs.readFileSync(OUTPUT);
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length < 30000 || pageCount < 20 || anchors.length !== 16) {
    throw new Error(`فشل فحص PDF: ${JSON.stringify({ bytes: pdf.length, pageCount, anchors: anchors.length, renderedWords })}`);
  }
  console.log(JSON.stringify({ output: OUTPUT, bytes: pdf.length, pages: pageCount, chaptersAndAppendix: anchors.length, renderedWords }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
  doc.end();
});
