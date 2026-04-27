/**
 * ScriptRunner REST Endpoint: Screen Schemes
 *
 * Returns all screen schemes with their operation → screen mappings
 * (Create/Edit/View/Default). Unavailable via REST API on Jira DC 10.x.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpScreenSchemes
 * Query params:
 *   id (optional) - return a single screen scheme by ID
 *
 * Response: { "screenSchemes": [ { "id", "name", "operations": { "default", "create", "edit", "view" } } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.issue.fields.screen.FieldScreen
import com.atlassian.jira.issue.fields.screen.FieldScreenScheme
import com.atlassian.jira.issue.fields.screen.FieldScreenSchemeItem
import com.atlassian.jira.issue.fields.screen.FieldScreenSchemeManager
import com.atlassian.jira.issue.operation.IssueOperation
import com.atlassian.jira.issue.operation.IssueOperations

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

jiraMcpScreenSchemes(httpMethod: "GET") { MultivaluedMap queryParams ->
    FieldScreenSchemeManager screenSchemeManager = ComponentAccessor.getComponent(FieldScreenSchemeManager)

    String filterById = queryParams.getFirst("id") as String

    Collection<FieldScreenScheme> schemes = screenSchemeManager.getFieldScreenSchemes()

    if (filterById) {
        Long targetId = filterById as Long
        schemes = schemes.findAll { FieldScreenScheme it -> it.id == targetId }
    }

    List<Map<String, Object>> results = schemes.collect { FieldScreenScheme scheme ->
        Map<String, Map<String, Object>> operations = [
            "default" : resolveScreenInfo(scheme, null),
            "create"  : resolveScreenInfo(scheme, IssueOperations.CREATE_ISSUE_OPERATION),
            "edit"    : resolveScreenInfo(scheme, IssueOperations.EDIT_ISSUE_OPERATION),
            "view"    : resolveScreenInfo(scheme, IssueOperations.VIEW_ISSUE_OPERATION)
        ]

        Map<String, Object> schemeMap = [
            id          : scheme.id,
            name        : scheme.name,
            description : scheme.description,
            operations  : operations
        ]
        return schemeMap
    }

    Response.ok(new JsonBuilder([screenSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}

Map<String, Object> resolveScreenInfo(FieldScreenScheme scheme, IssueOperation issueOp) {
    FieldScreenSchemeItem schemeItem = scheme.getFieldScreenSchemeItem(issueOp)
    if (schemeItem) {
        FieldScreen screen = schemeItem.fieldScreen
        return [screenId: screen?.id, screenName: screen?.name] as Map<String, Object>
    }
    return null
}
