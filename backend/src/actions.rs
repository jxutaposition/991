/// GTM action definitions for the agent executor.
///
/// Each tool is defined here with its name, description, and input schema.
/// Integrations call real APIs when credentials are configured; otherwise they return explicit errors (no synthetic success payloads).
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::anthropic::ToolDef;
use crate::credentials::DecryptedCredential;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Extract a usable bearer token from an OAuth2 or API key credential.
/// For JSON-encoded credentials (e.g. n8n, supabase with extra_fields),
/// extracts the `api_key` field rather than returning the raw JSON blob.
fn extract_bearer_token(cred: &DecryptedCredential) -> String {
    if cred.credential_type == "oauth2" {
        serde_json::from_str::<Value>(&cred.value).ok()
            .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| cred.value.clone())
    } else if let Ok(parsed) = serde_json::from_str::<Value>(&cred.value) {
        parsed.get("api_key").and_then(Value::as_str)
            .unwrap_or(&cred.value).to_string()
    } else {
        cred.value.clone()
    }
}

/// Truncate an HTTP response body and wrap it as a JSON result string.
fn http_result_json(status: u16, body: &str, max_chars: usize) -> String {
    let preview: String = body.chars().take(max_chars).collect();
    json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
}

// ── Tool library ──────────────────────────────────────────────────────────────

