/**
 * Dropping a comparison in.
 *
 * A comparison is uploaded as one bundle — both trees and their typing data in
 * a single request — because that is what the backend accepts and what the
 * unit actually is: half a comparison is not a thing anyone can look at.
 *
 * Typing data is optional and may be **one file or two**. One file when both
 * trees are the same organism and share a table; two when they are not. That
 * choice is the user's, so it is a visible switch rather than something
 * inferred from how many files they happened to drop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ComparisonStatus, MetricSummary } from "../api/types";
import { clearDraft, loadFields, loadFiles, saveFields, saveFile, type Slot } from "./draft";

const TREE_HINT = "Newick — .nwk, .newick, .tree";
const TABLE_HINT = "Tab-separated typing data — .tsv";

/**
 * The opening claim of a metric's description.
 *
 * A manifest's description is written for someone deciding whether to
 * implement against the metric and runs to a paragraph; this list is a choice
 * being made in a form. The full text is in GET /metrics for anyone who wants
 * it, and truncating here beats asking plugin authors to write twice.
 */
function firstSentence(text: string): string {
  const end = text.search(/\.\s/);
  return end === -1 ? text : text.slice(0, end + 1);
}

export function UploadPanel({ onReady }: { onReady: (comparisonId: string) => void }) {
  // Read once, synchronously, so the form renders filled after a refresh
  // rather than empty and then filling (draft.ts).
  const [draft] = useState(loadFields);
  const [files, setFiles] = useState<Partial<Record<Slot, File>>>({});
  const [sharedTyping, setSharedTyping] = useState(draft.sharedTyping);
  const [name, setName] = useState(draft.name);
  const [leftSpecies, setLeftSpecies] = useState(draft.leftSpecies);
  const [rightSpecies, setRightSpecies] = useState(draft.rightSpecies);

  // Files are asynchronous to read back. A slot the user has filled in the
  // meantime keeps what they chose; the stored one only fills empty slots.
  useEffect(() => {
    let live = true;
    loadFiles().then((stored) => {
      if (live) setFiles((current) => ({ ...stored, ...current }));
    });
    return () => {
      live = false;
    };
  }, []);

  /*
   * What this server can compute with, asked rather than assumed.
   *
   * Metrics are plugins (§11), so a list in the client would be a second
   * registry going stale the moment one is added, and `available` is a fact
   * about the deployment — a metric whose runtime is missing is registered and
   * cannot run. If the call fails the panel simply offers nothing and the
   * upload proceeds on the server's default, which is the honest fallback:
   * not being able to choose is better than choosing something absent.
   */
  const [metrics, setMetrics] = useState<MetricSummary[]>([]);
  // One metric per comparison, chosen like the bar length is: a comparison
  // is read under one metric, and the view shows the one it was computed with.
  const [chosen, setChosen] = useState<string>("");
  useEffect(() => {
    api
      .metrics()
      .then((found) => {
        // All of them, not only the usable ones: a metric the server knows
        // but cannot run is shown disabled, with the reason. Listing only the
        // usable ones hid the picker entirely when one was left, and on the
        // deployment that read as the choice having disappeared.
        setMetrics(found);
        const usable = found.filter((metric) => metric.available);
        // The remembered choice only if this server still offers it: a
        // metric whose runtime has gone would be sent and refused by name.
        const remembered = usable.some((metric) => metric.name === draft.metric)
          ? draft.metric
          : "";
        setChosen((current) => current || remembered || (usable[0]?.name ?? ""));
      })
      .catch(() => setMetrics([]));
  }, []);
  const [status, setStatus] = useState<ComparisonStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    saveFields({ name, leftSpecies, rightSpecies, sharedTyping, metric: chosen });
  }, [name, leftSpecies, rightSpecies, sharedTyping, chosen]);

  const put = useCallback((slot: Slot, file: File | undefined) => {
    setFiles((current) => ({ ...current, [slot]: file }));
    void saveFile(slot, file);
  }, []);

  const ready = Boolean(files.left_tree && files.right_tree);

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);

    const form = new FormData();
    form.append("left_tree", files.left_tree!);
    form.append("right_tree", files.right_tree!);
    if (files.left_isolates) form.append("left_isolates", files.left_isolates);
    if (!sharedTyping && files.right_isolates) {
      form.append("right_isolates", files.right_isolates);
    }
    if (name.trim()) form.append("name", name.trim());
    if (leftSpecies.trim()) form.append("left_species", leftSpecies.trim());
    if (rightSpecies.trim()) form.append("right_species", rightSpecies.trim());
    if (chosen) form.append("metrics", chosen);

    try {
      const accepted = await api.upload(form);
      // The server computes off the request path, so the only honest thing to
      // do here is poll — a comparison of two 500k-node trees is minutes.
      await poll(accepted.id, setStatus);
      // Done: the comparison is in the list now, so the draft has served.
      await clearDraft();
      onReady(accepted.id);
    } catch (failed) {
      setError(
        failed instanceof ApiError
          ? `${failed.message}${failed.hint ? ` — ${failed.hint}` : ""}`
          : String(failed),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="upload">
      <h2>New comparison</h2>
      <p className="upload-lead">
        Two trees, and optionally the typing data that goes with them. They are
        uploaded together and compared on the server.
      </p>

      <div className="drop-row">
        <DropZone
          label="Left tree"
          hint={TREE_HINT}
          accept=".nwk,.newick,.tree,.txt"
          file={files.left_tree}
          onFile={(f) => put("left_tree", f)}
        />
        <DropZone
          label="Right tree"
          hint={TREE_HINT}
          accept=".nwk,.newick,.tree,.txt"
          file={files.right_tree}
          onFile={(f) => put("right_tree", f)}
        />
      </div>

      <fieldset className="typing">
        <legend>Typing data (optional)</legend>
        <label className="switch">
          <input
            type="checkbox"
            checked={sharedTyping}
            onChange={(event) => setSharedTyping(event.target.checked)}
          />
          One table for both trees
          <span className="switch-note">
            Uncheck when the two trees are different organisms and each has its own.
          </span>
        </label>

        <div className="drop-row">
          <DropZone
            label={sharedTyping ? "Typing data" : "Left typing data"}
            hint={TABLE_HINT}
            accept=".tsv,.tab,.txt"
            file={files.left_isolates}
            onFile={(f) => put("left_isolates", f)}
          />
          {sharedTyping ? null : (
            <DropZone
              label="Right typing data"
              hint={TABLE_HINT}
              accept=".tsv,.tab,.txt"
              file={files.right_isolates}
              onFile={(f) => put("right_isolates", f)}
            />
          )}
        </div>
      </fieldset>

      <div className="fields">
        <label>
          Name
          <input
            type="text"
            value={name}
            placeholder="defaults to the two filenames"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Left species
          <input
            type="text"
            value={leftSpecies}
            placeholder="optional"
            onChange={(event) => setLeftSpecies(event.target.value)}
          />
        </label>
        <label>
          Right species
          <input
            type="text"
            value={rightSpecies}
            placeholder="optional"
            onChange={(event) => setRightSpecies(event.target.value)}
          />
        </label>
        {metrics.length > 0 ? (
          <label className="upload-metric">
            Compare with
            <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
              {metrics.map((metric) => (
                <option key={metric.name} value={metric.name} disabled={!metric.available}>
                  {metric.available ? metric.title : `${metric.title} — not installed on this server`}
                </option>
              ))}
            </select>
            <span className="field-help">
              {firstSentence(metrics.find((metric) => metric.name === chosen)?.description ?? "")}
            </span>
          </label>
        ) : null}
      </div>

      <p className="field-help">
        {/* Not decoration: sequence types are numbered per species, so across
            species identical labels match no actual organism. Declaring them
            is what lets the result say so. */}
        Naming both species lets the result say whether matching leaf labels
        mean the same organisms. Left blank, it reports that it could not check.
      </p>

      <button type="button" className="primary" disabled={!ready || busy} onClick={submit}>
        {busy ? "Uploading…" : "Upload and compare"}
      </button>

      {status ? (
        <p className={`upload-status ${status.status}`}>
          {status.status === "pending"
            ? "Queued — waiting for a worker."
            : status.status === "running"
              ? "Computing the comparison…"
              : status.status === "failed"
                ? `Failed: ${status.error ?? "no reason given"}`
                : "Ready."}
        </p>
      ) : null}
      {error ? <p className="upload-status failed">{error}</p> : null}
    </section>
  );
}

