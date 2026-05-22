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
        negative_prompt: 'people, person, human, woman, man, girl, boy, face, hands, body, portrait, photorealistic, hyperrealistic, 3D render, CGI, photograph, photography, realistic photo, text, words, letters, typography, numbers, signs, watermark',
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
      language
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
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;text-align:center;font-size:7pt;color:#999;font-family:'Lora',Georgia,serif;padding-bottom:4mm;"><span class="pageNumber"></span></div>`,
      margin: { top: 0, bottom: '20mm', left: 0, right: 0 }
    });

    await browser.close();

    const safeFilename = encodeURIComponent((bookTitle || 'my-story') + '.pdf');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="story.pdf"; filename*=UTF-8''${safeFilename}`,
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
      .filter(p => {
        const t = p.trim();
        if (!t) return false;
        // Strip AI-generated markdown headers (## 챕터 X, ## Chapter X, # Title, etc.)
        if (/^#{1,6}\s/.test(t)) return false;
        return true;
      })
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

  // Table of contents — chapter number + title only, no page numbers
  const tocHTML = chapters.map((ch, i) => `
    <div class="toc-entry">
      <span class="toc-num">${i + 1}</span>
      <span class="toc-title">${convertMarkdown(ch.title || '')}</span>
    </div>
  `).join('\n');

  return `
<!DOCTYPE html>
<html lang="${isKorean ? 'ko' : 'en'}">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Bebas+Neue&family=Montserrat:wght@300;400;600&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>

@font-face {
  font-family: 'NotoSansKR';
  src: url(data:font/woff2;base64,${koreanFontBase64}) format('woff2');
}

/* ── PAGE SETUP ── */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', Georgia, serif"};
  color: #1a1a1a;
  background: white;
}

/* ── COVER PAGE ── */
.cover-page {
  width: 127mm;
  height: 188mm;
  background-color: #1B2A4A;
  position: relative;
  overflow: hidden;
  page: cover-page;
  page-break-after: always;
}

.cover-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-scrim {
  position: absolute;
  left: 0; right: 0;
  top: 22%;
  padding: 10mm 10mm 14mm;
  background: linear-gradient(to bottom,
    rgba(0,0,0,0) 0%,
    rgba(0,0,0,0.68) 12%,
    rgba(0,0,0,0.68) 80%,
    rgba(0,0,0,0) 100%);
}

.cover-title {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Barlow Condensed', 'Bebas Neue', sans-serif"};
  font-size: ${isKorean ? '22pt' : '34pt'};
  font-weight: ${isKorean ? '700' : '900'};
  color: #FFFFFF;
  line-height: ${isKorean ? '1.25' : '1.1'};
  letter-spacing: ${isKorean ? 'normal' : '1px'};
  text-align: left;
  margin-bottom: 3mm;
}

.cover-author {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Montserrat', sans-serif"};
  font-size: 10pt;
  font-weight: ${isKorean ? '400' : '400'};
  color: #FFFFFF;
  opacity: 0.85;
  letter-spacing: ${isKorean ? '0.05em' : '0.15em'};
  text-transform: ${isKorean ? 'none' : 'uppercase'};
  text-align: left;
}

/* ── TOC PAGE ── */
.toc-page {
  width: auto;
  min-height: 155mm;
  padding: 15mm 0 20mm;
  page-break-after: always;
  display: flex;
  flex-direction: column;
}

.toc-heading {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  font-size: 7.5pt;
  font-weight: 400;
  color: #aaaaaa;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin-bottom: 9mm;
}

.toc-entry {
  display: flex;
  align-items: baseline;
  gap: 4mm;
  margin-bottom: 6mm;
}

.toc-num {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  font-size: 9pt;
  color: #999999;
  min-width: 5mm;
  font-weight: 400;
  flex-shrink: 0;
}

.toc-title {
  font-family: ${isKorean
    ? "'NotoSansKR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"
    : "'Lora', serif"};
  color: #1a1a1a;
  font-size: 10.5pt;
  line-height: 1.45;
  flex-shrink: 1;
}

/* ── CHAPTER PAGES ── */
.chapter-page {
  width: auto;
  min-height: 155mm;
  padding: 0 0 15mm;
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
  margin-top: 10mm;
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
@page {
  size: 127mm 188mm;
  margin: 18mm 15mm 10mm;
}

@page cover-page {
  margin: 0;
}

@media print {
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
    ? `<img class="cover-image" src="${coverImageUrl}" alt="cover" crossorigin="anonymous">`
    : ''}
  <div class="cover-scrim">
    <div class="cover-title">${bookTitle || ''}</div>
    ${authorName ? `<div class="cover-author">${authorName}</div>` : ''}
  </div>
</div>

<!-- TABLE OF CONTENTS -->
<div class="toc-page">
  <div class="toc-heading">${isKorean ? '목차' : 'Contents'}</div>
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
