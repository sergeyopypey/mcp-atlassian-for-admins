/**
 * ScriptRunner REST Endpoint: Custom Field Contexts
 *
 * Returns custom field contexts with project and issue type scoping.
 * Replaces the fragile internal API /rest/internal/2/field/{id}/context.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/customFieldContexts
 * Query params:
 *   fieldId (optional) - filter to a single field (e.g., "customfield_10001")
 *
 * Response: { "fields": [ { "fieldId", "fieldName", "contexts": [...] } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.config.IssueTypeManager
import com.atlassian.jira.issue.CustomFieldManager
import com.atlassian.jira.issue.fields.CustomField
import com.atlassian.jira.issue.fields.config.FieldConfigScheme
import com.atlassian.jira.issue.issuetype.IssueType
import com.atlassian.jira.project.Project

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

customFieldContexts(httpMethod: "GET") { MultivaluedMap queryParams ->
    CustomFieldManager customFieldManager = ComponentAccessor.customFieldManager
    IssueTypeManager issueTypeManager = ComponentAccessor.getObject(IssueTypeManager)

    String filterFieldId = queryParams.getFirst("fieldId") as String

    List<CustomField> customFields = customFieldManager.getCustomFieldObjects()

    if (filterFieldId) {
        customFields = customFields.findAll { CustomField it -> it.id == filterFieldId }
    }

    List<Map<String, Object>> results = customFields.collect { CustomField field ->
        List<FieldConfigScheme> schemes = field.configurationSchemes ?: []

        List<Map<String, Object>> contexts = schemes.collect { FieldConfigScheme scheme ->
            // Get associated projects
            List<Map<String, Object>> projects = scheme.associatedProjectObjects?.collect { Project project ->
                [id: project.id, key: project.key, name: project.name] as Map<String, Object>
            } ?: []

            // Get associated issue types
            Set<String> issueTypeIds = scheme.associatedIssueTypeIds()
            boolean isGlobal = issueTypeIds == null || issueTypeIds.isEmpty() ||
                               issueTypeIds.contains(null)

            List<Map<String, Object>> issueTypes = []
            if (!isGlobal && issueTypeIds) {
                issueTypes = issueTypeIds.findAll { String it -> it != null }.collect { String typeId ->
                    IssueType issueType = issueTypeManager.getIssueType(typeId)
                    [id: typeId, name: issueType?.name ?: typeId] as Map<String, Object>
                }
            }

            Map<String, Object> contextMap = [
                id                : scheme.id,
                name              : scheme.name,
                description       : scheme.description,
                isGlobalProjects  : projects.isEmpty(),
                projects          : projects,
                isAllIssueTypes   : isGlobal,
                issueTypes        : issueTypes
            ]
            return contextMap
        }

        Map<String, Object> fieldMap = [
            fieldId   : field.id,
            fieldName : field.name,
            fieldType : field.customFieldType?.name,
            contexts  : contexts
        ]
        return fieldMap
    }

    Response.ok(new JsonBuilder([fields: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}
