# scrape-website Action — FULLY WORKING

**Status**: DOCUMENTED
**Investigated**: INV-030 (Session 13)

## How It Works

Create action column with `actionKey: "scrape-website"`, `actionPackageId: "4299091f-3cd3-4d68-b198-0143575f471d"`, bind `url` input to a URL column. Works with autoRun.

## Output Fields (12)

`links`, `title`, `emails`, `images`, `favicon`, `bodyText`, `description`, `socialLinks`, `phoneNumbers`, `specificVendor`, `extractedKeywords`, `languagesDetectedFormatted`

## Formula Extraction

- `{{f_scrapeCol}}?.title` → page title
- `{{f_scrapeCol}}?.description` → meta description
- `{{f_scrapeCol}}?.emails` → array of emails found
- `{{f_scrapeCol}}?.bodyText` → full page text
- `Object.keys({{f_scrapeCol}} || {})` → list all available fields

## Practical Pattern

Insert company URLs → autoRun scrapes each → formula columns extract title/description/emails into individual text fields.
