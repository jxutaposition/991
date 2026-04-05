# JavaScript Code Node — 10 Production Patterns

## Pattern Selection Guide

| Goal | Pattern |
|------|---------|
| Combine multiple API responses | 1. Multi-Source Aggregation |
| Extract mentions/keywords | 2. Regex Filtering |
| Parse formatted text | 3. Markdown Parsing |
| Detect changes in data | 4. JSON Comparison |
| Prepare form data for CRM | 5. CRM Transformation |
| Process GitHub releases | 6. Release Processing |
| Add computed fields | 7. Array Transformation |
| Format Slack messages | 8. Slack Block Kit |
| Get top results | 9. Top N Filtering |
| Create text reports | 10. String Aggregation |

---

## 1. Multi-Source Data Aggregation

Combine data from multiple APIs, normalize different formats.

```javascript
const allItems = $input.all();
let articles = [];

for (const item of allItems) {
  const source = item.json.name || 'Unknown';
  const data = item.json;

  if (source === 'Hacker News' && data.hits) {
    for (const hit of data.hits) {
      articles.push({title: hit.title, url: hit.url, source: 'HN', score: hit.points || 0});
    }
  } else if (source === 'Reddit' && data.data?.children) {
    for (const post of data.data.children) {
      articles.push({title: post.data.title, url: post.data.url, source: 'Reddit', score: post.data.score || 0});
    }
  } else if (source === 'RSS' && data.items) {
    for (const rss of data.items) {
      articles.push({title: rss.title, url: rss.link, source: 'RSS', score: 0});
    }
  }
}

// Deduplicate by URL
const seen = new Set();
articles = articles.filter(a => !seen.has(a.url) && seen.add(a.url));

// Sort by score
articles.sort((a, b) => b.score - a.score);
return articles.map(a => ({json: {...a, fetchedAt: new Date().toISOString()}}));
```

---

## 2. Regex Filtering & Pattern Matching

Extract and track mentions using regex patterns.

```javascript
const etfPattern = /\b([A-Z]{2,5})\b/g;
const knownETFs = ['VOO', 'VTI', 'SCHD', 'SPY', 'QQQ', 'VXUS'];
const mentions = {};

for (const item of $input.all()) {
  const text = ((item.json.data?.title || '') + ' ' + (item.json.data?.selftext || '')).toUpperCase();
  const matches = text.match(etfPattern);
  if (matches) {
    for (const m of matches) {
      if (knownETFs.includes(m)) {
        mentions[m] = (mentions[m] || 0) + 1;
      }
    }
  }
}

return Object.entries(mentions)
  .map(([etf, count]) => ({json: {etf, mentions: count}}))
  .sort((a, b) => b.json.mentions - a.json.mentions);
```

**Variations**: Email `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b`, Phone `\d{3}[-.]?\d{3}[-.]?\d{4}`, Hashtag `#(\w+)`, URL `https?:\/\/[^\s]+`

---

## 3. Markdown Parsing & Structured Extraction

```javascript
const markdown = $input.first().json.data.markdown;
const adRegex = /##\s*(.*?)\n(.*?)(?=\n##|\n---|$)/gs;
const ads = [];
let match;

function parseTimeToMinutes(str) {
  if (!str) return 999999;
  let mins = 0;
  const d = str.match(/(\d+)\s*day/); if (d) mins += parseInt(d[1]) * 1440;
  const h = str.match(/(\d+)\s*hour/); if (h) mins += parseInt(h[1]) * 60;
  const m = str.match(/(\d+)\s*min/); if (m) mins += parseInt(m[1]);
  return mins;
}

while ((match = adRegex.exec(markdown)) !== null) {
  const title = match[1]?.trim() || 'No title';
  const content = match[2]?.trim() || '';
  const district = content.match(/\*\*District:\*\*\s*(.*?)(?:\n|$)/)?.[1]?.trim() || 'Unknown';
  const salary = content.match(/\*\*Salary:\*\*\s*(.*?)(?:\n|$)/)?.[1]?.trim() || 'N/A';
  const time = content.match(/Posted:\s*(.*?)\*/)?.[1];
  ads.push({title, district, salary, timeInMinutes: parseTimeToMinutes(time)});
}

ads.sort((a, b) => a.timeInMinutes - b.timeInMinutes);
return ads.map(ad => ({json: ad}));
```

