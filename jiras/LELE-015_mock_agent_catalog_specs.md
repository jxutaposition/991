# LELE-015: Mock Agent Catalog — MVP0 Specifications

## Purpose
The 20 mock agents in `backend/agents/` constitute the MVP0 catalog. This jira tracks the spec requirements for each agent to ensure the demo scenarios work end-to-end.

## Catalog Completeness Checklist

Each agent must have all of the following before MVP0 is complete:

| File | Required | Notes |
|------|----------|-------|
| `agent.toml` | ✅ | slug, name, category, intents, max_iterations, skip_judge |
| `prompt.md` | ✅ | 300+ words of real GTM heuristics — not placeholder |
| `tools.toml` | ✅ | Subset of global tool library |
| `judge_config.toml` | ✅ | threshold, rubric (3-6 items), need_to_know (1-3 items) |
| `input_schema.json` | ✅ | JSON Schema with required fields and descriptions |
| `output_schema.json` | ✅ | JSON Schema that documents what downstream agents receive |
| `examples/example_001.json` | ✅ | `{input: {...}, output: "..."}` — realistic content |
| `examples/example_002.json` | ✅ | Second example with different scenario |

## Agent Coverage by Category

### Research (4 agents)
- [x] icp_builder — intent: "build ideal customer profile", output: structured ICP with tier breakdown
- [x] company_researcher — intent: "research company", output: brief with triggers + hooks
- [x] contact_finder — intent: "find contacts", output: ranked contact list with LinkedIn URLs
- [x] competitor_analyzer — intent: "competitor analysis", output: competitive map + displacement angles

### Lead Management (3 agents)
- [x] lead_scorer — intent: "score leads", output: scored list with tier assignments
- [x] lead_list_builder — intent: "build lead list", output: ranked prospect list
- [x] crm_updater — intent: "update CRM", output: write confirmation, skip_judge=true

### Email Outreach (3 agents)
- [x] cold_email_writer — intent: "cold email", output: subject + body + word count
- [x] subject_line_optimizer — intent: "optimize subject line", output: ranked variants with scores
- [x] follow_up_sequence_builder — intent: "follow up sequence", output: 3-5 touch sequence

### Social / Direct (3 agents)
- [x] linkedin_message_writer — intent: "linkedin message", output: connection request + InMail
- [x] call_script_preparer — intent: "call script", output: agenda + discovery Qs + objection handling
- [x] meeting_prep_agent — intent: "meeting prep", output: full pre-meeting brief

### Content & Creative (3 agents)
- [x] creative_brief_generator — intent: "creative brief", output: full campaign brief
- [x] ad_copy_writer — intent: "ad copy", output: Meta + Google variants across 4 angles
- [x] landing_page_copy_writer — intent: "landing page", output: full page copy structure

### Advertising (2 agents)
- [x] meta_ads_campaign_builder — intent: "meta ads campaign", output: full campaign structure
- [x] google_ads_campaign_builder — intent: "google ads campaign", output: full campaign structure

### Analytics (2 agents)
- [x] campaign_performance_analyzer — intent: "campaign performance", output: analysis + recommendations
- [x] outreach_results_reporter — intent: "outreach results", output: report + red flags + recommendations

## Demo Scenario Agent Coverage

### Scenario A (9 agents, linear):
icp_builder → company_researcher → contact_finder → lead_scorer → lead_list_builder → cold_email_writer → subject_line_optimizer → follow_up_sequence_builder → crm_updater

### Scenario B (7 agents, branching parallel):
icp_builder → creative_brief_generator → ad_copy_writer → [meta_ads_campaign_builder ‖ google_ads_campaign_builder] → campaign_performance_analyzer → crm_updater

### Scenario C (7 agents, parallel converging):
contact_finder → lead_scorer → [cold_email_writer ‖ linkedin_message_writer] → follow_up_sequence_builder → crm_updater

### Scenario D (7 agents, fan-in analysis):
[outreach_results_reporter ‖ campaign_performance_analyzer] → competitor_analyzer → icp_builder → creative_brief_generator → ad_copy_writer

## Acceptance Criteria
- [ ] All 20 agents pass `AgentCatalog::load_from_disk()` without errors
- [ ] All agents have at least 2 examples with realistic, non-placeholder content
- [ ] `catalog_summary()` output is under 4000 tokens (for planner injection)
- [ ] Planner correctly identifies all 4 demo scenario DAGs from natural language request
- [ ] All input_schema.json and output_schema.json files are valid JSON Schema
