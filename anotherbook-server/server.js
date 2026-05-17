const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
require('dotenv').config();

let koreanFontBase64 = '';

async function loadKoreanFont() {
  try {
    const cssRes = await fetch(
      'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400&display=swap',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }
    );
    const css = await cssRes.text();
    const match = css.match(/url\((https:\/\/[^)]+\.woff2)\)/);
    if (!match) throw new Error('woff2 URL not found in Google Fonts CSS');
    const fontRes = await fetch(match[1]);
    const buf = await fontRes.arrayBuffer();
    koreanFontBase64 = Buffer.from(buf).toString('base64');
    console.log('Korean font (NotoSansKR) loaded successfully');
  } catch (err) {
    console.error('Failed to load Korean font:', err.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'AnotherBook PDF Server running' });
});

// ── IMAGE PROXY ENDPOINT ──
app.get('/proxy-image', async (req, res) => {
  const { url } = req.query;
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || 'image/png';
  res.set('Content-Type', contentType);
  res.send(Buffer.from(buffer));
});

// ── COVER GENERATION ENDPOINT ──
app.post('/generate-cover', async (req, res) => {
  const { prompt } = req.body;
  if (!process.env.IDEOGRAM_API_KEY) {
    return res.status(500).json({ error: 'IDEOGRAM_API_KEY not configured' });
  }
  try {
    const response = await fetch('https://api.ideogram.ai/v1/ideogram-v3/generate', {
      method: 'POST',
      headers: {
        'Api-Key': process.env.IDEOGRAM_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: prompt,
        negative_prompt: 'people, person, human, woman, man, girl, boy, face, hands, body, portrait, realistic photo, photography, text, words, letters, typography, numbers, signs, watermark',
        aspect_ratio: '2x3',
        num_images: 1,
        rendering_speed: 'FLASH',
        style_type: 'ILLUSTRATION',
        magic_prompt_option: 'OFF'
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ──
function hasKorean(str) {
  return /[가-힣ᄀ-ᇿ㄰-㆏]/.test(str || '');
}

function stripKorean(str) {
  return (str || '').replace(/[가-힣ᄀ-ᇿ㄰-㆏]/g, '').trim();
}

function convertMarkdown(text) {
  return (text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// ── MAIN PDF GENERATION ENDPOINT ──
app.post('/generate-pdf', async (req, res) => {
  const {
    bookTitle,
    authorName,
    chapters,        // array of { title, content }
    coverImageUrl,   // DALL-E image URL or null
    coverDesign,     // { coverColor, textColor,
                     //   accentColor, layout }
    language,        // 'ko' or 'en'
    selectedProduct  // 'digital', 'physical', 'gift'
  } = req.body;

  let browser;

  try {
    const bookHTML = generateBookHTML({
      bookTitle,
      authorName,
      chapters,
      coverImageUrl,
      coverDesign,
      language
    });

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    await page.setContent(bookHTML, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for all fonts (including Google Fonts) to fully download
    await page.evaluateHandle('document.fonts.ready');

    // Wait for images to load
    await page.evaluate(() => {
      return Promise.all(
        Array.from(document.images)
          .filter(img => !img.complete)
          .map(img => new Promise(resolve => {
            img.onload = img.onerror = resolve;
          }))
      );
    });

    // Calculate actual page numbers and update TOC placeholders
    await page.evaluate(() => {
      const PAGE_H_PX = (188 / 25.4) * 96;
      document.querySelectorAll('.chapter-page').forEach((el, i) => {
        let top = 0, node = el;
        while (node) { top += (node.offsetTop || 0); node = node.offsetParent; }
        const pageNum = Math.floor(top / PAGE_H_PX) + 1;
        const span = document.getElementById('toc-pnum-' + i);
        if (span) span.textContent = pageNum;
      });
    });

    const pdfBuffer = await page.pdf({
      width: '127mm',
      height: '188mm',
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: 0, bottom: 0,
                left: 0, right: 0 }
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        `attachment; filename="${bookTitle || 'my-story'}.pdf"`,
      'Content-Length': pdfBuffer.length
    });

    res.send(pdfBuffer);

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('PDF generation error:', error.message);
    console.error('PDF generation stack:', error.stack);
    res.status(500).json({
      error: 'PDF generation failed',
      message: error.message
    });
  }
});

// ── HTML GENERATION FUNCTION ──
function generateBookHTML({
  bookTitle,
  authorName,
  chapters,
  coverImageUrl,
  coverDesign,
  language
}) {
  const isKorean = language === 'ko';
  const coverBg     = coverDesign?.coverColor  || '#3D5A47';
  const textColor   = coverDesign?.textColor   || '#FFFFFF';
  const accentColor = coverDesign?.accentColor || '#C4A882';

  // Cover always shows English — strip Korean characters if present
  const coverAuthor = hasKorean(authorName) ? stripKorean(authorName) : (authorName || '');

  // Generate chapter HTML
  const chaptersHTML = chapters.map((ch, i) => {
    const chapterTitle = convertMarkdown(ch.title || '');

    const paragraphs = (ch.content || '')
      .split('\n')
      .filter(p => p.trim().length > 0)
      .map((p, pIndex) => {
        const trimmed = p.trim();

        if (trimmed === '---' || trimmed === '***') {
          return `<div class="scene-break">*&nbsp;&nbsp;*&nbsp;&nbsp;*</div>`;
        }

        const isFirst = pIndex === 0;
        return `<p class="${isFirst ? 'first-para' : ''}">${convertMarkdown(trimmed)}</p>`;
      })
      .join('\n');

    return `
      <div class="chapter-page" data-chapter-index="${i}">
        <div class="chapter-num">${i + 1}</div>
        <h2 class="chapter-title">${chapterTitle}</h2>
        <div class="chapter-body">
          ${paragraphs}
        </div>
      </div>
    `;
  }).join('\n');

  // Table of contents with dot leaders and page number placeholders
  const tocHTML = chapters.map((ch, i) => `
    <div class="toc-entry">
      <span class="toc-num">${i + 1}</span>
      <span class="toc-title">${convertMarkdown(ch.title || '')}</span>
      <span class="toc-dots"></span>
      <span class="toc-page-num" id="toc-pnum-${i}">—</span>
    </div>
  `).join('\n');

  return `
<!DOCTYPE html>
<html lang="${isKorean ? 'ko' : 'en'}">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Montserrat:wght@300&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>

@font-face {
  font-family: 'NotoSansKR';
  src: url(data:font/woff2;base64,${koreanFontBase64}) format('woff2');
}

/* ── PAGE SETUP ── */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  width: 127mm;
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', Georgia, serif"};
  color: #1a1a1a;
  background: white;
}

/* ── COVER PAGE (color allowed here only) ── */
.cover-page {
  width: 127mm;
  height: 188mm;
  background-color: ${coverBg};
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  page-break-after: always;
}

.cover-image {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  opacity: 0.85;
}

.cover-overlay {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 12mm 10mm;
}

.cover-title {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Bebas Neue', sans-serif"};
  font-size: ${isKorean ? '22pt' : '28pt'};
  font-weight: ${isKorean ? '700' : '400'};
  color: ${textColor};
  line-height: 1.2;
  letter-spacing: ${isKorean ? '0.02em' : '0.01em'};
  max-width: 90%;
}

.cover-author {
  font-family: 'Montserrat', sans-serif;
  font-weight: 300;
  font-size: 11pt;
  color: ${textColor};
  opacity: 0.85;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}

.cover-logo {
  font-family: 'Montserrat', sans-serif;
  font-size: 8pt;
  color: ${accentColor};
  letter-spacing: 0.2em;
  text-transform: uppercase;
  text-align: center;
  margin-top: 4mm;
}

.cover-accent-line {
  width: 40%;
  height: 1px;
  background: ${accentColor};
  margin: 4mm 0;
}

/* ── TOC PAGE ── */
.toc-page {
  width: 127mm;
  height: 188mm;
  padding: 90px 15mm 20mm;
  page-break-after: always;
  display: flex;
  flex-direction: column;
}

.toc-entry {
  display: flex;
  align-items: baseline;
  gap: 2mm;
  margin-bottom: 5mm;
  font-size: 10pt;
  line-height: 1.5;
}

.toc-num {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  font-size: 9pt;
  color: #000000;
  min-width: 5mm;
  font-weight: 400;
  flex-shrink: 0;
}

.toc-title {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  color: #000000;
  font-size: 10pt;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  flex-shrink: 1;
}

.toc-dots {
  flex: 1;
  border-bottom: 1px dotted #999;
  margin-bottom: 3px;
  min-width: 5mm;
  flex-shrink: 0;
}

.toc-page-num {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  font-size: 9pt;
  color: #000000;
  min-width: 7mm;
  text-align: right;
  flex-shrink: 0;
}

/* ── CHAPTER PAGES ── */
.chapter-page {
  width: 127mm;
  min-height: 188mm;
  padding: 18mm 15mm 20mm;
  page-break-before: always;
}

.chapter-num {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', Georgia, serif"};
  font-size: 28px;
  font-weight: 400;
  color: #1a1a1a;
  text-align: center;
  letter-spacing: 8px;
  margin-top: 12mm;
  margin-bottom: 8px;
}

.chapter-title {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  font-size: 22px;
  font-weight: 700;
  color: #1a1a1a;
  text-align: center;
  line-height: 1.3;
  margin-bottom: 40px;
}

/* ── BODY TEXT ── */
.chapter-body {
  font-size: ${isKorean ? '10.5pt' : '11pt'};
  line-height: ${isKorean ? '2.0' : '1.85'};
  color: #1a1a1a;
  text-align: justify;
  hyphens: auto;
  word-break: ${isKorean ? 'keep-all' : 'normal'};
}

.chapter-body p {
  margin-bottom: 0;
  text-indent: ${isKorean ? '1em' : '1.5em'};
}

.chapter-body p.first-para {
  text-indent: 0;
}

/* Drop cap for English only */
${!isKorean ? `
.chapter-body p.first-para::first-letter {
  font-family: 'Lora', serif;
  font-size: 3.2em;
  font-weight: 700;
  float: left;
  line-height: 0.75;
  margin-right: 3px;
  margin-top: 4px;
  color: #1a1a1a;
}
` : ''}

.chapter-body em {
  font-style: italic;
}

.scene-break {
  text-align: center;
  color: #1a1a1a;
  font-size: 14px;
  margin: 6mm 0;
  letter-spacing: 12px;
}

/* ── PRINT SETTINGS ── */
@media print {
  @page {
    size: 127mm 188mm;
    margin: 0;
  }

  p {
    orphans: 3;
    widows: 3;
  }
}

</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover-page">
  ${coverImageUrl
    ? `<img class="cover-image"
            src="${coverImageUrl}"
            alt="cover"
            crossorigin="anonymous">`
    : ''}
  <div class="cover-overlay">
    <div>
      <div class="cover-title">${bookTitle || ''}</div>
      <div class="cover-accent-line"></div>
    </div>
    <div>
      ${coverAuthor ? `<div class="cover-author">${coverAuthor}</div>` : ''}
      <div class="cover-logo">anotherbook</div>
    </div>
  </div>
</div>

<!-- TABLE OF CONTENTS -->
<div class="toc-page">
  ${tocHTML}
</div>

<!-- CHAPTERS -->
${chaptersHTML}

</body>
</html>
  `;
}

async function testPuppeteer() {
  try {
    const b = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process']
    });
    await b.close();
    console.log('Puppeteer OK');
  } catch (err) {
    console.error('Puppeteer startup test failed:', err.message);
    console.error('Puppeteer startup stack:', err.stack);
  }
}

// ── START SERVER ──
const PORT = process.env.PORT || 3001;
Promise.all([loadKoreanFont(), testPuppeteer()]).then(() => {
  app.listen(PORT, () => {
    console.log(`AnotherBook PDF Server running on port ${PORT}`);
  });
});