/// All tool definitions available in the global tool library.
/// Each agent's tools.toml specifies which subset it can access.
pub fn all_action_defs() -> Vec<ToolDef> {
    vec![
        // Research tools
        ToolDef {
            name: "search_linkedin_profile".to_string(),
            description: "Search LinkedIn for a person or company profile. Returns name, title, company, summary, and recent activity.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Name, company, or LinkedIn URL"}
                },
                "required": ["query"]
            }),
            required_credential: Some("apollo".to_string()),
        },
        ToolDef {
            name: "fetch_company_news".to_string(),
            description: "Get recent news articles for a company domain. Returns headlines, summaries, and dates.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "domain": {"type": "string", "description": "Company domain (e.g. stripe.com)"},
                    "limit": {"type": "integer", "description": "Max articles to return (default 5)"}
                },
                "required": ["domain"]
            }),
            required_credential: Some("tavily".to_string()),
        },
        ToolDef {
            name: "search_company_data".to_string(),
            description: "Look up company enrichment data: funding rounds, employee count, tech stack, location, industry.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "company_name": {"type": "string"},
                    "domain": {"type": "string"}
                }
            }),
            required_credential: Some("apollo".to_string()),
        },
        ToolDef {
            name: "find_contacts".to_string(),
            description: "Find decision-maker contacts at a company. Returns name, title, email (when available), LinkedIn URL.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "company_name": {"type": "string"},
                    "domain": {"type": "string"},
                    "titles": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Target job titles (e.g. ['VP Sales', 'Head of Growth'])"
                    }
                },
                "required": ["company_name"]
            }),
            required_credential: Some("apollo".to_string()),
        },

        // CRM tools
        ToolDef {
            name: "read_crm_contact".to_string(),
            description: "Read contact or company data from CRM (HubSpot/Salesforce). Returns properties, activity history, deal stages.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "identifier": {"type": "string", "description": "Email, name, or CRM ID"}
                },
                "required": ["identifier"]
            }),
            required_credential: Some("hubspot".to_string()),
        },
        ToolDef {
            name: "write_crm_contact".to_string(),
            description: "Create or update a contact/company record in CRM. Returns the record ID.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "email": {"type": "string"},
                    "first_name": {"type": "string"},
                    "last_name": {"type": "string"},
                    "company": {"type": "string"},
                    "properties": {"type": "object", "description": "Additional CRM properties as key-value pairs"}
                },
                "required": ["email"]
            }),
            required_credential: Some("hubspot".to_string()),
        },
        ToolDef {
            name: "read_crm_pipeline".to_string(),
            description: "Get deals, pipeline stages, and activity history from CRM. Returns deal list with amounts, stages, and close dates.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pipeline_name": {"type": "string"},
                    "stage": {"type": "string"},
                    "limit": {"type": "integer"}
                }
            }),
            required_credential: Some("hubspot".to_string()),
        },

        // Outreach tools
        ToolDef {
            name: "write_draft".to_string(),
            description: "Produce a final written draft (cold email, LinkedIn message, ad copy, landing page copy, etc.) and store it for review.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "type": {"type": "string", "description": "Type of draft: cold_email, linkedin_message, ad_copy, landing_page, call_script, follow_up"},
                    "subject": {"type": "string", "description": "Subject line (for emails)"},
                    "body": {"type": "string", "description": "Full body content"},
                    "recipient": {"type": "string", "description": "Recipient name/company (for personalization context)"},
                    "metadata": {"type": "object"}
                },
                "required": ["type", "body"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "optimize_subject_line".to_string(),
            description: "Generate and score multiple subject line variants for an email. Returns variants ranked by predicted open rate.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "email_body": {"type": "string"},
                    "recipient_context": {"type": "string"},
                    "count": {"type": "integer", "description": "Number of variants to generate (default 5)"}
                },
                "required": ["email_body"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "fetch_email_analytics".to_string(),
            description: "Get outreach email performance: open rates, reply rates, conversion rates by campaign or sequence.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "campaign_id": {"type": "string"},
                    "sequence_id": {"type": "string"},
                    "date_range_days": {"type": "integer"}
                }
            }),
            required_credential: Some("hubspot".to_string()),
        },

        // Advertising tools — STUB: not yet wired to live APIs.
        // These definitions exist for schema discovery only. execute_action returns an error.
        // TODO: Implement when Meta/Google Marketing API credentials are supported.
        ToolDef {
            name: "meta_ads_api".to_string(),
            description: "Create or update a Meta (Facebook/Instagram) ad campaign, ad set, or creative. Returns campaign/ad IDs.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "create_campaign, create_adset, create_ad, get_campaigns"},
                    "campaign_name": {"type": "string"},
                    "objective": {"type": "string"},
                    "budget_daily": {"type": "number"},
                    "targeting": {"type": "object"},
                    "creative": {"type": "object"}
                },
                "required": ["action"]
            }),
            required_credential: Some("meta".to_string()),
        },
        ToolDef {
            name: "google_ads_api".to_string(),
            description: "Create or update Google Ads campaigns, ad groups, keywords, and bidding. Returns campaign/ad group IDs.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "create_campaign, create_adgroup, create_keywords, get_campaigns"},
                    "campaign_name": {"type": "string"},
                    "campaign_type": {"type": "string"},
                    "budget_daily": {"type": "number"},
                    "keywords": {"type": "array", "items": {"type": "string"}},
                    "ad_text": {"type": "object"}
                },
                "required": ["action"]
            }),
            required_credential: Some("google_ads".to_string()),
        },
        ToolDef {
            name: "fetch_ad_performance".to_string(),
            description: "Pull ad campaign performance metrics: impressions, clicks, CTR, CPC, conversions, ROAS.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "description": "meta, google, or all"},
                    "campaign_id": {"type": "string"},
                    "date_range_days": {"type": "integer"}
                }
            }),
            required_credential: None,
        },

        // Web tools
        ToolDef {
            name: "web_search".to_string(),
            description: "Search the web for company news, market data, competitor info, or any public information.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
                "required": ["query"]
            }),
            required_credential: Some("tavily".to_string()),
        },
        ToolDef {
            name: "fetch_url".to_string(),
            description: "Fetch and parse the text content of a web page.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string"}
                },
                "required": ["url"]
            }),
            required_credential: None,
        },

        // ── Clay-specific tools ────────────────────────────────────────────
        ToolDef {
            name: "clay_get_table_schema".to_string(),
            description: "Read the full schema of a Clay table: all fields with IDs, names, types, formulas, enrichment configs, and view ordering. Requires session cookie in Clay credentials.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"}
                },
                "required": ["table_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_create_field".to_string(),
            description: "Create a new column in a Clay table. Supports text, formula, action, and source column types. Use clay_get_table_schema first to get field IDs for formula references. Requires session cookie in Clay credentials.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "name": {"type": "string", "description": "Column name"},
                    "field_type": {"type": "string", "enum": ["text", "formula", "action", "source"], "description": "Column type"},
                    "active_view_id": {"type": "string", "description": "Grid view ID (e.g. gv_abc123) — get from clay_get_table_schema gridViews"},
                    "type_settings": {"type": "object", "description": "Column-specific settings: dataTypeSettings for text, formulaText/formulaType for formula, actionKey/inputsBinding for action columns"}
                },
                "required": ["table_id", "name", "field_type", "active_view_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_create_source".to_string(),
            description: "Create a new source (e.g. webhook) on a Clay table. Returns the source ID. Requires session cookie in Clay credentials. workspace_id falls back to credential settings.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric, from the URL)"},
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "name": {"type": "string", "description": "Source name (e.g. 'Inbound Webhook')"},
                    "source_type": {"type": "string", "description": "Source type (e.g. 'v3-action')"},
                    "type_settings": {"type": "object", "description": "Source-specific settings (e.g. {\"hasAuth\": false, \"iconType\": \"Webhook\"})"}
                },
                "required": ["workspace_id", "table_id", "name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_read_rows".to_string(),
            description: "Read rows from a Clay table via the v3 API. Requires a view_id (get from clay_get_table_schema → views[]). Returns records with cell values keyed by field IDs. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "view_id": {"type": "string", "description": "View ID (e.g. gv_abc123) — required. Get from clay_get_table_schema response under views[]. Use the default/all-rows view for full table reads."},
                    "limit": {"type": "integer", "description": "Max rows to return (default 100). Note: offset is NOT supported by Clay API."}
                },
                "required": ["table_id", "view_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_write_rows".to_string(),
            description: "Write rows to a Clay table via the v3 API. Each row must use field IDs (f_xxx) as keys in a 'cells' object. Use clay_get_table_schema first to get field IDs. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "rows": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "Array of row objects. Each object should have field IDs as keys (e.g. {\"f_abc123\": \"value\"}). Use clay_get_table_schema to get field IDs first."
                    }
                },
                "required": ["table_id", "rows"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_trigger_enrichment".to_string(),
            description: "Trigger enrichment runs on specific fields and rows of a Clay table via the v3 API. Requires session cookie and field IDs. Use clay_get_table_schema to get field IDs first.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "field_ids": {"type": "array", "items": {"type": "string"}, "description": "Field IDs to trigger enrichment on (e.g. [\"f_abc123\"])"},
                    "record_ids": {"type": "array", "items": {"type": "string"}, "description": "Optional: specific record IDs to run on. If empty, may run on no records."},
                    "force_run": {"type": "boolean", "description": "Force re-run even if already completed (default false)"}
                },
                "required": ["table_id", "field_ids"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_update_rows".to_string(),
            description: "Update existing rows in a Clay table via the v3 API. Updates are async (enqueued). Each record needs its ID and new cell values keyed by field IDs. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "records": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "Array of record update objects. Each needs an 'id' (record ID r_xxx) and 'cells' with field ID keys."
                    }
                },
                "required": ["table_id", "records"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_delete_rows".to_string(),
            description: "Delete rows from a Clay table via the v3 API. Pass an array of record IDs to delete. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "record_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of record IDs to delete (e.g. [\"r_abc123\"])"
                    }
                },
                "required": ["table_id", "record_ids"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_app_accounts".to_string(),
            description: "List all connected auth accounts (enrichment providers) in the Clay workspace. Returns authAccountId values needed for enrichment column creation. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_actions".to_string(),
            description: "List all available enrichment actions (1,191 actions, 170+ providers) with full I/O schemas. Use to discover actionKey and actionPackageId for enrichment column creation. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_sources".to_string(),
            description: "List all sources (webhooks, manual, etc.) in the Clay workspace. Returns source IDs, types, webhook URLs, and subscription details. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_get_workspace".to_string(),
            description: "Get Clay workspace details including billing, credit balance, feature flags, and abilities. Use to check enrichment credit balance before bulk operations. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_workbooks".to_string(),
            description: "List all workbooks in the Clay workspace. Returns workbook IDs and names. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_create_workbook".to_string(),
            description: "Create a new Clay workbook in the workspace via v3 API. Returns the workbook ID (wb_xxx). Use this to group related tables together, then pass the workbook_id to clay_create_table.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to credential settings."},
                    "name": {"type": "string", "description": "Workbook name"}
                },
                "required": ["name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_create_table".to_string(),
            description: "Create a new Clay table in a workspace via v3 API. Returns the new table ID. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to the value stored in credentials if not provided."},
                    "name": {"type": "string", "description": "Table name"},
                    "table_type": {"type": "string", "enum": ["spreadsheet", "company", "people", "jobs"], "description": "Table type (default: spreadsheet)"},
                    "workbook_id": {"type": "string", "description": "Workbook ID (wb_xxx) to place the table in. If omitted, Clay auto-creates a new workbook per table."}
                },
                "required": ["name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_delete_table".to_string(),
            description: "Delete a Clay table via v3 API. Destructive — cannot be undone. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID to delete (e.g. t_abc123)"}
                },
                "required": ["table_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_tables".to_string(),
            description: "List all tables in a Clay workspace via v3 API. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Clay workspace ID (numeric). Falls back to the value stored in credentials if not provided."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_update_field".to_string(),
            description: "Update an existing column in a Clay table via v3 API (rename, change settings). Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "field_id": {"type": "string", "description": "Field ID to update (e.g. f_abc123)"},
                    "updates": {"type": "object", "description": "Fields to update: name, typeSettings, etc."}
                },
                "required": ["table_id", "field_id", "updates"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_delete_field".to_string(),
            description: "Delete a column from a Clay table via v3 API. Destructive — cannot be undone. Requires session cookie.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "field_id": {"type": "string", "description": "Field ID to delete (e.g. f_abc123)"}
                },
                "required": ["table_id", "field_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // ── Clay tier-2 tools (workflows, views, export, sources, documents, admin) ──
        // For details on any of these, agents should call read_tool_doc(clay, <doc>) where
        // <doc> is workflows | csv-export | views | documents | admin | endpoint-reference.

        // Table duplication
        ToolDef {
            name: "clay_duplicate_table".to_string(),
            description: "Duplicate a Clay table — copies all columns, views, and table settings. Rows are NOT copied (schema-only). Field IDs change. Useful for template-based table creation. See read_tool_doc(clay, endpoint-reference).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Source Clay table ID (e.g. t_abc123)"},
                    "name": {"type": "string", "description": "Name for the new table. Defaults to 'Copy of {original}'."}
                },
                "required": ["table_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // View CRUD
        ToolDef {
            name: "clay_create_view".to_string(),
            description: "Create a new view on a Clay table. Body accepts only `name` reliably — filter/sort PATCH does not yet persist. See read_tool_doc(clay, views).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID (e.g. t_abc123)"},
                    "name": {"type": "string", "description": "View name"}
                },
                "required": ["table_id", "name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_update_view".to_string(),
            description: "Update a Clay view. Rename works reliably; filter/sort updates accept the call but do not persist (returned values are null). See read_tool_doc(clay, views).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID"},
                    "view_id": {"type": "string", "description": "View ID (gv_xxx)"},
                    "updates": {"type": "object", "description": "Fields to update: {name?, filter?, sort?}"}
                },
                "required": ["table_id", "view_id", "updates"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_delete_view".to_string(),
            description: "Delete a view from a Clay table. Cannot delete the last view — at least one must remain.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID"},
                    "view_id": {"type": "string", "description": "View ID (gv_xxx)"}
                },
                "required": ["table_id", "view_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // CSV export
        ToolDef {
            name: "clay_export_table".to_string(),
            description: "Start an async CSV export job for a Clay table. Returns the export job ID (ej_xxx). Poll with clay_get_export until status='FINISHED'. See read_tool_doc(clay, csv-export).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "table_id": {"type": "string", "description": "Clay table ID"},
                    "format": {"type": "string", "description": "Export format. Default 'csv'."}
                },
                "required": ["table_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_get_export".to_string(),
            description: "Poll the status of a Clay CSV export job. Returns status (ACTIVE → FINISHED) and uploadedFilePath when complete.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "export_job_id": {"type": "string", "description": "Export job ID (ej_xxx) returned by clay_export_table"}
                },
                "required": ["export_job_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // Source management
        ToolDef {
            name: "clay_get_source".to_string(),
            description: "Get details of a Clay source (webhook). The webhook URL is at state.url. Includes sourceSubscriptions (which table/field the source feeds).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source_id": {"type": "string", "description": "Source ID (s_xxx)"}
                },
                "required": ["source_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_update_source".to_string(),
            description: "Update a Clay source. Partial update — pass only the fields you want to change. Empty body is a no-op that returns the current state.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source_id": {"type": "string", "description": "Source ID (s_xxx)"},
                    "updates": {"type": "object", "description": "Fields to update (e.g. {name, typeSettings})"}
                },
                "required": ["source_id", "updates"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_delete_source".to_string(),
            description: "Delete a Clay source. Returns {success: true}. Destructive.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source_id": {"type": "string", "description": "Source ID (s_xxx)"}
                },
                "required": ["source_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // Workflows — basics
        ToolDef {
            name: "clay_list_workflows".to_string(),
            description: "List all tc-workflows (Claygent agentic workflows) in the workspace. Returns workflow IDs (wf_xxx) and names. See read_tool_doc(clay, workflows) before triggering runs.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_get_workflow".to_string(),
            description: "Get a Clay workflow's full graph (nodes + edges) plus server-side validation (errors, warnings). Free pre-flight check before running. See read_tool_doc(clay, workflows).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_run_workflow".to_string(),
            description: "Start a direct workflow run. Auto-resolves the latest snapshot. Returns the run record (wfr_xxx). NOTE: direct runs cannot be cancelled — only paused. To cancel, wrap in a 1-row csv_import batch instead. Read read_tool_doc(clay, workflows) first.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "inputs": {"type": "object", "description": "Input variables for the workflow run (free-form)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_get_workflow_run".to_string(),
            description: "Get a workflow run with all its steps. Returns full step telemetry (prompts, tool calls, reasoning, token usage). Discriminated on type='current'|'archived'.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "run_id": {"type": "string", "description": "Run ID (wfr_xxx)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "run_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_workflow_runs".to_string(),
            description: "List runs for a workflow. Query supports limit and offset.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "limit": {"type": "integer", "description": "Max runs (default 50)"},
                    "offset": {"type": "integer", "description": "Pagination offset (default 0)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // Workflows — control plane (Phase B)
        ToolDef {
            name: "clay_pause_workflow_run".to_string(),
            description: "Pause an active workflow run. Returns 400 if the run is in a terminal state.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "run_id": {"type": "string", "description": "Run ID (wfr_xxx)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "run_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_unpause_workflow_run".to_string(),
            description: "Resume a paused workflow run. Returns 400 if the run is not in paused state.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "run_id": {"type": "string", "description": "Run ID (wfr_xxx)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "run_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_continue_workflow_step".to_string(),
            description: "Human-in-the-loop: provide feedback to a workflow step that is waiting on human input. The humanFeedbackInput body is a discriminated union (ApproveToolCall, DenyToolCall, DenyTransition, etc.). Find waiting steps with clay_list_waiting_steps.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "run_id": {"type": "string", "description": "Run ID (wfr_xxx)"},
                    "step_id": {"type": "string", "description": "Step ID (wfrs_xxx)"},
                    "human_feedback_input": {"type": "object", "description": "Discriminated union body. e.g. {type: 'ApproveToolCall', toolName, approveToolCallForEntireRun}"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "run_id", "step_id", "human_feedback_input"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_waiting_steps".to_string(),
            description: "List all workflow run steps currently waiting on human input within a workflow. Drives the HITL UI. callbackData is discriminated on the wait reason.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // Workflows — authoring
        ToolDef {
            name: "clay_create_workflow".to_string(),
            description: "Create a new tc-workflow. Returns the workflow record (wf_xxx). The workflow is empty — add nodes/edges separately.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Workflow name (max 255 chars)"},
                    "default_model_id": {"type": "string", "description": "Default LLM model ID for nodes that don't specify one"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_create_workflow_node".to_string(),
            description: "Add a node to a workflow. Note: 'regular' nodes with no model/prompt are NOT actually inert — Clay silently injects Haiku + a system prompt. Even 'inert' test runs burn ~12k tokens.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "name": {"type": "string", "description": "Node name (max 255)"},
                    "node_type": {"type": "string", "enum": ["regular", "code", "conditional", "map", "reduce", "tool"], "description": "Node type. Default 'regular'."},
                    "description": {"type": "string", "description": "Optional description"},
                    "model_id": {"type": "string", "description": "Optional LLM model ID (overrides workflow default)"},
                    "is_initial": {"type": "boolean", "description": "Whether this is the workflow's start node"},
                    "is_terminal": {"type": "boolean", "description": "Whether this is a terminal/output node"},
                    "position": {"type": "object", "description": "Optional layout position {x, y}"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_create_workflow_edge".to_string(),
            description: "Connect two workflow nodes with an edge. Returns the edge record (wfe_xxx).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "source_node_id": {"type": "string", "description": "Source node ID (wfn_xxx)"},
                    "target_node_id": {"type": "string", "description": "Target node ID (wfn_xxx)"},
                    "metadata": {"type": "object", "description": "Optional edge metadata (e.g. {conditionalSourceHandle})"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "source_node_id", "target_node_id"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_get_workflow_snapshot".to_string(),
            description: "Get a specific workflow snapshot by ID. Snapshots embed the full workflow definition at the time of capture. Snapshots are auto-created by batch runs — there is no manual snapshot create endpoint.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "Workflow ID (wf_xxx)"},
                    "snapshot_id": {"type": "string", "description": "Snapshot ID (wfs_xxx)"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["workflow_id", "snapshot_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // Admin (Phase C)
        ToolDef {
            name: "clay_list_users".to_string(),
            description: "List all members of the Clay workspace with their roles and profile info. See read_tool_doc(clay, admin).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_list_tags".to_string(),
            description: "List resource tags in the Clay workspace (signals/tagging subsystem). Advisory — the tags subsystem is not yet fully reverse-engineered; this may return unexpected shapes. See read_tool_doc(clay, admin).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": []
            }),
            required_credential: Some("clay".to_string()),
        },

        // Documents (RAG)
        ToolDef {
            name: "clay_upload_document".to_string(),
            description: "Upload a document to Clay's Documents/RAG store. Three-step S3 flow handled internally. The agent passes either inline text content OR a public URL to fetch. Returns the full document record (doc_xxx). See read_tool_doc(clay, documents).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Document filename (1-500 chars)"},
                    "content": {"type": "string", "description": "Inline text content to upload (alternative to source_url)"},
                    "source_url": {"type": "string", "description": "Public HTTPS URL to fetch and upload (alternative to content)"},
                    "mime_type": {"type": "string", "description": "MIME type. Defaults to 'text/plain' for inline content."},
                    "context": {"type": "string", "description": "Document context. Defaults to 'agent_playground'."},
                    "folder_id": {"type": "string", "description": "Optional folder ID"},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["name"]
            }),
            required_credential: Some("clay".to_string()),
        },
        ToolDef {
            name: "clay_delete_document".to_string(),
            description: "Delete a document from Clay's Documents store. Hard delete is irreversible.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "document_id": {"type": "string", "description": "Document ID (doc_xxx)"},
                    "hard": {"type": "boolean", "description": "Hard delete (irreversible). Default true."},
                    "workspace_id": {"type": "integer", "description": "Workspace ID. Falls back to credential settings."}
                },
                "required": ["document_id"]
            }),
            required_credential: Some("clay".to_string()),
        },

        // External API tool
        ToolDef {
            name: "http_request".to_string(),
            description: "Make an HTTP request to an external API. Use your knowledge docs to determine the correct endpoint, headers, and body format.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method"},
                    "url": {"type": "string", "description": "Full URL including protocol"},
                    "headers": {"type": "object", "description": "Request headers as key-value pairs"},
                    "body": {"type": "object", "description": "Request body (sent as JSON)"},
                    "timeout_seconds": {"type": "integer", "description": "Request timeout in seconds (default 30)"}
                },
                "required": ["method", "url"]
            }),
            required_credential: None, // Generic — credential depends on agent context
        },

        // Knowledge retrieval (RAG) — two-step: search finds locations, read fetches full context
        ToolDef {
            name: "search_knowledge".to_string(),
            description: "Search the expert knowledge corpus for relevant reference material. Returns compact results with document IDs and locations. After finding relevant results, use read_knowledge to fetch full sections for detailed context.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language search query describing what information you need"},
                    "limit": {"type": "integer", "description": "Max results to return (default 5, max 10)"}
                },
                "required": ["query"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "read_knowledge".to_string(),
            description: "Read a section of a knowledge document by chunk range. Use after search_knowledge returns results — pass the document_id and chunk_index from the search results to fetch full continuous text around that location. Returns concatenated chunk content for the requested range.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "document_id": {"type": "string", "description": "The document UUID from search_knowledge results"},
                    "chunk_index": {"type": "integer", "description": "Center chunk index to read around (from search results)"},
                    "range": {"type": "integer", "description": "Number of chunks to return centered on chunk_index (default 5, max 20). E.g. range=5 returns chunk_index-2 through chunk_index+2."}
                },
                "required": ["document_id", "chunk_index"]
            }),
            required_credential: None,
        },

        // Platform tool reference docs (always available)
        ToolDef {
            name: "read_tool_doc".to_string(),
            description: "Read a platform tool reference document. Returns the full markdown content. Check your prompt for the list of available doc names.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "tool_id": {"type": "string", "description": "Tool ID (e.g. 'n8n', 'clay', 'slack')"},
                    "doc_name": {"type": "string", "description": "Doc name from the reference list (e.g. 'error-catalog', 'integration-requirements')"}
                },
                "required": ["tool_id", "doc_name"]
            }),
            required_credential: None,
        },

        // Internal orchestration tools (always available)
        ToolDef {
            name: "read_upstream_output".to_string(),
            description: "Read the output of a completed upstream agent node in this session. Use to access research, scores, or drafts produced by earlier agents.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agent_slug": {"type": "string", "description": "The agent slug whose output you want to read"}
                },
                "required": ["agent_slug"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "write_output".to_string(),
            description: "Write this agent's final structured output. Call ONLY after verifying your work is complete: all acceptance criteria met, deliverables exist and are functional (not just planned), and results verified by reading them back or testing. If you haven't verified, do that first.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "result": {"type": "object", "description": "The structured output matching this agent's output_schema"},
                    "summary": {"type": "string", "description": "Human-readable summary of what was produced"},
                    "artifacts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string", "description": "Type of artifact (e.g. 'workflow', 'page', 'table', 'dashboard', 'function')"},
                                "url": {"type": "string", "description": "URL or identifier of the created artifact"},
                                "title": {"type": "string", "description": "Human-readable name"}
                            }
                        },
                        "description": "Artifacts created or modified during this task"
                    },
                    "verification": {
                        "type": "object",
                        "properties": {
                            "criteria_results": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "criterion": {"type": "string"},
                                        "status": {"type": "string", "enum": ["PASS", "PARTIAL", "FAIL"]},
                                        "evidence": {"type": "string"}
                                    }
                                },
                                "description": "How each acceptance criterion was verified"
                            },
                            "blockers": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Items that could not be completed, with reasons"
                            },
                            "self_score": {
                                "type": "integer",
                                "description": "Self-assessment score 1-10"
                            }
                        },
                        "description": "Verification results showing how the work was validated"
                    }
                },
                "required": ["result", "summary"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "request_user_action".to_string(),
            description: "Pause execution and present the user with a manual action to complete in an external tool. Provide a short summary and structured sections so the UI can render progressive disclosure (collapsed overview -> expandable details). Execution resumes when the user replies.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action_title": {
                        "type": "string",
                        "description": "Short title for the manual step, e.g. 'Create Clay social listening table'"
                    },
                    "summary": {
                        "type": "string",
                        "description": "One-sentence overview of what the user needs to do, shown prominently in the UI"
                    },
                    "sections": {
                        "type": "array",
                        "description": "Typed content blocks rendered with progressive disclosure. Each section has a 'type' discriminator.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": ["overview", "table_spec", "steps", "warnings", "reference", "inputs"],
                                    "description": "Section type: 'overview' (always-visible prose), 'table_spec' (column grid with expandable detail), 'steps' (numbered checklist with expandable detail), 'warnings' (always-visible bullet list), 'reference' (collapsible key-value pairs), 'inputs' (typed input fields the user must fill in — renders smart pickers in the UI)"
                                },
                                "title": {"type": "string", "description": "Section heading"},
                                "content": {"type": "string", "description": "For 'overview': the prose text"},
                                "summary": {"type": "string", "description": "For 'table_spec'/'steps': one-line summary shown in collapsed header"},
                                "columns": {
                                    "type": "array",
                                    "description": "For 'table_spec': column definitions",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "name": {"type": "string"},
                                            "type": {"type": "string", "description": "Column type (Text, Enrichment, Formula, Action, Lookup, etc.)"},
                                            "purpose": {"type": "string", "description": "Short description shown in the grid row"},
                                            "detail": {"type": "string", "description": "Full configuration detail shown on expand/click (provider settings, formula text, webhook config, etc.)"}
                                        },
                                        "required": ["name", "type", "purpose"]
                                    }
                                },
                                "steps": {
                                    "type": "array",
                                    "description": "For 'steps': ordered step list",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "step": {"type": "integer"},
                                            "label": {"type": "string", "description": "Short label shown in the checklist"},
                                            "detail": {"type": "string", "description": "Full instructions shown on expand"}
                                        },
                                        "required": ["step", "label"]
                                    }
                                },
                                "items": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "For 'warnings': list of warning strings"
                                },
                                "entries": {
                                    "type": "object",
                                    "description": "For 'reference': key-value pairs (URLs, IDs, config values)"
                                },
                                "inputs": {
                                    "type": "array",
                                    "description": "For 'inputs': typed input fields the user must fill in. The frontend renders smart pickers based on input_type (e.g., a Slack channel dropdown for 'slack_channel', a Notion database picker for 'notion_database').",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": {"type": "string", "description": "Unique identifier for this input (used as the key in the reply payload)"},
                                            "label": {"type": "string", "description": "Human-readable label shown above the input"},
                                            "input_type": {
                                                "type": "string",
                                                "enum": ["text", "slack_channel", "notion_database", "notion_page", "email", "url", "select"],
                                                "description": "Controls which UI picker is rendered. 'slack_channel' shows a channel dropdown if Slack is connected; 'notion_database'/'notion_page' show Notion pickers; 'select' renders a dropdown from the 'options' array; others render standard inputs."
                                            },
                                            "required": {"type": "boolean", "description": "Whether the user must provide this value before submitting"},
                                            "description": {"type": "string", "description": "Help text shown below the input"},
                                            "default": {"type": "string", "description": "Pre-filled default value (optional)"},
                                            "options": {
                                                "type": "array",
                                                "description": "For input_type 'select': the dropdown choices",
                                                "items": {
                                                    "type": "object",
                                                    "properties": {
                                                        "value": {"type": "string"},
                                                        "label": {"type": "string"}
                                                    },
                                                    "required": ["value", "label"]
                                                }
                                            }
                                        },
                                        "required": ["id", "label", "input_type"]
                                    }
                                }
                            },
                            "required": ["type", "title"]
                        }
                    },
                    "context": {
                        "type": "object",
                        "description": "Structured data the user needs: webhook URLs, column definitions, formula text, API keys to configure, etc."
                    },
                    "resume_hint": {
                        "type": "string",
                        "description": "What the user should provide when done, e.g. 'Reply with the Clay table ID and the webhook URL from the action column'"
                    }
                },
                "required": ["action_title", "summary", "sections", "resume_hint"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "spawn_agent".to_string(),
            description: "Spawn a child agent to handle a sub-task. The child agent runs synchronously and returns its complete output inline. Pass rich context, acceptance criteria, and examples to ensure quality output.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agent_slug": {"type": "string", "description": "Slug of the agent/skill to spawn"},
                    "task_description": {"type": "string", "description": "Specific task for the child agent"},
                    "context": {"type": "string", "description": "Full background context the child agent needs: domain knowledge, upstream outputs, schema details, constraints"},
                    "acceptance_criteria": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Specific, verifiable conditions the output must meet"
                    },
                    "examples": {"type": "string", "description": "Reference material, prior work, or examples that guide the agent"},
                    "skill_slugs": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of skill slugs to compose. Overlays for each skill are resolved and concatenated into the child's prompt."
                    }
                },
                "required": ["agent_slug", "task_description"]
            }),
            required_credential: None,
        },
    ]
}

