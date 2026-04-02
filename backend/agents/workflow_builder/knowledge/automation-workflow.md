# Use Case: Automation / Workflow

**Tools:** http_request, web_search, fetch_url for API-driven automation

Handles execution only. Planning is handled upstream before this file is reached.

---

## What this covers

Any change request in Clay, Tolt, Notion, n8n, Lovable, or Typeform. Anything that writes to an external tool.

---

## Execution

### 1. Before any API call

Check knowledge docs and upstream context for API reference information. Get credentials from the system — they are auto-injected based on required_integrations.

### 2. Tool-specific approach

All tool operations use the `http_request` tool to interact with REST APIs:
- **Clay:** Use Clay REST API for table operations, column creation, row management
- **n8n:** Use n8n REST API for workflow CRUD, node configuration, execution
- **Notion:** Use Notion API for page/database/block operations
- **Other tools:** Use their respective REST APIs via http_request

Before designing any table structure, workflow, or integration:
- Read relevant knowledge docs for the tool
- Design against known constraints before executing
- Document any workarounds discovered during execution

### 3. Execute

Run the task via API calls. If anything errors mid-execution: read the error response, diagnose, and retry with a corrected approach. Document persistent failures as blockers.

### 4. Produce

Call `write_output` with outcome summary, resource IDs created, and any issues encountered.
