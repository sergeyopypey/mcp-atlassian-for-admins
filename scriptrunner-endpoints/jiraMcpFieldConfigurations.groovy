/**
 * ScriptRunner REST Endpoint: Field Configurations
 *
 * Returns all field configurations with their field items (required, hidden, renderer, description).
 * This data is unavailable via REST API on Jira DC 10.x (GET /rest/api/2/fieldconfiguration → 404).
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpFieldConfigurations
 * Query params:
 *   id (optional) - return a single field configuration by ID
 *
 * Response: { "fieldConfigurations": [ { "id", "name", "description", "isDefault", "fields": [...] } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.issue.fields.FieldManager
import com.atlassian.jira.issue.fields.Field
import com.atlassian.jira.issue.fields.layout.field.EditableFieldLayout
import com.atlassian.jira.issue.fields.layout.field.FieldLayout
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutItem
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutManager

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

jiraMcpFieldConfigurations(httpMethod: "GET") { MultivaluedMap queryParams ->
    FieldLayoutManager fieldLayoutManager = ComponentAccessor.getComponent(FieldLayoutManager)
    FieldManager fieldManager = ComponentAccessor.fieldManager

    String filterById = queryParams.getFirst("id") as String

    List<EditableFieldLayout> layouts = fieldLayoutManager.getEditableFieldLayouts() as List<EditableFieldLayout>

    if (filterById) {
        Long targetId = filterById as Long
        layouts = layouts.findAll { EditableFieldLayout it -> it.id == targetId }
    }

    List<Map<String, Object>> results = layouts.collect { FieldLayout layout ->
        List<Map<String, Object>> items = layout.getFieldLayoutItems().collect { FieldLayoutItem item ->
            String fieldId = item.orderableField?.id ?: item.fieldDescriptor?.get("id") as String
            String fieldName = null
            try {
                Field field = fieldManager.getField(fieldId)
                fieldName = field?.name
            } catch (Exception e) {
                fieldName = fieldId
            }

            Map<String, Object> fieldMap = [
                fieldId       : fieldId,
                fieldName     : fieldName,
                isRequired    : item.isRequired(),
                isHidden      : item.isHidden(),
                rendererType  : item.rendererType,
                description   : item.fieldDescription
            ]
            return fieldMap
        }

        Map<String, Object> layoutMap = [
            id          : layout.id,
            name        : layout.name ?: "Default Field Configuration",
            description : layout.description,
            isDefault   : layout.isDefault(),
            fieldCount  : items.size(),
            fields      : items
        ]
        return layoutMap
    }

    Response.ok(new JsonBuilder([fieldConfigurations: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}
