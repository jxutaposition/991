"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  Database,
  Play,
  RefreshCw,
  Table2,
  Eye,
  ChevronRight,
  X,
} from "lucide-react";

interface TableInfo {
  schema: string;
  table_name: string;
  row_count: number;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  sql: string;
  error?: string;
}

function formatRowCount(n: number): string {
  if (n < 0) return "view";
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncateCell(value: unknown, max: number = 120): string {
  if (value === null || value === undefined) return "null";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return str.length > max ? str.slice(0, max) + "\u2026" : str;
}

function prettyPrint(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export default function DataViewerPage() {
  const { apiFetch } = useAuth();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [sql, setSql] = useState("SELECT * FROM live_events ORDER BY created_at DESC LIMIT 50");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [selectedCell, setSelectedCell] = useState<{ col: string; value: unknown } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const autoRefreshRef = useRef(autoRefresh);
  const sqlRef = useRef(sql);

  // Keep refs in sync
  autoRefreshRef.current = autoRefresh;
  sqlRef.current = sql;

  // Load table list
  useEffect(() => {
    apiFetch("/api/data/schemas")
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data) => {
        const sorted = (data.tables ?? []).sort((a: TableInfo, b: TableInfo) => {
          // Tables with rows first, then views, then alphabetical
          if (a.row_count >= 0 && b.row_count < 0) return -1;
          if (a.row_count < 0 && b.row_count >= 0) return 1;
          return a.table_name.localeCompare(b.table_name);
        });
        setTables(sorted);
        setTablesLoading(false);
      })
      .catch((err) => { console.error("Failed to load tables:", err); setTablesLoading(false); });
  }, []);

  const executeQuery = useCallback(async (queryStr?: string) => {
    const q = queryStr ?? sqlRef.current;
    if (!q.trim()) return;
    setQueryLoading(true);
    try {
      const res = await apiFetch("/api/data/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: q }),
      });
      if (!res.ok) throw new Error(`Query failed: ${res.statusText}`);
      const data = await res.json();
      setResult(data);
      setLastRefresh(new Date());
    } catch (e) {
      setResult({
        columns: [],
        rows: [],
        row_count: 0,
        sql: q,
        error: e instanceof Error ? e.message : "Request failed",
      });
    }
    setQueryLoading(false);
  }, []);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (autoRefreshRef.current) {
        executeQuery();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, executeQuery]);

  const handleTableClick = (tableName: string) => {
    const newSql = `SELECT * FROM ${tableName} LIMIT 100`;
    setSql(newSql);
    executeQuery(newSql);
    setSelectedCell(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      executeQuery();
    }
    // Tab inserts 2 spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newVal = sql.substring(0, start) + "  " + sql.substring(end);
      setSql(newVal);
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  };

  return (
    <div className="flex h-screen">
      {/* Left: Table Browser */}
      <div className="w-56 shrink-0 border-r border-rim bg-page overflow-y-auto">
        <div className="p-3 border-b border-rim">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink-2 uppercase tracking-wider">
            <Database className="w-3.5 h-3.5" />
            Tables
          </div>
        </div>
        {tablesLoading ? (
          <p className="p-3 text-xs text-ink-3">Loading...</p>
        ) : (
          <div className="py-1">
            {tables.map((t) => (
              <button
                key={t.table_name}
                onClick={() => handleTableClick(t.table_name)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface transition-colors group"
              >
                {t.row_count < 0 ? (
                  <Eye className="w-3 h-3 text-purple-400 shrink-0" />
                ) : (
                  <Table2 className="w-3 h-3 text-ink-3 shrink-0" />
                )}
                <span className="text-xs text-ink truncate flex-1 group-hover:text-brand">
                  {t.table_name}
                </span>
                <span className="text-xs text-ink-3 font-mono shrink-0">
                  {formatRowCount(t.row_count)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: Editor + Results */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* SQL Editor */}
        <div className="border-b border-rim bg-page shrink-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-rim">
            <button
              onClick={() => executeQuery()}
              disabled={queryLoading}
              className="flex items-center gap-1.5 bg-brand text-white px-3 py-1 rounded text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              <Play className="w-3 h-3" />
              {queryLoading ? "Running..." : "Run"}
            </button>
            <span className="text-xs text-ink-3">Ctrl+Enter</span>
            <div className="flex-1" />
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                autoRefresh
                  ? "bg-green-100 text-green-700 hover:bg-green-200"
                  : "bg-surface text-ink-3 hover:text-ink-2"
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${autoRefresh ? "animate-spin" : ""}`} />
              {autoRefresh ? "Auto: ON (5s)" : "Auto: OFF"}
            </button>
            {lastRefresh && (
              <span className="text-xs text-ink-3">
                {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </div>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={4}
            spellCheck={false}
            className="w-full bg-page text-ink font-mono text-xs px-3 py-2 resize-none focus:outline-none leading-relaxed"
            placeholder="SELECT * FROM live_events ORDER BY created_at DESC LIMIT 50"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-auto min-h-0">
          {result?.error && (
            <div className="m-3 p-3 bg-red-50 border border-red-200 rounded-lg">
              <pre className="text-xs text-red-700 whitespace-pre-wrap font-mono">{result.error}</pre>
            </div>
          )}

          {result && !result.error && result.rows.length === 0 && (
            <div className="p-8 text-center text-ink-3 text-sm">
              No rows returned.
            </div>
          )}

          {result && result.rows.length > 0 && (
            <div className="overflow-auto">
              <table className="w-full text-xs font-mono border-collapse">
                <thead>
                  <tr className="sticky top-0 bg-surface z-10 border-b border-rim">
                    <th className="px-3 py-2 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider w-8">
                      #
                    </th>
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        className="px-3 py-2 text-left text-xs font-semibold text-ink-3 uppercase tracking-wider whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr
                      key={i}
                      className={`border-b border-rim/50 hover:bg-surface/50 ${
                        i % 2 === 0 ? "" : "bg-surface/30"
                      }`}
                    >
                      <td className="px-3 py-1.5 text-ink-3">{i + 1}</td>
                      {result.columns.map((col) => (
                        <td
                          key={col}
                          onClick={() => setSelectedCell({ col, value: row[col] })}
                          className="px-3 py-1.5 text-ink max-w-[280px] truncate cursor-pointer hover:bg-brand/5"
                          title="Click to inspect"
                        >
                          {row[col] === null ? (
                            <span className="text-ink-3 italic">null</span>
                          ) : (
                            truncateCell(row[col])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3 py-2 text-xs text-ink-3 border-t border-rim bg-surface sticky bottom-0">
                {result.row_count} row{result.row_count !== 1 ? "s" : ""} returned
              </div>
            </div>
          )}

          {!result && (
            <div className="p-8 text-center text-ink-3 text-sm">
              <Database className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p>Click a table or write SQL and press Ctrl+Enter</p>
            </div>
          )}
        </div>

        {/* Cell Inspector */}
        {selectedCell && (
          <div className="border-t border-rim bg-page shrink-0 max-h-60 overflow-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-rim">
              <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                <ChevronRight className="w-3 h-3 inline mr-1" />
                {selectedCell.col}
              </span>
              <button
                onClick={() => setSelectedCell(null)}
                className="text-ink-3 hover:text-ink"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <pre className="px-3 py-2 text-xs font-mono text-ink whitespace-pre-wrap leading-relaxed">
              {prettyPrint(selectedCell.value)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
