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
import { CheckboxMenu } from "./ui/CheckboxMenu";
import { useUrlState } from "./useUrlState";
import { COLOR_TARGETS, type ColorTarget } from "./comparison/colorTarget";
import type {
  ComparisonSummary,
  DatasetsResponse,
  PairSummary,
  WhoAmI,
} from "./api/types";

export function App() {
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [datasets, setDatasets] = useState<DatasetsResponse | null>(null);
  const [showTyping, setShowTyping] = useState(false);
  // Divergence colouring is on by default: it is what the comparison is for.
  const [showGradient, setShowGradient] = useState(true);
  const [colorTarget, setColorTarget] = useState<ColorTarget>("branches");
  const [labelClades, setLabelClades] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [view, setView] = useUrlState();
  const [chosen, setChosen] = useState<PairSummary | null>(null);
  const [summary, setSummary] = useState<ComparisonSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [who, datasets] = await Promise.all([api.me(), api.datasets()]);
      setMe(who);
      setDatasets(datasets);
      setPairs(datasets.pairs);
      setError(null);
    } catch (failed) {
      setError(failed instanceof ApiError ? failed.message : String(failed));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Restore from the URL once the listing arrives. A refresh on a comparison
  // must come back to that comparison, not to the chooser: getting back to a
  // view of two large trees is not free, and a URL that does not name what it
  // shows cannot be shared.
  useEffect(() => {
    if (!view.comparison || chosen?.id === view.comparison) return;
    const found = pairs.find((pair) => pair.id === view.comparison);
    if (found) setChosen(found);
  }, [pairs, view.comparison, chosen]);

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
            RF <strong>{Number(summary.summary.rf).toLocaleString()}</strong>
            {summary.summary.rf_normalised !== undefined ? (
              <em> ({Number(summary.summary.rf_normalised).toFixed(3)} normalised)</em>
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
          /*
           * One menu rather than a checkbox each. Three switches across a
           * header is a row of unlabelled state; a menu names what it holds
           * and leaves room for the next one.
           */
          <CheckboxMenu
            summary="View"
            align="right"
            items={[
              {
                key: "gradient",
                label: "Divergence",
                checked: showGradient,
                note: "colour branches by how much the trees disagree",
              },
              {
                key: "typing",
                label: "Typing data",
                checked: showTyping,
                note: "a bar of isolates on each leaf",
              },
              {
                key: "clades",
                label: "Clade sizes",
                checked: labelClades,
                note: "label every collapsed clade with its leaf count",
              },
              // Where the gradient lands, not whether it is on — so the choice
              // is offered only while there is one to place.
              ...(showGradient
                ? COLOR_TARGETS.map((target, index) => ({
                    key: `colour:${target.key}`,
                    label: target.label,
                    checked: colorTarget === target.key,
                    note: target.note,
                    group: "colour-target",
                    heading: index === 0 ? "Colour the divergence on" : undefined,
                  }))
                : []),
            ]}
            onToggle={(key) => {
              if (key === "gradient") setShowGradient((on) => !on);
              if (key === "typing") setShowTyping((on) => !on);
              if (key === "clades") setLabelClades((on) => !on);
              if (key.startsWith("colour:")) {
                setColorTarget(key.slice("colour:".length) as ColorTarget);
              }
            }}
          />
        ) : null}
        {chosen ? (
          <button
            type="button"
            className="back-button"
            onClick={() => setExporting(true)}
            title="A report with the trees as shown and the comparison values"
          >
            Export
          </button>
        ) : null}
        {chosen ? (
          <button
            type="button"
            className="back-button"
            onClick={() => {
              setChosen(null);
              setView({ comparison: null, left: [], right: [] });
            }}
          >
            <span aria-hidden="true">←</span> Back
          </button>
        ) : null}
      </header>

      {error ? <p className="app-error">{error}</p> : null}

      {chosen ? (
        <>
          {chosen.caution ? <p className="caution">{chosen.caution}</p> : null}
          <ComparisonView
            key={chosen.id}
            pair={chosen}
            initial={
              view.comparison === chosen.id
                ? { left: view.left, right: view.right }
                : undefined
            }
            onNavigate={(l, r) => setView({ comparison: chosen.id, left: l, right: r })}
            isolateSets={isolateSetsFor(chosen, datasets)}
            showTyping={showTyping}
            showGradient={showGradient}
            colorTarget={colorTarget}
            labelClades={labelClades}
            summary={summary}
            exporting={exporting}
            onExportClose={() => setExporting(false)}
          />
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
                      onClick={() => {
                        setChosen(pair);
                        setView({ comparison: pair.id, left: [], right: [] });
                      }}
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
              if (built) {
                setChosen(built);
                setView({ comparison: built.id, left: [], right: [] });
              }
            }}
          />
        </div>
      )}
    </div>
  );
}


/**
 * Which isolate store holds each side's typing data.
 *
 * A tree's store is keyed by its species for catalogue data and by its dataset
 * id for an upload (§24.5), so the answer comes from the listing rather than
 * being assembled here. Null where a tree has none, which is the common case
 * before anyone uploads a table.
 */
function isolateSetsFor(
  pair: PairSummary,
  datasets: DatasetsResponse | null,
): [string | null, string | null] {
  if (!datasets) return [null, null];
  const have = new Set(datasets.isolates.map((isolate) => isolate.species));
  const forTree = (treeId: string): string | null => {
    const tree = datasets.trees.find((candidate) => candidate.id === treeId);
    for (const candidate of [treeId, tree?.species]) {
      if (candidate && have.has(candidate)) return candidate;
    }
    return null;
  };
  return [forTree(pair.left), forTree(pair.right)];
}
