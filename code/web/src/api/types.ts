/**
 * The wire contract, as TypeScript.
 *
 * Hand-written rather than generated, deliberately: the surface is small, and
 * a generated client would bring a build step and a lot of types nothing uses.
 * These mirror `api/schemas.py` — if the two disagree, that file is right.
 *
 * Two conventions run through all of it (see the server's OpenAPI description):
 *
 * - **Node identity is the pre-order index in the stored tree.** One integer
 *   addresses a node in the topology, in a comparison, and in the next request.
 * - **Payloads are positional.** Parallel arrays in one agreed order; entry *k*
 *   of every array describes the same node. Comparison values for a slice line
 *   up index for index with its topology, so there is no join.
 */

export interface WhoAmI {
  owner_id: string;
  subject: string;
  issuer: string;
  email: string;
  display_name: string;
  mock: boolean;
}

export interface SliceNodes {
  /** Pre-order index in the STORED tree. The join key for everything else. */
  id: number[];
  /** Index into THESE arrays, or -1 at the slice root. Not a stored id. */
  parent: number[];
  label: string[];
  branch_len: (number | null)[];
  /** Leaves beneath this node in the FULL tree, not the number returned here. */
  true_leaf_count: number[];
  /** True where this tip stands for a clade that was not expanded. */
  truncated: boolean[];
}

export interface ComparisonValues {
  similarity: (number | null)[];
  corresponds: (number | null)[];
  columns?: Record<string, (number | null)[]>;
}

export interface TreeSlice {
  tree: string;
  root: number;
  budget: number;
  displayed_leaves: number;
  hidden_leaves: number;
  total_leaves: number;
  nodes: SliceNodes;
  comparison?: ComparisonValues | null;
}

export interface TreeSummary {
  id: string;
  species: string;
  method: string;
  n_nodes: number;
  n_leaves: number;
  max_depth: number;
}

export interface PairSummary {
  id: string;
  left: string;
  right: string;
  species: string;
  same_species: boolean | null;
  label_match: string;
  shared_leaves: number;
  shared_fraction: number;
  caution: string | null;
  metrics: string[];
  status: "pending" | "running" | "ready" | "failed";
}

export interface IsolateSummary {
  species: string;
  n_rows: number;
  keys: string[];
}

export interface DatasetsResponse {
  trees: TreeSummary[];
  pairs: PairSummary[];
  isolates: IsolateSummary[];
}

export interface ComparisonSummary {
  pair_id: string;
  left: string;
  right: string;
  metric: string;
  summary: Record<string, number>;
  same_species: boolean | null;
  caution: string | null;
}

export interface UploadAccepted {
  id: string;
  status: string;
  left_id: string;
  right_id: string;
  poll: string;
}

export interface ComparisonStatus {
  id: string;
  status: "pending" | "running" | "ready" | "failed";
  display_name: string;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  ready: boolean;
}

/** Every failure from the API carries this shape. */
export interface ApiErrorBody {
  detail: string;
  code: string;
  hint: string | null;
}
