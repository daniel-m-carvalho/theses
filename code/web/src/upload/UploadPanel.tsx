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

import { useCallback, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ComparisonStatus } from "../api/types";

type Slot = "left_tree" | "right_tree" | "left_isolates" | "right_isolates";

const TREE_HINT = "Newick — .nwk, .newick, .tree";
const TABLE_HINT = "Tab-separated typing data — .tsv";

export function UploadPanel({ onReady }: { onReady: (comparisonId: string) => void }) {
  const [files, setFiles] = useState<Partial<Record<Slot, File>>>({});
  const [sharedTyping, setSharedTyping] = useState(true);
  const [name, setName] = useState("");
  const [leftSpecies, setLeftSpecies] = useState("");
  const [rightSpecies, setRightSpecies] = useState("");
  const [status, setStatus] = useState<ComparisonStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const put = useCallback((slot: Slot, file: File | undefined) => {
    setFiles((current) => ({ ...current, [slot]: file }));
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

    try {
      const accepted = await api.upload(form);
      // The server computes off the request path, so the only honest thing to
      // do here is poll — a comparison of two 500k-node trees is minutes.
      await poll(accepted.id, setStatus);
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