---

## 4. JSON Comparison & Change Detection

```javascript
const orderKeys = obj => {
  const o = {};
  Object.keys(obj).sort().forEach(k => o[k] = obj[k]);
  return o;
};

const allItems = $input.all();
const original = JSON.parse(Buffer.from(allItems[0].json.content, 'base64').toString());
const current = allItems[1].json;

const diffs = [];
for (const key of Object.keys(original)) {
  if (JSON.stringify(original[key]) !== JSON.stringify(current[key])) {
    diffs.push({field: key, original: original[key], current: current[key]});
  }
}
for (const key of Object.keys(current)) {
  if (!(key in original)) diffs.push({field: key, original: null, current: current[key], status: 'new'});
}

return [{json: {identical: diffs.length === 0, differenceCount: diffs.length, differences: diffs}}];
```

**Deep diff variation**:
```javascript
function deepDiff(obj1, obj2, path = '') {
  const changes = [];
  for (const key in obj1) {
    const p = path ? `${path}.${key}` : key;
    if (!(key in obj2)) changes.push({type: 'removed', path: p, value: obj1[key]});
    else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') changes.push(...deepDiff(obj1[key], obj2[key], p));
    else if (obj1[key] !== obj2[key]) changes.push({type: 'modified', path: p, from: obj1[key], to: obj2[key]});
  }
  for (const key in obj2) {
    if (!(key in obj1)) changes.push({type: 'added', path: path ? `${path}.${key}` : key, value: obj2[key]});
  }
  return changes;
}
```

---

## 5. CRM Data Transformation

```javascript
const {name, email, phone, company, course_interest, message, timestamp} = $input.all()[0].json;

const nameParts = name.split(' ');
const firstName = nameParts[0] || '';
const lastName = nameParts.slice(1).join(' ') || 'Unknown';
const cleanPhone = phone.replace(/[^\d]/g, '');

return [{json: {
  data: {
    type: 'Contact',
    attributes: {
      first_name: firstName, last_name: lastName,
      email1: email.toLowerCase(), phone_work: cleanPhone,
      account_name: company,
      description: `Interest: ${course_interest}\nMessage: ${message}\nSubmitted: ${timestamp}`,
      lead_source: 'Website Form', status: 'New'
    }
  }
}}];
```

**Lead scoring variation**:
```javascript
function scoreContact(data) {
  let score = 0;
  if (data.email) score += 10;
  if (data.phone) score += 10;
  if (data.company) score += 15;
  if (data.title?.toLowerCase().includes('director')) score += 20;
  if (data.message?.length > 100) score += 10;
  return score;
}
```

---

## 6. Release Information Processing

```javascript
const releases = $input.first().json
  .filter(r => !r.prerelease && !r.draft)
  .slice(0, 10)
  .map(r => {
    let highlights = 'No highlights';
    if (r.body?.includes('## Highlights:')) {
      highlights = r.body.split('## Highlights:')[1]?.split('##')[0]?.trim();
    }
    return {
      tag: r.tag_name, name: r.name, published: r.published_at,
      author: r.author.login, url: r.html_url, highlights,
      assets: r.assets.map(a => ({name: a.name, size: a.size, downloads: a.download_count}))
    };
  });

return releases.map(r => ({json: r}));
```

---

## 7. Array Transformation with Context

