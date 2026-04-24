/**
 * ScriptRunner REST Endpoint: Issue Type Screen Schemes
 *
 * Returns all issue type screen schemes with their issue type → screen scheme mappings
 * and associated projects. Unavailable via REST API on Jira DC 10.x.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/issueTypeScreenSchemes
 * Query params:
 *   id (optional) - return a single scheme by ID
 *
 * Response: { "issueTypeScreenSchemes": [ { "id", "name", "mappings": [...], "projects": [...] } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.config.IssueTypeManager
import com.atlassian.jira.issue.fields.screen.FieldScreenScheme
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenScheme
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenSchemeEntity
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenSchemeManager
import com.atlassian.jira.issue.issuetype.IssueType
import com.atlassian.jira.project.Project

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

issueTypeScreenSchemes(httpMethod: "GET") { MultivaluedMap queryParams ->
    IssueTypeScreenSchemeManager issueTypeScreenSchemeManager = ComponentAccessor.getComponent(IssueTypeScreenSchemeManager)
    IssueTypeManager issueTypeManager = ComponentAccessor.getObject(IssueTypeManager)

    String filterById = queryParams.getFirst("id") as String

    Collection<IssueTypeScreenScheme> schemes = issueTypeScreenSchemeManager.getIssueTypeScreenSchemes()

    if (filterById) {
        Long targetId = filterById as Long
        schemes = schemes.findAll { IssueTypeScreenScheme it -> it.id == targetId }
    }

    List<Map<String, Object>> results = schemes.collect { IssueTypeScreenScheme scheme ->
        List<Map<String, Object>> mappings = []

        Collection<IssueTypeScreenSchemeEntity> entities = scheme.getEntities()
        entities.each { IssueTypeScreenSchemeEntity entity ->
            String issueTypeId = entity.issueTypeId
            String issueTypeName = "Default"
            if (issueTypeId) {
                IssueType issueType = issueTypeManager.getIssueType(issueTypeId)
                issueTypeName = issueType?.name ?: issueTypeId
            }

            FieldScreenScheme screenScheme = entity.fieldScreenScheme
            mappings.add([
                issueTypeId      : issueTypeId,
                issueTypeName    : issueTypeName,
                screenSchemeId   : screenScheme?.id,
                screenSchemeName : screenScheme?.name
            ] as Map<String, Object>)
        }

        // Get associated projects
        Collection<Project> associatedProjects = issueTypeScreenSchemeManager.getProjects(scheme)
        List<Map<String, Object>> projects = associatedProjects.collect { Project project ->
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

    Response.ok(new JsonBuilder([issueTypeScreenSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}