/** Poll until the comparison leaves `pending`/`running`. */
async function poll(
  comparisonId: string,
  report: (status: ComparisonStatus) => void,
): Promise<void> {
  // Backs off so a long computation does not become a request every second for
  // several minutes.
  let wait = 500;
  for (;;) {
    const status = await api.status(comparisonId);
    report(status);
    if (status.status === "ready") return;
    if (status.status === "failed") {
      throw new ApiError(400, {
        detail: status.error ?? "The comparison failed.",
        code: "comparison_failed",
      });
    }
    await new Promise((resume) => setTimeout(resume, wait));
    wait = Math.min(wait * 1.5, 5_000);
  }
}

function DropZone({
  label,
  hint,
  accept,
  file,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  file: File | undefined;
  onFile: (file: File | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={`drop-zone${over ? " over" : ""}${file ? " filled" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onFile(event.dataTransfer.files[0]);
      }}
      onClick={() => input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") input.current?.click();
      }}
    >
      <p className="drop-label">{label}</p>
      {file ? (
        <>
          <p className="drop-file">{file.name}</p>
          <p className="drop-hint">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
          <button
            type="button"
            className="link-button"
            onClick={(event) => {
              event.stopPropagation();
              onFile(undefined);
            }}
          >
            Remove
          </button>
        </>
      ) : (
        <p className="drop-hint">Drop a file here, or click to choose. {hint}</p>
      )}
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => onFile(event.target.files?.[0])}
      />
    </div>
  );
}
