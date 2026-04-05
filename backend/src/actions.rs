/// GTM action definitions for the agent executor.
///
/// Each tool is defined here with its name, description, and input schema.
/// In Phase 0 (MVP), tools return mock/stub responses.
/// Real integrations (HubSpot, LinkedIn, Meta Ads, etc.) are added in later phases.
use serde_json::{json, Value};
use tracing::info;

use crate::anthropic::ToolDef;

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

        // Advertising tools
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

        // Knowledge retrieval (RAG)
        ToolDef {
            name: "search_knowledge".to_string(),
            description: "Search the expert knowledge corpus for relevant reference material. Returns the most semantically similar chunks from uploaded playbooks, ICP docs, battle cards, transcripts, and other documents. Use when you need factual reference data, client-specific context, or expert methodology that isn't in your system prompt.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language search query describing what information you need"},
                    "limit": {"type": "integer", "description": "Max chunks to return (default 5, max 10)"}
                },
                "required": ["query"]
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
                    "verification": {"type": "string", "description": "How you verified the work is correct (e.g. 'fetched the created workflow via GET and confirmed 3 nodes configured', 'loaded the dashboard URL and confirmed data displays')"}
                },
                "required": ["result", "summary"]
            }),
            required_credential: None,
        },
        ToolDef {
            name: "request_user_action".to_string(),
            description: "Pause execution and present the user with a manual action they need to complete in an external tool (e.g. Clay UI, Lovable editor). Provide detailed, step-by-step instructions with all necessary specs. Execution will resume when the user replies with the result.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action_title": {
                        "type": "string",
                        "description": "Short title for the manual step, e.g. 'Create Clay social listening table'"
                    },
                    "instructions": {
                        "type": "string",
                        "description": "Detailed step-by-step instructions in markdown. Include column specs, formulas, URLs, settings — everything the user needs."
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
                "required": ["action_title", "instructions", "resume_hint"]
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

    let always_available = ["read_upstream_output", "write_output", "request_user_action"];

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
pub fn action_credential(tool_name: &str) -> Option<String> {
    all_action_defs()
        .into_iter()
        .find(|t| t.name == tool_name)
        .and_then(|t| t.required_credential)
}

// ── Tool execution (Phase 0: mock responses) ──────────────────────────────────

/// Execute a tool call and return the result as a JSON string.
/// Phase 0: Returns realistic mock data for all GTM tools.
/// Phase 1+: Calls real integrations.
pub async fn execute_action(
    name: &str,
    input: &Value,
    session_id: &str,
    node_outputs: &std::collections::HashMap<String, Value>,
    credentials: &crate::credentials::CredentialMap,
    settings: &crate::config::Settings,
) -> String {
    info!(tool = %name, "executing tool");

    match name {
        "search_linkedin_profile" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            // Try Apollo people/match API first, fall back to mock
            if let Some(cred) = credentials.get("apollo") {
                let client = reqwest::Client::new();
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
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
                    }
                    Err(e) => json!({"error": format!("Apollo request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "No Apollo credential configured. Add an Apollo API key to enable LinkedIn profile search.",
                    "fallback_mock": true,
                    "name": "Alex Johnson",
                    "title": "VP of Sales",
                    "company": "Acme Corp",
                    "location": "San Francisco, CA",
                    "summary": "10 years building sales teams at high-growth SaaS companies"
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
                let client = reqwest::Client::new();
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
                let client = reqwest::Client::new();
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
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
                    }
                    Err(e) => json!({"error": format!("Apollo request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "No Apollo credential configured. Add an Apollo API key to enable company enrichment.",
                    "fallback_mock": true,
                    "company": company,
                    "employees": 120,
                    "industry": "B2B SaaS"
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
                let client = reqwest::Client::new();
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
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
                    }
                    Err(e) => json!({"error": format!("Apollo request failed: {}", e)}).to_string(),
                }
            } else {
                json!({
                    "error": "No Apollo credential configured. Add an Apollo API key to enable contact search.",
                    "fallback_mock": true,
                    "company": company,
                    "contacts": [
                        {"name": "Sarah Chen", "title": "VP Sales", "email": "sarah@example.com"},
                        {"name": "Marcus Williams", "title": "Head of Growth", "email": "marcus@example.com"}
                    ]
                }).to_string()
            }
        }

        "read_crm_contact" => {
            let identifier = input.get("identifier").and_then(Value::as_str).unwrap_or("");
            if let Some(cred) = credentials.get("hubspot") {
                let token = if cred.credential_type == "oauth2" {
                    serde_json::from_str::<Value>(&cred.value).ok()
                        .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                        .unwrap_or_else(|| cred.value.clone())
                } else { cred.value.clone() };

                let client = reqwest::Client::new();
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
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
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
                let token = if cred.credential_type == "oauth2" {
                    serde_json::from_str::<Value>(&cred.value).ok()
                        .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                        .unwrap_or_else(|| cred.value.clone())
                } else { cred.value.clone() };

                let client = reqwest::Client::new();
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
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
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
                let token = if cred.credential_type == "oauth2" {
                    serde_json::from_str::<Value>(&cred.value).ok()
                        .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                        .unwrap_or_else(|| cred.value.clone())
                } else { cred.value.clone() };

                let client = reqwest::Client::new();
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
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
                    }
                    Err(e) => json!({"error": format!("HubSpot request failed: {}", e)}).to_string(),
                }
            } else {
                json!({"error": "No HubSpot credential configured. Connect HubSpot in integration settings."}).to_string()
            }
        }

        "fetch_email_analytics" => {
            if let Some(cred) = credentials.get("hubspot") {
                let token = if cred.credential_type == "oauth2" {
                    serde_json::from_str::<Value>(&cred.value).ok()
                        .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                        .unwrap_or_else(|| cred.value.clone())
                } else { cred.value.clone() };

                let client = reqwest::Client::new();
                match client.get("https://api.hubapi.com/marketing-emails/v1/emails/with-statistics")
                    .header("Authorization", format!("Bearer {token}"))
                    .query(&[("limit", "10")])
                    .send().await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let body = resp.text().await.unwrap_or_default();
                        let preview: String = body.chars().take(settings.http_response_max_chars).collect();
                        json!({"status": status, "data": serde_json::from_str::<Value>(&preview).unwrap_or(json!(preview))}).to_string()
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

        "search_knowledge" => {
            json!({"error": "search_knowledge is handled by agent_runner, not execute_action"}).to_string()
        }

        "web_search" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");

            let api_key = credentials.get("tavily")
                .map(|c| c.value.clone())
                .or_else(|| settings.tavily_api_key.clone());

            if let Some(key) = api_key {
                let client = reqwest::Client::new();
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
                "platform": "all",
                "metrics": {
                    "impressions": 45000,
                    "clicks": 1200,
                    "ctr": 2.67,
                    "cpc": 4.20,
                    "conversions": 48,
                    "cpa": 105.00,
                    "roas": 3.2
                },
                "top_performing_ad": "Your recent funding round ad copy variant B"
            }).to_string()
        }

        "meta_ads_api" | "google_ads_api" => {
            let action = input.get("action").and_then(Value::as_str).unwrap_or("create");
            json!({
                "success": true,
                "action": action,
                "id": format!("mock_{}", uuid::Uuid::new_v4()),
                "status": "active",
                "note": "Mock response — Phase 0. Real API integration in Phase 3."
            }).to_string()
        }

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
                        let token = if cred.credential_type == "oauth2" {
                            serde_json::from_str::<Value>(&cred.value).ok()
                                .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| cred.value.clone())
                        } else { cred.value.clone() };
                        request = request.header("Authorization", format!("Bearer {token}"));
                    }
                } else if url.contains("api.notion.com") {
                    if let Some(cred) = credentials.get("notion") {
                        let token = if cred.credential_type == "oauth2" {
                            serde_json::from_str::<Value>(&cred.value).ok()
                                .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| cred.value.clone())
                        } else { cred.value.clone() };
                        request = request.header("Authorization", format!("Bearer {token}"));
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
                } else if url.contains(".n8n.cloud") || url.contains("n8n.") || url.contains("/api/v1/workflows") || url.contains("/api/v1/executions") || url.contains("/api/v1/credentials") || settings.n8n_base_url.as_deref().map_or(false, |base| url.starts_with(base)) {
                    let api_key = credentials.get("n8n")
                        .map(|cred| {
                            serde_json::from_str::<Value>(&cred.value).ok()
                                .and_then(|v| v.get("api_key").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| cred.value.clone())
                        })
                        .or_else(|| settings.n8n_api_key.clone());
                    if let Some(key) = api_key {
                        request = request.header("X-N8N-API-KEY", &key);
                    }
                } else if url.contains("graph.facebook.com") {
                    if let Some(cred) = credentials.get("meta") {
                        let token = if cred.credential_type == "oauth2" {
                            serde_json::from_str::<Value>(&cred.value).ok()
                                .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| cred.value.clone())
                        } else { cred.value.clone() };
                        request = request.header("Authorization", format!("Bearer {token}"));
                    }
                } else if url.contains("googleapis.com") {
                    if let Some(cred) = credentials.get("google") {
                        let token = if cred.credential_type == "oauth2" {
                            serde_json::from_str::<Value>(&cred.value).ok()
                                .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| cred.value.clone())
                        } else { cred.value.clone() };
                        request = request.header("Authorization", format!("Bearer {token}"));
                    }
                } else if url.contains("slack.com/api") {
                    if let Some(cred) = credentials.get("slack") {
                        let token = if cred.credential_type == "oauth2" {
                            serde_json::from_str::<Value>(&cred.value).ok()
                                .and_then(|v| v.get("access_token").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| cred.value.clone())
                        } else { cred.value.clone() };
                        request = request.header("Authorization", format!("Bearer {token}"));
                    }
                } else if url.contains("api.apollo.io") {
                    if let Some(cred) = credentials.get("apollo") {
                        request = request.header("x-api-key", &cred.value);
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
                    }
                    json!({
                        "status": status,
                        "body": body_preview,
                    }).to_string()
                }
                Err(e) => {
                    tracing::error!(%method, %url, error = %e, "http_request failed");
                    json!({"error": format!("HTTP request failed: {}", e)}).to_string()
                }
            }
        }

        _ => {
            json!({"error": format!("Unknown tool: {}", name), "note": "This tool may not be implemented yet in Phase 0"}).to_string()
        }
    }
}
