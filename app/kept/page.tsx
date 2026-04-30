"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DeepDiveRecord, DeepDiveResult, Investor, DecisionMap } from "../../lib/types";

type StateResponse = {
  decisions: DecisionMap;
};

type DeepDiveResponse = {
  deepDives: DeepDiveRecord[];
};

export default function KeptPage() {
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [deepDives, setDeepDives] = useState<Record<string, DeepDiveRecord>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/investors", { cache: "no-store" }).then(r => r.json() as Promise<{ investors: Investor[] }>),
      fetch("/api/state", { cache: "no-store" }).then(r => r.json() as Promise<StateResponse>),
      fetch("/api/deep-dive", { cache: "no-store" }).then(r => r.json() as Promise<DeepDiveResponse>),
    ]).then(([profileState, state, deepDiveState]) => {
      setInvestors(profileState.investors);
      setDecisions(state.decisions || {});
      setDeepDives(Object.fromEntries((deepDiveState.deepDives || []).map(d => [d.investorId, d])));
      setLoaded(true);
    }).catch(err => {
      setError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    });
  }, []);

  const kept = useMemo(() => investors
    .filter(i => decisions[i.id] === "keep")
    .sort((a, b) => a.name.localeCompare(b.name)), [investors, decisions]);
  const selected = kept.find(i => i.id === selectedId) || kept[0] || null;
  const selectedDive = selected ? deepDives[selected.id] : null;

  async function crossOff(investor: Investor) {
    setDecisions(prev => ({ ...prev, [investor.id]: "cut" }));
    if (selectedId === investor.id) setSelectedId(null);
    const res = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "saveSwipe", id: investor.id, decision: "cut", queue: "none" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error || `failed to cross off ${investor.name}`);
    }
  }

  async function runDeepDive(investor: Investor) {
    setRunningId(investor.id);
    setError(null);
    setDeepDives(prev => ({
      ...prev,
      [investor.id]: {
        investorId: investor.id,
        status: "running",
        result: prev[investor.id]?.result || null,
        error: null,
        updatedAt: new Date().toISOString(),
      },
    }));
    try {
      const res = await fetch("/api/deep-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ investorId: investor.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "deep dive failed");
      const record = body.deepDive as DeepDiveRecord;
      setDeepDives(prev => ({ ...prev, [investor.id]: record }));
      setSelectedId(investor.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setDeepDives(prev => ({
        ...prev,
        [investor.id]: {
          investorId: investor.id,
          status: "error",
          result: null,
          error: message,
          updatedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setRunningId(null);
    }
  }

  if (!loaded) return <main style={pageStyle}>Loading kept profiles...</main>;

  return (
    <main style={pageStyle}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 650 }}>Kept profiles</h1>
          <div style={{ color: "#9a9aa3", fontSize: 13 }}>{kept.length} people marked keep</div>
        </div>
        <Link href="/" style={buttonLinkStyle}>Back to review</Link>
      </header>

      {error && <div style={errorStyle}>{error}</div>}

      <section style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", gap: 16, alignItems: "start" }}>
        <div style={panelStyle}>
          {kept.length === 0 ? (
            <div style={{ color: "#9a9aa3", fontSize: 14 }}>No kept profiles.</div>
          ) : kept.map(investor => {
            const dive = deepDives[investor.id];
            const active = selected?.id === investor.id;
            return (
              <div key={investor.id} style={{ ...rowStyle, borderColor: active ? "#7aa7ff" : "#2a2a31" }}>
                <button onClick={() => crossOff(investor)} aria-label={`Remove ${investor.name} from kept`} style={checkStyle}>×</button>
                <button onClick={() => setSelectedId(investor.id)} style={nameStyle}>
                  <span style={{ color: "#fff", fontWeight: 650 }}>{investor.name}</span>
                  <span style={{ color: "#9a9aa3", fontSize: 12 }}>{investor.firm}</span>
                </button>
                <button
                  onClick={() => runDeepDive(investor)}
                  disabled={runningId === investor.id}
                  style={deepDiveButtonStyle}
                >
                  {runningId === investor.id || dive?.status === "running" ? "Running..." : dive?.status === "complete" ? "Rerun" : "Deep dive"}
                </button>
              </div>
            );
          })}
        </div>

        <div style={panelStyle}>
          {selected ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", marginBottom: 14 }}>
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 650 }}>{selected.name}</h2>
                  <div style={{ color: "#c5c5cc", fontSize: 14 }}>{selected.role} · {selected.firm}</div>
                </div>
                <button onClick={() => runDeepDive(selected)} disabled={runningId === selected.id} style={deepDiveButtonStyle}>
                  {runningId === selected.id || selectedDive?.status === "running" ? "Running..." : selectedDive?.status === "complete" ? "Rerun deep dive" : "Deep dive"}
                </button>
              </div>
              <ProfileSummary investor={selected} />
              <DeepDiveView record={selectedDive} />
            </>
          ) : (
            <div style={{ color: "#9a9aa3", fontSize: 14 }}>Select a kept profile.</div>
          )}
        </div>
      </section>
    </main>
  );
}

