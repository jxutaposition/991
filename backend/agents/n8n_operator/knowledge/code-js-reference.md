# JavaScript Code Node — Built-in Reference

## $helpers.httpRequest()

Make HTTP requests directly from Code nodes.

### Complete Options
```javascript
const response = await $helpers.httpRequest({
  method: 'POST',  // GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
  url: 'https://api.example.com/users',
  headers: {
    'Authorization': 'Bearer token123',
    'Content-Type': 'application/json'
  },
  body: {name: 'John', email: 'john@example.com'},
  qs: {page: 1, limit: 10},          // query string params
  timeout: 10000,                      // milliseconds
  json: true,                          // auto-parse JSON (default: true)
  simple: false,                       // don't throw on HTTP errors (default: true)
  resolveWithFullResponse: false       // return only body (default: false)
});
```

### Authentication Patterns
```javascript
// Bearer Token
headers: { 'Authorization': `Bearer ${$env.API_TOKEN}` }

// API Key
headers: { 'X-API-Key': $env.API_KEY }

// Basic Auth
const creds = Buffer.from(`${username}:${password}`).toString('base64');
headers: { 'Authorization': `Basic ${creds}` }
```

### Error Handling
```javascript
try {
  const response = await $helpers.httpRequest({
    url: 'https://api.example.com/users',
    simple: false  // don't throw on 4xx/5xx
  });
  return [{json: {success: true, data: response}}];
} catch (error) {
  return [{json: {success: false, error: error.message}}];
}
```

### Full Response (headers, status)
```javascript
const response = await $helpers.httpRequest({
  url: 'https://api.example.com/data',
  resolveWithFullResponse: true
});
// response.statusCode, response.headers, response.body
```

---

## DateTime (Luxon)

### Current Time
```javascript
const now = DateTime.now();
const nowTokyo = DateTime.now().setZone('Asia/Tokyo');
const today = DateTime.now().startOf('day');
```

### Formatting
```javascript
now.toISO()                          // "2025-01-20T15:30:00.000Z"
now.toSQL()                          // "2025-01-20 15:30:00.000"
now.toHTTP()                         // "Mon, 20 Jan 2025 15:30:00 GMT"
now.toFormat('yyyy-MM-dd')           // "2025-01-20"
now.toFormat('HH:mm:ss')            // "15:30:00"
now.toFormat('MMMM dd, yyyy')       // "January 20, 2025"
now.toFormat('EEEE, MMMM dd')       // "Monday, January 20"
now.toFormat('yyyyMMdd')             // "20250120"
now.toFormat('dd/MM/yy HH:mm')      // "20/01/25 15:30"
```

### Parsing
```javascript
DateTime.fromISO('2025-01-20T15:30:00')
DateTime.fromFormat('01/20/2025', 'MM/dd/yyyy')
DateTime.fromSQL('2025-01-20 15:30:00')
DateTime.fromSeconds(1737384600)
DateTime.fromMillis(1737384600000)
```

### Arithmetic
```javascript
now.plus({days: 1})       now.minus({days: 1})
now.plus({weeks: 1})      now.minus({hours: 2})
now.plus({months: 1})     now.plus({days: 90})
```

### Comparisons & Differences
```javascript
targetDate > now                                       // boolean
targetDate.equals(now)
targetDate.diff(now, 'days').days                      // number
targetDate.diff(now, ['months', 'days', 'hours']).toObject()  // {months, days, hours}
```

### Timezone
```javascript
now.setZone('Asia/Tokyo').toISO()
now.setZone('America/New_York').toISO()
now.toUTC().toISO()
now.zoneName          // "America/Los_Angeles"
now.offset            // offset in minutes
```

### Period Boundaries
```javascript
now.startOf('day')    now.endOf('day')
now.startOf('week')   now.endOf('week')
now.startOf('month')  now.endOf('month')
now.startOf('year')   now.endOf('year')
```

### Date Info
```javascript
now.weekday           // 1=Mon, 7=Sun
now.weekdayLong       // "Monday"
now.month             // 1-12
now.monthLong         // "January"
now.year, now.quarter, now.daysInMonth
now.weekday > 5       // is weekend
```

---

## $jmespath() — JSON Querying

```javascript
const data = $input.first().json;

// Extract fields
$jmespath(data, 'users[*].name')

// Filter
$jmespath(data, 'users[?age >= `18`]')

// Sort + limit
$jmespath(data, 'users | sort_by(@, &score) | reverse(@) | [0:5]')

// Multi-field projection
$jmespath(data, 'users[*].{name: name, email: contact.email}')

// Aggregation
$jmespath(data, 'sum(products[*].price)')
$jmespath(data, 'length(products)')
```

