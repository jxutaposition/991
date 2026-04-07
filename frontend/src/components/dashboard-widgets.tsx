"use client";

import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  FunnelChart, Funnel, LabelList,
  AreaChart, Area,
} from "recharts";

const COLORS = [
  "#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd",
  "#818cf8", "#4f46e5", "#7c3aed", "#5b21b6",
  "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8",
];

export interface WidgetSpec {
  id: string;
  type: "stat" | "stats" | "bar" | "line" | "pie" | "funnel" | "area" | "table" | "text";
  title: string;
  span?: number; // grid column span (1-4, default 1)
  config?: Record<string, unknown>;
  data?: unknown[];
  value?: string | number;
  description?: string;
  cards?: Array<{ id?: string; title: string; value: string | number; description?: string; trend?: string }>;
}

export function StatWidget({ spec }: { spec: WidgetSpec }) {
  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
        {spec.value ?? "—"}
      </p>
      {spec.description && (
        <p className="mt-1 text-sm text-zinc-500">{spec.description}</p>
      )}
    </div>
  );
}

export function BarWidget({ spec }: { spec: WidgetSpec }) {
  const data = (spec.data ?? []) as Record<string, unknown>[];
  const cfg = spec.config ?? {};
  const xKey = (cfg.xKey as string) ?? "name";
  const yKeys = (cfg.yKeys as string[]) ?? (data.length > 0
    ? Object.keys(data[0]).filter(k => k !== xKey && typeof data[0][k] === "number")
    : ["value"]);

  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          {yKeys.map((key, i) => (
            <Bar key={key} dataKey={key} fill={COLORS[i % COLORS.length]} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LineWidget({ spec }: { spec: WidgetSpec }) {
  const data = (spec.data ?? []) as Record<string, unknown>[];
  const cfg = spec.config ?? {};
  const xKey = (cfg.xKey as string) ?? "name";
  const yKeys = (cfg.yKeys as string[]) ?? (data.length > 0
    ? Object.keys(data[0]).filter(k => k !== xKey && typeof data[0][k] === "number")
    : ["value"]);

  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          {yKeys.map((key, i) => (
            <Line key={key} type="monotone" dataKey={key} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AreaWidget({ spec }: { spec: WidgetSpec }) {
  const data = (spec.data ?? []) as Record<string, unknown>[];
  const cfg = spec.config ?? {};
  const xKey = (cfg.xKey as string) ?? "name";
  const yKeys = (cfg.yKeys as string[]) ?? (data.length > 0
    ? Object.keys(data[0]).filter(k => k !== xKey && typeof data[0][k] === "number")
    : ["value"]);

  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          {yKeys.map((key, i) => (
            <Area key={key} type="monotone" dataKey={key} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.15} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PieWidget({ spec }: { spec: WidgetSpec }) {
  const data = (spec.data ?? []) as Record<string, unknown>[];
  const cfg = spec.config ?? {};
  const nameKey = (cfg.nameKey as string) ?? "name";
  const valueKey = (cfg.valueKey as string) ?? "value";

  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={data} dataKey={valueKey} nameKey={nameKey} cx="50%" cy="50%"
            outerRadius={100} label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`}
            labelLine={false} fontSize={11}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FunnelWidget({ spec }: { spec: WidgetSpec }) {
  const data = (spec.data ?? []) as Record<string, unknown>[];
  const cfg = spec.config ?? {};
  const nameKey = (cfg.nameKey as string) ?? "name";
  const valueKey = (cfg.valueKey as string) ?? "value";

  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <ResponsiveContainer width="100%" height={280}>
        <FunnelChart>
          <Tooltip />
          <Funnel dataKey={valueKey} nameKey={nameKey} data={data} isAnimationActive>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
            <LabelList position="right" fill="#374151" stroke="none" dataKey={nameKey} fontSize={12} />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TableWidget({ spec }: { spec: WidgetSpec }) {
  const data = (spec.data ?? []) as Record<string, unknown>[];
  if (data.length === 0) {
    return (
      <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
        <p className="text-sm font-medium text-zinc-500">{spec.title}</p>
        <p className="mt-4 text-sm text-zinc-400">No data</p>
      </div>
    );
  }
  const columns = Object.keys(data[0]);

  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm overflow-x-auto">
      <p className="mb-4 text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            {columns.map(col => (
              <th key={col} className="py-2 px-3 text-left font-medium text-zinc-600 dark:text-zinc-300">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 50).map((row, i) => (
            <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800">
              {columns.map(col => (
                <td key={col} className="py-2 px-3 text-zinc-700 dark:text-zinc-300">{String(row[col] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > 50 && (
        <p className="mt-2 text-xs text-zinc-400">Showing 50 of {data.length} rows</p>
      )}
    </div>
  );
}

export function TextWidget({ spec }: { spec: WidgetSpec }) {
  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-6 shadow-sm">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{spec.title}</p>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{spec.description ?? ""}</p>
    </div>
  );
}

function StatsWidget({ spec }: { spec: WidgetSpec }) {
  const cards = spec.cards ?? [];
  return (
    <div className="rounded-xl border bg-white dark:bg-zinc-900 p-4 shadow-sm">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">{spec.title}</p>
      <div className="grid grid-cols-2 gap-3">
        {cards.map((card, idx) => (
          <div key={card.id ?? idx} className="rounded-lg bg-zinc-50 dark:bg-zinc-800 p-3">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{card.title}</p>
            <p className="text-xl font-bold text-zinc-900 dark:text-zinc-50 mt-1">{card.value}</p>
            {card.description && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">{card.description}</p>
            )}
            {card.trend && (
              <p className="text-xs text-indigo-500 font-medium mt-0.5">{card.trend}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardWidget({ spec }: { spec: WidgetSpec }) {
  switch (spec.type) {
    case "stat": return <StatWidget spec={spec} />;
    case "stats": return <StatsWidget spec={spec} />;
    case "bar": return <BarWidget spec={spec} />;
    case "line": return <LineWidget spec={spec} />;
    case "area": return <AreaWidget spec={spec} />;
    case "pie": return <PieWidget spec={spec} />;
    case "funnel": return <FunnelWidget spec={spec} />;
    case "table": return <TableWidget spec={spec} />;
    case "text": return <TextWidget spec={spec} />;
    default: return <TextWidget spec={{ ...spec, description: `Unknown widget type: ${spec.type}` }} />;
  }
}
