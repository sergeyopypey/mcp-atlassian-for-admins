/**
 * ScriptRunner script-registry export.
 *
 * `dump_script_registry` reproduces ScriptRunner's "Export all scripts" bundle
 * on disk: every configured artifact (listeners, REST endpoints, jobs,
 * behaviours, UI fragments, script fields, resources, workflow functions, JQL
 * function filters) as JSON, the script-root `.groovy` tree, instance metadata,
 * and the `Output.csv` summary.
 *
 * Why not call the export endpoint and hand back the zip? The bundle is a binary
 * archive and is only useful unpacked, so this is the one tool that writes to
 * the local filesystem (every other tool just returns a JSON string). All writes
 * are confined under `output_dir`.
 */

import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ToolDef } from "./types.js";
import { dumps } from "../json.js";
import { isHttpStatusError } from "../errors.js";
import { unzipBuffer } from "../zip.js";

export const scriptRegistryTools: ToolDef[] = [
  {
    name: "dump_script_registry",
    description:
      "Export the full ScriptRunner script registry to a directory, reproducing " +
      "ScriptRunner's 'Export all scripts' bundle: all listeners, REST endpoints, " +
      "jobs, behaviours, UI fragments, script fields, resources, workflow functions " +
      "and JQL filters (as JSON config items with their inline scripts), the " +
      "script-root .groovy files, instance metadata, and Output.csv. " +
      "Unlike other tools this WRITES TO THE LOCAL FILESYSTEM under output_dir.",
    inputShape: {
      output_dir: z
        .string()
        .describe("Directory to write the export bundle into (created if missing)."),
      active_only: z.coerce
        .boolean()
        .optional()
        .describe(
          "If true, use ScriptRunner's 'Export active scripts only'. This is not just " +
            "the full export minus disabled items: ScriptRunner also leaves out whole " +
            "item types, depending on its version — script fields are always omitted, " +
            "and some versions omit all workflow functions too. Default false exports " +
            "everything; use it when the full inventory matters.",
        ),
    },
    async handler({ client }, args) {
      const activeOnly: boolean = args.active_only ?? false;
      let zip: Buffer;
      try {
        zip = await client.exportScriptRegistryZip(activeOnly);
      } catch (e) {
        if (isHttpStatusError(e) && e.status === 404) {
          return dumps({
            error:
              "ScriptRunner's script export endpoint is not available on this instance " +
              "(HTTP 404 for /rest/scriptrunner/latest/script/export). The installed " +
              "ScriptRunner likely predates 'Export all scripts' (e.g. 7.x); check its " +
              "version with dump_plugin_inventory.",
          });
        }
        throw e;
      }
      const entries = unzipBuffer(zip);

      const outDir = path.resolve(args.output_dir);
      const countsByFolder: Record<string, number> = {};
      let fileCount = 0;

      for (const entry of entries) {
        if (entry.path.endsWith("/")) continue; // directory marker — created on demand

        const dest = path.join(outDir, entry.path);
        // Zip-slip guard: never let an entry escape output_dir.
        const rel = path.relative(outDir, dest);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new Error(`Refusing to write entry outside output_dir: ${entry.path}`);
        }

        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, entry.data);

        fileCount++;
        const top = entry.path.split("/")[0];
        countsByFolder[top] = (countsByFolder[top] ?? 0) + 1;
      }

      return dumps({
        outputDir: outDir,
        activeOnly,
        zipBytes: zip.length,
        fileCount,
        countsByFolder,
      });
    },
  },
];