```javascript
const items = $input.all()
  .sort((a, b) => b.json.score - a.json.score)
  .map((item, index) => ({
    json: {
      ...item.json,
      rank: index + 1,
      medal: index < 3 ? ['🥇', '🥈', '🥉'][index] : '',
      isRecent: new Date(item.json.date) > new Date(Date.now() - 30*24*60*60*1000),
      age: Math.floor((Date.now() - new Date(item.json.date)) / (24*60*60*1000)) + ' days ago'
    }
  }));

return items;
```

**Percentage variation**:
```javascript
const total = $input.all().reduce((s, i) => s + i.json.value, 0);
return $input.all().map(i => ({json: {...i.json, percentage: ((i.json.value / total) * 100).toFixed(2) + '%'}}));
```

---

## 8. Slack Block Kit Formatting

```javascript
const date = new Date().toISOString().split('T')[0];
const data = $input.first().json;

return [{json: {
  text: `Daily Report - ${date}`,
  blocks: [
    {type: "header", text: {type: "plain_text", text: `📊 Report - ${date}`}},
    {type: "section", text: {type: "mrkdwn",
      text: `*Status:* ${data.status === 'ok' ? '✅ All Clear' : '⚠️ Issues'}\n*Alerts:* ${data.alertCount || 0}`
    }},
    {type: "divider"},
    {type: "section", fields: [
      {type: "mrkdwn", text: `*Failed Logins:*\n${data.failedLogins || 0}`},
      {type: "mrkdwn", text: `*API Errors:*\n${data.apiErrors || 0}`},
      {type: "mrkdwn", text: `*Uptime:*\n${data.uptime || '100%'}`},
      {type: "mrkdwn", text: `*Response Time:*\n${data.avgResponseTime || 'N/A'}ms`}
    ]},
    {type: "context", elements: [{type: "mrkdwn", text: "Auto-generated by n8n"}]}
  ]
}}];
```

**Status emoji helper**:
```javascript
const emoji = {success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️'};
```

---

## 9. Top N Filtering & Ranking

```javascript
const chunks = $input.item.json.chunks || [];
const topChunks = chunks
  .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
  .slice(0, 6);

return [{json: {
  topChunks,
  count: topChunks.length,
  maxSimilarity: topChunks[0]?.similarity || 0,
  minSimilarity: topChunks[topChunks.length - 1]?.similarity || 0,
  avgSimilarity: topChunks.reduce((s, c) => s + (c.similarity || 0), 0) / topChunks.length
}}];
```

**Variations**: Minimum threshold: `.filter(i => i.json.score >= 0.7)` before sort. Composite score: `(relevance * 0.6) + (recency * 0.4)`. Percentile: `allScores[Math.floor(allScores.length * 0.05)]`.

---

## 10. String Aggregation & Reporting

```javascript
const items = $input.all();
const messages = items.map(i => i.json.message);

const header = `**Daily Summary**\n📅 ${new Date().toLocaleString()}\n📊 Total: ${messages.length}\n\n`;
const body = messages.join('\n\n---\n\n');
const footer = `\n\n---\n✅ Generated at ${new Date().toISOString()}`;

return [{json: {report: header + body + footer, count: messages.length}}];
```

**Markdown table variation**:
```javascript
const headers = '| Name | Status | Score |\n|------|--------|-------|\n';
const rows = items.map(i => `| ${i.json.name} | ${i.json.status} | ${i.json.score} |`).join('\n');
return [{json: {table: headers + rows}}];
```

---

## Key Techniques Across Patterns

- **Array chaining**: `.filter()` → `.map()` → `.sort()` → `.slice()`
- **Regex**: `text.match(pattern)`, `re.exec()` in while loop, `.replace()`
- **Object destructuring**: `const {name, email} = item.json;`
- **Spread operator**: `{...item.json, newField: value}`
- **Optional chaining**: `data?.nested?.field || 'default'`
- **Template literals**: `` `Hello ${name}!` ``
- **Set for dedup**: `const seen = new Set(); arr.filter(x => !seen.has(x.id) && seen.add(x.id))`
- **Reduce for aggregation**: `.reduce((sum, item) => sum + item.json.amount, 0)`
