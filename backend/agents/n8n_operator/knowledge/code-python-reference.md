# Python Code Node — Reference

## ⚠️ JavaScript First

Use JavaScript for 95% of use cases. Python only when: you need specific stdlib functions, or are significantly more comfortable with Python.

**Why JS is preferred**: `$helpers.httpRequest()`, Luxon DateTime, no library limitations, better n8n docs.

---

## CRITICAL: No External Libraries

```python
# ❌ ModuleNotFoundError
import requests, pandas, numpy, bs4, selenium, psycopg2, pymongo, sqlalchemy

# ✅ Standard library ONLY
import json, datetime, re, base64, hashlib, urllib.parse, math, random, statistics
```

### Workarounds
- **HTTP (no requests)** → HTTP Request node before Code, or switch to JS
- **Data analysis (no pandas)** → list comprehensions + statistics module
- **Databases (no drivers)** → n8n database nodes
- **Web scraping (no bs4)** → HTML Extract node

---

## Data Access (underscore-prefixed)

```python
_input.all()              # all items (most common)
_input.first()            # first item
_input.item               # Each Item mode only
_node["NodeName"]["json"] # reference other nodes
_json                     # direct current item
_now                      # current datetime
_today                    # today's date
_jmespath(data, 'query')  # JSON path query
```

### Webhook Data
```python
# ❌ KeyError
name = _json["name"]
# ✅ Correct
name = _json["body"]["name"]
# ✅ Safe
name = _json.get("body", {}).get("name", "Unknown")
```

---

## Return Format

```python
# ✅ Correct formats
return [{"json": {"result": "success"}}]
return [{"json": {"id": 1}}, {"json": {"id": 2}}]
return []  # valid empty

# ❌ Wrong
return {"json": {"result": "success"}}    # missing list
return [{"result": "success"}]            # missing "json" key
```

---

## Top 5 Errors

### #1: ModuleNotFoundError (Python-specific!)
```python
import requests  # ❌ NOT AVAILABLE
# Use HTTP Request node or switch to JavaScript
```

### #2: Empty Code / Missing Return
Always end with `return [{"json": {...}}]`

### #3: KeyError (Dictionary Access)
```python
# ❌ Crashes
name = item["json"]["name"]
# ✅ Safe
name = item["json"].get("name", "Unknown")
# ✅ Nested safe
name = _json.get("body", {}).get("user", {}).get("name", "Unknown")
```

### #4: IndexError (List Access)
```python
# ❌ Crashes on empty
first = items[0]
# ✅ Check first
if items:
    first = items[0]
# ✅ Or use slicing (never raises)
first_five = items[:5]
```

### #5: Incorrect Return Format
Must be `[{"json": {...}}]`

---

## Standard Library Reference

### json — JSON Operations
```python
import json
data = json.loads('{"name": "Alice"}')           # parse
output = json.dumps({"key": "value"}, indent=2)  # stringify
# Handle errors: json.JSONDecodeError
```

### datetime — Date/Time
```python
from datetime import datetime, timedelta

now = datetime.now()
now.isoformat()                        # "2025-01-20T15:30:00"
now.strftime("%Y-%m-%d")              # "2025-01-20"
now.strftime("%B %d, %Y")            # "January 20, 2025"
now.strftime("%I:%M %p")             # "03:30 PM"

# Parsing
dt = datetime.fromisoformat("2025-01-15T14:30:00")
dt.year, dt.month, dt.day, dt.hour, dt.weekday()  # 0=Mon

# Arithmetic
tomorrow = now + timedelta(days=1)
last_week = now - timedelta(weeks=1)
diff = (date2 - date1).days

# Formatting codes
# %Y=year, %m=month, %d=day, %H=24h, %I=12h, %M=min, %S=sec, %p=AM/PM
# %A=weekday, %B=month name, %a=short weekday, %b=short month
```

### re — Regular Expressions
```python
import re
re.search(r'\b[\w.-]+@[\w.-]+\.\w+\b', text)     # find first
re.findall(r'#(\w+)', text)                         # find all
re.sub(r'\$', '', text)                             # replace
re.match(r'^[\w.-]+@', email)                       # match start
re.split(r'[,;|]', text)                            # split on pattern
# Flags: re.IGNORECASE, re.MULTILINE, re.DOTALL
```

