/**
 * ScriptRunner REST Endpoint: Field Configuration Schemes
 *
 * Returns all field configuration schemes with their issue type → field configuration mappings
 * and associated projects. Unavailable via REST API on Jira DC 10.x.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/fieldConfigurationSchemes
 * Query params:
 *   id (optional) - return a single scheme by ID
 *
 * Response: { "fieldConfigurationSchemes": [ { "id", "name", "mappings": [...], "projects": [...] } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.config.IssueTypeManager
import com.atlassian.jira.issue.fields.layout.field.EditableFieldLayout
import com.atlassian.jira.issue.fields.layout.field.FieldConfigurationScheme
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutManager
import com.atlassian.jira.issue.issuetype.IssueType
import com.atlassian.jira.project.Project
import com.atlassian.jira.project.ProjectManager

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

fieldConfigurationSchemes(httpMethod: "GET") { MultivaluedMap queryParams ->
    FieldLayoutManager fieldLayoutManager = ComponentAccessor.getComponent(FieldLayoutManager)
    ProjectManager projectManager = ComponentAccessor.projectManager
    IssueTypeManager issueTypeManager = ComponentAccessor.getObject(IssueTypeManager)

    String filterById = queryParams.getFirst("id") as String

    List<FieldConfigurationScheme> schemes = fieldLayoutManager.getFieldConfigurationSchemes() as List<FieldConfigurationScheme>

    if (filterById) {
        Long targetId = filterById as Long
        schemes = schemes.findAll { FieldConfigurationScheme it -> it.id == targetId }
    }

    List<Map<String, Object>> results = schemes.collect { FieldConfigurationScheme scheme ->
        List<Map<String, Object>> mappings = []
        Collection<IssueType> allIssueTypes = issueTypeManager.getIssueTypes()

        // Get the default (unmapped) field layout
        Long defaultEntity = scheme.getFieldLayoutId(null)
        EditableFieldLayout defaultLayout = defaultEntity ?
            fieldLayoutManager.getEditableFieldLayout(defaultEntity) : null

        mappings.add([
            issueTypeId    : null,
            issueTypeName  : "Default",
            fieldConfigId  : defaultLayout?.id,
            fieldConfigName: defaultLayout?.name ?: "Default Field Configuration"
        ] as Map<String, Object>)

        // Get explicit issue type mappings
        allIssueTypes.each { IssueType issueType ->
            Long layoutId = scheme.getFieldLayoutId(issueType.id)
            if (layoutId != defaultEntity) {
                EditableFieldLayout layout = fieldLayoutManager.getEditableFieldLayout(layoutId)
                mappings.add([
                    issueTypeId    : issueType.id,
                    issueTypeName  : issueType.name,
                    fieldConfigId  : layout?.id,
                    fieldConfigName: layout?.name ?: "Default Field Configuration"
                ] as Map<String, Object>)
            }
        }

        // Get associated projects
        List<Map<String, Object>> projects = projectManager.getProjects().findAll { Project project ->
            FieldConfigurationScheme projectScheme = fieldLayoutManager.getFieldConfigurationScheme(project)
            projectScheme?.id == scheme.id
        }.collect { Project project ->
            [id: project.id, key: project.key, name: project.name] as Map<String, Object>
        }

        Map<String, Object> schemeMap = [
            id          : scheme.id,
            name        : scheme.name,
            description : scheme.description,
            mappings    : mappings,
            projects    : projects
        ]
        return schemeMap
    }

    Response.ok(new JsonBuilder([fieldConfigurationSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}
