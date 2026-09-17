/** Atlassian Assets (formerly Insight) introspection tools — read-only, DC/IQL. */

import { z } from "zod";
import { dumps } from "../json.js";
import { boundedAll } from "../client.js";
import type { ToolDef } from "./types.js";

/** Compact an object type into the fields that matter for a structure audit. */
function compactObjectType(t: any): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    parentObjectTypeId: t.parentObjectTypeId ?? null,
    objectSchemaId: t.objectSchemaId,
    position: t.position,
    abstract: t.abstractObjectType ?? false,
    inherited: t.inherited ?? false,
    icon: t.icon ? (t.icon.name ?? null) : null,
  };
}

/** Compact an attribute definition (the heart of a schema dump). */
function compactAttribute(a: any): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    label: a.label ?? false,
    type: a.type,
    defaultType: a.defaultType ? (a.defaultType.name ?? null) : null,
    referenceObjectTypeId: a.referenceObjectTypeId ?? null,
    referenceType: a.referenceType ? (a.referenceType.name ?? null) : null,
    minimumCardinality: a.minimumCardinality,
    maximumCardinality: a.maximumCardinality,
    required: a.minimumCardinality ? a.minimumCardinality > 0 : false,
    editable: a.editable ?? null,
  };
}

const IQL_DEFAULT_MAX_RESULTS = 25;

/**
 * Compact an object's attribute values for search results: each value becomes
 * its display value, and a reference becomes {id, objectKey, label} instead of
 * the full nested object (avatar, links, timestamps) Assets embeds.
 */
function compactAttributeValues(attributes: any[] | undefined): Array<Record<string, unknown>> {
  return (attributes ?? []).map((a: any) => ({
    objectTypeAttributeId: a.objectTypeAttributeId,
    values: (a.objectAttributeValues ?? []).map((v: any) =>
      v.referencedObject
        ? {
            id: v.referencedObject.id,
            objectKey: v.referencedObject.objectKey,
            label: v.referencedObject.label,
          }
        : (v.displayValue ?? v.value ?? null),
    ),
  }));
}

