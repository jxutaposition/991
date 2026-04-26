"use client";

import { useEffect, useMemo, useState } from "react";
import investorsData from "../lib/investors.json";
import type { Investor, Decision, DecisionMap } from "../lib/types";
import { loadDecisions, saveDecision, clearDecisions, exportCSV } from "../lib/storage";

const ALL_INVESTORS = investorsData as Investor[];

const TARGET_MEETINGS = 52;
const TARGET_KEEPS_5X = TARGET_MEETINGS * 5; // 260
const TARGET_KEEPS_50PCT = Math.ceil(ALL_INVESTORS.length / 2);

type FilterMode = "all" | "warm" | "cold_angel" | "cold_partner" | "unreviewed";

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
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [filter, setFilter] = useState<FilterMode>("unreviewed");
  const [index, setIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDecisions(loadDecisions());
    setHydrated(true);
  }, []);

  const filtered = useMemo(() => {
    let list = ALL_INVESTORS;
    if (filter === "warm") list = list.filter(i => i.bucket === "warm");
    else if (filter === "cold_angel") list = list.filter(i => i.bucket === "cold_angel");
    else if (filter === "cold_partner") list = list.filter(i => i.bucket === "cold_partner");
    else if (filter === "unreviewed") list = list.filter(i => !decisions[i.id]);
    return list;
  }, [filter, decisions]);

  // Reset index when filter changes
  useEffect(() => { setIndex(0); }, [filter]);

  const current = filtered[index];

  function decide(d: Decision) {
    if (!current) return;
    saveDecision(current.id, d);
    setDecisions(prev => ({ ...prev, [current.id]: d }));
    if (filter === "unreviewed") {
      // index stays; the filtered list will shrink and the next item slides in
    } else {
      setIndex(i => Math.min(i + 1, filtered.length - 1));
    }
  }

  function back() {
    if (filter === "unreviewed") {
      // pick the most recent decision and reverse it: simplest = pop last by name
      // Better: just decrement index in non-filtered view
      setFilter("all");
      setIndex(i => Math.max(0, i - 1));
    } else {
      setIndex(i => Math.max(0, i - 1));
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") decide("cut");
      else if (e.key === "ArrowRight") decide("keep");
      else if (e.key === "ArrowUp") back();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const totalReviewed = Object.keys(decisions).length;
  const kept = Object.values(decisions).filter(d => d === "keep").length;
  const cut = Object.values(decisions).filter(d => d === "cut").length;

  if (!hydrated) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  return (
    <main style={{ minHeight: "100vh", padding: "16px", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
      <Header
        kept={kept}
        cut={cut}
        total={ALL_INVESTORS.length}
        reviewed={totalReviewed}
        target5x={TARGET_KEEPS_5X}
        target50={TARGET_KEEPS_50PCT}
        filter={filter}
        setFilter={setFilter}
        filteredCount={filtered.length}
        currentIndex={index}
        onExport={() => exportCSV(decisions, ALL_INVESTORS)}
        onReset={() => {
          if (confirm("Clear all decisions?")) {
            clearDecisions();
            setDecisions({});
            setIndex(0);
          }
        }}
      />

      {current ? (
        <Card investor={current} decision={decisions[current.id]} />
      ) : (
        <EmptyState />
      )}

      {current && (
        <Controls onCut={() => decide("cut")} onKeep={() => decide("keep")} onBack={back} />
      )}
    </main>
  );
}

function Header(props: {
  kept: number; cut: number; total: number; reviewed: number;
  target5x: number; target50: number;
  filter: FilterMode; setFilter: (f: FilterMode) => void;
  filteredCount: number; currentIndex: number;
  onExport: () => void; onReset: () => void;
}) {
  const { kept, cut, total, reviewed, target5x, target50, filter, setFilter, filteredCount, currentIndex, onExport, onReset } = props;
  const remaining = Math.max(0, filteredCount - currentIndex);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Lele Investor Swipe</h1>
        <div style={{ fontSize: 12, color: "#9a9aa3" }}>
          {reviewed}/{total} reviewed · {kept} kept · {cut} cut
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, fontSize: 11, color: "#9a9aa3", flexWrap: "wrap" }}>
        <Pill active={kept >= target5x}>5× target: {kept}/{target5x}</Pill>
        <Pill active={kept >= target50}>50% kept: {kept}/{target50}</Pill>
        <Pill active>{remaining} left in filter</Pill>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <FilterBtn active={filter === "unreviewed"} onClick={() => setFilter("unreviewed")}>Unreviewed</FilterBtn>
        <FilterBtn active={filter === "warm"} onClick={() => setFilter("warm")}>Warm</FilterBtn>
        <FilterBtn active={filter === "cold_angel"} onClick={() => setFilter("cold_angel")}>Angels</FilterBtn>
        <FilterBtn active={filter === "cold_partner"} onClick={() => setFilter("cold_partner")}>Partners</FilterBtn>
        <FilterBtn active={filter === "all"} onClick={() => setFilter("all")}>All</FilterBtn>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <FilterBtn onClick={onExport}>Export CSV</FilterBtn>
          <FilterBtn onClick={onReset}>Reset</FilterBtn>
        </span>
      </div>
    </div>
  );
}

