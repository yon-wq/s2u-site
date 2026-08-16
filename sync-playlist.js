// scripts/sync-playlist.js
// Reads the "인스트럭터 세션 트래커" Notion database, filters rows where
// 담당 브랜드 = "S2:U" and 음악 링크 is set, and rewrites the auto-generated
// playlist block in index.html (between the PLAYLIST_AUTO_START/END markers).
//
// Requires a NOTION_TOKEN env var (a Notion internal integration token that
// has been shared with the "인스트럭터 세션 트래커" database).

const fs = require('fs');
const path = require('path');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '46bee8b251d44405937be6fd9eb3a14c'; // 인스트럭터 세션 트래커
const INDEX_HTML = path.join(__dirname, '..', 'index.html');

if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN env var. Add it as a repo secret (Settings → Secrets and variables → Actions).');
  process.exit(1);
}

const PALETTE = [
  ['#ff3d2e', '#1a0b08'], ['#2b6cb0', '#0a1420'], ['#2b6cb0', '#08131c'],
  ['#ff3d2e', '#1c0f08'], ['#2b6cb0', '#0c1a10'],
];

function providerOf(url) {
  if (/open\.spotify\.com/.test(url)) return 'SPOTIFY';
  if (/music\.youtube\.com|youtube\.com|youtu\.be/.test(url)) return 'YOUTUBE MUSIC';
  if (/soundcloud\.com/.test(url)) return 'SOUNDCLOUD';
  return 'LINK';
}

function embedSrc(url) {
  if (/open\.spotify\.com/.test(url)) {
    const m = url.match(/playlist\/([a-zA-Z0-9]+)/) || url.match(/track\/([a-zA-Z0-9]+)/);
    const kind = url.includes('/track/') ? 'track' : 'playlist';
    return m ? `https://open.spotify.com/embed/${kind}/${m[1]}?utm_source=generator&theme=0` : null;
  }
  if (/music\.youtube\.com|youtube\.com|youtu\.be/.test(url)) {
    const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (listMatch) return `https://www.youtube.com/embed/videoseries?list=${listMatch[1]}`;
    const vidMatch = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return vidMatch ? `https://www.youtube.com/embed/${vidMatch[1]}` : null;
  }
  if (/soundcloud\.com/.test(url)) {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff3d2e&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false&visual=false`;
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function queryNotion() {
  const results = [];
  let cursor = undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          and: [
            { property: '담당 브랜드', select: { equals: 'S2:U' } },
            { property: '음악 링크', url: { is_not_empty: true } },
          ],
        },
        sorts: [{ property: '수업일', direction: 'descending' }],
        start_cursor: cursor,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

function extractTrack(page) {
  const props = page.properties;
  const title = props['프로그램/수업명']?.title?.[0]?.plain_text || '(제목 없음)';
  const instructor = props['강사']?.rich_text?.[0]?.plain_text || '';
  const url = props['음악 링크']?.url || '';
  return { title, tag: instructor, url };
}

function buildBlock(tracks) {
  const wave = '<svg class="mix-wave" viewBox="0 0 120 32" aria-hidden="true"><path d="M2 16h2M8 10h2v12H8zM14 4h2v24h-2zM20 12h2v8h-2zM26 8h2v16h-2zM32 14h2v4h-2zM38 2h2v28h-2zM44 11h2v10h-2zM50 6h2v20h-2zM56 15h2v2h-2z" fill="currentColor" opacity="0.85"/></svg>';

  const cards = tracks.map((t, i) => {
    const [c1, c2] = PALETTE[i % PALETTE.length];
    const src = embedSrc(t.url);
    const label = providerOf(t.url);
    const iframe = src
      ? `<iframe class="mix-iframe" id="mix-iframe-${i}" data-src="${escapeHtml(src)}" allow="autoplay; encrypted-media" loading="lazy"></iframe>`
      : '';
    return `    <div class="mix-card">
      <div class="mix-card-head">
        <span class="mix-title">${escapeHtml(t.title)}</span>
        <span class="mix-tag">${escapeHtml(t.tag)}</span>
      </div>
      <div class="mix-player-wrap">
        ${iframe}
        <button class="mix-thumb" type="button" data-idx="${i}" style="background:linear-gradient(150deg, ${c1}55, ${c2} 75%);">
          ${wave}
          <span class="mix-play-btn">▶</span>
          <span class="mix-thumb-label">탭하여 재생 · ${label}</span>
        </button>
      </div>
      <a class="mix-fallback" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${label}에서 열기 ↗</a>
    </div>`;
  }).join('\n');

  const jsonBlock = JSON.stringify(tracks, null, 2);

  return `<div class="mix-grid" id="mixGrid">
${cards}
    </div>
    <script type="application/json" id="playlist-data">
${jsonBlock}
</script>`;
}

async function main() {
  const pages = await queryNotion();
  const tracks = pages.map(extractTrack).filter(t => t.url);

  if (tracks.length === 0) {
    console.log('No S2:U tracks with a music link found — leaving index.html untouched.');
    return;
  }

  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const startMarker = '<!-- PLAYLIST_AUTO_START (regenerated by .github/workflows/sync-playlist.yml — do not hand-edit between these markers) -->';
  const endMarker = '<!-- PLAYLIST_AUTO_END -->';

  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('Could not find PLAYLIST_AUTO_START/END markers in index.html');
  }

  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  const newBlock = '\n        ' + buildBlock(tracks) + '\n        ';
  const newHtml = before + newBlock + after;

  if (newHtml === html) {
    console.log('Playlist already up to date — no changes.');
    return;
  }

  fs.writeFileSync(INDEX_HTML, newHtml, 'utf-8');
  console.log(`Updated index.html with ${tracks.length} track(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
