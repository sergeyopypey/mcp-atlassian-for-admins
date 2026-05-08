/**
 * ScriptRunner REST Endpoint: Field Configuration Schemes
 *
 * Returns field configuration schemes with their issue type → field configuration
 * mappings and associated projects. Unavailable via REST API on Jira DC 10.x.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpFieldConfigurationSchemes
 * Query params:
 *   id (optional) - return a single scheme by ID
 *
 * Schemes are enumerated by walking projects: the global
 * FieldLayoutManager.getFieldConfigurationSchemes() throws an internal NPE on
 * instances that have an orphaned scheme (DefaultFieldLayoutManager:388). As a
 * result only schemes assigned to at least one project are returned.
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

jiraMcpFieldConfigurationSchemes(httpMethod: "GET") { MultivaluedMap queryParams ->
    FieldLayoutManager fieldLayoutManager = ComponentAccessor.getComponent(FieldLayoutManager)
    ProjectManager projectManager = ComponentAccessor.projectManager
    IssueTypeManager issueTypeManager = ComponentAccessor.getComponent(IssueTypeManager)

    String filterById = queryParams.getFirst("id") as String

    // Enumerate schemes by walking projects — the global
    // getFieldConfigurationSchemes() NPEs on instances with an orphaned scheme.
    // Project associations are collected in the same pass.
    Map<Long, FieldConfigurationScheme> schemeById = [:]
    Map<Long, List<Map<String, Object>>> projectsByScheme = [:]
    projectManager.getProjects().each { Project project ->
        try {
            FieldConfigurationScheme s = fieldLayoutManager.getFieldConfigurationScheme(project)
            if (s != null) {
                Long sid = s.id as Long
                schemeById[sid] = s
                if (!projectsByScheme.containsKey(sid)) {
                    projectsByScheme[sid] = new ArrayList<Map<String, Object>>()
                }
                projectsByScheme[sid].add(
                    [id: project.id, key: project.key, name: project.name] as Map<String, Object>)
            }
        } catch (Exception ignored) {
        }
    }

    List<FieldConfigurationScheme> schemes = new ArrayList<>(schemeById.values())
    if (filterById) {
        Long targetId = filterById as Long
        schemes = schemes.findAll { FieldConfigurationScheme it -> it.id == targetId }
    }

    Collection<IssueType> allIssueTypes = issueTypeManager.getIssueTypes()

    List<Map<String, Object>> results = schemes.collect { FieldConfigurationScheme scheme ->
        try {
            List<Map<String, Object>> mappings = []

            // Default (unmapped) field layout
            Long defaultEntity = scheme.getFieldLayoutId(null)
            EditableFieldLayout defaultLayout = defaultEntity ?
                fieldLayoutManager.getEditableFieldLayout(defaultEntity) : null
            mappings.add([
                issueTypeId    : null,
                issueTypeName  : "Default",
                fieldConfigId  : defaultLayout?.id,
                fieldConfigName: defaultLayout?.name ?: "Default Field Configuration"
            ] as Map<String, Object>)

            // Explicit issue type mappings
            allIssueTypes.each { IssueType issueType ->
                Long layoutId = scheme.getFieldLayoutId(issueType.id)
                if (layoutId != defaultEntity) {
                    EditableFieldLayout layout = layoutId ?
                        fieldLayoutManager.getEditableFieldLayout(layoutId) : null
                    mappings.add([
                        issueTypeId    : issueType.id,
                        issueTypeName  : issueType.name,
                        fieldConfigId  : layout?.id,
                        fieldConfigName: layout?.name ?: "Default Field Configuration"
                    ] as Map<String, Object>)
                }
            }

            return [
                id         : scheme.id,
                name       : scheme.name,
                description: scheme.description,
                mappings   : mappings,
                projects   : projectsByScheme.get(scheme.id as Long) ?: []
            ] as Map<String, Object>
        } catch (Exception e) {
            return [
                id   : scheme?.id,
                name : scheme?.name,
                error: e.message
            ] as Map<String, Object>
        }
    }

    Response.ok(new JsonBuilder([fieldConfigurationSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}