/// Return tool definitions for a specific agent based on its tools list.
/// Always includes the internal orchestration tools.
pub fn actions_for_agent(agent_tools: &[String], include_spawn: bool) -> Vec<ToolDef> {
    let all = all_action_defs();

    let always_available = ["read_upstream_output", "write_output", "request_user_action", "search_knowledge", "read_knowledge", "read_tool_doc"];

    all.into_iter()
        .filter(|t| {
            agent_tools.contains(&t.name)
                || always_available.contains(&t.name.as_str())
                || (include_spawn && t.name == "spawn_agent")
        })
        .collect()
}

/// Return tool definitions including spawn_agent unconditionally.
/// Used by the orchestrator and any agent that needs to spawn children.
pub fn actions_for_orchestrator(agent_tools: &[String]) -> Vec<ToolDef> {
    actions_for_agent(agent_tools, true)
}

/// Look up the required_credential for a tool by name.
/// Uses a static mapping instead of allocating all tool definitions.
pub fn action_credential(tool_name: &str) -> Option<String> {
    let cred = match tool_name {
        "search_linkedin_profile" | "search_company_data" | "find_contacts" => Some("apollo"),
        "fetch_company_news" | "web_search" => Some("tavily"),
        "read_crm_contact" | "write_crm_contact" | "read_crm_pipeline" | "fetch_email_analytics" => Some("hubspot"),
        "meta_ads_api" => Some("meta"),
        "google_ads_api" => Some("google_ads"),
        "clay_read_rows" | "clay_write_rows" | "clay_trigger_enrichment"
        | "clay_get_table_schema" | "clay_create_field" | "clay_create_source"
        | "clay_create_table" | "clay_delete_table" | "clay_list_tables"
        | "clay_update_field" | "clay_delete_field"
        | "clay_update_rows" | "clay_delete_rows" | "clay_list_app_accounts"
        | "clay_list_actions" | "clay_list_sources" | "clay_get_workspace"
        | "clay_list_workbooks" | "clay_create_workbook"
        | "clay_duplicate_table"
        | "clay_create_view" | "clay_update_view" | "clay_delete_view"
        | "clay_export_table" | "clay_get_export"
        | "clay_get_source" | "clay_update_source" | "clay_delete_source"
        | "clay_list_workflows" | "clay_get_workflow" | "clay_run_workflow"
        | "clay_get_workflow_run" | "clay_list_workflow_runs"
        | "clay_pause_workflow_run" | "clay_unpause_workflow_run"
        | "clay_continue_workflow_step" | "clay_list_waiting_steps"
        | "clay_create_workflow" | "clay_create_workflow_node"
        | "clay_create_workflow_edge" | "clay_get_workflow_snapshot"
        | "clay_list_users" | "clay_list_tags"
        | "clay_upload_document" | "clay_delete_document" => Some("clay"),
        _ => None,
    };
    cred.map(String::from)
}

