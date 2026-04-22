export interface Session {
  id: string;
  status: string;
  request_text: string;
  plan: unknown;
  plan_approved_at: string | null;
  created_at: string;
  completed_at: string | null;
  project_id: string | null;
  project_description_id: string | null;
}

export interface ExecutionNode {
  id: string;
  agent_slug: string;
  task_description: string;
  status: string;
  requires: string[];
  judge_score: number | null;
  judge_feedback: string | null;
  output: string | null;
  parent_uid: string | null;
  depth: number;
  description: string | null;
  started_at: string | null;
  completed_at: string | null;
  artifacts: unknown;
  acceptance_criteria: string | null;
  error_category: string | null;
}

export interface SessionWithNodes {
  session: Session;
  nodes: ExecutionNode[];
}

export interface CreateExecutionResponse {
  session_id: string;
  plan: unknown;
  node_count: number;
}

export interface StreamEntry {
  id: string;
  node_id: string;
  stream_type: "event" | "thinking" | "message";
  sub_type: string;
  content: string | null;
  thinking_text: string | null;
  role: string | null;
  created_at: string;
}

export interface AgentInfo {
  slug: string;
  name: string;
  description: string;
  intents: string[];
  automation_mode: string;
  required_integrations: string[];
}