### base64 — Encoding
```python
import base64
encoded = base64.b64encode("Hello".encode('utf-8')).decode('utf-8')
decoded = base64.b64decode(encoded).decode('utf-8')

# Basic Auth header
creds = f"{username}:{password}"
auth = f"Basic {base64.b64encode(creds.encode()).decode()}"
```

### hashlib — Hashing
```python
import hashlib
hashlib.sha256("text".encode()).hexdigest()
hashlib.md5("text".encode()).hexdigest()
# Generate unique ID
unique_id = hashlib.sha256(f"{datetime.now().isoformat()}-{user_id}".encode()).hexdigest()[:16]
```

### urllib.parse — URL Operations
```python
from urllib.parse import urlparse, urlencode, parse_qs, quote, unquote

parsed = urlparse("https://example.com/path?key=value")
# parsed.scheme, parsed.netloc, parsed.path, parsed.query

query_string = urlencode({"name": "Alice", "email": "a@b.com"})
params = parse_qs("name=Alice&tags=a&tags=b")

encoded = quote("Hello World!")
decoded = unquote(encoded)
```

### math
```python
import math
math.ceil(3.2)     # 4
math.floor(3.7)    # 3
math.sqrt(16)      # 4.0
math.pow(2, 3)     # 8.0
math.log10(100)    # 2.0
math.pi, math.e
```

### random
```python
import random
random.random()              # 0.0 to 1.0
random.randint(1, 100)       # 1 to 100
random.choice(["a", "b"])    # pick one
random.sample(items, 10)     # pick 10 without replacement
random.shuffle(list_copy)    # in-place shuffle
```

### statistics
```python
from statistics import mean, median, stdev, mode, variance
mean([1, 2, 3, 4, 5])       # 3.0
median([1, 2, 3, 4, 5])     # 3
stdev([1, 2, 3, 4, 5])      # requires len > 1
```

### collections
```python
from collections import defaultdict, Counter
grouped = defaultdict(list)
for item in items:
    grouped[item["category"]].append(item)

counts = Counter(["a", "b", "a", "c", "a"])  # {'a': 3, 'b': 1, 'c': 1}
```

---

## Python vs JavaScript Quick Comparison

| Task | Python | JavaScript |
|------|--------|------------|
| Data access | `_input.all()` | `$input.all()` |
| Safe dict | `user.get("name", "?")` | `user.name \|\| "?"` |
| Filtering | `[x for x in items if cond]` | `items.filter(x => cond)` |
| Sorting | `items.sort(key=lambda x: x["score"], reverse=True)` | `items.sort((a, b) => b.score - a.score)` |
| HTTP | ❌ Not available | `await $helpers.httpRequest()` |
| Dates | `datetime` (basic) | `DateTime` Luxon (advanced) |

---

## Common Patterns

### Filter & Aggregate
```python
items = _input.all()
total = sum(item["json"].get("amount", 0) for item in items)
valid = [item for item in items if item["json"].get("amount", 0) > 0]
return [{"json": {"total": total, "count": len(valid)}}]
```

### Transform with List Comprehension
```python
return [
    {"json": {"id": item["json"].get("id"), "name": item["json"].get("name", "").upper()}}
    for item in _input.all()
]
```

### Statistical Analysis
```python
from statistics import mean, median, stdev
values = [item["json"].get("value", 0) for item in _input.all() if "value" in item["json"]]
if values:
    return [{"json": {"mean": mean(values), "median": median(values), "stdev": stdev(values) if len(values) > 1 else 0, "min": min(values), "max": max(values)}}]
return [{"json": {"error": "No values"}}]
```

---

## Checklist

- [ ] Considered JavaScript first
- [ ] No external imports
- [ ] Return `[{"json": {...}}]` on all paths
- [ ] Using `.get()` for dictionary access
- [ ] Webhook data via `["body"]`
- [ ] Mode correct (All Items vs Each Item)
