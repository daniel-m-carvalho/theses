/**
 * Talking to PhyloDelta.
 *
 * One place that knows URLs and error handling, so components deal in values
 * and failures rather than in fetch. Every non-2xx response carries
 * `{detail, code, hint}`; `ApiError` preserves `code`, because that is the
 * stable thing to branch on — `detail` may be reworded.
 */

import type {
  ApiErrorBody,
  CompositionResponse,
  IsolateKeys,
  ComparisonStatus,
  ComparisonSummary,
  DatasetsResponse,
  NodeContext,
  TreeSlice,
  UploadAccepted,
  WhoAmI,
} from "./types";

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | null;

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.detail ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code ?? "unknown";
    this.hint = body.hint ?? null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) {
    // A failure may not be JSON — a proxy timing out, for instance — so the
    // parse is guarded rather than assumed.
    let body: Partial<ApiErrorBody> = {};
    try {
      body = await response.json();
    } catch {
      body = { detail: response.statusText };
    }
    throw new ApiError(response.status, body);
  }
  return (await response.json()) as T;
}

export const api = {
  me: () => request<WhoAmI>("/me"),

  datasets: () => request<DatasetsResponse>("/datasets"),

  comparison: (pairId: string, metric = "rf") =>
    request<ComparisonSummary>(
      `/comparisons/${encodeURIComponent(pairId)}?metric=${encodeURIComponent(metric)}`,
    ),

  status: (comparisonId: string) =>
    request<ComparisonStatus>(
      `/comparisons/${encodeURIComponent(comparisonId)}/status`,
    ),

  /**
   * A budget-limited view of a subtree, with comparison values in the same
   * response when `compare` is given.
   *
   * This is the call the whole design exists for: the client never receives
   * the full tree, only as much of it as the budget allows, and asks again
   * with a different `root` to go deeper.
   */
  slice: (
    treeId: string,
    options: {
      root?: number;
      budget?: number;
      compare?: string;
      metric?: string;
      order?: "size" | "difference";
      /** A node to draw as itself rather than summarise into a wedge. */
      keep?: number;
      signal?: AbortSignal;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.root !== undefined) query.set("root", String(options.root));
    query.set("budget", String(options.budget ?? 500));
    if (options.compare) query.set("compare", options.compare);
    if (options.metric) query.set("metric", options.metric);
    if (options.order) query.set("order", options.order);
    if (options.keep !== undefined) query.set("keep", String(options.keep));
    return request<TreeSlice>(
      `/trees/${encodeURIComponent(treeId)}/slice?${query}`,
      { signal: options.signal },
    );
  },

  /**
   * The nearest ancestor of `node` worth rooting a view at.
   *
   * Needed because a panel holds its tree only as the slice it asked for, so
   * it knows nothing about the ancestors of a node in the *other* tree — and
   * "find this leaf over there" resolves to exactly that: a node outside the
   * other panel's slice, usually a tip, which alone draws as one dot.
   */
  ancestor: (
    treeId: string,
    node: number,
    options: { minLeaves?: number; maxLeaves?: number; signal?: AbortSignal } = {},
  ) => {
    const query = new URLSearchParams({ node: String(node) });
    if (options.minLeaves !== undefined) query.set("min_leaves", String(options.minLeaves));
    if (options.maxLeaves !== undefined) query.set("max_leaves", String(options.maxLeaves));
    return request<NodeContext>(
      `/trees/${encodeURIComponent(treeId)}/ancestor?${query}`,
      { signal: options.signal },
    );
  },

  isolateKeys: (isolateSet: string) =>
    request<IsolateKeys>(`/isolates/${encodeURIComponent(isolateSet)}/keys`),

  /**
   * Typing-data composition for the leaves currently on screen.
   *
   * POST rather than GET because the leaf list is the request: a slice can
   * name hundreds of sequence types, which is past what belongs in a URL.
   */
  compositions: (
    isolateSet: string,
    body: { leaves: string[]; segment_by: string; filter?: Record<string, string[]> },
  ) =>
    request<CompositionResponse>(
      `/isolates/${encodeURIComponent(isolateSet)}/compositions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: {}, ...body }),
      },
    ),

  upload: (form: FormData) =>
    request<UploadAccepted>("/comparisons", { method: "POST", body: form }),

  remove: (comparisonId: string) =>
    request<{ id: string; bytes_freed: number }>(
      `/comparisons/${encodeURIComponent(comparisonId)}`,
      { method: "DELETE" },
    ),
};
