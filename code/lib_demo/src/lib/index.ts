/**
 * Public API for the phylogenetic-tree presentation library.
 *
 * A consuming app builds a viewer, feeds it a plain `NewickNode` tree, and
 * attaches operators:
 *
 *   import { TreeViewer, SelectionOperator, parseNewick } from "./lib";
 *
 *   const viewer = new TreeViewer(container, { layoutMode: "cladogram" });
 *   new SelectionOperator().attach(viewer);
 *   viewer.setTree(parseNewick(newickString));
 *
 * Nothing here knows about a specific dataset, fetching, or page layout — that
 * is the application's job, so the library can be reused across projects.
 */

// --- Tree model & data ---
export type { NewickNode, LayoutMode, IsCollapsed, ChildOrder } from "./presentation/tree/types";
export { NEVER_COLLAPSED } from "./presentation/tree/types";
export {
  maxRootDist,
  maxDepth,
  subtreeSize,
  countLeaves,
  getSubtreeLeaves,
  rerootTree,
  prepareTree,
  orderByName,
  orderByNumeric,
  orderBySizeDesc,
} from "./presentation/tree/model";
export { parseNewick } from "./presentation/tree/newick";
export { leafNamesOf, mrcaId } from "./presentation/tree/navigation";

// --- Layout (extend via new LayoutEngine + LAYOUT_ENGINES registry) ---
export type { LayoutNode, LayoutEngine, LayoutContext, BuiltGraph } from "./presentation/tree/layout";
export { buildGraph, LAYOUT_ENGINES, BRANCH_COLOR } from "./presentation/tree/layout";

// --- Viewer core ---
export { TreeViewer, FILTER_DIM_COLOR } from "./presentation/viewer/tree_viewer";
export type {
  TreeViewerOptions,
  ViewerEvents,
  NodeReducer,
  EdgeReducer,
  LeafFilter,
} from "./presentation/viewer/tree_viewer";
export { Emitter } from "./presentation/viewer/emitter";
export type { Handler } from "./presentation/viewer/emitter";

// --- Color ---
export { CategoricalColorScale, DEFAULT_PALETTE } from "./presentation/color/color_scale";
export {
  SequentialColorScale,
  DIFF_PALETTE,
  type SequentialColorScaleOptions,
} from "./presentation/color/color_scale";

// --- Backend-driven leaf data ---
export type { LeafDatum, LeafSegment, LeafDataProvider } from "./presentation/data/leaf_data";
export { datumTotal, datumSegments } from "./presentation/data/leaf_data";

// --- Comparison / difference data ---
export type {
  NodeKeyOf,
  ComparisonValues,
  ComparisonValueProvider,
  DifferenceSet,
  DifferencePredicate,
  CorrespondenceMap,
} from "./presentation/data/comparison";
export { keyByClade, keyByName } from "./presentation/data/comparison";

// --- Operators ---
export type { TreeOperator } from "./presentation/operators/operator";
export { ExpandCollapseOperator } from "./presentation/operators/expand_collapse";
export type { ExpandCollapseOptions } from "./presentation/operators/expand_collapse";
export { CladeShapePresenter } from "./presentation/operators/clade_shape";
export type { CladeShapeOptions } from "./presentation/operators/clade_shape";
export type { ExpandMode } from "./presentation/operators/expand_collapse";
export { SubtreeNavigator } from "./presentation/operators/subtree_navigator";
export type { SubtreeStep } from "./presentation/operators/subtree_navigator";
export { SelectionOperator } from "./presentation/operators/selection";
export type { SelectionOptions } from "./presentation/operators/selection";
export { BarChartPresenter } from "./presentation/operators/barchart_presenter";
export type { BarChartOptions, BarScale } from "./presentation/operators/barchart_presenter";
export { ComparisonOperator } from "./presentation/operators/comparison";
export type { ComparisonOptions, ComparisonMode } from "./presentation/operators/comparison";

// --- Performance layer (generic caching; no tree/Sigma/API knowledge) ---
export { CacheManager } from "./performance/cache_manager";
export type { CacheManagerOptions, CacheCallback } from "./performance/cache_manager";
export { CacheEntry } from "./performance/cache_entry";
export type { CacheTier } from "./performance/cache_entry";
export { DoubleLinkedList } from "./performance/double_linked_list";
export type { Linkable } from "./performance/double_linked_list";

// --- Config-driven bootstrap ---
export { createViewer, createComparison, createFromConfig } from "./config/config";
export type {
  Config,
  ViewerConfig,
  OperatorsConfig,
  PanelConfig,
  ExpandCollapseConfig,
  CladeShapeConfig,
  SelectionConfig,
  BarChartConfig,
  ComparisonConfig,
  DataProviders,
  ViewerProviders,
  ComparisonProviders,
  ViewerHandle,
  ComparisonHandle,
  PanelOperators,
} from "./config/config";