/// Which scoping-parameter kinds a tool requires to be resolved before it
/// runs. Each kind maps to an array of user-saved presets stored under
/// `credential.metadata.presets.<kind>`. Agent launch is blocked if any
/// required kind has zero presets saved. Empty slice = no scoping params
/// needed (account-scoped tools).
pub fn action_required_presets(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        // All Clay v3 tools are workspace-scoped.
        "clay_read_rows" | "clay_write_rows" | "clay_trigger_enrichment"
        | "clay_get_table_schema" | "clay_create_field" | "clay_create_source"
        | "clay_create_table" | "clay_delete_table" | "clay_list_tables"
        | "clay_update_field" | "clay_delete_field"
        | "clay_update_rows" | "clay_delete_rows" | "clay_list_app_accounts"
        | "clay_list_actions" | "clay_list_sources" | "clay_get_workspace"
        | "clay_list_workbooks" | "clay_create_workbook"
        | "clay_duplicate_table"
        | "clay_create_view" | "clay_update_view" | "clay_delete_view"
        | "clay_export_table" | "clay_get_export"
        | "clay_get_source" | "clay_update_source" | "clay_delete_source"
        | "clay_list_workflows" | "clay_get_workflow" | "clay_run_workflow"
        | "clay_get_workflow_run" | "clay_list_workflow_runs"
        | "clay_pause_workflow_run" | "clay_unpause_workflow_run"
        | "clay_continue_workflow_step" | "clay_list_waiting_steps"
        | "clay_create_workflow" | "clay_create_workflow_node"
        | "clay_create_workflow_edge" | "clay_get_workflow_snapshot"
        | "clay_list_users" | "clay_list_tags"
        | "clay_upload_document" | "clay_delete_document" => &["clay_workspace"],
        _ => &[],
    }
}

// ── Clay credential helper ─────────────────────────────────────────────────────

/// Parse a merged Clay credential for its secrets only.
///
/// Scoping parameters (workspace_id, etc.) are NOT resolved here anymore.
/// The resolver stage runs before execution and the runner injects resolved
/// ids into `tool_input` at each tool-call site; this function now only
/// unpacks the API key and the v3 session cookie.
fn parse_clay_cred(
    cred: &crate::credentials::DecryptedCredential,
) -> (String, Option<String>) {
    let parsed: serde_json::Value = serde_json::from_str(&cred.value).unwrap_or(serde_json::json!({}));
    let api_key = parsed.get("api_key").and_then(serde_json::Value::as_str)
        .unwrap_or(&cred.value).to_string();
    let session_cookie = parsed.get("session_cookie").and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with("claysession=") {
                s.to_string()
            } else {
                format!("claysession={}", s)
            }
        });
    (api_key, session_cookie)
}

// ── Clay HTTP helper ─────────────────────────────────────────────────────────

/// Execute a Clay v3 HTTP request with the session cookie. Centralizes the
/// boilerplate (Cookie + Accept headers, status classification, error wrapping)
/// shared by all the tier-2 clay_* handlers added in the workflows/views/export
/// drift-closure pass.
async fn clay_http_request(
    http_client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    cookie: &str,
    body: Option<&Value>,
    settings: &crate::config::Settings,
) -> String {
    let mut req = http_client
        .request(method, url)
        .header("Cookie", cookie)
        .header("Accept", "application/json");
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").json(b);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            if status >= 400 {
                let (error_type, suggestion) = classify_http_error(status);
                json!({
                    "status": status,
                    "error_type": error_type,
                    "suggestion": suggestion,
                    "body": body_text.chars().take(1000).collect::<String>(),
                })
                .to_string()
            } else {
                http_result_json(status, &body_text, settings.http_response_max_chars)
            }
        }
        Err(e) => json!({"error": format!("Clay v3 request failed: {}", e)}).to_string(),
    }
}

// ── n8n credential helper ──────────────────────────────────────────────────────

/// Parse a merged n8n credential (JSON with api_key + base_url).
/// Falls back to treating the raw value as a bare API key for backwards compatibility.
fn parse_n8n_cred(cred: &crate::credentials::DecryptedCredential) -> (String, Option<String>) {
    let parsed: serde_json::Value = serde_json::from_str(&cred.value).unwrap_or(serde_json::json!({}));
    let api_key = parsed.get("api_key").and_then(serde_json::Value::as_str)
        .unwrap_or(&cred.value).to_string();
    let base_url = parsed.get("base_url").and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string());
    (api_key, base_url)
}

// ── Tool execution ────────────────────────────────────────────────────────────

/// Execute a tool call and return the result as a JSON string.
pub async fn execute_action(
    name: &str,
    input: &Value,
    session_id: &str,
    node_outputs: &std::collections::HashMap<String, Value>,
    credentials: &crate::credentials::CredentialMap,
    settings: &crate::config::Settings,
    http_client: &reqwest::Client,
) -> String {
    let result = execute_action_inner(name, input, session_id, node_outputs, credentials, settings, http_client).await;

    // Log tool failures at warn level (successes already logged by agent_runner)
    if let Ok(parsed) = serde_json::from_str::<Value>(&result) {
        if parsed.get("error").is_some() {
            warn!(tool = %name, "tool returned error");
        }
    }

    result
}