export const assetsTools: ToolDef[] = [
  {
    name: "list_object_schemas",
    description:
      "List all Atlassian Assets (Insight) object schemas with key, status, and " +
      "object/object-type counts. Start here to find a schema_id for the other Assets tools.",
    inputShape: {},
    async handler({ client }) {
      const schemas = await client.listObjectSchemas();
      return dumps(
        schemas.map((s: any) => ({
          id: s.id,
          name: s.name,
          objectSchemaKey: s.objectSchemaKey,
          status: s.status,
          objectCount: s.objectCount,
          objectTypeCount: s.objectTypeCount,
          description: (s.description || "").slice(0, 200),
        })),
      );
    },
  },

  {
    name: "get_object_schema",
    description: "Get one Assets object schema's metadata by ID (name, key, status, counts).",
    inputShape: {
      schema_id: z.coerce.number().int().describe("Object schema ID (from list_object_schemas)"),
    },
    async handler({ client }, args) {
      return dumps(await client.getObjectSchema(args.schema_id));
    },
  },

  {
    name: "list_object_types",
    description:
      "List the object types within an Assets schema (e.g. Server, Laptop, Employee). " +
      "Returns a flat list by default; set hierarchical=true to preserve the parent tree.",
    inputShape: {
      schema_id: z.coerce.number().int().describe("Object schema ID (from list_object_schemas)"),
      hierarchical: z
        .boolean()
        .optional()
        .describe("Return the nested type tree instead of a flat list (default false)"),
    },
    async handler({ client }, args) {
      const types = await client.listObjectTypes(args.schema_id, args.hierarchical ?? false);
      return dumps(types.map(compactObjectType));
    },
  },

  {
    name: "get_object_type",
    description:
      "Get one Assets object type's metadata by ID (parent, position, abstract flag, icon).",
    inputShape: {
      object_type_id: z.coerce.number().int().describe("Object type ID (from list_object_types)"),
    },
    async handler({ client }, args) {
      return dumps(compactObjectType(await client.getObjectType(args.object_type_id)));
    },
  },

  {
    name: "get_object_type_attributes",
    description:
      "Get the attribute definitions for an Assets object type — name, data type, references, " +
      "cardinality, and whether required. The core of auditing a schema's structure.",
    inputShape: {
      object_type_id: z.coerce.number().int().describe("Object type ID (from list_object_types)"),
    },
    async handler({ client }, args) {
      const attrs = await client.getObjectTypeAttributes(args.object_type_id);
      return dumps(attrs.map(compactAttribute));
    },
  },

  {
    name: "get_schema_attributes",
    description:
      "Get all attribute definitions across an entire Assets schema in one list — a fast way " +
      "to survey every field defined in the schema regardless of object type.",
    inputShape: {
      schema_id: z.coerce.number().int().describe("Object schema ID (from list_object_schemas)"),
    },
    async handler({ client }, args) {
      const attrs = await client.getSchemaAttributes(args.schema_id);
      return dumps(attrs.map(compactAttribute));
    },
  },

  {
    name: "list_object_statuses",
    description:
      "List Assets status types and their categories. Returns global status types, or only " +
      "those scoped to a schema when schema_id is provided.",
    inputShape: {
      schema_id: z
        .coerce.number()
        .int()
        .optional()
        .describe("Optional object schema ID to scope the statuses (default: global)"),
    },
    async handler({ client }, args) {
      const statuses = await client.listObjectStatuses(args.schema_id);
      return dumps(
        statuses.map((s: any) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          objectSchemaId: s.objectSchemaId ?? null,
          description: (s.description || "").slice(0, 200),
        })),
      );
    },
  },

  {
    name: "search_objects_iql",
    description:
      'Search Assets objects with IQL (Insight Query Language), e.g. \'objectType = "Laptop" ' +
      'AND Status = "In Use"\'. Supports AND/OR/NOT, IN(...), LIKE, dot-walking ' +
      '(Department.Name = "IT"), and "order by". Returns the total match count and up to ' +
      `max_results objects (default ${IQL_DEFAULT_MAX_RESULTS}); each attribute is given as ` +
      "objectTypeAttributeId (names via get_object_type_attributes) with its display values, " +
      "references as {id, objectKey, label}. Narrow the IQL rather than raising max_results: " +
      "every object carries all its attributes, so for attribute-heavy types (15+ attributes) " +
      "a few dozen objects can already exceed the response size limit and the call fails. " +
      "Use get_object for one object's full detail.",
    inputShape: {
      iql: z.string().describe('IQL query string, e.g. \'objectType = "Server"\''),
      schema_id: z
        .coerce.number()
        .int()
        .optional()
        .describe("Optional object schema ID to scope the search"),
      max_results: z
        .coerce.number()
        .int()
        .optional()
        .describe(`Cap the number of objects returned (default ${IQL_DEFAULT_MAX_RESULTS})`),
    },
    async handler({ client }, args) {
      const { objects, total } = await client.searchObjectsIql(args.iql, {
        objectSchemaId: args.schema_id,
        maxResults: args.max_results ?? IQL_DEFAULT_MAX_RESULTS,
      });
      return dumps({
        total,
        returned: objects.length,
        objects: objects.map((o: any) => ({
          id: o.id,
          label: o.label,
          objectKey: o.objectKey,
          objectType: o.objectType ? (o.objectType.name ?? null) : null,
          attributes: compactAttributeValues(o.attributes),
        })),
      });
    },
  },

  {
    name: "get_object",
    description:
      "Get one Assets object by ID with its attribute values — full detail for a single asset.",
    inputShape: {
      object_id: z.coerce.number().int().describe("Object ID (from search_objects_iql)"),
    },
    async handler({ client }, args) {
      const obj = await client.getObject(args.object_id);
      return dumps({
        id: obj.id,
        label: obj.label,
        objectKey: obj.objectKey,
        objectType: obj.objectType ? (obj.objectType.name ?? null) : null,
        created: obj.created,
        updated: obj.updated,
        attributes: obj.attributes ?? (await client.getObjectAttributes(args.object_id)),
      });
    },
  },

  {
    name: "get_object_connected_tickets",
    description: "Get the Jira issues/tickets connected to an Assets object.",
    inputShape: {
      object_id: z.coerce.number().int().describe("Object ID (from search_objects_iql)"),
    },
    async handler({ client }, args) {
      return dumps(await client.getObjectConnectedTickets(args.object_id));
    },
  },

  {
    name: "dump_assets_schema",
    description:
      "Dump an entire Assets schema's structure in one call: the schema metadata, its status " +
      "types, and every object type with its full attribute definitions. The Assets equivalent " +
      "of dump_global_config — a complete structural snapshot for auditing.",
    inputShape: {
      schema_id: z.coerce.number().int().describe("Object schema ID (from list_object_schemas)"),
    },
    async handler({ client }, args) {
      const schemaId = args.schema_id;
      const [schema, statuses, types] = await Promise.all([
        client.getObjectSchema(schemaId),
        client.listObjectStatuses(schemaId),
        client.listObjectTypes(schemaId, false),
      ]);

      // Fetch each type's attributes in parallel, bounded so DC isn't overwhelmed.
      const attrLists = await boundedAll(
        types.map((t: any) => () => client.getObjectTypeAttributes(t.id)),
      );

      return dumps({
        schema: {
          id: schema.id,
          name: schema.name,
          objectSchemaKey: schema.objectSchemaKey,
          status: schema.status,
          objectCount: schema.objectCount,
          objectTypeCount: schema.objectTypeCount,
        },
        statuses: statuses.map((s: any) => ({ id: s.id, name: s.name, category: s.category })),
        objectTypes: types.map((t: any, i: number) => ({
          ...compactObjectType(t),
          attributes: (attrLists[i] ?? []).map(compactAttribute),
        })),
      });
    },
  },
];