function Pill({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span style={{
      padding: "3px 8px",
      borderRadius: 999,
      background: active ? "#1a3a25" : "#1a1a1f",
      color: active ? "#7eeab0" : "#9a9aa3",
      border: `1px solid ${active ? "#22c55e44" : "#2a2a31"}`,
    }}>{children}</span>
  );
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
          background: decision === "keep" ? "#22c55e" : "#ef4444",
          color: "#fff",
        }}>{decision === "keep" ? "KEPT" : "CUT"}</div>
      )}

      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
          <span style={{
            padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            background: bucketColor(i.bucket), color: "#0b0b0d",
          }}>{bucketLabel(i.bucket)}</span>
          <span style={{ fontSize: 11, color: "#9a9aa3" }}>signal: {i.score}</span>
          {i.confidence && <span style={{ fontSize: 11, color: "#9a9aa3" }}>· data: {i.confidence}</span>}
          {i.sf_uncertain && <span style={{ fontSize: 11, color: "#f59e0b" }}>· SF unverified</span>}
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 600 }}>{i.name}</h2>
        <div style={{ color: "#c5c5cc", fontSize: 14 }}>{i.role}{i.firm && i.firm !== i.role ? ` · ${i.firm}` : ""}</div>
        {i.firm_partner_role && (
          <div style={{ color: "#9a9aa3", fontSize: 12, marginTop: 2 }}>Also: {i.firm_partner_role}</div>
        )}
      </div>

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

      {(i.sector_focus.length > 0 || i.stage_focus.length > 0 || i.check_size) && (
        <Section label="Fit">
          <div style={{ fontSize: 13, color: "#c5c5cc" }}>
            {i.sector_focus.length > 0 && <div>Sector: {i.sector_focus.join(", ")}</div>}
            {i.stage_focus.length > 0 && <div>Stage: {i.stage_focus.join(", ")}</div>}
            {i.check_size && <div>Check: {i.check_size}</div>}
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

      {i.testimonials.length > 0 && (
        <Section label="Founder testimonials">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {i.testimonials.slice(0, 3).map((t, idx) => (
              <blockquote key={idx} style={{ borderLeft: "2px solid #3a3a44", paddingLeft: 10, fontSize: 13, color: "#c5c5cc" }}>
                &ldquo;{t.quote}&rdquo;
                <cite style={{ display: "block", fontStyle: "normal", color: "#9a9aa3", fontSize: 12, marginTop: 2 }}>
                  — {t.author}{t.source_url ? <> · <a href={t.source_url} target="_blank" rel="noopener noreferrer">source</a></> : null}
                </cite>
              </blockquote>
            ))}
          </div>
        </Section>
      )}

      {i.notes && (
        <Section label="Notes">
          <p style={{ fontSize: 13, color: "#c5c5cc", lineHeight: 1.5 }}>{i.notes}</p>
        </Section>
      )}

      <div style={{ marginTop: "auto", display: "flex", gap: 12, fontSize: 13 }}>
        {i.linkedin && <a href={i.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn / Source</a>}
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

function Controls({ onCut, onKeep, onBack }: { onCut: () => void; onKeep: () => void; onBack: () => void }) {
  return (
    <div style={{ display: "flex", gap: 10, position: "sticky", bottom: 0, paddingTop: 8, paddingBottom: 8, background: "linear-gradient(to top, #0b0b0d 70%, transparent)" }}>
      <button onClick={onBack} style={btnStyle("#22222a", "#c5c5cc", false)} aria-label="back">↑ Back</button>
      <button onClick={onCut} style={btnStyle("#3b1e1e", "#fca5a5", true)}>← Cut</button>
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

function EmptyState() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: 40, textAlign: "center" }}>
      <div style={{ fontSize: 24 }}>🎯</div>
      <h2 style={{ fontSize: 18, fontWeight: 600 }}>Done with this filter.</h2>
      <p style={{ color: "#9a9aa3", fontSize: 14 }}>Switch filter above or export your decisions.</p>
    </div>
  );
}
