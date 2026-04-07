import type {
  SessionWithNodes,
  CreateExecutionResponse,
  StreamEntry,
} from "./types.js";

export class LeleApiClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Lele API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  async submitRequest(
    requestText: string,
    opts?: {
      clientSlug?: string;
      model?: string;
      projectSlug?: string;
      expertId?: string;
    }
  ): Promise<CreateExecutionResponse> {
    return this.request<CreateExecutionResponse>("POST", "/api/execute", {
      request_text: requestText,
      mode: "orchestrated",
      client_slug: opts?.clientSlug,
      model: opts?.model,
      project_slug: opts?.projectSlug,
      expert_id: opts?.expertId,
    });
  }

  async getSession(sessionId: string): Promise<SessionWithNodes> {
    return this.request<SessionWithNodes>("GET", `/api/execute/${sessionId}`);
  }

  async approvePlan(sessionId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      "POST",
      `/api/execute/${sessionId}/approve`
    );
  }

  async stopExecution(sessionId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      "POST",
      `/api/execute/${sessionId}/stop`
    );
  }

  async getNodeStream(
    sessionId: string,
    nodeId: string
  ): Promise<{ stream: StreamEntry[] }> {
    return this.request<{ stream: StreamEntry[] }>(
      "GET",
      `/api/execute/${sessionId}/nodes/${nodeId}/stream`
    );
  }

  async replyToNode(
    sessionId: string,
    nodeId: string,
    message: string
  ): Promise<unknown> {
    return this.request("POST", `/api/execute/${sessionId}/nodes/${nodeId}/reply`, {
      message,
    });
  }

  async sessionChat(sessionId: string, message: string): Promise<unknown> {
    return this.request("POST", `/api/execute/${sessionId}/chat`, { message });
  }

  async listSessions(limit = 10): Promise<unknown> {
    return this.request("GET", `/api/execute/sessions?limit=${limit}`);
  }
}
