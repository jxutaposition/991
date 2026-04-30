"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Investor, Decision, DecisionMap } from "../lib/types";
import { normalizeLinkedInProfileUrl } from "../lib/linkedin";
import { loadRemoteState, saveSwipeDecision, clearDecisions, exportCSV, exportLGMQueue, exportLGMMissingLinkedInQueue, inspectStateDiagnostics } from "../lib/storage";
import type { StateDiagnostics } from "../lib/storage";

const FIT_TOPICS = [
  { label: "SMB tech", words: ["smb", "small business", "seller", "merchant", "payroll", "commerce", "service business", "ops"] },
  { label: "Marketplace", words: ["marketplace", "two-sided", "network effects", "consumer platform"] },
  { label: "Impact", words: ["impact", "mission", "civic", "govtech", "public interest", "education", "healthcare", "climate", "social"] },
  { label: "PLG", words: ["product-led", "product led", "self-serve", "productivity", "dev tools", "developer tools", "notion", "figma", "replit"] },
  { label: "Community-led", words: ["community", "creator", "substack", "discord", "all raise", "operator collective"] },
  { label: "Women", words: ["women", "female founder", "project include", "all raise"] },
  { label: "Australian", words: ["australian", "australia", "sydney", "melbourne", "brisbane"] },
  { label: "Agent applications", words: ["agent", "agents", "ai", "automation", "workflow", "copilot"] },
];

const TARGET_MEETINGS = 52;
const TARGET_KEEPS_5X = TARGET_MEETINGS * 5; // 260

type FilterMode = "all" | "warm" | "cold_angel" | "cold_partner" | "yale_alumni" | "unreviewed" | "skipped";
type ViewMode = "review" | "message";

function pushToLGM(investor: Investor) {
  const linkedinUrl = normalizeLinkedInProfileUrl(investor.linkedin);
  const { firstname, lastname } = splitName(investor.name);
  if (!linkedinUrl) {
    console.warn("Skipping LGM add without a valid LinkedIn profile URL", {
      id: investor.id,
      name: investor.name,
      url: investor.linkedin,
    });
    return;
  }
  fetch("/api/lgm/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstname,
      lastname,
      linkedinUrl,
      companyName: investor.firm,
      jobTitle: investor.role,
      sourceInvestorId: investor.id,
    }),
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) console.warn("LGM add failed", j);
    })
    .catch(err => console.warn("LGM add error", err));
}

function formatAUM(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(usd >= 10_000_000_000 ? 0 : 1)}B AUM`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(0)}M AUM`;
  return `$${usd.toLocaleString()} AUM`;
}

function bucketLabel(b: string) {
  if (b === "warm") return "WARM";
  if (b === "cold_angel") return "ANGEL";
  if (b === "cold_partner") return "PARTNER";
  return b.toUpperCase();
}

function bucketColor(b: string) {
  if (b === "warm") return "#22c55e";
  if (b === "cold_angel") return "#f59e0b";
  if (b === "cold_partner") return "#7aa7ff";
  return "#888";
}

