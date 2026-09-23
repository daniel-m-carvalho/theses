/**
 * The application shell.
 *
 * Two states: choosing a comparison, and looking at one. Everything else —
 * navigation, menus, slicing — belongs to the comparison view.
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api/client";
import { ComparisonView } from "./comparison/ComparisonView";
import { UploadPanel } from "./upload/UploadPanel";
import type { ComparisonSummary, PairSummary, WhoAmI } from "./api/types";

export function App() {
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [chosen, setChosen] = useState<PairSummary | null>(null);
  const [summary, setSummary] = useState<ComparisonSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [who, datasets] = await Promise.all([api.me(), api.datasets()]);
      setMe(who);
      setPairs(datasets.pairs);
      setError(null);
    } catch (failed) {
      setError(failed instanceof ApiError ? failed.message : String(failed));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!chosen || chosen.status !== "ready") {
      setSummary(null);
      return;
    }
    api.comparison(chosen.id).then(setSummary).catch(() => setSummary(null));
  }, [chosen]);

  return (
    <div className="app">
      <header className="app-bar">
        <h1>PhyloDelta</h1>
        <p className="tagline">Compare large phylogenetic trees without loading them</p>
        <span className="spacer" />
        {summary ? (
          <span className="headline" title="Robinson-Foulds distance">
            RF <strong>{summary.summary.rf?.toLocaleString()}</strong>
            {summary.summary.rf_normalised !== undefined ? (
              <em> ({summary.summary.rf_normalised.toFixed(3)} normalised)</em>
            ) : null}
          </span>
        ) : null}
        {me?.mock ? (
          <span className="chip warn" title="No credentials are being checked">
            demo mode
          </span>
        ) : me ? (
          <span className="chip">{me.display_name || me.owner_id}</span>
        ) : null}
        {chosen ? (
          <button type="button" className="link-button" onClick={() => setChosen(null)}>
            Choose another
          </button>
        ) : null}
      </header>

      {error ? <p className="app-error">{error}</p> : null}

      {chosen ? (
        <>
          {chosen.caution ? <p className="caution">{chosen.caution}</p> : null}
          <ComparisonView key={chosen.id} pair={chosen} />
        </>
      ) : (
        <div className="chooser">
          <section className="existing">
            <h2>Your comparisons</h2>
            {pairs.length === 0 ? (
              <p className="empty">Nothing yet. Upload two trees to begin.</p>
            ) : (
              <ul className="pair-list">
                {pairs.map((pair) => (
                  <li key={pair.id}>
                    <button
                      type="button"
                      className="pair"
                      disabled={pair.status !== "ready"}
                      onClick={() => setChosen(pair)}
                    >
                      <span className="pair-name">
                        {pair.left} vs {pair.right}
                      </span>
                      <span className={`pair-status ${pair.status}`}>{pair.status}</span>
                      {pair.status === "ready" ? (
                        <span className="pair-detail">
                          {pair.shared_leaves.toLocaleString()} shared leaves ·{" "}
                          {pair.metrics.join(", ") || "no metrics"}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <UploadPanel
            onReady={async (comparisonId) => {
              await refresh();
              const datasets = await api.datasets();
              setPairs(datasets.pairs);
              const built = datasets.pairs.find((pair) => pair.id === comparisonId);
              if (built) setChosen(built);
            }}
          />
        </div>
      )}
    </div>
  );
}
