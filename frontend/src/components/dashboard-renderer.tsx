"use client";

import { DashboardWidget, type WidgetSpec } from "./dashboard-widgets";
import { DashboardDataProvider } from "@/lib/dashboard-data";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export interface DashboardView {
  id: string;
  label: string;
  widgets: WidgetSpec[];
}

export interface DashboardSpec {
  title: string;
  description?: string;
  widgets: WidgetSpec[];
  views?: DashboardView[];
  refreshInterval?: number;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

function WidgetGrid({ widgets }: { widgets: WidgetSpec[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {widgets.map((widget) => {
        const span = Math.min(Math.max(widget.span ?? 1, 1), 4);
        const spanClass = span === 4 ? "sm:col-span-2 lg:col-span-4"
          : span === 3 ? "sm:col-span-2 lg:col-span-3"
          : span === 2 ? "sm:col-span-2"
          : "";
        return (
          <div key={widget.id} className={spanClass}>
            <DashboardWidget spec={widget} />
          </div>
        );
      })}
    </div>
  );
}

export function DashboardRenderer({ spec }: { spec: DashboardSpec }) {
  const hasViews = spec.views && spec.views.length > 0;

  return (
    <DashboardDataProvider
      supabaseUrl={spec.supabaseUrl}
      supabaseAnonKey={spec.supabaseAnonKey}
      refreshInterval={spec.refreshInterval}
    >
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <header className="border-b bg-white dark:bg-zinc-900 px-6 py-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">{spec.title}</h1>
          {spec.description && (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{spec.description}</p>
          )}
        </header>

        <main className="mx-auto max-w-7xl px-6 py-8">
          {hasViews ? (
            <Tabs defaultValue={spec.views![0].id}>
              <TabsList className="mb-6">
                {spec.views!.map((view) => (
                  <TabsTrigger key={view.id} value={view.id}>
                    {view.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {spec.views!.map((view) => (
                <TabsContent key={view.id} value={view.id}>
                  <WidgetGrid widgets={view.widgets} />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <WidgetGrid widgets={spec.widgets} />
          )}
        </main>
      </div>
    </DashboardDataProvider>
  );
}
