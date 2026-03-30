import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] gap-8 px-6 text-center">
      <div className="space-y-3">
        <h1 className="text-4xl font-bold tracking-tight text-white">
          Expert GTM, on demand.
        </h1>
        <p className="text-zinc-400 text-lg max-w-xl">
          Describe your GTM goal. lele builds a plan from expert-trained agents
          and executes it — research, outreach, ads, and CRM updates, end to end.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/execute"
          className="bg-white text-zinc-950 px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-zinc-100 transition-colors"
        >
          Start a workflow →
        </Link>
        <Link
          href="/catalog"
          className="border border-zinc-700 text-zinc-300 px-5 py-2.5 rounded-lg text-sm font-medium hover:border-zinc-500 transition-colors"
        >
          Browse agents
        </Link>
      </div>
    </div>
  );
}
