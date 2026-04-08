"use client";

import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WidgetDataSource {
  table: string;
  select?: string;
  filters?: Record<string, string>;
  orderBy?: string;
  limit?: number;
  /** Client-side aggregate for stat widgets. */
  aggregate?: "count" | "sum" | "avg" | "min" | "max";
  aggregateColumn?: string;
}

interface DashboardDataContextValue {
  supabase: SupabaseClient | null;
  refreshInterval: number;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const DashboardDataContext = createContext<DashboardDataContextValue>({
  supabase: null,
  refreshInterval: 0,
});

export function DashboardDataProvider({
  supabaseUrl,
  supabaseAnonKey,
  refreshInterval = 0,
  children,
}: {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  refreshInterval?: number;
  children: ReactNode;
}) {
  const supabase = useMemo(() => {
    if (supabaseUrl && supabaseAnonKey) {
      return createClient(supabaseUrl, supabaseAnonKey);
    }
    return null;
  }, [supabaseUrl, supabaseAnonKey]);

  const value = useMemo(
    () => ({ supabase, refreshInterval }),
    [supabase, refreshInterval],
  );

  return (
    <DashboardDataContext.Provider value={value}>
      {children}
    </DashboardDataContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface WidgetDataResult {
  data: unknown[];
  value: string | number | null;
  loading: boolean;
  error: string | null;
}

function computeAggregate(
  rows: Record<string, unknown>[],
  aggregate: WidgetDataSource["aggregate"],
  column?: string,
): string | number | null {
  if (!aggregate) return null;
  if (aggregate === "count") return rows.length;
  if (!column) return null;

  const nums = rows
    .map((r) => Number(r[column]))
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return null;

  switch (aggregate) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    default:
      return null;
  }
}

/**
 * Fetches widget data from Supabase when a `dataSource` is present, otherwise
 * falls back to the static `data` / `value` embedded in the spec.
 */
export function useWidgetData(spec: {
  data?: unknown[];
  value?: string | number;
  dataSource?: WidgetDataSource;
}): WidgetDataResult {
  const { supabase, refreshInterval } = useContext(DashboardDataContext);
  const { dataSource } = spec;

  const [data, setData] = useState<unknown[]>(spec.data ?? []);
  const [value, setValue] = useState<string | number | null>(spec.value ?? null);
  const [loading, setLoading] = useState(!!dataSource && !!supabase);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!dataSource || !supabase) return;

    try {
      let query = supabase
        .from(dataSource.table)
        .select(dataSource.select ?? "*");

      if (dataSource.filters) {
        for (const [col, expr] of Object.entries(dataSource.filters)) {
          const dotIdx = expr.indexOf(".");
          if (dotIdx === -1) continue;
          const op = expr.slice(0, dotIdx);
          const val = expr.slice(dotIdx + 1);
          switch (op) {
            case "eq": query = query.eq(col, val); break;
            case "neq": query = query.neq(col, val); break;
            case "gt": query = query.gt(col, Number(val) || val); break;
            case "gte": query = query.gte(col, Number(val) || val); break;
            case "lt": query = query.lt(col, Number(val) || val); break;
            case "lte": query = query.lte(col, Number(val) || val); break;
            case "in": {
              const items = val.replace(/^\(|\)$/g, "").split(",");
              query = query.in(col, items);
              break;
            }
            case "is":
              query = query.is(col, val === "null" ? null : val);
              break;
            case "ilike": query = query.ilike(col, val); break;
            case "like": query = query.like(col, val); break;
          }
        }
      }

      if (dataSource.orderBy) {
        const parts = dataSource.orderBy.split(".");
        query = query.order(parts[0], { ascending: parts[1] !== "desc" });
      }

      if (dataSource.limit) {
        query = query.limit(dataSource.limit);
      }

      const { data: rows, error: fetchErr } = await query;

      if (fetchErr) {
        setError(fetchErr.message);
        if (spec.data?.length) setData(spec.data);
        return;
      }

      const result = (rows ?? []) as unknown as Record<string, unknown>[];
      setData(result);
      setError(null);

      if (dataSource.aggregate) {
        const agg = computeAggregate(result, dataSource.aggregate, dataSource.aggregateColumn);
        if (agg !== null) setValue(agg);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
      if (spec.data?.length) setData(spec.data);
    } finally {
      setLoading(false);
    }
  }, [dataSource, supabase, spec.data]);

  useEffect(() => {
    if (!dataSource || !supabase) {
      setData(spec.data ?? []);
      setValue(spec.value ?? null);
      setLoading(false);
      return;
    }

    fetchData();

    if (refreshInterval > 0) {
      const timer = setInterval(fetchData, refreshInterval * 1000);
      return () => clearInterval(timer);
    }
  }, [dataSource, supabase, refreshInterval, fetchData, spec.data, spec.value]);

  return { data, value, loading, error };
}