async fn execute_action_inner(
    name: &str,
    input: &Value,
    session_id: &str,
    node_outputs: &std::collections::HashMap<String, Value>,
    credentials: &crate::credentials::CredentialMap,
    settings: &crate::config::Settings,
    http_client: &reqwest::Client,
) -> String {

    match name {
        "search_linkedin_profile" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            if let Some(cred) = credentials.get("apollo") {
                let client = http_client;
                let body = if query.contains("linkedin.com") {
                    json!({"linkedin_url": query})
                } else {
                    let org = input.get("company").and_then(Value::as_str).unwrap_or("");
                    json!({"name": query, "organization_name": org})
                };
                match client.post("https://api.apollo.io/api/v1/people/match")
                    .header("x-api-key", &cred.value)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("Apollo request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "No Apollo credential configured. Add an Apollo API key in Settings → Integrations to enable LinkedIn profile search."
                }).to_string()
            }
        }

        "fetch_company_news" => {
            let domain = input.get("domain").and_then(Value::as_str).unwrap_or("");
            // Delegate to Tavily web search with news-oriented query
            let api_key = credentials.get("tavily")
                .map(|c| c.value.clone())
                .or_else(|| settings.tavily_api_key.clone());

            if let Some(key) = api_key {
                let client = http_client;
                match client.post("https://api.tavily.com/search")
                    .json(&json!({
                        "api_key": key,
                        "query": format!("{} company news recent announcements", domain),
                        "max_results": input.get("limit").and_then(Value::as_u64).unwrap_or(5),
                        "search_depth": "advanced"
                    }))
                    .send().await
                {
                    Ok(resp) => {
                        let body = resp.text().await.unwrap_or_default();
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        preview
                    }
                    Err(e) => json!({"error": format!("News search failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No Tavily API key configured for news search."}).to_string()
            }
        }

        "search_company_data" => {
            let company = input.get("company_name").and_then(Value::as_str).unwrap_or("");
            let domain = input.get("domain").and_then(Value::as_str).unwrap_or("");
            // Try Apollo organization enrichment
            if let Some(cred) = credentials.get("apollo") {
                let client = http_client;
                let body = if !domain.is_empty() {
                    json!({"domain": domain})
                } else {
                    json!({"name": company})
                };
                match client.post("https://api.apollo.io/api/v1/organizations/enrich")
                    .header("x-api-key", &cred.value)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("Apollo request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "No Apollo credential configured. Add an Apollo API key in Settings → Integrations to enable company enrichment."
                }).to_string()
            }
        }

        "find_contacts" => {
            let company = input.get("company_name").and_then(Value::as_str).unwrap_or("");
            let domain = input.get("domain").and_then(Value::as_str).unwrap_or("");
            let titles = input.get("titles").and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>())
                .unwrap_or_default();
            // Try Apollo people search
            if let Some(cred) = credentials.get("apollo") {
                let client = http_client;
                let mut body = json!({
                    "organization_name": company,
                    "per_page": 10
                });
                if !domain.is_empty() {
                    body["organization_domains"] = json!([domain]);
                }
                if !titles.is_empty() {
                    body["person_titles"] = json!(titles);
                }
                match client.post("https://api.apollo.io/api/v1/mixed_people/search")
                    .header("x-api-key", &cred.value)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("Apollo request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "No Apollo credential configured. Add an Apollo API key in Settings → Integrations to enable contact search."
                }).to_string()
            }
        }

        "read_crm_contact" => {
            let identifier = input.get("identifier").and_then(Value::as_str).unwrap_or("");
            if let Some(cred) = credentials.get("hubspot") {
                let token = extract_bearer_token(cred);

                let client = http_client;
                let result = if identifier.contains('@') {
                    // Search by email
                    client.post("https://api.hubapi.com/crm/v3/objects/contacts/search")
                        .header("Authorization", format!("Bearer {token}"))
                        .json(&json!({
                            "filterGroups": [{
                                "filters": [{
                                    "propertyName": "email",
                                    "operator": "EQ",
                                    "value": identifier
                                }]
                            }],
                            "properties": ["email", "firstname", "lastname", "company", "jobtitle", "phone", "lifecyclestage", "hs_lead_status"]
                        }))
                        .send().await
                } else if identifier.chars().all(|c| c.is_ascii_digit()) {
                    // Lookup by ID
                    client.get(format!(
                        "https://api.hubapi.com/crm/v3/objects/contacts/{}?properties=email,firstname,lastname,company,jobtitle,phone,lifecyclestage,hs_lead_status",
                        identifier
                    ))
                        .header("Authorization", format!("Bearer {token}"))
                        .send().await
                } else {
                    // Search by name
                    client.post("https://api.hubapi.com/crm/v3/objects/contacts/search")
                        .header("Authorization", format!("Bearer {token}"))
                        .json(&json!({
                            "query": identifier,
                            "properties": ["email", "firstname", "lastname", "company", "jobtitle", "phone", "lifecyclestage", "hs_lead_status"]
                        }))
                        .send().await
                };

                match result {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("HubSpot request failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No HubSpot credential configured. Connect HubSpot in integration settings."}).to_string()
            }
        }

        "write_crm_contact" => {
            let properties = input.get("properties").cloned().unwrap_or(json!({}));
            let contact_id = input.get("contact_id").and_then(Value::as_str);
            if let Some(cred) = credentials.get("hubspot") {
                let token = extract_bearer_token(cred);

                let client = http_client;
                let result = if let Some(id) = contact_id {
                    // Update existing contact
                    client.patch(format!("https://api.hubapi.com/crm/v3/objects/contacts/{}", id))
                        .header("Authorization", format!("Bearer {token}"))
                        .json(&json!({"properties": properties}))
                        .send().await
                } else {
                    // Create new contact
                    client.post("https://api.hubapi.com/crm/v3/objects/contacts")
                        .header("Authorization", format!("Bearer {token}"))
                        .json(&json!({"properties": properties}))
                        .send().await
                };

                match result {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("HubSpot request failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No HubSpot credential configured. Connect HubSpot in integration settings."}).to_string()
            }
        }

        "read_crm_pipeline" => {
            let pipeline_id = input.get("pipeline_id").and_then(Value::as_str);
            if let Some(cred) = credentials.get("hubspot") {
                let token = extract_bearer_token(cred);

                let client = http_client;
                let url = if let Some(pid) = pipeline_id {
                    format!("https://api.hubapi.com/crm/v3/pipelines/deals/{}", pid)
                } else {
                    "https://api.hubapi.com/crm/v3/pipelines/deals".to_string()
                };
                match client.get(&url)
                    .header("Authorization", format!("Bearer {token}"))
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("HubSpot request failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No HubSpot credential configured. Connect HubSpot in integration settings."}).to_string()
            }
        }

        "fetch_email_analytics" => {
            if let Some(cred) = credentials.get("hubspot") {
                let token = extract_bearer_token(cred);

                let client = http_client;
                match client.get("https://api.hubapi.com/marketing-emails/v1/emails/with-statistics")
                    .header("Authorization", format!("Bearer {token}"))
                    .query(&[("limit", "10")])
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        http_result_json(status, &body, settings.http_response_max_chars)
                    }
                    Err(e) => json!({"error": format!("HubSpot email analytics failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No HubSpot credential configured. Connect HubSpot in integration settings."}).to_string()
            }
        }

        "fetch_url" => {
            let url = input.get("url").and_then(Value::as_str).unwrap_or("");
            if url.is_empty() {
                return json!({"error": "url parameter is required"}).to_string();
            }
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            match client.get(url)
                .header("User-Agent", "Mozilla/5.0 (compatible; LeleBot/1.0)")
                .send().await
            {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    let text: String = body.chars().take(settings.http_response_max_chars).collect();
                    json!({"status": status, "content": text}).to_string()
                }
                Err(e) => json!({"error": format!("Failed to fetch URL: {}", e)}).to_string(),
            }
        }

        "spawn_agent" => {
            // spawn_agent is handled directly by agent_runner.rs (synchronous execution).
            // This branch should never be reached during normal execution.
            let agent_slug = input.get("agent_slug").and_then(Value::as_str).unwrap_or("");
            let task = input.get("task_description").and_then(Value::as_str).unwrap_or("");
            json!({
                "error": "spawn_agent should be handled by agent_runner, not actions::execute_action",
                "agent_slug": agent_slug,
                "task": task
            }).to_string()
        }

        "write_draft" => {
            let draft_type = input.get("type").and_then(Value::as_str).unwrap_or("email");
            let body = input.get("body").and_then(Value::as_str).unwrap_or("");
            json!({
                "draft_id": uuid::Uuid::new_v4().to_string(),
                "type": draft_type,
                "body": body,
                "stored": true
            }).to_string()
        }

        "optimize_subject_line" => {
            json!({
                "variants": [
                    {"subject": "Quick question about your Q4 pipeline", "score": 8.2},
                    {"subject": "Saw you're hiring — thought this might help", "score": 7.9},
                    {"subject": "How [Company] handles outbound", "score": 7.5},
                    {"subject": "15 min to show you something", "score": 7.1},
                    {"subject": "Your recent Series A + our platform", "score": 8.5}
                ],
                "best": "Your recent Series A + our platform"
            }).to_string()
        }

        "read_upstream_output" => {
            let slug = input.get("agent_slug").and_then(Value::as_str).unwrap_or("");
            if let Some(output) = node_outputs.get(slug) {
                output.to_string()
            } else {
                json!({"error": format!("No output found for agent: {}", slug)}).to_string()
            }
        }

        "write_output" => {
            json!({"stored": true, "session_id": session_id}).to_string()
        }

        "request_user_action" => {
            json!({"status": "paused", "message": "Waiting for user to complete manual action"}).to_string()
        }

        "search_knowledge" | "read_knowledge" => {
            json!({"error": format!("{} is handled by agent_runner, not execute_action", name)}).to_string()
        }

        "web_search" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");

            let api_key = credentials.get("tavily")
                .map(|c| c.value.clone())
                .or_else(|| settings.tavily_api_key.clone());

            if let Some(key) = api_key {
                let client = http_client;
                match client.post("https://api.tavily.com/search")
                    .json(&json!({
                        "api_key": key,
                        "query": query,
                        "max_results": 5
                    }))
                    .send()
                    .await
                {
                    Ok(resp) => {
                        let body = resp.text().await.unwrap_or_default();
                        let body_preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        body_preview
                    }
                    Err(e) => json!({"error": format!("Tavily search failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No Tavily API key configured. Set TAVILY_API_KEY or add a tavily credential for this client."}).to_string()
            }
        }

        "fetch_ad_performance" => {
            json!({
                "error": "fetch_ad_performance is not wired to a live ads API. Configure the relevant integration and implement the provider call in execute_action, or use a different tool."
            }).to_string()
        }

        "meta_ads_api" | "google_ads_api" => {
            json!({
                "error": "This ads API tool is not implemented yet. Use provider-specific credentials and HTTP tools, or extend execute_action with the official Meta/Google Marketing APIs."
            }).to_string()
        }

        // ── Clay dedicated tools ────────────────────────────────────────
        "clay_get_table_schema" | "clay_create_field" | "clay_create_source"
        | "clay_create_table" | "clay_delete_table" | "clay_list_tables"
        | "clay_update_field" | "clay_delete_field"
        | "clay_read_rows" | "clay_write_rows" | "clay_trigger_enrichment"
        | "clay_update_rows" | "clay_delete_rows" | "clay_list_app_accounts"
        | "clay_list_actions" | "clay_list_sources" | "clay_get_workspace"
        | "clay_list_workbooks" | "clay_create_workbook"
        | "clay_duplicate_table"
        | "clay_create_view" | "clay_update_view" | "clay_delete_view"
        | "clay_export_table" | "clay_get_export"
        | "clay_get_source" | "clay_update_source" | "clay_delete_source"
        | "clay_list_workflows" | "clay_get_workflow" | "clay_run_workflow"
        | "clay_get_workflow_run" | "clay_list_workflow_runs"
        | "clay_pause_workflow_run" | "clay_unpause_workflow_run"
        | "clay_continue_workflow_step" | "clay_list_waiting_steps"
        | "clay_create_workflow" | "clay_create_workflow_node"
        | "clay_create_workflow_edge" | "clay_get_workflow_snapshot"
        | "clay_list_users" | "clay_list_tags"
        | "clay_upload_document" | "clay_delete_document" => {
            let cred = match credentials.get("clay") {
                Some(c) => c,
                None => return json!({
                    "error": "No Clay credential configured. Add your Clay session cookie in Settings → Integrations."
                }).to_string(),
            };
            let (_api_key, session_cookie) = parse_clay_cred(cred);

            // workspace_id is injected into tool_input by the runner from the
            // plan's resolved entities (see agent_runner.rs + resolver.rs).
            // If it's missing here, something upstream in the pipeline failed
            // — either the resolver didn't run, or the plan is being executed
            // without resolution gating. Fail loudly rather than guess.
            let resolved_ws_id: u64 = match input
                .get("workspace_id")
                .and_then(Value::as_u64)
                .or_else(|| input.get("workspace_id").and_then(Value::as_str).and_then(|s| s.parse().ok()))
            {
                Some(id) => id,
                None => {
                    return json!({
                        "error": "workspace_id not resolved for this node. The resolver stage should have populated it before execute; check plan.description.resolved_entities and agent_runner injection.",
                        "unresolved_entity": "clay_workspace",
                    })
                    .to_string();
                }
            };

            let clay_result = match name {
        "clay_get_table_schema" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}", table_id);
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot read schema via API.",
                    "no_session": true,
                    "action": "Use request_user_action to ask the user for schema details. They can enable full automation by adding a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        "clay_create_field" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let fname = input.get("name").and_then(Value::as_str).unwrap_or("");
            let field_type = input.get("field_type").and_then(Value::as_str).unwrap_or("text");
            let active_view_id = input.get("active_view_id").and_then(Value::as_str).unwrap_or("");
            let type_settings = input.get("type_settings").cloned().unwrap_or(json!({"dataTypeSettings": {"type": "text"}}));

            if table_id.is_empty() || fname.is_empty() || active_view_id.is_empty() {
                return json!({"error": "table_id, name, and active_view_id are required"}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}/fields", table_id);
                let body = json!({
                    "name": fname,
                    "type": field_type,
                    "activeViewId": active_view_id,
                    "typeSettings": type_settings
                });
                match http_client.post(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 create field failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot create columns via API.",
                    "no_session": true,
                    "action": "Use request_user_action to instruct the user to create this column manually. They can enable full automation by adding a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        "clay_create_source" => {
            let ws_id = resolved_ws_id;
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let src_name = input.get("name").and_then(Value::as_str).unwrap_or("Webhook");
            let source_type = input.get("source_type").and_then(Value::as_str).unwrap_or("v3-action");
            let type_settings = input.get("type_settings").cloned().unwrap_or(json!({"hasAuth": false, "iconType": "Webhook"}));

            if ws_id == 0 || table_id.is_empty() {
                return json!({"error": "workspace_id and table_id are required. workspace_id can be set in Clay credential settings or passed as a parameter."}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let body = json!({
                    "workspaceId": ws_id,
                    "tableId": table_id,
                    "name": src_name,
                    "type": source_type,
                    "typeSettings": type_settings
                });
                match http_client.post("https://api.clay.com/v3/sources")
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 create source failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot create sources via API.",
                    "no_session": true,
                    "action": "Use request_user_action to instruct the user to create this source manually. They can enable full automation by adding a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        "clay_create_table" => {
            let ws_id = resolved_ws_id;
            let table_name = input.get("name").and_then(Value::as_str).unwrap_or("");
            let table_type = input.get("table_type").and_then(Value::as_str).unwrap_or("spreadsheet");
            let workbook_id = input.get("workbook_id").and_then(Value::as_str).unwrap_or("");

            if ws_id == 0 {
                return json!({"error": "workspace_id is required. Set it in Clay credential settings or pass as a parameter."}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let mut body = json!({
                    "workspaceId": ws_id,
                    "type": table_type
                });
                if !table_name.is_empty() {
                    body["name"] = json!(table_name);
                }
                if !workbook_id.is_empty() {
                    body["workbookId"] = json!(workbook_id);
                }
                match http_client.post("https://api.clay.com/v3/tables")
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 create table failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot create tables via API.",
                    "no_session": true,
                    "action": "Use request_user_action to instruct the user to create a table in Clay UI. They can enable full automation by adding a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        "clay_delete_table" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}", table_id);
                match http_client.delete(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            json!({"ok": true, "deleted": table_id}).to_string()
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 delete table failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured — cannot delete tables via API.", "no_session": true}).to_string()
            }
        }

        "clay_list_tables" => {
            let ws_id = resolved_ws_id;
            if ws_id == 0 {
                return json!({"error": "workspace_id is required. Set it in Clay credential settings or pass as a parameter."}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let url = format!("https://api.clay.com/v3/workspaces/{}/tables", ws_id);
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 list tables failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured — cannot list tables via API.", "no_session": true}).to_string()
            }
        }

        "clay_update_field" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let field_id = input.get("field_id").and_then(Value::as_str).unwrap_or("");
            let updates = input.get("updates").cloned().unwrap_or(json!({}));
            if table_id.is_empty() || field_id.is_empty() {
                return json!({"error": "table_id and field_id are required"}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}/fields/{}", table_id, field_id);
                match http_client.patch(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&updates)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 update field failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured — cannot update fields via API.", "no_session": true}).to_string()
            }
        }

        "clay_delete_field" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let field_id = input.get("field_id").and_then(Value::as_str).unwrap_or("");
            if table_id.is_empty() || field_id.is_empty() {
                return json!({"error": "table_id and field_id are required"}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}/fields/{}", table_id, field_id);
                match http_client.delete(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            json!({"ok": true, "deleted_field": field_id}).to_string()
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 delete field failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured — cannot delete fields via API.", "no_session": true}).to_string()
            }
        }

        // ── Row operations via v3 /records endpoint (v1 is deprecated) ──

        "clay_read_rows" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let view_id = input.get("view_id").and_then(Value::as_str).unwrap_or("");
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(100);

            if table_id.is_empty() || view_id.is_empty() {
                return json!({"error": "table_id and view_id are required. Get view_id from clay_get_table_schema → views[]."}).to_string();
            }

            if let Some(cookie) = &session_cookie {
                let url = format!(
                    "https://api.clay.com/v3/tables/{}/views/{}/records?limit={}",
                    table_id, view_id, limit
                );
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 read rows failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot read rows via API.",
                    "no_session": true,
                    "action": "Add a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        "clay_write_rows" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let rows = input.get("rows").cloned().unwrap_or(json!([]));

            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }

            if let Some(cookie) = &session_cookie {
                // Convert rows to v3 records format: [{cells: {fieldId: value}}]
                let records: Vec<Value> = if let Some(arr) = rows.as_array() {
                    arr.iter().map(|row| json!({"cells": row})).collect()
                } else {
                    vec![json!({"cells": rows})]
                };

                let url = format!("https://api.clay.com/v3/tables/{}/records", table_id);
                let body = json!({"records": records});
                match http_client.post(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 write rows failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot write rows via API.",
                    "no_session": true,
                    "action": "Add a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        "clay_trigger_enrichment" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let field_ids = input.get("field_ids").cloned().unwrap_or(json!([]));
            let record_ids = input.get("record_ids").cloned().unwrap_or(json!([]));
            let force_run = input.get("force_run").and_then(Value::as_bool).unwrap_or(false);

            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }

            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}/run", table_id);
                let body = json!({
                    "fieldIds": field_ids,
                    "runRecords": { "recordIds": record_ids },
                    "forceRun": force_run,
                    "callerName": "99percent-agent"
                });
                match http_client.patch(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 trigger enrichment failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot trigger enrichment via API.",
                    "no_session": true,
                    "action": "Add a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        // ── New v3 tools (discovered via bleeding-edge research) ──

        "clay_update_rows" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let records = input.get("records").cloned().unwrap_or(json!([]));

            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }

            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}/records", table_id);
                let body = json!({"records": records});
                match http_client.patch(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 update rows failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_delete_rows" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let record_ids = input.get("record_ids").cloned().unwrap_or(json!([]));

            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }

            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/tables/{}/records", table_id);
                let body = json!({"recordIds": record_ids});
                match http_client.delete(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            json!({"ok": true, "deleted_count": record_ids.as_array().map(|a| a.len()).unwrap_or(0)}).to_string()
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 delete rows failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_list_app_accounts" => {
            let ws_id = resolved_ws_id;
            if let Some(cookie) = &session_cookie {
                let url = if ws_id > 0 {
                    format!("https://api.clay.com/v3/app-accounts?workspaceId={}", ws_id)
                } else {
                    "https://api.clay.com/v3/app-accounts".to_string()
                };
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 list app accounts failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_list_actions" => {
            let ws_id = resolved_ws_id;
            if ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/actions?workspaceId={}", ws_id);
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 list actions failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_list_sources" => {
            let ws_id = resolved_ws_id;
            if ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/sources?workspaceId={}", ws_id);
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 list sources failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_get_workspace" => {
            let ws_id = resolved_ws_id;
            if ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/workspaces/{}", ws_id);
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 get workspace failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_list_workbooks" => {
            let ws_id = resolved_ws_id;
            if ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            if let Some(cookie) = &session_cookie {
                let url = format!("https://api.clay.com/v3/workspaces/{}/workbooks", ws_id);
                match http_client.get(&url)
                    .header("Cookie", cookie.as_str())
                    .header("Accept", "application/json")
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 list workbooks failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "Session cookie not configured.", "no_session": true, "action": "Add a session cookie in Settings → Integrations → Clay."}).to_string()
            }
        }

        "clay_create_workbook" => {
            let ws_id = resolved_ws_id;
            let wb_name = input.get("name").and_then(Value::as_str).unwrap_or("");
            if ws_id == 0 {
                return json!({"error": "workspace_id is required. Set it in Clay credential settings or pass as a parameter."}).to_string();
            }
            if wb_name.is_empty() {
                return json!({"error": "name is required for workbook creation."}).to_string();
            }
            if let Some(ref cookie) = session_cookie {
                let body = json!({
                    "workspaceId": ws_id,
                    "name": wb_name
                });
                match http_client.post("https://api.clay.com/v3/workbooks")
                    .header("Cookie", cookie.as_str())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .json(&body)
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let resp_body = resp.text().await.unwrap_or_default();
                        if status >= 400 {
                            let (error_type, suggestion) = classify_http_error(status);
                            json!({"status": status, "error_type": error_type, "suggestion": suggestion, "body": resp_body.chars().take(1000).collect::<String>()}).to_string()
                        } else {
                            http_result_json(status, &resp_body, settings.http_response_max_chars)
                        }
                    }
                    Err(e) => json!({"error": format!("Clay v3 create workbook failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "Session cookie not configured — cannot create workbooks via API.",
                    "no_session": true,
                    "action": "Use request_user_action to instruct the user to create the workbook in Clay UI. They can enable full automation by adding a session cookie in Settings → Integrations → Clay."
                }).to_string()
            }
        }

        // ── Tier-2 tools (workflows, views, export, sources, documents, admin) ──

        "clay_duplicate_table" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/tables/{}/duplicate", table_id);
            let mut body = json!({});
            if let Some(name) = input.get("name").and_then(Value::as_str) {
                if !name.is_empty() { body["name"] = json!(name); }
            }
            if resolved_ws_id > 0 { body["workspaceId"] = json!(resolved_ws_id); }
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_create_view" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let view_name = input.get("name").and_then(Value::as_str).unwrap_or("");
            if table_id.is_empty() || view_name.is_empty() {
                return json!({"error": "table_id and name are required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/tables/{}/views", table_id);
            let body = json!({"name": view_name});
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_update_view" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let view_id = input.get("view_id").and_then(Value::as_str).unwrap_or("");
            let updates = input.get("updates").cloned().unwrap_or(json!({}));
            if table_id.is_empty() || view_id.is_empty() {
                return json!({"error": "table_id and view_id are required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/tables/{}/views/{}", table_id, view_id);
            clay_http_request(http_client, reqwest::Method::PATCH, &url, cookie, Some(&updates), settings).await
        }

        "clay_delete_view" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let view_id = input.get("view_id").and_then(Value::as_str).unwrap_or("");
            if table_id.is_empty() || view_id.is_empty() {
                return json!({"error": "table_id and view_id are required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/tables/{}/views/{}", table_id, view_id);
            clay_http_request(http_client, reqwest::Method::DELETE, &url, cookie, None, settings).await
        }

        "clay_export_table" => {
            let table_id = input.get("table_id").and_then(Value::as_str).unwrap_or("");
            let format_str = input.get("format").and_then(Value::as_str).unwrap_or("csv");
            if table_id.is_empty() {
                return json!({"error": "table_id is required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/tables/{}/export", table_id);
            let body = json!({"format": format_str});
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_get_export" => {
            let job_id = input.get("export_job_id").and_then(Value::as_str).unwrap_or("");
            if job_id.is_empty() {
                return json!({"error": "export_job_id is required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/exports/{}", job_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_get_source" => {
            let source_id = input.get("source_id").and_then(Value::as_str).unwrap_or("");
            if source_id.is_empty() {
                return json!({"error": "source_id is required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/sources/{}", source_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_update_source" => {
            let source_id = input.get("source_id").and_then(Value::as_str).unwrap_or("");
            let updates = input.get("updates").cloned().unwrap_or(json!({}));
            if source_id.is_empty() {
                return json!({"error": "source_id is required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/sources/{}", source_id);
            clay_http_request(http_client, reqwest::Method::PATCH, &url, cookie, Some(&updates), settings).await
        }

        "clay_delete_source" => {
            let source_id = input.get("source_id").and_then(Value::as_str).unwrap_or("");
            if source_id.is_empty() {
                return json!({"error": "source_id is required"}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/sources/{}", source_id);
            clay_http_request(http_client, reqwest::Method::DELETE, &url, cookie, None, settings).await
        }

        "clay_list_workflows" => {
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows", resolved_ws_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_get_workflow" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() {
                return json!({"error": "workflow_id is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/graph", resolved_ws_id, workflow_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_run_workflow" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let inputs = input.get("inputs").cloned().unwrap_or(json!({}));
            if workflow_id.is_empty() {
                return json!({"error": "workflow_id is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/runs", resolved_ws_id, workflow_id);
            let body = json!({"inputs": inputs});
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_get_workflow_run" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let run_id = input.get("run_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() || run_id.is_empty() {
                return json!({"error": "workflow_id and run_id are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/runs/{}", resolved_ws_id, workflow_id, run_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_list_workflow_runs" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(50);
            let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0);
            if workflow_id.is_empty() {
                return json!({"error": "workflow_id is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!(
                "https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/runs?limit={}&offset={}",
                resolved_ws_id, workflow_id, limit, offset
            );
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_pause_workflow_run" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let run_id = input.get("run_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() || run_id.is_empty() {
                return json!({"error": "workflow_id and run_id are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/runs/{}/pause", resolved_ws_id, workflow_id, run_id);
            let body = json!({});
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_unpause_workflow_run" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let run_id = input.get("run_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() || run_id.is_empty() {
                return json!({"error": "workflow_id and run_id are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/runs/{}/unpause", resolved_ws_id, workflow_id, run_id);
            let body = json!({});
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_continue_workflow_step" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let run_id = input.get("run_id").and_then(Value::as_str).unwrap_or("");
            let step_id = input.get("step_id").and_then(Value::as_str).unwrap_or("");
            let hfi = input.get("human_feedback_input").cloned().unwrap_or(json!({}));
            if workflow_id.is_empty() || run_id.is_empty() || step_id.is_empty() {
                return json!({"error": "workflow_id, run_id, and step_id are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!(
                "https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/runs/{}/steps/{}/continue",
                resolved_ws_id, workflow_id, run_id, step_id
            );
            let body = json!({"humanFeedbackInput": hfi});
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_list_waiting_steps" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() {
                return json!({"error": "workflow_id is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/steps/waiting", resolved_ws_id, workflow_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_create_workflow" => {
            let wf_name = input.get("name").and_then(Value::as_str).unwrap_or("");
            if wf_name.is_empty() {
                return json!({"error": "name is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows", resolved_ws_id);
            let mut body = json!({"name": wf_name});
            if let Some(model) = input.get("default_model_id").and_then(Value::as_str) {
                if !model.is_empty() { body["defaultModelId"] = json!(model); }
            }
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_create_workflow_node" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let node_name = input.get("name").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() || node_name.is_empty() {
                return json!({"error": "workflow_id and name are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/nodes", resolved_ws_id, workflow_id);
            let mut body = json!({"name": node_name});
            if let Some(nt) = input.get("node_type").and_then(Value::as_str) {
                if !nt.is_empty() { body["nodeType"] = json!(nt); }
            }
            if let Some(d) = input.get("description").and_then(Value::as_str) {
                if !d.is_empty() { body["description"] = json!(d); }
            }
            if let Some(m) = input.get("model_id").and_then(Value::as_str) {
                if !m.is_empty() { body["modelId"] = json!(m); }
            }
            if let Some(b) = input.get("is_initial").and_then(Value::as_bool) { body["isInitial"] = json!(b); }
            if let Some(b) = input.get("is_terminal").and_then(Value::as_bool) { body["isTerminal"] = json!(b); }
            if let Some(p) = input.get("position") { body["position"] = p.clone(); }
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_create_workflow_edge" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let source = input.get("source_node_id").and_then(Value::as_str).unwrap_or("");
            let target = input.get("target_node_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() || source.is_empty() || target.is_empty() {
                return json!({"error": "workflow_id, source_node_id, and target_node_id are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/edges", resolved_ws_id, workflow_id);
            let mut body = json!({"sourceNodeId": source, "targetNodeId": target});
            if let Some(m) = input.get("metadata") { body["metadata"] = m.clone(); }
            clay_http_request(http_client, reqwest::Method::POST, &url, cookie, Some(&body), settings).await
        }

        "clay_get_workflow_snapshot" => {
            let workflow_id = input.get("workflow_id").and_then(Value::as_str).unwrap_or("");
            let snapshot_id = input.get("snapshot_id").and_then(Value::as_str).unwrap_or("");
            if workflow_id.is_empty() || snapshot_id.is_empty() {
                return json!({"error": "workflow_id and snapshot_id are required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!(
                "https://api.clay.com/v3/workspaces/{}/tc-workflows/{}/snapshots/{}",
                resolved_ws_id, workflow_id, snapshot_id
            );
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_list_users" => {
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!("https://api.clay.com/v3/workspaces/{}/users", resolved_ws_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_list_tags" => {
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            // The tags subsystem is not fully reverse-engineered. The advisory tool
            // hits resource-tags as the most likely path. See knowledge/admin.md.
            let url = format!("https://api.clay.com/v3/workspaces/{}/resource-tags", resolved_ws_id);
            clay_http_request(http_client, reqwest::Method::GET, &url, cookie, None, settings).await
        }

        "clay_upload_document" => {
            let doc_name = input.get("name").and_then(Value::as_str).unwrap_or("");
            let inline_content = input.get("content").and_then(Value::as_str);
            let source_url = input.get("source_url").and_then(Value::as_str);
            let mime_type = input.get("mime_type").and_then(Value::as_str).unwrap_or("text/plain");
            let context = input.get("context").and_then(Value::as_str).unwrap_or("agent_playground");
            let folder_id = input.get("folder_id").and_then(Value::as_str);

            if doc_name.is_empty() {
                return json!({"error": "name is required"}).to_string();
            }
            if inline_content.is_none() && source_url.is_none() {
                return json!({"error": "either content or source_url is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };

            // Step 1: get S3 upload URL
            let init_url = format!("https://api.clay.com/v3/documents/{}/upload-url", resolved_ws_id);
            let mut init_body = json!({"name": doc_name, "context": context});
            if let Some(f) = folder_id {
                if !f.is_empty() { init_body["folderId"] = json!(f); }
            }
            let init_resp = clay_http_request(http_client, reqwest::Method::POST, &init_url, cookie, Some(&init_body), settings).await;
            let init_parsed: Value = match serde_json::from_str(&init_resp) {
                Ok(v) => v,
                Err(_) => return json!({"error": "Document upload init: failed to parse Clay response", "raw": init_resp}).to_string(),
            };
            if init_parsed.get("error").is_some() || init_parsed.get("error_type").is_some() {
                return init_parsed.to_string();
            }
            let init_data = init_parsed.get("data").unwrap_or(&init_parsed);
            let document_id = match init_data.get("documentId").and_then(Value::as_str) {
                Some(id) => id.to_string(),
                None => return json!({"error": "Document upload init returned no documentId", "response": init_parsed}).to_string(),
            };
            let upload_url = match init_data.get("uploadUrl").and_then(Value::as_str) {
                Some(u) => u.to_string(),
                None => return json!({"error": "Document upload init returned no uploadUrl", "response": init_parsed}).to_string(),
            };
            let s3_fields = init_data.get("fields").cloned().unwrap_or(json!({}));

            // Step 2: fetch source content if needed, then S3 multipart POST
            let file_bytes: Vec<u8> = if let Some(c) = inline_content {
                c.as_bytes().to_vec()
            } else if let Some(url) = source_url {
                match http_client.get(url).send().await {
                    Ok(r) => match r.bytes().await {
                        Ok(b) => b.to_vec(),
                        Err(e) => return json!({"error": format!("Failed to read source_url body: {}", e)}).to_string(),
                    },
                    Err(e) => return json!({"error": format!("Failed to fetch source_url: {}", e)}).to_string(),
                }
            } else {
                return json!({"error": "no content"}).to_string();
            };

            let mut form = reqwest::multipart::Form::new();
            if let Some(map) = s3_fields.as_object() {
                for (k, v) in map {
                    if let Some(s) = v.as_str() {
                        form = form.text(k.clone(), s.to_string());
                    }
                }
            }
            let part = reqwest::multipart::Part::bytes(file_bytes)
                .file_name(doc_name.to_string())
                .mime_str(mime_type)
                .unwrap_or_else(|_| reqwest::multipart::Part::text(""));
            form = form.part("file", part);

            let s3_status = match http_client.post(&upload_url).multipart(form).send().await {
                Ok(r) => r.status().as_u16(),
                Err(e) => return json!({"error": format!("S3 upload failed: {}", e)}).to_string(),
            };
            if !(200..300).contains(&s3_status) {
                return json!({"error": "S3 upload returned non-2xx", "s3_status": s3_status}).to_string();
            }

            // Step 3: confirm upload
            let confirm_url = format!("https://api.clay.com/v3/documents/{}/{}/confirm-upload", resolved_ws_id, document_id);
            let confirm_body = json!({});
            clay_http_request(http_client, reqwest::Method::POST, &confirm_url, cookie, Some(&confirm_body), settings).await
        }

        "clay_delete_document" => {
            let document_id = input.get("document_id").and_then(Value::as_str).unwrap_or("");
            let hard = input.get("hard").and_then(Value::as_bool).unwrap_or(true);
            if document_id.is_empty() {
                return json!({"error": "document_id is required"}).to_string();
            }
            if resolved_ws_id == 0 {
                return json!({"error": "workspace_id is required."}).to_string();
            }
            let cookie = match &session_cookie {
                Some(c) => c,
                None => return json!({"error": "Session cookie not configured.", "no_session": true}).to_string(),
            };
            let url = format!(
                "https://api.clay.com/v3/documents/{}/{}?hard={}",
                resolved_ws_id, document_id, hard
            );
            clay_http_request(http_client, reqwest::Method::DELETE, &url, cookie, None, settings).await
        }

        _ => json!({"error": format!("Unknown clay tool: {}", name)}).to_string(),
            }; // end inner match

            // Inject resolved workspace_id into successful Clay responses so the LLM
            // always has the correct ID in context (prevents hallucinated workspace IDs in artifacts).
            if resolved_ws_id > 0 {
                if let Ok(mut parsed) = serde_json::from_str::<Value>(&clay_result) {
                    if parsed.get("error").is_none() {
                        parsed["_workspace_id"] = json!(resolved_ws_id);
                        parsed["_workspace_url_base"] = json!(format!("https://app.clay.com/workspaces/{}", resolved_ws_id));
                        return parsed.to_string();
                    }
                }
            }
            clay_result
        } // end clay tools block

        "http_request" => {
            let method = input.get("method").and_then(Value::as_str).unwrap_or("GET");
            let url = input.get("url").and_then(Value::as_str).unwrap_or("");
            let timeout_secs = input.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(30);

            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(timeout_secs))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());

            let mut request = match method {
                "POST" => client.post(url),
                "PUT" => client.put(url),
                "PATCH" => client.patch(url),
                "DELETE" => client.delete(url),
                _ => client.get(url),
            };

            // Check which headers the agent already provided
            let agent_headers = input.get("headers").and_then(Value::as_object);
            let has_auth = agent_headers
                .map(|h| h.keys().any(|k| k.eq_ignore_ascii_case("authorization")))
                .unwrap_or(false);
            let has_notion_version = agent_headers
                .map(|h| h.keys().any(|k| k.eq_ignore_ascii_case("notion-version")))
                .unwrap_or(false);

            if let Some(headers) = input.get("headers").and_then(Value::as_object) {
                for (key, val) in headers {
                    if let Some(v) = val.as_str() {
                        request = request.header(key.as_str(), v);
                    }
                }
            }

            // Auto-inject credentials if agent didn't provide auth
            if !has_auth {
                if url.contains("api.hubapi.com") {
                    if let Some(cred) = credentials.get("hubspot") {
                        request = request.header("Authorization", format!("Bearer {}", extract_bearer_token(cred)));
                    }
                } else if url.contains("api.notion.com") {
                    if let Some(cred) = credentials.get("notion") {
                        request = request.header("Authorization", format!("Bearer {}", extract_bearer_token(cred)));
                        if !has_notion_version {
                            request = request.header("Notion-Version", "2022-06-28");
                        }
                    }
                } else if url.contains("supabase.co") {
                    if let Some(cred) = credentials.get("supabase") {
                        request = request.header("apikey", &cred.value);
                        request = request.header("Authorization", format!("Bearer {}", cred.value));
                    }
                } else if url.contains("tolt.io") || url.contains("api.tolt.io") {
                    if let Some(cred) = credentials.get("tolt") {
                        request = request.header("Authorization", format!("Bearer {}", cred.value));
                    }
                } else if url.contains(".n8n.cloud") || url.contains("n8n.") || url.contains("/api/v1/workflows") || url.contains("/api/v1/executions") || url.contains("/api/v1/credentials") || credentials.get("n8n").map_or(false, |c| { let (_, bu) = parse_n8n_cred(c); bu.as_deref().map_or(false, |b| url.starts_with(b)) }) {
                    if let Some(cred) = credentials.get("n8n") {
                        let (key, _) = parse_n8n_cred(cred);
                        debug!(key_len = key.len(), "injecting X-N8N-API-KEY header");
                        request = request.header("X-N8N-API-KEY", key.as_str());
                    } else {
                        warn!("n8n URL detected but no credential configured for this project");
                    }
                } else if url.contains("graph.facebook.com") {
                    if let Some(cred) = credentials.get("meta") {
                        request = request.header("Authorization", format!("Bearer {}", extract_bearer_token(cred)));
                    }
                } else if url.contains("googleapis.com") {
                    if let Some(cred) = credentials.get("google") {
                        request = request.header("Authorization", format!("Bearer {}", extract_bearer_token(cred)));
                    }
                } else if url.contains("slack.com/api") {
                    if let Some(cred) = credentials.get("slack") {
                        request = request.header("Authorization", format!("Bearer {}", extract_bearer_token(cred)));
                    }
                } else if url.contains("api.apollo.io") {
                    if let Some(cred) = credentials.get("apollo") {
                        request = request.header("x-api-key", &cred.value);
                    }
                } else if url.contains("api.clay.com") {
                    if let Some(cred) = credentials.get("clay") {
                        request = request.header("Authorization", format!("Bearer {}", cred.value));
                    }
                }
            }

            if let Some(body) = input.get("body") {
                request = request.json(body);
            }

            tracing::info!(
                %method, %url,
                has_auth = %has_auth,
                has_body = input.get("body").is_some(),
                "http_request outgoing"
            );

            match request.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body_text = resp.text().await.unwrap_or_default();
                    let body_preview: String = body_text.chars().take(settings.http_response_max_chars).collect();
                    if status >= 400 {
                        tracing::warn!(%method, %url, %status, body = %body_preview.chars().take(500).collect::<String>(), "http_request error response");
                        let (error_type, suggestion) = classify_http_error(status);
                        json!({
                            "status": status,
                            "body": body_preview,
                            "error_type": error_type,
                            "suggestion": suggestion,
                        }).to_string()
                    } else {
                        json!({
                            "status": status,
                            "body": body_preview,
                        }).to_string()
                    }
                }
                Err(e) => {
                    tracing::error!(%method, %url, error = %e, "http_request failed");
                    json!({
                        "error": format!("HTTP request failed: {}", e),
                        "error_type": "network_error",
                        "suggestion": "Check the URL and try again. If the service is down, document as a blocker.",
                    }).to_string()
                }
            }
        }

        _ => {
            json!({"error": format!("Unknown or unimplemented tool: {}", name)}).to_string()
        }
    }
}

/// Classify HTTP error codes into actionable error types with recovery suggestions.
fn classify_http_error(status: u16) -> (&'static str, &'static str) {
    match status {
        401 | 403 => ("credential_error", "Credential may be expired or misconfigured. Document as a blocker with the integration name."),
        404 => ("not_found", "Resource not found. List/search available resources first, then operate on what exists."),
        429 => ("rate_limited", "Rate limited. Wait before retrying — don't hammer the endpoint."),
        400 | 422 => ("validation_error", "Validation error. Read the error body carefully — it usually tells you the exact field that's wrong."),
        409 => ("conflict", "Resource conflict. The resource may already exist or be in an incompatible state. Read current state first."),
        500..=599 => ("server_error", "Server error. Retry once. If it persists, document as a blocker."),
        _ => ("unknown_error", "Unexpected error. Read the response body for details."),
    }
}