export default function Page() {
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [filter, setFilter] = useState<FilterMode>("unreviewed");
  const [view, setView] = useState<ViewMode>("review");
  const [index, setIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [lgmQueue, setLgmQueue] = useState<string[]>([]);
  const [lgmMissingLinkedInQueue, setLgmMissingLinkedInQueue] = useState<string[]>([]);
  const [moreQueue, setMoreQueue] = useState<string[]>([]);
  const [stateDiagnostics, setStateDiagnostics] = useState<StateDiagnostics | null>(null);
  const [lastSaveError, setLastSaveError] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addLinkedIn, setAddLinkedIn] = useState("");
  const [addingProfile, setAddingProfile] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/investors", { cache: "no-store" }).then(r => {
        if (!r.ok) throw new Error(`investors request failed: ${r.status}`);
        return r.json() as Promise<{ investors: Investor[] }>;
      }),
      loadRemoteState(),
    ]).then(([profileState, state]) => {
      setInvestors(profileState.investors);
      setDecisions(state.decisions);
      setLgmQueue(state.lgmQueue);
      setLgmMissingLinkedInQueue(state.lgmMissingLinkedInQueue);
      setMoreQueue(state.moreQueue);
      setHydrated(true);
    }).catch(err => {
      setLastSaveError(err instanceof Error ? err.message : String(err));
      setHydrated(true);
    });
  }, []);

  async function refreshDiagnostics() {
    const diagnostics = await inspectStateDiagnostics();
    setStateDiagnostics(diagnostics);
    return diagnostics;
  }

  async function addProfile() {
    const name = addName.trim();
    const linkedin = addLinkedIn.trim();
    if (!name) return;
    setAddingProfile(true);
    setLastSaveError(null);
    try {
      const res = await fetch("/api/investors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, linkedin }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "profile add failed");
      const investor = body.investor as Investor;
      setInvestors(prev => [investor, ...prev.filter(i => i.id !== investor.id)]);
      setAddName("");
      setAddLinkedIn("");
      setFilter("unreviewed");
      setSearchQuery(investor.name);
      setIndex(0);
    } catch (err) {
      setLastSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingProfile(false);
    }
  }

  const filtered = useMemo(() => {
    let list = investors;
    if (filter === "warm") list = list.filter(i => i.bucket === "warm");
    else if (filter === "cold_angel") list = list.filter(i => i.bucket === "cold_angel");
    else if (filter === "cold_partner") list = list.filter(i => i.bucket === "cold_partner");
    else if (filter === "yale_alumni") list = list.filter(isYaleAlum);
    else if (filter === "unreviewed") list = list.filter(i => !decisions[i.id]);
    else if (filter === "skipped") list = list.filter(i => decisions[i.id] === "skip");
    const q = searchQuery.trim().toLowerCase();
    if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
    return list;
  }, [filter, decisions, searchQuery, investors]);
  const messagingInvestors = useMemo(() => investors
    .filter(i => isRealAngel(i))
    .sort((a, b) => connectionRank(a) - connectionRank(b) || b.score - a.score), [investors]);
  const messaging = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return messagingInvestors;
    return messagingInvestors.filter(i => i.name.toLowerCase().includes(q));
  }, [searchQuery, messagingInvestors]);

  // Reset index when filter changes
  useEffect(() => { setIndex(0); }, [filter, searchQuery]);

  const current = filtered[index];

  async function persistDecision(selected: Investor, d: Decision) {
    const queue = d === "keep"
      ? normalizeLinkedInProfileUrl(selected.linkedin) ? "lgm" : "lgmMissingLinkedIn"
      : d === "more" ? "more" : "none";
    await saveSwipeDecision(selected.id, d, queue);
  }

  function decide(d: Decision) {
    if (!current) return;
    const selected = current;
    setDecisions(prev => ({ ...prev, [selected.id]: d }));
    // Auto-queue Keeps to LGM "investors" campaign sync queue
    if (d === "keep") {
      if (normalizeLinkedInProfileUrl(selected.linkedin)) {
        setLgmQueue(prev => prev.includes(selected.id) ? prev : [...prev, selected.id]);
        setLgmMissingLinkedInQueue(prev => prev.filter(id => id !== selected.id));
        pushToLGM(selected);
      } else {
        setLgmQueue(prev => prev.filter(id => id !== selected.id));
        setLgmMissingLinkedInQueue(prev => prev.includes(selected.id) ? prev : [...prev, selected.id]);
        console.warn("Kept investor has no valid LinkedIn profile URL for LGM", {
          id: selected.id,
          name: selected.name,
          url: selected.linkedin,
        });
      }
      setMoreQueue(prev => prev.filter(id => id !== selected.id));
    } else if (d === "more") {
      setLgmQueue(prev => prev.filter(id => id !== selected.id));
      setLgmMissingLinkedInQueue(prev => prev.filter(id => id !== selected.id));
      setMoreQueue(prev => prev.includes(selected.id) ? prev : [...prev, selected.id]);
    } else {
      setLgmQueue(prev => prev.filter(id => id !== selected.id));
      setLgmMissingLinkedInQueue(prev => prev.filter(id => id !== selected.id));
      setMoreQueue(prev => prev.filter(id => id !== selected.id));
    }
    if (filter === "unreviewed") {
      // index stays; the filtered list will shrink and the next item slides in
    } else {
      setIndex(i => Math.min(i + 1, filtered.length - 1));
    }
    persistDecision(selected, d).then(() => {
      setLastSaveError(null);
    }).catch(err => {
      setLastSaveError(err instanceof Error ? err.message : String(err));
      console.warn("Failed to persist investor decision", {
        id: selected.id,
        decision: d,
        err,
      });
    });
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") decide("cut");
      else if (e.key === "ArrowRight") decide("keep");
      else if (e.key === "ArrowDown") decide("skip");
      else if (e.key === "ArrowUp") decide("more");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const totalReviewed = Object.keys(decisions).length;
  const kept = Object.values(decisions).filter(d => d === "keep").length;
  const cut = Object.values(decisions).filter(d => d === "cut").length;
  const skipped = Object.values(decisions).filter(d => d === "skip").length;
  const more = Object.values(decisions).filter(d => d === "more").length;

  if (!hydrated) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  return (
    <main style={{ minHeight: "100vh", padding: "16px", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      <Header
        view={view}
        setView={setView}
        kept={kept}
        cut={cut}
        skipped={skipped}
        more={more}
        total={investors.length}
        reviewed={totalReviewed}
        target5x={TARGET_KEEPS_5X}
        target50={Math.ceil(investors.length / 2)}
        filter={filter}
        setFilter={setFilter}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        filteredCount={filtered.length}
        currentIndex={index}
        onExport={() => exportCSV(decisions, investors)}
        onExportLGM={() => {
          const n = exportLGMQueue(investors, lgmQueue);
          alert(`Exported ${n} kept investors as LGM-ready CSV. Import into your LGM "investors" campaign as an audience.`);
        }}
        lgmQueueSize={lgmQueue.length}
        lgmMissingLinkedInSize={lgmMissingLinkedInQueue.length}
        moreQueueSize={moreQueue.length}
        diagnostics={stateDiagnostics}
        lastSaveError={lastSaveError}
        onRefreshDiagnostics={refreshDiagnostics}
        addName={addName}
        setAddName={setAddName}
        addLinkedIn={addLinkedIn}
        setAddLinkedIn={setAddLinkedIn}
        addingProfile={addingProfile}
        onAddProfile={addProfile}
        onExportLGMMissingLinkedIn={() => {
          const n = exportLGMMissingLinkedInQueue(investors, lgmMissingLinkedInQueue);
          alert(`Exported ${n} kept investors missing valid LinkedIn profile URLs.`);
        }}
        onReset={async () => {
          if (confirm("Clear all decisions?")) {
            await clearDecisions();
            setDecisions({});
            setLgmQueue([]);
            setLgmMissingLinkedInQueue([]);
            setMoreQueue([]);
            setIndex(0);
          }
        }}
      />

      {view === "review" ? (
        <>
          {current ? (
            <Card investor={current} decision={decisions[current.id]} />
          ) : (
            <EmptyState />
          )}

          {current && (
            <Controls onCut={() => decide("cut")} onSkip={() => decide("skip")} onMore={() => decide("more")} onKeep={() => decide("keep")} />
          )}
        </>
      ) : (
        <MessagingTab investors={messaging} />
      )}
    </main>
  );
}

function splitName(name: string) {
  const clean = name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const parts = clean.split(" ").filter(Boolean);
  return {
    firstname: parts[0] || "",
    lastname: parts.length > 1 ? parts.slice(1).join(" ") : "",
  };
}

function Header(props: {
  view: ViewMode; setView: (v: ViewMode) => void;
  kept: number; cut: number; skipped: number; more: number; total: number; reviewed: number;
  target5x: number; target50: number;
  filter: FilterMode; setFilter: (f: FilterMode) => void;
  searchQuery: string; setSearchQuery: (q: string) => void;
  filteredCount: number; currentIndex: number;
  onExport: () => void; onExportLGM: () => void; onExportLGMMissingLinkedIn: () => void; lgmQueueSize: number; lgmMissingLinkedInSize: number; moreQueueSize: number;
  diagnostics: StateDiagnostics | null; lastSaveError: string | null; onRefreshDiagnostics: () => Promise<StateDiagnostics>;
  addName: string; setAddName: (value: string) => void; addLinkedIn: string; setAddLinkedIn: (value: string) => void; addingProfile: boolean; onAddProfile: () => void;
  onReset: () => void;
}) {
  const { view, setView, kept, cut, skipped, more, total, reviewed, target5x, target50, filter, setFilter, searchQuery, setSearchQuery, filteredCount, currentIndex, onExport, onExportLGM, onExportLGMMissingLinkedIn, lgmQueueSize, lgmMissingLinkedInSize, moreQueueSize, diagnostics, lastSaveError, onRefreshDiagnostics, addName, setAddName, addLinkedIn, setAddLinkedIn, addingProfile, onAddProfile, onReset } = props;
  const remaining = Math.max(0, filteredCount - currentIndex);
  const legacyReviewed = diagnostics ? Object.keys(diagnostics.legacy.decisions).length : null;
  const remoteReviewed = diagnostics?.remote ? Object.keys(diagnostics.remote.decisions).length : null;
  const mergedReviewed = diagnostics ? Object.keys(diagnostics.merged.decisions).length : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Lele Investor Swipe</h1>
        <div style={{ fontSize: 12, color: "#9a9aa3" }}>
          {reviewed}/{total} reviewed · {kept} kept · {cut} cut · {skipped} skipped
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, fontSize: 11, color: "#9a9aa3", flexWrap: "wrap" }}>
        <Pill active={kept >= target5x}>5× target: {kept}/{target5x}</Pill>
        <Pill active={kept >= target50} href="/kept">50% kept: {kept}/{target50}</Pill>
        <Pill active={lgmMissingLinkedInSize > 0}>LGM retry: {lgmMissingLinkedInSize}</Pill>
        <Pill active={moreQueueSize > 0}>Lookalikes: {moreQueueSize}</Pill>
        <Pill active>{remaining} left in filter</Pill>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <FilterBtn active={view === "review"} onClick={() => setView("review")}>Review</FilterBtn>
        <FilterBtn active={view === "message"} onClick={() => setView("message")}>Message</FilterBtn>
        <FilterBtn active={filter === "unreviewed"} onClick={() => setFilter("unreviewed")}>Unreviewed</FilterBtn>
        <FilterBtn active={filter === "warm"} onClick={() => setFilter("warm")}>Warm</FilterBtn>
        <FilterBtn active={filter === "cold_angel"} onClick={() => setFilter("cold_angel")}>Angels</FilterBtn>
        <FilterBtn active={filter === "cold_partner"} onClick={() => setFilter("cold_partner")}>Partners</FilterBtn>
        <FilterBtn active={filter === "yale_alumni"} onClick={() => setFilter("yale_alumni")}>Yale alum</FilterBtn>
        <FilterBtn active={filter === "skipped"} onClick={() => setFilter("skipped")}>Skipped ({skipped})</FilterBtn>
        <FilterBtn active={filter === "all"} onClick={() => setFilter("all")}>All</FilterBtn>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <FilterBtn onClick={onExport}>Export CSV</FilterBtn>
          <FilterBtn onClick={onExportLGM}>LGM queue ({lgmQueueSize})</FilterBtn>
          <FilterBtn onClick={onExportLGMMissingLinkedIn}>LGM retry ({lgmMissingLinkedInSize})</FilterBtn>
          <FilterBtn onClick={() => { onRefreshDiagnostics(); }}>Debug state</FilterBtn>
          <FilterBtn onClick={onReset}>Reset</FilterBtn>
        </span>
      </div>

      {(diagnostics || lastSaveError) && (
        <div style={{ border: "1px solid #3a3a44", background: "#111116", borderRadius: 8, padding: 10, fontSize: 12, color: "#c5c5cc", display: "grid", gap: 4 }}>
          <div style={{ color: "#fff", fontWeight: 600 }}>State debug</div>
          {diagnostics && (
            <>
              <div>LocalStorage reviewed: {legacyReviewed} · keep queue: {diagnostics.legacy.lgmQueue.length} · lookalikes: {diagnostics.legacy.moreQueue.length} · invalid/retry: {diagnostics.legacy.lgmMissingLinkedInQueue.length}</div>
              <div>Remote reviewed: {remoteReviewed ?? "failed"} · merged reviewed: {mergedReviewed}</div>
              {diagnostics.remoteError && <div style={{ color: "#fca5a5" }}>Remote error: {diagnostics.remoteError}</div>}
            </>
          )}
          {lastSaveError && <div style={{ color: "#fca5a5" }}>Last save error: {lastSaveError}</div>}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gap: 8,
          padding: 10,
          borderRadius: 8,
          border: "1px solid #2a2a31",
          background: "#141419",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#e5e7eb", textTransform: "uppercase", letterSpacing: 0 }}>
            Add profile
          </div>
          <div style={{ fontSize: 12, color: "#9a9aa3" }}>Name required, LinkedIn optional</div>
        </div>
        <form
          onSubmit={e => {
            e.preventDefault();
            onAddProfile();
          }}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(160px, 1fr) minmax(190px, 1.4fr) auto",
            gap: 6,
            alignItems: "center",
          }}
        >
          <input
            value={addName}
            onChange={e => setAddName(e.target.value)}
            placeholder="Name"
            aria-label="Add profile name"
            style={inputStyle}
          />
          <input
            value={addLinkedIn}
            onChange={e => setAddLinkedIn(e.target.value)}
            placeholder="Optional LinkedIn URL"
            aria-label="Optional LinkedIn URL"
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={addingProfile || !addName.trim()}
            style={{
              padding: "9px 12px",
              borderRadius: 8,
              background: addName.trim() ? "#1e3b29" : "#1a1a1f",
              color: addName.trim() ? "#86efac" : "#777",
              border: "1px solid #2a2a31",
              cursor: addName.trim() ? "pointer" : "not-allowed",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {addingProfile ? "Adding..." : "Add"}
          </button>
        </form>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by name"
          aria-label="Search by name"
          style={{
            width: "100%",
            padding: "9px 10px",
            borderRadius: 8,
            background: "#111116",
            color: "#fff",
            border: "1px solid #2a2a31",
            fontSize: 13,
            outline: "none",
          }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            aria-label="Clear name search"
            style={{
              padding: "9px 12px",
              borderRadius: 8,
              background: "transparent",
              color: "#9a9aa3",
              border: "1px solid #2a2a31",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function Pill({ children, active, href }: { children: React.ReactNode; active?: boolean; href?: string }) {
  const style: React.CSSProperties = {
    padding: "3px 8px",
    borderRadius: 999,
    background: active ? "#1a3a25" : "#1a1a1f",
    color: active ? "#7eeab0" : "#9a9aa3",
    border: `1px solid ${active ? "#22c55e44" : "#2a2a31"}`,
    textDecoration: "none",
  };
  if (href) return <Link href={href} style={style}>{children}</Link>;
  return <span style={style}>{children}</span>;
}

function FilterBtn({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 10px",
      borderRadius: 8,
      background: active ? "#2a2a31" : "transparent",
      color: active ? "#fff" : "#9a9aa3",
      border: `1px solid ${active ? "#3a3a44" : "#2a2a31"}`,
      cursor: "pointer",
      fontSize: 12,
    }}>{children}</button>
  );
}

function Card({ investor, decision }: { investor: Investor; decision?: Decision }) {
  const i = investor;
  return (
    <div style={{
      background: "#16161b",
      border: "1px solid #2a2a31",
      borderRadius: 16,
      padding: 20,
      flex: 1,
      display: "flex",
      flexDirection: "column",
      gap: 14,
      minHeight: 400,
      position: "relative",
    }}>
      {decision && (
        <div style={{
          position: "absolute", top: 12, right: 12,
          padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
          background: decision === "keep" ? "#22c55e" : decision === "skip" ? "#a855f7" : decision === "more" ? "#0ea5e9" : "#ef4444",
          color: "#fff",
        }}>{decision === "keep" ? "KEPT" : decision === "skip" ? "SKIPPED" : decision === "more" ? "MORE" : "CUT"}</div>
      )}

      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{
            padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            background: bucketColor(i.bucket), color: "#0b0b0d",
          }}>{bucketLabel(i.bucket)}</span>
          <span style={{ fontSize: 11, color: "#9a9aa3" }}>signal: {i.score}</span>
          {i.confidence && <span style={{ fontSize: 11, color: "#9a9aa3" }}>· data: {i.confidence}</span>}
          {i.sf_uncertain && <span style={{ fontSize: 11, color: "#f59e0b" }}>· SF unverified</span>}
          {typeof i.aum_usd === "number" && i.aum_usd > 0 && (
            <span style={{
              padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
              background: "#1e3b29", color: "#86efac",
            }}>{formatAUM(i.aum_usd)}</span>
          )}
          {i.firm_stages && (
            <span style={{ fontSize: 11, color: "#9a9aa3" }}>· stages: {i.firm_stages}</span>
          )}
          {i.connection_degree === "1st" && (
            <span style={{
              padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
              background: "#22c55e", color: "#0b0b0d",
            }}>1ST DEGREE</span>
          )}
          {i.connection_degree === "2nd" && (
            <span style={{
              padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
              background: "#facc15", color: "#0b0b0d",
            }}>2ND DEGREE</span>
          )}
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 600 }}>{i.name}</h2>
        <div style={{ color: "#c5c5cc", fontSize: 14 }}>{i.role}{i.firm && i.firm !== i.role ? ` · ${i.firm}` : ""}</div>
        {i.firm_partner_role && (
          <div style={{ color: "#9a9aa3", fontSize: 12, marginTop: 2 }}>Also: {i.firm_partner_role}</div>
        )}
      </div>

      {i.connection_degree === "2nd" && i.connection_via && i.connection_via.length > 0 && (
        <Section label="Warm intro paths (your connections at this firm)">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {i.connection_via.slice(0, 5).map((c, idx) => (
              <div key={idx} style={{ fontSize: 13 }}>
                <span style={{ color: "#fde68a", fontWeight: 600 }}>{c.name}</span>
                <span style={{ color: "#9a9aa3" }}> — {c.occupation}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {i.connection_degree === "1st" && (
        <Section label="Connection status">
          <div style={{ fontSize: 13, color: "#86efac" }}>
            ✓ You're already 1st-degree connected on LinkedIn — message directly.
          </div>
        </Section>
      )}

      {i.thesis_blurb && (
        <Section label="Thesis">
          <p style={{ fontSize: 14, lineHeight: 1.5 }}>{i.thesis_blurb}</p>
        </Section>
      )}

      {i.portfolio.length > 0 && (
        <Section label={`Portfolio (${i.portfolio.length})`}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {i.portfolio.map((p, idx) => (
              <span key={idx} style={{ padding: "4px 8px", borderRadius: 6, background: "#22222a", fontSize: 12 }}>{p}</span>
            ))}
          </div>
        </Section>
      )}

      {i.network_signals.length > 0 && (
        <Section label="Network signals">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {i.network_signals.map((s, idx) => (
              <span key={idx} style={{ padding: "4px 8px", borderRadius: 6, background: "#1d2438", color: "#a8c2ff", fontSize: 12 }}>{s}</span>
            ))}
          </div>
        </Section>
      )}

      {(i.sector_focus.length > 0 || i.stage_focus.length > 0 || i.check_size || i.leads_rounds) && (
        <Section label="Individual focus">
          <div style={{ fontSize: 13, color: "#c5c5cc" }}>
            {i.sector_focus.length > 0 && <div>Sector: {i.sector_focus.join(", ")}</div>}
            {i.stage_focus.length > 0 && <div>Stage: {i.stage_focus.join(", ")}</div>}
            {i.check_size && <div>Check: {i.check_size}</div>}
            {i.leads_rounds && i.leads_rounds !== "unknown" && (
              <div>
                Leads rounds: <span style={{ color: i.leads_rounds === "lead" ? "#86efac" : i.leads_rounds === "both" ? "#fde68a" : "#9a9aa3" }}>
                  {i.leads_rounds === "lead" ? "Yes (leads)" : i.leads_rounds === "both" ? "Both (leads + follows)" : "Follows only"}
                </span>
              </div>
            )}
          </div>
        </Section>
      )}

      {i.firm_stages && (
        <Section label="Firm-level (separate)">
          <div style={{ fontSize: 13, color: "#c5c5cc" }}>
            <div>Firm stages: {i.firm_stages}</div>
            {typeof i.aum_usd === "number" && i.aum_usd > 0 && <div>Firm AUM: {formatAUM(i.aum_usd)}</div>}
          </div>
        </Section>
      )}

      {i.co_investors && i.co_investors.length > 0 && (
        <Section label="Frequent co-investors">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {i.co_investors.map((c, idx) => (
              <span key={idx} style={{ padding: "4px 8px", borderRadius: 6, background: "#2a1f30", color: "#e9d5ff", fontSize: 12 }}>{c}</span>
            ))}
          </div>
        </Section>
      )}

      {i.writings.length > 0 && (
        <Section label="Writings & talks">
          <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
            {i.writings.slice(0, 5).map((w, idx) => (
              <li key={idx} style={{ fontSize: 13 }}>
                <span style={{ color: "#9a9aa3", textTransform: "uppercase", fontSize: 10, marginRight: 6 }}>{w.type}</span>
                {w.url ? <a href={w.url} target="_blank" rel="noopener noreferrer">{w.title}</a> : w.title}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {i.notes && (
        <Section label="Notes">
          <p style={{ fontSize: 13, color: "#c5c5cc", lineHeight: 1.5 }}>{i.notes}</p>
        </Section>
      )}

      <div style={{ marginTop: "auto", display: "flex", gap: 12, fontSize: 13 }}>
        {i.linkedin && <a href={i.linkedin} target="_blank" rel="noopener noreferrer">{normalizeLinkedInProfileUrl(i.linkedin) ? "LinkedIn" : "Source"}</a>}
      </div>

      {!i.enriched && (
        <div style={{ fontSize: 11, color: "#f59e0b", padding: 8, background: "#2a200a", borderRadius: 6 }}>
          ⚠ Baseline data only — enrichment not yet completed for this profile.
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#9a9aa3", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Controls({ onCut, onSkip, onMore, onKeep }: { onCut: () => void; onSkip: () => void; onMore: () => void; onKeep: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8, position: "sticky", bottom: 0, paddingTop: 8, paddingBottom: 8, background: "linear-gradient(to top, #0b0b0d 70%, transparent)" }}>
      <button onClick={onMore} style={btnStyle("#123044", "#7dd3fc", false)} aria-label="more">↑ More</button>
      <button onClick={onCut} style={btnStyle("#3b1e1e", "#fca5a5", true)}>← Cut</button>
      <button onClick={onSkip} style={btnStyle("#2d2440", "#d8b4fe", false)} aria-label="skip">↓ Skip</button>
      <button onClick={onKeep} style={btnStyle("#1e3b29", "#86efac", true)}>Keep →</button>
    </div>
  );
}

function btnStyle(bg: string, fg: string, big: boolean): React.CSSProperties {
  return {
    flex: big ? 1 : 0,
    padding: big ? "16px 20px" : "16px 14px",
    borderRadius: 12,
    background: bg,
    color: fg,
    border: `1px solid ${fg}33`,
    fontSize: big ? 16 : 14,
    fontWeight: 600,
    cursor: "pointer",
  };
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 10px",
  borderRadius: 8,
  background: "#111116",
  color: "#fff",
  border: "1px solid #2a2a31",
  fontSize: 13,
  outline: "none",
};

function MessagingTab({ investors }: { investors: Investor[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>People to message</h2>
        <div style={{ fontSize: 12, color: "#9a9aa3" }}>{investors.length} matches</div>
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        {investors.map(i => (
          <MessageCard key={i.id} investor={i} />
        ))}
      </div>
    </div>
  );
}

function MessageCard({ investor }: { investor: Investor }) {
  const fits = getFits(investor);
  const copy = buildProfileCopy(investor, fits);
  return (
    <div style={{ background: "#16161b", border: "1px solid #2a2a31", borderRadius: 12, padding: 16, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{investor.name}</div>
          <div style={{ fontSize: 12, color: "#9a9aa3" }}>{investor.role}{investor.firm ? ` · ${investor.firm}` : ""}</div>
        </div>
        <a href={investor.linkedin} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>LinkedIn</a>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {fits.map(f => <span key={f} style={{ padding: "3px 8px", borderRadius: 999, background: "#202028", fontSize: 11, color: "#d7d7df" }}>{f}</span>)}
        <span style={{ padding: "3px 8px", borderRadius: 999, background: investor.connection_degree === "1st" ? "#16301f" : investor.connection_degree === "2nd" ? "#33261b" : "#24242c", fontSize: 11, color: "#eaeaea" }}>{investor.connection_degree === "1st" ? "1st degree" : investor.connection_degree === "2nd" ? "2nd degree" : "connection unknown"}</span>
      </div>
      <div style={{ fontSize: 12, color: "#9a9aa3" }}>Caught my eye: {profileHook(investor)}</div>
      <textarea readOnly value={copy} rows={4} style={{ width: "100%", resize: "none", background: "#101014", color: "#f2f2f7", border: "1px solid #2a2a31", borderRadius: 8, padding: 10, fontSize: 13, lineHeight: 1.4 }} />
    </div>
  );
}

function getFits(i: Investor): string[] {
  const haystack = [
    i.notes,
    i.thesis_blurb,
    i.firm,
    i.role,
    i.firm_partner_role,
    i.bucket,
    ...(i.sector_focus || []),
    ...(i.stage_focus || []),
    ...(i.network_signals || []),
    ...(i.writings || []).map(w => `${w.type} ${w.title}`),
  ].filter(Boolean).join(" ").toLowerCase();
  return FIT_TOPICS.filter(t => t.words.some(w => haystack.includes(w))).map(t => t.label);
}

function startupLine(fits: string[]) {
  const first = fits[0] || "SMB tech";
  if (first === "Agent applications") return "99 helps service businesses run agent-first ops.";
  if (first === "Impact") return "99 turns service businesses into agent-first ops.";
  if (first === "Marketplace") return "99 helps operators scale with agent-first workflows.";
  if (first === "Community-led") return "99 helps community-driven operators use agents.";
  return "99 turns service businesses into agent-first ops.";
}

function buildProfileCopy(i: Investor, fits: string[]) {
  const hook = profileHook(i);
  const intro = i.connection_degree === "1st" ? "Already connected here" : i.connection_degree === "2nd" ? "We have a mutual connection" : "Reaching out here";
  return `${intro}. What caught my eye: ${hook}. ${startupLine(fits)} ${normalizeLinkedInProfileUrl(i.linkedin)}`;
}

function profileHook(i: Investor): string {
  const writing = i.writings?.find(w => w.title)?.title;
  if (writing) return shorten(`your ${writing}`);

  const thesis = cleanSentence(i.thesis_blurb);
  if (thesis) return shorten(thesis);

  if (i.portfolio?.length) return shorten(`your work around ${i.portfolio.slice(0, 3).join(", ")}`);
  if (i.sector_focus?.length) return shorten(`your ${i.sector_focus.slice(0, 3).join(", ")} focus`);
  if (i.stage_focus?.length) return shorten(`your ${i.stage_focus.slice(0, 2).join(" / ")} investing focus`);

  const note = cleanSentence(i.notes);
  if (note) return shorten(note);

  return shorten(`${i.role} at ${i.firm}`);
}

function cleanSentence(value?: string): string {
  return (value || "").replace(/\s+/g, " ").replace(/[.。]+$/, "").trim();
}

function shorten(value: string): string {
  const clean = cleanSentence(value);
  return clean.length > 115 ? `${clean.slice(0, 112).trim()}...` : clean;
}

function connectionRank(i: Investor) {
  if (i.connection_degree === "1st") return 0;
  if (i.connection_degree === "2nd") return 1;
  return 2;
}

function isRealAngel(i: Investor) {
  const notes = (i.notes || "").toLowerCase();
  if (notes.includes("unclear if invests") || notes.includes("unverified angel") || notes.includes("limited public angel signal") || notes.includes("flagged") || notes.includes("exclude") || notes.includes("deprioritize") || notes.includes("not a fit") || notes.includes("long shot")) {
    return false;
  }
  return Boolean(i.leads_rounds && i.leads_rounds !== "unknown") || /angel|invest|checks|portfolio|personal angel|small check|advisor|scout/i.test(notes);
}

function isYaleAlum(i: Investor) {
  if (i.sub_bucket === "yale_alumni") return true;
  const haystack = [
    i.notes,
    i.thesis_blurb,
    i.sub_bucket,
    ...(i.network_signals || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return /\byale\b/.test(haystack);
}

function hasLinkedIn(i: Investor) {
  return Boolean(normalizeLinkedInProfileUrl(i.linkedin));
}

function isConnectionEligible(i: Investor) {
  return i.connection_degree === "1st" || (i.connection_degree === "2nd" && Boolean(i.connection_via && i.connection_via.length));
}

function EmptyState() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: 40, textAlign: "center" }}>
      <div style={{ fontSize: 24 }}>🎯</div>
      <h2 style={{ fontSize: 18, fontWeight: 600 }}>Done with this filter.</h2>
      <p style={{ color: "#9a9aa3", fontSize: 14 }}>Switch filter above or export your decisions.</p>
    </div>
  );
}
