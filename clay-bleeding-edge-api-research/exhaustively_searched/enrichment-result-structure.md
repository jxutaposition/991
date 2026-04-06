# Enrichment Cell Value Structure

**Status**: DOCUMENTED
**Investigated**: INV-024 (Session 9)

## Finding
The cell `value` for enrichment columns is a **preview string**, not a structured JSON object.

Example for `normalize-company-name`:
```json
{
  "value": "✅ Anthropic",
  "metadata": {
    "status": "SUCCESS",
    "isPreview": true,
    "imagePreview": "https://clay-base-prod-static.s3.amazonaws.com/icons/svg/clay.svg"
  }
}
```

The `isPreview: true` flag confirms this is a display-friendly summary, not the raw enrichment output.

## For Structured Data
Use formula extraction: `{{f_enrichCol}}?.normalized_name` to pull specific keys from the underlying result. The preview string is what gets displayed in the UI cell.
