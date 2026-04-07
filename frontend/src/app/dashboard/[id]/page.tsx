"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { DashboardRenderer, type DashboardSpec } from "@/components/dashboard-renderer";

export default function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  const { apiFetch, token } = useAuth();
  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !id) return;

    async function loadDashboard() {
      try {
        const res = await apiFetch(`/api/execute/nodes/${id}`);
        if (!res.ok) throw new Error(`Failed to load node: ${res.statusText}`);
        const data = await res.json();

        const node = data.node ?? data;
        const artifacts = node.artifacts ?? [];
        const output = node.output ?? {};

        const dashSpec = artifacts.find(
          (a: Record<string, unknown>) => a.type === "dashboard_spec"
        );
        if (dashSpec?.spec) {
          setSpec(dashSpec.spec as DashboardSpec);
          return;
        }

        if (output.dashboard_spec) {
          setSpec(output.dashboard_spec as DashboardSpec);
          return;
        }

        if (output.result?.dashboard_spec) {
          setSpec(output.result.dashboard_spec as DashboardSpec);
          return;
        }

        setError("No dashboard specification found in this node's output.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        setLoading(false);
      }
    }

    loadDashboard();
  }, [id, token, apiFetch]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin h-8 w-8 rounded-full border-2 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center max-w-lg">
          <p className="text-red-700 font-medium">Dashboard Error</p>
          <p className="mt-2 text-sm text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!spec) return null;

  return <DashboardRenderer spec={spec} />;
}