---

## $getWorkflowStaticData() — Persistent Storage

Data that persists **across workflow executions**.

```javascript
const staticData = $getWorkflowStaticData();

// Rate limiting
if (staticData.lastRun && (Date.now() - staticData.lastRun < 60000)) {
  return [{json: {error: 'Rate limit: wait 1 minute'}}];
}
staticData.lastRun = Date.now();

// Track last processed ID
const lastId = staticData.lastProcessedId || 0;
const newItems = $input.all().filter(item => item.json.id > lastId);
if (newItems.length > 0) {
  staticData.lastProcessedId = Math.max(...newItems.map(i => i.json.id));
}

// Accumulate across runs
staticData.accumulated = staticData.accumulated || [];
staticData.accumulated.push(...$input.all().map(i => i.json));
```

---

## Data Access Patterns

### $input.all() — Process All Items (most common)
```javascript
const allItems = $input.all();
// Filter
const active = allItems.filter(item => item.json.status === 'active');
// Transform
const mapped = allItems.map(item => ({json: {id: item.json.id, name: item.json.name}}));
// Aggregate
const total = allItems.reduce((sum, item) => sum + (item.json.amount || 0), 0);
// Sort + limit
const top5 = allItems.sort((a, b) => b.json.score - a.json.score).slice(0, 5);
// Group by
const grouped = {};
for (const item of allItems) {
  const cat = item.json.category || 'Other';
  (grouped[cat] = grouped[cat] || []).push(item.json);
}
// Deduplicate
const seen = new Set();
const unique = allItems.filter(item => !seen.has(item.json.id) && seen.add(item.json.id));
```

### $input.first() — Single Item
```javascript
const data = $input.first().json;
const users = data.data?.users || [];
return users.map(user => ({json: {id: user.id, name: user.profile?.name || 'Unknown'}}));
```

### $input.item — Each Item Mode Only
```javascript
const item = $input.item;
return [{json: {...item.json, processed: true, processedAt: new Date().toISOString()}}];
```

### $node["Name"] — Reference Specific Nodes
```javascript
const webhook = $node["Webhook"].json;
const api = $node["HTTP Request"].json;
return [{json: {combined: {webhook: webhook.body, api: api}}}];
```

### Webhook Data Structure
```javascript
// Webhook output: {headers, params, query, body}
// USER DATA IS IN body
const payload = $input.first().json.body;
const name = payload.name;
const apiKey = $input.first().json.query.api_key;
const contentType = $input.first().json.headers['content-type'];
```

### Common Mistakes
- `item.name` → `item.json.name` (must access .json property)
- `$input.item` in All Items mode → undefined (use `$input.first()`)
- `$input.all()[0].json` without length check → crash on empty
- Mutating original: `items[0].json.x = y` → create new objects with spread

---

## Standard Globals

### Math
`Math.round()`, `Math.floor()`, `Math.ceil()`, `Math.max()`, `Math.min()`, `Math.random()`, `Math.abs()`, `Math.sqrt()`, `Math.pow()`

### JSON
`JSON.parse(string)`, `JSON.stringify(obj)`, `JSON.stringify(obj, null, 2)` (pretty)

### Object
`Object.keys()`, `Object.values()`, `Object.entries()`, `Object.assign()`, `'key' in obj`

### Array
`.map()`, `.filter()`, `.reduce()`, `.find()`, `.some()`, `.every()`, `.includes()`, `.join()`, `.sort()`, `.slice()`, `.flat()`

### console (debug — appears in browser F12)
`console.log()`, `console.error()`, `console.warn()`

---

## Node.js Modules

### crypto
```javascript
const crypto = require('crypto');
crypto.createHash('sha256').update('text').digest('hex');
crypto.createHash('md5').update('text').digest('hex');
crypto.randomBytes(16).toString('hex');
```

### Buffer
```javascript
Buffer.from('Hello').toString('base64');      // encode
Buffer.from(encoded, 'base64').toString();    // decode
Buffer.from('Hello').toString('hex');         // hex
```

### URL / URLSearchParams
```javascript
const url = new URL('https://example.com/path?p=1');
const params = new URLSearchParams({search: 'q', page: 1});
params.toString()  // "search=q&page=1"
```

---

## NOT Available
❌ axios, lodash, moment, request, or any external npm package.
Use `$helpers.httpRequest()` for HTTP. Use DateTime (Luxon) instead of moment.
