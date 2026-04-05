# JavaScript Code Node — Error Patterns

## Top 5 Errors by Frequency

### #1: Empty Code / Missing Return — 38% of failures

**Error messages**: "Code cannot be empty", "Code must return data"

```javascript
// ❌ Forgot to return
const items = $input.all();
for (const item of items) { console.log(item.json.name); }
// no return!

// ❌ Not all paths return
if (items.length === 0) { return []; }
const processed = items.map(item => ({json: item.json}));
// forgot return processed!

// ✅ Always return
const items = $input.all();
if (items.length === 0) return [];
return items.map(item => ({json: {...item.json, processed: true}}));
```

**Rules**: Every code path must return. Empty `[]` is valid. Return inside try-catch too.

---

### #2: Expression Syntax Confusion — 8% of failures

**Error**: "Unexpected token" or literal `{{ }}` strings in output

n8n has TWO syntaxes:
- `{{ }}` expressions — in Set, IF, HTTP Request, Slack, etc.
- JavaScript — in Code nodes (NO `{{ }}`)

```javascript
// ❌ WRONG in Code node
const userName = "{{ $json.name }}";      // literal string!
const value = "{{ $now.toFormat('yyyy-MM-dd') }}";

// ✅ CORRECT in Code node
const userName = $json.name;              // direct access
const value = DateTime.now().toFormat('yyyy-MM-dd');
const message = `Hello ${$json.name}!`;  // template literal
```

| Context | Syntax | Example |
|---------|--------|---------|
| Set/IF/HTTP nodes | `{{ }}` | `{{$json.name}}` |
| **Code node** | **JavaScript** | `$json.name` |
| **Code node strings** | **Template literals** | `` `Hello ${$json.name}` `` |

---

### #3: Incorrect Return Wrapper — 5% of failures

**Error**: "Return value must be an array", "Each item must have json property"

```javascript
// ❌ Object without array
return {json: {result: 'success'}};

// ❌ Array without json key
return [{id: 1, name: 'Alice'}];

// ❌ Incomplete structure
return [{data: {result: 'success'}}];  // "data" not "json"

// ✅ Single result
return [{json: {result: 'success'}}];

// ✅ Multiple results
return [{json: {id: 1}}, {json: {id: 2}}];

// ✅ Transformed array
return items.map(item => ({json: {id: item.json.id, processed: true}}));

// ✅ Empty (valid)
return [];
```

---

### #4: Unmatched Expression Brackets — 6% of failures

**Error**: "Unmatched expression brackets" during save

Caused by unbalanced quotes or brackets in strings:
```javascript
// ❌ Quote issues
const message = "It's a nice day";  // may break
const html = "<div class=\"container\">";  // escaping issues

// ✅ Use template literals
const message = `It's a nice day`;
const html = `<div class="${className}"><h1>${title}</h1></div>`;
```

Escaping guide: `\'` in single-quoted, `\"` in double-quoted, `\\` for backslash, or just use backtick template literals.

---

### #5: Missing Null Checks — Common Runtime Error

**Error**: "Cannot read property 'X' of undefined/null"

```javascript
// ❌ Crashes if user doesn't exist
const email = item.json.user.email;

// ✅ Optional chaining
const email = item.json?.user?.email || 'no-email';

// ✅ Guard clause
if (!item.json.user) return [];
const email = item.json.user.email;

// ✅ Default values
const users = $json.users || [];
const names = users.map(u => u.name || 'Unknown');
```

**Webhook data safety**:
```javascript
// ❌ Risky
const name = $json.body.user.name;

// ✅ Safe
const name = $json.body?.user?.name || 'Unknown';
```

**Array safety**:
```javascript
// ❌ Crashes on empty
const first = $input.all()[0].json;

// ✅ Check length
const items = $input.all();
if (items.length === 0) return [];
const first = items[0].json;

// ✅ Or use $input.first()
const first = $input.first().json;
```

**Nullish coalescing** (`??`) vs logical OR (`||`):
```javascript
const timeout = $json.settings?.advanced?.timeout ?? 30000;  // 0 is valid
const name = $json.name || 'Unknown';  // 0/"" would become 'Unknown'
```

---

## Error Prevention Checklist

### Code Structure
- [ ] Code field is not empty
- [ ] Return statement exists
- [ ] ALL code paths return (if/else, try/catch)

### Return Format
- [ ] Returns array `[...]`
- [ ] Each item has `json` property: `{json: {...}}`

### Syntax
- [ ] No `{{ }}` (use direct JavaScript)
- [ ] Template literals use backticks: `` `${variable}` ``
- [ ] Quotes/brackets balanced

### Data Safety
- [ ] Null checks with `?.` for optional properties
- [ ] Array length checks before `[0]` access
- [ ] Webhook data via `.body`
- [ ] Try-catch for API calls and risky operations
- [ ] Default values for missing data

### Testing
- [ ] Test with empty input
- [ ] Test with missing fields
- [ ] Check browser console (F12) for errors

---

## Quick Error Reference

| Error Message | Cause | Fix |
|---------------|-------|-----|
| "Code cannot be empty" | Empty code field | Add code |
| "Code must return data" | Missing return | Add `return [...]` |
| "Return value must be an array" | Returning object | Wrap in `[...]` |
| "Each item must have json property" | Missing json key | Use `{json: {...}}` |
| "Unexpected token" | `{{ }}` in code | Remove `{{ }}`, use JS |
| "Cannot read property X of undefined" | Missing null check | Use `?.` |
| "Cannot read property X of null" | Null value | Add guard clause |
| "Unmatched expression brackets" | Quote/bracket imbalance | Use template literals |

---

## Debugging Tips

```javascript
// 1. console.log (appears in browser F12)
console.log('Items:', $input.all().length);
console.log('First:', JSON.stringify($input.first().json, null, 2));

// 2. Return intermediate state
return [{json: {debug: $input.first().json}}];

// 3. Try-catch to see errors
try {
  const result = riskyOperation();
  return [{json: {result}}];
} catch (error) {
  return [{json: {error: error.message, stack: error.stack}}];
}
```
