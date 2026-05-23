const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
require('dotenv').config(); // v2

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
  const { prompt, language } = req.body;
  if (!process.env.IDEOGRAM_API_KEY) {
    return res.status(500).json({ error: 'IDEOGRAM_API_KEY not configured' });
  }
  // English covers: Ideogram renders the complete cover including typography, so text is allowed.
  // Korean covers: no text in image; title/author are overlaid by the app.
  const negativePrompt = language === 'en'
    ? 'people, person, human, woman, man, girl, boy, face, hands, body, portrait, photorealistic, hyperrealistic, 3D render, CGI, photograph, photography, realistic photo, watermark'
    : 'people, person, human, woman, man, girl, boy, face, hands, body, portrait, photorealistic, hyperrealistic, 3D render, CGI, photograph, photography, realistic photo, text, words, letters, typography, numbers, signs, watermark';
  try {
    const response = await fetch('https://api.ideogram.ai/v1/ideogram-v3/generate', {
      method: 'POST',
      headers: {
        'Api-Key': process.env.IDEOGRAM_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: prompt,
        negative_prompt: negativePrompt,
        aspect_ratio: '2x3',
        num_images: 1,
        rendering_speed: 'FLASH',
        style_type: 'DESIGN',
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

function sanitizeFilename(s) {
  return (s || '').replace(/[\s/\\:*?"<>|]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'untitled';
}

// Fetch a URL and return a base64 data URI, or null on failure.
async function fetchImageAsDataUri(url) {
  if (!url) return null;
  try {
    console.log(`[cover] Fetching cover image: ${url.substring(0, 80)}...`);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.error(`[cover] HTTP ${res.status} fetching cover image`);
      return null;
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buf = await res.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    console.log(`[cover] Cover image fetched OK — ${buf.byteLength} bytes, type=${contentType}`);
    return `data:${contentType};base64,${b64}`;
  } catch (err) {
    console.error(`[cover] Failed to fetch cover image: ${err.message}`);
    return null;
  }
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
    // Pre-fetch cover image to base64 so Puppeteer never hits an external URL
    // (avoids Ideogram URL expiry and CORS issues in headless Chromium)
    const coverDataUri = await fetchImageAsDataUri(coverImageUrl);
    if (coverImageUrl && !coverDataUri) {
      console.warn('[cover] Cover image could not be fetched — PDF will render without cover image');
    }

    const bookHTML = generateBookHTML({
      bookTitle,
      authorName,
      chapters,
      coverImageUrl: coverDataUri,
      coverDesign,
      language,
      selectedProduct
    });

    const isLinux = process.platform === 'linux';
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        ...(isLinux ? ['--no-zygote', '--single-process'] : [])
      ]
    });

    const page = await browser.newPage();

    await page.setContent(bookHTML, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for all fonts (including Google Fonts) to fully download
    await page.evaluateHandle('document.fonts.ready');

    // Wait for images to load and log per-image status
    const imageResults = await page.evaluate(() => {
      const imgs = Array.from(document.images);
      return Promise.all(
        imgs.map(img => new Promise(resolve => {
          if (img.complete) {
            resolve({ src: img.src.substring(0, 60), loaded: img.naturalWidth > 0 });
          } else {
            img.onload = () => resolve({ src: img.src.substring(0, 60), loaded: true });
            img.onerror = () => resolve({ src: img.src.substring(0, 60), loaded: false });
          }
        }))
      );
    });
    imageResults.forEach(r => {
      if (r.loaded) {
        console.log(`[img] loaded OK: ${r.src}`);
      } else {
        console.error(`[img] FAILED to load: ${r.src}`);
      }
    });

    const pdfBuffer = await page.pdf({
      width: '127mm',
      height: '188mm',
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: '0', bottom: '0', left: '0', right: '0' }
    });

    await browser.close();

    const filename = `anotherbook_${sanitizeFilename(bookTitle)}_${sanitizeFilename(authorName)}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
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
  language,
  selectedProduct
}) {
  const isKorean = language === 'ko';
  const tier = selectedProduct === 'physical' ? 'physical' : 'digital';
  const coverBg = coverDesign?.coverColor || '#3D5A47';

  const coverAuthor = hasKorean(authorName) ? stripKorean(authorName) : (authorName || '');
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const today = new Date();
  const yr = today.getFullYear();
  const mo = today.getMonth() + 1;
  const dy = today.getDate();
  const publishDateKo = `${yr}년 ${mo}월 ${dy}일`;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const publishDateEn = `${MONTHS[today.getMonth()]} ${dy}, ${yr}`;

  const bodyFont = isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', Georgia, serif";

  // ── Copyright page ──
  const copyrightHTML = isKorean ? `
<div class="copyright-page">
  <p class="cp-title">${esc(bookTitle)}</p>
  <div class="cp-table">
    <div class="cp-row"><span class="cp-label">발행</span><span class="cp-sep">│</span><span class="cp-val">${publishDateKo}</span></div>
    <div class="cp-row"><span class="cp-label">저자</span><span class="cp-sep">│</span><span class="cp-val">${esc(authorName)}</span></div>
    <div class="cp-row"><span class="cp-label">펴낸곳</span><span class="cp-sep">│</span><span class="cp-val">어나더북</span></div>
  </div>
  <p class="cp-desc">이 책은 어나더북(AnotherBook)의 AI 작가와 함께 쓴<br>세상에 하나뿐인 맞춤형 소설입니다.</p>
  <p class="cp-copy">© ${yr} 어나더북. All rights reserved.</p>
</div>` : `
<div class="copyright-page">
  <p class="cp-title">${esc(bookTitle)}</p>
  <div class="cp-table">
    <div class="cp-row"><span class="cp-label">First Edition</span><span class="cp-sep">·</span><span class="cp-val">${publishDateEn}</span></div>
    <div class="cp-row"><span class="cp-label">Author</span><span class="cp-sep">·</span><span class="cp-val">${esc(authorName)}</span></div>
    <div class="cp-row"><span class="cp-label">Published by</span><span class="cp-sep">·</span><span class="cp-val">AnotherBook</span></div>
  </div>
  <p class="cp-desc">This book is a one-of-a-kind personalized novel,<br>written together with AnotherBook's AI writer.<br>Every story is unique to its reader.</p>
  <p class="cp-copy">© ${yr} AnotherBook. All rights reserved.</p>
</div>`;

  // ── TOC (chapter number + title only, no page numbers) ──
  const tocHTML = `
<div class="toc-page">
  <div class="toc-heading">${isKorean ? '목 차' : 'Contents'}</div>
  ${chapters.map((ch, i) => `
  <div class="toc-entry">
    <span class="toc-num">${i + 1}</span>
    <span class="toc-title">${convertMarkdown(ch.title || '')}</span>
  </div>`).join('')}
</div>`;

  const blankPage = `<div class="blank-page"></div>`;

  // Digital:  Cover | Copyright | TOC | Blank | Ch1…
  // Physical: Cover | Copyright | Blank | Blank | TOC | Blank | Ch1…
  const middleFrontMatter = tier === 'physical'
    ? `${blankPage}\n${blankPage}\n${tocHTML}\n${blankPage}`
    : `${tocHTML}\n${blankPage}`;

  // ── Chapter pages ──
  const chaptersHTML = chapters.map((ch, i) => {
    const paragraphs = (ch.content || '')
      .split('\n')
      .filter(p => {
        const t = p.trim();
        return t && !/^#{1,6}\s/.test(t);
      })
      .map((p, pIdx) => {
        const t = p.trim();
        if (t === '---' || t === '***') return `<div class="scene-break">*&nbsp;&nbsp;*&nbsp;&nbsp;*</div>`;
        return `<p class="${pIdx === 0 ? 'first-para' : ''}">${convertMarkdown(t)}</p>`;
      })
      .join('\n');

    return `
<div class="chapter-page${i === 0 ? ' first-chapter' : ''}">
  <div class="chapter-num">${i + 1}</div>
  <h2 class="chapter-title">${convertMarkdown(ch.title || '')}</h2>
  <div class="chapter-body">
    ${paragraphs}
  </div>
</div>`;
  }).join('\n');

  // ── Margins per tier ──
  // Digital: symmetric 18mm. Physical: mirrored (inside 22mm, outside 15mm).
  const marginCSS = tier === 'physical' ? `
@page          { size: 127mm 188mm; margin: 18mm; }
@page :left    { margin-left: 22mm; margin-right: 15mm; }
@page :right   { margin-left: 15mm; margin-right: 22mm; }` : `
@page          { size: 127mm 188mm; margin: 18mm; }`;

  return `<!DOCTYPE html>
<html lang="${isKorean ? 'ko' : 'en'}">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Bebas+Neue&family=Montserrat:wght@300;400;600&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
@font-face { font-family: 'NotoSansKR'; src: url(data:font/woff2;base64,${koreanFontBase64}) format('woff2'); }

* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: ${bodyFont}; color: #1a1a1a; background: white; }

${marginCSS}

/* Named pages: front matter gets no page number; body pages get centered counter */
@page cover-page { margin: 0; }
@page front-matter { @bottom-center { content: none; } }
@page {
  @bottom-center {
    content: counter(page);
    font-family: ${bodyFont};
    font-size: 9pt;
    color: #aaaaaa;
  }
}

/* ── COVER ── */
.cover-page {
  width: 127mm; height: 188mm;
  background-color: ${coverBg};
  position: relative; overflow: hidden;
  page: cover-page; page-break-after: always;
}
.cover-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cover-scrim {
  position: absolute; left: 0; right: 0; top: 22%;
  padding: 10mm 10mm 14mm;
  background: linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,.68) 12%, rgba(0,0,0,.68) 80%, rgba(0,0,0,0) 100%);
}
.cover-title {
  font-family: ${isKorean ? "'NotoSansKR','Malgun Gothic',sans-serif" : "'Barlow Condensed','Bebas Neue',sans-serif"};
  font-size: ${isKorean ? '22pt' : '34pt'}; font-weight: ${isKorean ? '700' : '900'};
  color: #fff; line-height: ${isKorean ? '1.25' : '1.1'};
  letter-spacing: ${isKorean ? 'normal' : '1px'}; margin-bottom: 3mm;
}
.cover-author {
  font-family: ${isKorean ? "'NotoSansKR',sans-serif" : "'Montserrat',sans-serif"};
  font-size: 10pt; color: #fff; opacity: .85;
  letter-spacing: ${isKorean ? '.05em' : '.15em'};
  text-transform: ${isKorean ? 'none' : 'uppercase'};
}

/* ── COPYRIGHT ── */
.copyright-page {
  min-height: 155mm; page: front-matter; page-break-after: always;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 20mm 5mm 15mm;
}
.cp-title { font-family: ${bodyFont}; font-size: 13pt; font-weight: 700; text-align: center; margin-bottom: 14mm; }
.cp-table { margin-bottom: 12mm; }
.cp-row   { display: flex; gap: 4mm; margin-bottom: 4mm; font-family: ${bodyFont}; font-size: 9.5pt; }
.cp-label { min-width: 20mm; color: #888; }
.cp-sep   { color: #ccc; }
.cp-val   { color: #333; }
.cp-desc  { font-family: ${bodyFont}; font-size: 9pt; color: #777; text-align: center; line-height: 1.8; margin-bottom: 10mm; }
.cp-copy  { font-family: ${bodyFont}; font-size: 8.5pt; color: #aaa; text-align: center; }

/* ── BLANK / TOC ── */
.blank-page { min-height: 155mm; page: front-matter; page-break-after: always; }
.toc-page {
  min-height: 155mm; padding: 12mm 0 15mm;
  page: front-matter; page-break-after: always;
  display: flex; flex-direction: column;
}
.toc-heading { font-family: ${bodyFont}; font-size: 7.5pt; color: #aaa; letter-spacing: .18em; text-transform: uppercase; margin-bottom: 7mm; }
.toc-entry   { display: flex; align-items: baseline; gap: 4mm; margin-bottom: 4mm; }
.toc-num     { font-family: ${bodyFont}; font-size: 9pt; color: #999; min-width: 5mm; flex-shrink: 0; }
.toc-title   { font-family: ${bodyFont}; color: #1a1a1a; font-size: 10.5pt; line-height: 1.3; }

/* ── CHAPTER PAGES ──
   break-before: right forces each chapter to start on a recto (odd/right) page;
   Chromium inserts a blank verso automatically when needed.
   counter-reset: page 0 on the first chapter makes Chapter 1 = page 1. */
.chapter-page {
  padding-bottom: 15mm;
  break-before: right;
  page-break-before: right;
}
.chapter-page.first-chapter { counter-reset: page 0; }

.chapter-num {
  font-family: ${bodyFont}; font-size: 28px; font-weight: 400;
  color: #1a1a1a; text-align: center; letter-spacing: 8px;
  margin-top: 10mm; margin-bottom: 8px;
}
.chapter-title {
  font-family: ${bodyFont}; font-size: 22px; font-weight: 700;
  color: #1a1a1a; text-align: center; line-height: 1.3; margin-bottom: 40px;
}

/* ── BODY TEXT ── */
.chapter-body {
  font-size: ${isKorean ? '10.5pt' : '11pt'};
  line-height: ${isKorean ? '2.0' : '1.85'};
  color: #1a1a1a; text-align: justify; hyphens: auto;
  word-break: ${isKorean ? 'keep-all' : 'normal'};
}
.chapter-body p { margin-bottom: 0; text-indent: ${isKorean ? '1em' : '1.5em'}; }
.chapter-body p.first-para { text-indent: 0; }
${!isKorean ? `.chapter-body p.first-para::first-letter {
  font-size: 3.2em; font-weight: 700; float: left; line-height: .75; margin-right: 3px; margin-top: 4px;
}` : ''}
.chapter-body em { font-style: italic; }
.scene-break { text-align: center; font-size: 14px; margin: 6mm 0; letter-spacing: 12px; }

@media print { p { orphans: 3; widows: 3; } }
</style>
</head>
<body>

<div class="cover-page">
  ${coverImageUrl ? `<img class="cover-image" src="${coverImageUrl}" alt="cover">` : ''}
  ${isKorean ? `<div class="cover-scrim">
    <div class="cover-title">${esc(bookTitle)}</div>
    ${coverAuthor ? `<div class="cover-author">${esc(coverAuthor)}</div>` : ''}
  </div>` : ''}
</div>

${copyrightHTML}

${middleFrontMatter}

${chaptersHTML}

</body>
</html>`;
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
