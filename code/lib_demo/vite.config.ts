import { defineConfig } from "vite";
import path from "path";

// Serve the repo-level datasets/ folder at the site root, so its subfolders are
// fetchable directly: trees as fetch("/gen_trees/vibrio-nj-tree.nwk") and
// isolate metadata as fetch("/isolated_data/vibrio.txt"). The datasets live
// outside the app (<repo>/datasets) so they can be shared/regenerated
// independently of this demo.
export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, "../../datasets"),
});
