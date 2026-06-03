/** Plugin (app) inventory tools — read-only, via the native UPM REST API. */

import { z } from "zod";
import { dumps } from "../json.js";
import { boundedAll } from "../client.js";
import type { ToolDef } from "./types.js";

/** Compact a plugin record plus its (optional) license into inventory fields. */
function compactPlugin(p: any, license: any): Record<string, unknown> {
  return {
    key: p.key,
    name: p.name,
    version: p.version,
    enabled: p.enabled ?? null,
    userInstalled: p.userInstalled ?? null,
    vendor: p.vendor ? (p.vendor.name ?? null) : null,
    license: license
      ? {
          valid: license.valid ?? null,
          licenseType: license.licenseType ?? null,
          evaluation: license.evaluation ?? null,
          maintenanceExpiryDate: license.maintenanceExpiryDate ?? null,
          supportEntitlementNumber: license.supportEntitlementNumber ?? null,
        }
      : null,
    description: (p.description || "").slice(0, 200),
  };
}

export const pluginTools: ToolDef[] = [
  {
    name: "dump_plugin_inventory",
    description:
      "Dump the installed apps (plugins) on this Jira instance: key, name, version, " +
      "enabled state, vendor, and license (validity, type, evaluation flag, maintenance " +
      "expiry). Lists Marketplace/admin-installed apps by default; set include_system=true " +
      "to also include bundled/system plugins. Uses the native UPM REST API.",
    inputShape: {
      include_system: z
        .boolean()
        .optional()
        .describe(
          "Include bundled/system plugins (userInstalled=false). " +
            "Default false: only Marketplace/admin-installed apps.",
        ),
    },
    async handler({ client }, args) {
      const all = await client.listPlugins();
      const plugins = args.include_system ? all : all.filter((p: any) => p.userInstalled === true);

      // Fetch each plugin's license in parallel, bounded so DC isn't overwhelmed.
      const licenses = await boundedAll(
        plugins.map((p: any) => () => client.getPluginLicense(p.key)),
      );

      return dumps({
        count: plugins.length,
        includesSystem: args.include_system ?? false,
        plugins: plugins.map((p: any, i: number) => compactPlugin(p, licenses[i] ?? null)),
      });
    },
  },
];
