/// GTM tool definitions for the agent executor.
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
pub fn all_tool_defs() -> Vec<ToolDef> {
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
        },
        ToolDef {
            name: "write_output".to_string(),
            description: "Write this agent's final structured output. Call once when the task is complete.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "result": {"type": "object", "description": "The structured output matching this agent's output_schema"},
                    "summary": {"type": "string", "description": "Human-readable summary of what was produced"}
                },
                "required": ["result", "summary"]
            }),
        },
        ToolDef {
            name: "spawn_agent".to_string(),
            description: "Spawn a child agent to handle a sub-task. The child agent runs synchronously and returns its output inline. Use only when needed for dynamic sub-tasks not covered by the pre-planned nodes.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "agent_slug": {"type": "string", "description": "Slug of the agent to spawn"},
                    "task_description": {"type": "string", "description": "Specific task for the child agent"}
                },
                "required": ["agent_slug", "task_description"]
            }),
        },
    ]
}

/// Return tool definitions for a specific agent based on its tools list.
/// Always includes the internal orchestration tools.
pub fn tools_for_agent(agent_tools: &[String], include_spawn: bool) -> Vec<ToolDef> {
    let all = all_tool_defs();

    // Internal tools always available
    let always_available = ["read_upstream_output", "write_output"];

    all.into_iter()
        .filter(|t| {
            agent_tools.contains(&t.name)
                || always_available.contains(&t.name.as_str())
                || (include_spawn && t.name == "spawn_agent")
        })
        .collect()
}

// ── Tool execution (Phase 0: mock responses) ──────────────────────────────────

/// Execute a tool call and return the result as a JSON string.
/// Phase 0: Returns realistic mock data for all GTM tools.
/// Phase 1+: Calls real integrations.
pub async fn execute_tool(
    name: &str,
    input: &Value,
    session_id: &str,
    node_outputs: &std::collections::HashMap<String, Value>,
) -> String {
    info!(tool = %name, "executing tool");

    match name {
        "search_linkedin_profile" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            json!({
                "name": "Alex Johnson",
                "title": "VP of Sales",
                "company": "Acme Corp",
                "location": "San Francisco, CA",
                "summary": "10 years building sales teams at high-growth SaaS companies",
                "recent_posts": ["Posted about Q3 pipeline strategies", "Shared article on outbound best practices"]
            }).to_string()
        }

        "fetch_company_news" => {
            let domain = input.get("domain").and_then(Value::as_str).unwrap_or("");
            json!({
                "domain": domain,
                "articles": [
                    {"title": "Company raises $15M Series A", "date": "2025-11-15", "summary": "Led by Sequoia, funding to accelerate GTM expansion"},
                    {"title": "Launches new enterprise product tier", "date": "2025-10-28", "summary": "Targeting companies with 200+ employees"}
                ]
            }).to_string()
        }

        "search_company_data" => {
            let company = input.get("company_name").and_then(Value::as_str).unwrap_or("Unknown");
            json!({
                "company": company,
                "employees": 120,
                "founded": 2019,
                "funding": "$18M total (Series A)",
                "tech_stack": ["Salesforce", "HubSpot", "Segment", "AWS"],
                "industry": "B2B SaaS",
                "hq": "San Francisco, CA",
                "growth_yoy": "45%"
            }).to_string()
        }

        "find_contacts" => {
            let company = input.get("company_name").and_then(Value::as_str).unwrap_or("Unknown");
            json!({
                "company": company,
                "contacts": [
                    {"name": "Sarah Chen", "title": "VP Sales", "email": "sarah@example.com", "linkedin": "linkedin.com/in/sarahchen"},
                    {"name": "Marcus Williams", "title": "Head of Growth", "email": "marcus@example.com", "linkedin": "linkedin.com/in/marcuswilliams"}
                ]
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

        "web_search" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            json!({
                "results": [
                    {"title": format!("Search result for: {}", query), "url": "https://example.com/1", "snippet": "Relevant information about the search query..."},
                    {"title": "Additional context", "url": "https://example.com/2", "snippet": "More details about the topic..."}
                ]
            }).to_string()
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

        _ => {
            json!({"error": format!("Unknown tool: {}", name), "note": "This tool may not be implemented yet in Phase 0"}).to_string()
        }
    }
}
