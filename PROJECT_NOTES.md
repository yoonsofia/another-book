\# AnotherBook Project Notes

Last updated: 2026-05-04



\## Project Overview

AI-powered personalized novel service. Customer answers a questionnaire,

AI writes a custom 10-chapter novel, customer receives it as PDF or printed book.



\*\*Live website:\*\* https://yoonsofia.github.io/another-book

\*\*PDF server:\*\* https://anotherbook-server-production.up.railway.app



\---



\## Folder Structure



C:\\Users\\Sae saem Yoon\\PROJECTS

│ ├── MYFIRSTAPP\\ ← website (index.html) │ ├── index.html │ └── PROJECT\_NOTES.md │ └── anotherbook-server\\ ← PDF server (server.js) ├── server.js ├── package.json ├── nixpacks.toml └── .railwayignore





\---



\## Deploy Commands



\### Website (index.html → GitHub Pages):

```bash

cd "C:\\Users\\Sae saem Yoon\\PROJECTS\\MYFIRSTAPP"

git add index.html

git commit -m "describe change"

git push origin main



PDF Server

cd "C:\\Users\\Sae saem Yoon\\PROJECTS\\anotherbook-server"

railway up



Pricing

Digital PDF: ₩9,900

Printed book: ₩39,900

Gift box (book + PDF + special packaging): ₩59,900

Premium gift box: ₩89,900

Story Generation

10 chapters per book

Target: \~5,000 words per chapter (split into 3 parts of 1,500 words each)

Total target: \~50,000 words (\~130 pages)

max\_tokens per part: 3,000

Languages supported: Korean (ko) and English (en)

Korean words/cultural references allowed naturally in English stories (romanized form preferred, e.g. eomma, aigoo, ahjussi)

jsPDF cannot render Hangul — use Puppeteer server for Korean PDFs

Cover Design

Direction:

Style: Bold flat graphic illustration (NOT watercolor)

One unexpected symbolic object representing story theme (e.g. cracked mirror, floating key, torn envelope, melting clock)

Symbol represents what the story FEELS like, not what literally happens

No people, no faces, no figures, no human silhouettes

No text, no letters in the DALL-E image

DALL-E 3 API Settings:

model: 'dall-e-3'

size: '1024x1792'

quality: 'hd'

style: 'vivid'

DALL-E 3 Prompt Structure:

Copy"Bold flat graphic illustration for a literary book cover. 

Central symbolic image: \[ONE unexpected object representing theme]. 

Background color: \[exact hex from Claude's decision]. 

Bold graphic flat illustration style, modern literary fiction book cover art,

clean bold shapes, strong color contrast, ultra crisp edges, 

solid color fills, high contrast, no soft gradients, no blur, no noise,

print-ready quality. No people, no faces, no figures. No text, no letters."

Claude decides (returns JSON):

coverColor (hex)

textColor (hex)

accentColor (hex)

symbol (description)

layout (e.g. title\_dominant, centered, split)

titleSize (massive/large/small)

titlePosition (top/center/bottom)

titleLines (array of strings)

authorPosition (bottom\_left/bottom\_right/bottom\_center)

symbolSize (percentage of cover)

symbolPosition (center/lower\_center/upper\_center)

dallePrompt (full prompt string)

Layout:

Top 25%: solid color band — title text

Middle \~50%: DALL-E illustration

Bottom 25%: solid color band — author name + logo

Forest green (#3D5A47) used as brand color for bands

Smart text contrast: dark text if background brightness > 180, white otherwise

Cover Selection Page Options:

AI Generated Cover (Claude + DALL-E 3)

Photo Upload (customer uploads their own photo)

Min size: 1MB, min resolution: 1000x1500px, aspect ratio \~2:3

Format: JPG or PNG

Simple Text Cover (typography only)

Fonts

Cover:

English title: Bebas Neue (400), letter-spacing 4px, large

English author: Montserrat Light (300), letter-spacing 6px, uppercase

Korean title: Noto Serif KR Bold (700)

Korean author: Noto Sans KR Light (300), letter-spacing 4px

Book Body (inside PDF):

English body: Lora (400, 700), font-size 11pt, line-height 1.8

Korean body: Noto Sans KR (400), font-size 11pt, line-height 2.0

Google Fonts to load in server.js:

Bebas Neue (400)

Playfair Display (700, 900)

Montserrat (300, 400)

Lora (400, 700)

Noto Serif KR (400, 700)

Noto Sans KR (300, 400)

PDF Generation

Method:

Primary: Puppeteer server on Railway (high quality, 300 DPI equivalent)

Fallback: jsPDF in browser (lower quality, backup only)

PDF Server endpoint:

POST https://anotherbook-server-production.up.railway.app/generate-pdf



Request body:

Copy{

&#x20; "bookTitle": "",

&#x20; "authorName": "",

&#x20; "chapters": \[],

&#x20; "coverImageUrl": "",

&#x20; "coverDesign": {},

&#x20; "language": "ko or en",

&#x20; "selectedProduct": ""

}

PDF Specs:

Page size: 127mm x 188mm (standard paperback)

Margins: standard book margins

Cover page: full bleed image with title/author overlay

Table of contents: chapter titles with page numbers

Chapter pages: drop caps (English only), scene breaks, headers/footers optional

Running headers: removed (not needed)

Print Quality Notes:

DALL-E 3 outputs at 72-96 DPI natively

Bold flat graphic style upscales better than painterly styles

Future improvement: add Replicate API for 2x upscaling after generation

Cost Per Book (approximate)

Chapter 1 generation (Claude): \~₩44

Chapters 2-10 (Claude): \~₩396

Cover design decision (Claude): \~₩15

Cover illustration (DALL-E 3 HD): \~₩58

Total: \~₩513 per book

Profit margins:

Digital PDF: ₩9,900 - ₩513 = ₩9,387 profit

Printed book: ₩39,900 - ₩513 - printing = \~₩29,900 profit

Gift box: ₩59,900 - ₩513 - packaging = \~₩44,400 profit

Pending / Not Started

Payment system integration

Email delivery system

Physical book printing partner

Price updates

API key protection for Railway server

Replicate API upscaling for print quality

Analytics / order tracking

Known Issues / Fixed

✅ jsPDF cannot render Korean Hangul → solved by Puppeteer server

✅ PDF font error (Playfair Display) → solved by using built-in fonts as fallback

✅ Cover still showing watercolor/book stack → needs new DALL-E prompt applied

✅ Railway crash: index.js not found → fixed package.json to use server.js

✅ Railway crash: server.js missing from folder → copied from MYFIRSTAPP folder

⚠️ Cover bold graphic style not yet confirmed live → needs screenshot test

⚠️ Font updates not yet applied to server.js → pending railway up