function ProfileSummary({ investor }: { investor: Investor }) {
  return (
    <section style={{ ...subPanelStyle, gap: 12, marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Badge>{bucketLabel(investor.bucket)}</Badge>
        <span style={{ color: "#9a9aa3", fontSize: 12 }}>signal: {investor.score}</span>
        {investor.confidence && <span style={{ color: "#9a9aa3", fontSize: 12 }}>data: {investor.confidence}</span>}
        {investor.sub_bucket && <span style={{ color: "#9a9aa3", fontSize: 12 }}>{investor.sub_bucket}</span>}
      </div>

      {investor.thesis_blurb && (
        <div>
          <div style={labelStyle}>Thesis</div>
          <div style={bodyTextStyle}>{investor.thesis_blurb}</div>
        </div>
      )}

      {investor.portfolio?.length > 0 && (
        <div>
          <div style={labelStyle}>Portfolio</div>
          <ChipList values={investor.portfolio} />
        </div>
      )}

      {investor.network_signals?.length > 0 && (
        <div>
          <div style={labelStyle}>Network signals</div>
          <ChipList values={investor.network_signals} />
        </div>
      )}

      {(investor.sector_focus?.length > 0 || investor.stage_focus?.length > 0 || investor.check_size || investor.leads_rounds) && (
        <div>
          <div style={labelStyle}>Individual focus</div>
          <div style={bodyTextStyle}>
            {investor.sector_focus?.length > 0 && <div>Sector: {investor.sector_focus.join(", ")}</div>}
            {investor.stage_focus?.length > 0 && <div>Stage: {investor.stage_focus.join(", ")}</div>}
            {investor.check_size && <div>Check: {investor.check_size}</div>}
            {investor.leads_rounds && investor.leads_rounds !== "unknown" && <div>Leads rounds: {investor.leads_rounds}</div>}
          </div>
        </div>
      )}

      {investor.notes && (
        <div>
          <div style={labelStyle}>Notes</div>
          <div style={bodyTextStyle}>{investor.notes}</div>
        </div>
      )}

      {investor.linkedin && (
        <div>
          <a href={investor.linkedin} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>LinkedIn</a>
        </div>
      )}
    </section>
  );
}

function ChipList({ values }: { values: string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {values.map((value, idx) => (
        <span key={`${value}-${idx}`} style={chipStyle}>{value}</span>
      ))}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span style={badgeStyle}>{children}</span>;
}

function bucketLabel(bucket: string) {
  if (bucket === "warm") return "WARM";
  if (bucket === "cold_angel") return "ANGEL";
  if (bucket === "cold_partner") return "PARTNER";
  return bucket.toUpperCase();
}

function DeepDiveView({ record }: { record?: DeepDiveRecord | null }) {
  if (!record) {
    return <div style={emptyStyle}>No deep dive yet.</div>;
  }
  if (record.status === "running") {
    return <div style={emptyStyle}>Research is running. This can take a couple minutes.</div>;
  }
  if (record.status === "error") {
    return <div style={errorStyle}>{record.error || "Deep dive failed"}</div>;
  }
  if (!record.result) {
    return <div style={emptyStyle}>No saved result.</div>;
  }
  return <ResultView result={record.result} updatedAt={record.updatedAt} />;
}

function ResultView({ result, updatedAt }: { result: DeepDiveResult; updatedAt: string }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ color: "#9a9aa3", fontSize: 12 }}>Updated {new Date(updatedAt).toLocaleString()}</div>

      <Section title="Patterns">
        <Pattern label="Founders" value={result.patterns?.founders} />
        <Pattern label="Traction" value={result.patterns?.traction} />
        <Pattern label="Product" value={result.patterns?.product} />
        <Pattern label="Thesis" value={result.patterns?.investorThesis} />
      </Section>

      <Section title={`Pre-seed investments (${result.preSeedInvestments?.length || 0})`}>
        {(result.preSeedInvestments || []).map((investment, idx) => (
          <article key={`${investment.company}-${idx}`} style={investmentStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <h3 style={{ fontSize: 18, fontWeight: 650 }}>{investment.company}</h3>
              <span style={{ color: "#9a9aa3", fontSize: 12 }}>{investment.stage} · {investment.roundDate} · {investment.confidence}</span>
            </div>
            <p style={bodyTextStyle}>{investment.oneLine}</p>
            <Pattern label="Product" value={investment.product} />
            <Pattern label="Traction at investment" value={investment.tractionAtInvestment} />
            <Pattern label="Investor role" value={investment.investorRole} />
            <Pattern label="Why they likely invested" value={investment.whyInvestorLikelyInvested} />
            <Pattern label="Thesis match" value={investment.thesisMatch} />

            {investment.founders?.length > 0 && (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={labelStyle}>Founders</div>
                {investment.founders.map((founder, founderIdx) => (
                  <div key={`${founder.name}-${founderIdx}`} style={subPanelStyle}>
                    <div style={{ fontWeight: 650 }}>{founder.name}</div>
                    <div style={bodyTextStyle}>{founder.background}</div>
                    <div style={bodyTextStyle}>{founder.whyRightPerson}</div>
                    <div style={{ ...bodyTextStyle, color: "#9a9aa3" }}>{founder.evidence}</div>
                  </div>
                ))}
              </div>
            )}

            {investment.sources?.length > 0 && (
              <div style={{ display: "grid", gap: 6 }}>
                <div style={labelStyle}>Sources</div>
                {investment.sources.map((source, sourceIdx) => (
                  <a key={`${source.url}-${sourceIdx}`} href={source.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>
                    {source.title || source.url}
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
      </Section>

      {result.gaps?.length > 0 && (
        <Section title="Gaps">
          <ul style={{ display: "grid", gap: 6, paddingLeft: 18 }}>
            {result.gaps.map((gap, idx) => <li key={idx} style={bodyTextStyle}>{gap}</li>)}
          </ul>
        </Section>
      )}

      {result.researchNotes && (
        <Section title="Research notes">
          <p style={bodyTextStyle}>{result.researchNotes}</p>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h3 style={{ color: "#fff", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</h3>
      {children}
    </section>
  );
}

function Pattern({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={bodyTextStyle}>{value}</div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: 20,
  maxWidth: 1180,
  margin: "0 auto",
  display: "grid",
  gap: 16,
  alignContent: "start",
};

const panelStyle: React.CSSProperties = {
  background: "#16161b",
  border: "1px solid #2a2a31",
  borderRadius: 12,
  padding: 14,
  display: "grid",
  gap: 10,
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "32px 1fr auto",
  gap: 8,
  alignItems: "center",
  border: "1px solid #2a2a31",
  borderRadius: 8,
  padding: 8,
};

const checkStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "#2a1a1a",
  color: "#fca5a5",
  border: "1px solid #5a2a2a",
  cursor: "pointer",
  fontSize: 18,
};

const nameStyle: React.CSSProperties = {
  background: "transparent",
  border: 0,
  cursor: "pointer",
  display: "grid",
  gap: 2,
  textAlign: "left",
};

const deepDiveButtonStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  background: "#123044",
  color: "#7dd3fc",
  border: "1px solid #7dd3fc33",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 650,
};

const buttonLinkStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #2a2a31",
  color: "#c5c5cc",
};

const investmentStyle: React.CSSProperties = {
  border: "1px solid #2a2a31",
  borderRadius: 10,
  padding: 14,
  display: "grid",
  gap: 10,
  background: "#111116",
};

const subPanelStyle: React.CSSProperties = {
  border: "1px solid #2a2a31",
  borderRadius: 8,
  padding: 10,
  background: "#17171d",
  display: "grid",
  gap: 5,
};

const chipStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  background: "#1d2438",
  color: "#a8c2ff",
  fontSize: 12,
};

const badgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 750,
  background: "#f59e0b",
  color: "#0b0b0d",
};

const labelStyle: React.CSSProperties = {
  color: "#9a9aa3",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 3,
};

const bodyTextStyle: React.CSSProperties = {
  color: "#d7d7df",
  fontSize: 14,
  lineHeight: 1.45,
};

const emptyStyle: React.CSSProperties = {
  color: "#9a9aa3",
  fontSize: 14,
  padding: 20,
  textAlign: "center",
};

const errorStyle: React.CSSProperties = {
  color: "#fca5a5",
  border: "1px solid #5a2a2a",
  background: "#2a1a1a",
  borderRadius: 8,
  padding: 10,
  fontSize: 13,
};
