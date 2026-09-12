/**
 * ScriptRunner REST Endpoints: Jira MCP Admin Endpoints (combined)
 *
 * A single ScriptRunner script that registers every Jira MCP admin REST endpoint.
 * Each closure below is an independent GET endpoint exposed at
 * /rest/scriptrunner/latest/custom/<endpointName>. Paste this one file into a
 * single ScriptRunner REST Endpoint item instead of one item per endpoint.
 *
 * Endpoints:
 *   jiraMcpFieldConfigurations          - field configurations with field items (required/hidden/renderer)
 *   jiraMcpFieldConfigurationSchemes    - field configuration schemes with issue type mappings and projects
 *   jiraMcpScreenSchemes                - screen schemes with operation -> screen mappings
 *   jiraMcpIssueTypeScreenSchemes       - issue type screen schemes with issue type -> screen scheme mappings
 *   jiraMcpCustomFieldContexts          - custom field contexts with project/issue type scoping
 *   jiraMcpListeners                    - all registered event listeners
 *   jiraMcpScheduledServices            - Jira scheduled services (mail handlers, etc.)
 *   jiraMcpApplicationLinks             - application links to Confluence, Bitbucket, etc.
 *   jiraMcpEffectivePermissions         - resolved effective permissions for user+project
 *   jiraMcpExportWorkflow               - workflow OpenSymphony XML descriptor (Jira Administrators only)
 *   jiraMcpServerLog                    - list/tail/grep server log files (System Administrators only)
 *
 * All endpoints are read-only (GET) and return JSON unless noted otherwise.
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.sal.api.component.ComponentLocator
import com.atlassian.applinks.api.ApplicationLink
import com.atlassian.applinks.api.ApplicationLinkService
import com.atlassian.applinks.api.ApplicationType

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.config.IssueTypeManager
import com.atlassian.jira.config.util.JiraHome
import com.atlassian.jira.issue.issuetype.IssueType
import com.atlassian.jira.project.Project
import com.atlassian.jira.project.ProjectManager

import com.atlassian.jira.issue.CustomFieldManager
import com.atlassian.jira.issue.fields.CustomField
import com.atlassian.jira.issue.fields.Field
import com.atlassian.jira.issue.fields.FieldManager
import com.atlassian.jira.issue.fields.config.FieldConfigScheme

import com.atlassian.jira.issue.fields.layout.field.EditableFieldLayout
import com.atlassian.jira.issue.fields.layout.field.FieldConfigurationScheme
import com.atlassian.jira.issue.fields.layout.field.FieldLayout
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutItem
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutManager

import com.atlassian.jira.issue.fields.screen.FieldScreen
import com.atlassian.jira.issue.fields.screen.FieldScreenScheme
import com.atlassian.jira.issue.fields.screen.FieldScreenSchemeItem
import com.atlassian.jira.issue.fields.screen.FieldScreenSchemeManager
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenScheme
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenSchemeEntity
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenSchemeManager
import com.atlassian.jira.issue.operation.IssueOperation
import com.atlassian.jira.issue.operation.IssueOperations

import com.atlassian.jira.event.JiraListener
import com.atlassian.jira.event.ListenerManager
import com.atlassian.jira.service.JiraServiceContainer
import com.atlassian.jira.service.ServiceManager

import com.atlassian.jira.permission.GlobalPermissionKey
import com.atlassian.jira.security.PermissionManager
import com.atlassian.jira.security.plugin.ProjectPermissionKey
import com.atlassian.jira.user.ApplicationUser
import com.atlassian.jira.user.util.UserManager

import com.atlassian.jira.workflow.JiraWorkflow
import com.atlassian.jira.workflow.WorkflowManager
import com.opensymphony.module.propertyset.PropertySet

import org.ofbiz.core.entity.GenericValue

import java.nio.charset.StandardCharsets
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException
import java.util.zip.GZIPInputStream

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

/**
 * Field Configurations
 *
 * Returns all field configurations with their field items (required, hidden, renderer, description).
 * This data is unavailable via REST API on Jira DC 10.x (GET /rest/api/2/fieldconfiguration -> 404).
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpFieldConfigurations
 * Query params:
 *   id (optional) - return a single field configuration by ID
 *
 * Response: { "fieldConfigurations": [ { "id", "name", "description", "isDefault", "fields": [...] } ] }
 */
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
            return fieldMap as Map<String, Object>
        }

        Map<String, Object> layoutMap = [
            id          : layout.id,
            name        : layout.name ?: "Default Field Configuration",
            description : layout.description,
            isDefault   : layout.isDefault(),
            fieldCount  : items.size(),
            fields      : items
        ]
        return layoutMap as Map<String, Object>
    }

    Response.ok(new JsonBuilder([fieldConfigurations: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Field Configuration Schemes
 *
 * Returns field configuration schemes with their issue type -> field configuration
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

/**
 * Screen Schemes
 *
 * Returns all screen schemes with their operation -> screen mappings
 * (Create/Edit/View/Default). Unavailable via REST API on Jira DC 10.x.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpScreenSchemes
 * Query params:
 *   id (optional) - return a single screen scheme by ID
 *
 * Response: { "screenSchemes": [ { "id", "name", "operations": { "default", "create", "edit", "view" } } ] }
 */
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
        return schemeMap as Map<String, Object>
    }

    Response.ok(new JsonBuilder([screenSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Issue Type Screen Schemes
 *
 * Returns all issue type screen schemes with their issue type -> screen scheme mappings
 * and associated projects. Unavailable via REST API on Jira DC 10.x.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpIssueTypeScreenSchemes
 * Query params:
 *   id (optional) - return a single scheme by ID
 *
 * Response: { "issueTypeScreenSchemes": [ { "id", "name", "mappings": [...], "projects": [...] } ] }
 */
jiraMcpIssueTypeScreenSchemes(httpMethod: "GET") { MultivaluedMap queryParams ->
    IssueTypeScreenSchemeManager issueTypeScreenSchemeManager = ComponentAccessor.getComponent(IssueTypeScreenSchemeManager)
    IssueTypeManager issueTypeManager = ComponentAccessor.getComponent(IssueTypeManager)
    ProjectManager projectManager = ComponentAccessor.projectManager

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

        // Get associated projects — getProjects() returns legacy GenericValues,
        // so resolve each to a Project object via the ProjectManager.
        List<Map<String, Object>> projects = []
        (issueTypeScreenSchemeManager.getProjects(scheme) as Collection<GenericValue>).each { GenericValue gv ->
            Project project = projectManager.getProjectObj(gv.getLong("id"))
            if (project != null) {
                projects.add([id: project.id, key: project.key,
                              name: project.name] as Map<String, Object>)
            }
        }

        Map<String, Object> schemeMap = [
            id          : scheme.id,
            name        : scheme.name,
            description : scheme.description,
            mappings    : mappings,
            projects    : projects
        ]
        return schemeMap as Map<String, Object>
    }

    Response.ok(new JsonBuilder([issueTypeScreenSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Custom Field Contexts
 *
 * Returns custom field contexts with project and issue type scoping.
 * Replaces the fragile internal API /rest/internal/2/field/{id}/context.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpCustomFieldContexts
 * Query params:
 *   fieldId (optional) - filter to a single field (e.g., "customfield_10001")
 *
 * Response: { "fields": [ { "fieldId", "fieldName", "contexts": [...] } ] }
 */
jiraMcpCustomFieldContexts(httpMethod: "GET") { MultivaluedMap queryParams ->
    CustomFieldManager customFieldManager = ComponentAccessor.customFieldManager
    IssueTypeManager issueTypeManager = ComponentAccessor.getComponent(IssueTypeManager)

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
            Set<String> issueTypeIds = scheme.getAssociatedIssueTypeIds()
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
            return contextMap as Map<String, Object>
        }

        Map<String, Object> fieldMap = [
            fieldId   : field.id,
            fieldName : field.name,
            fieldType : field.customFieldType?.name,
            contexts  : contexts
        ]
        return fieldMap as Map<String, Object>
    }

    Response.ok(new JsonBuilder([fields: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Event Listeners
 *
 * Returns all registered event listeners in the Jira instance, including
 * built-in, plugin-provided, and ScriptRunner listeners. Completely invisible
 * to the REST API.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpListeners
 *
 * Response: { "listeners": [ { "name", "className", "events", "source" } ] }
 */
jiraMcpListeners(httpMethod: "GET") { MultivaluedMap queryParams ->
    ListenerManager listenerManager = ComponentAccessor.getComponent(ListenerManager)

    List<Map<String, Object>> results = []

    // Get Jira's registered listeners (legacy style)
    try {
        Map<String, JiraListener> registeredListeners = listenerManager.getListeners()
        registeredListeners.each { String id, JiraListener listener ->
            Class<?> listenerClass = listener.getClass()
            String className = listenerClass.name

            String source
            if (className.contains("onresolve")) {
                source = "scriptrunner"
            } else if (className.contains("atlassian")) {
                source = "built-in"
            } else {
                source = "plugin"
            }

            results.add([
                id        : id,
                name      : listener.hasProperty("name") ? listener.name : listenerClass.simpleName,
                className : className,
                source    : source,
                isInternal: className.startsWith("com.atlassian.jira")
            ] as Map<String, Object>)
        }
    } catch (Exception e) {
        results.add([error: "Failed to enumerate legacy listeners: ${e.message}"] as Map<String, Object>)
    }

    Response.ok(new JsonBuilder([
        listeners: results,
        count    : results.size()
    ]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Scheduled Services
 *
 * Returns all Jira scheduled services (mail handlers, backup services, etc.).
 * These run on cron schedules and are invisible to the REST API.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpScheduledServices
 *
 * Response: { "services": [ { "id", "name", "className", "delay", "properties" } ] }
 */
jiraMcpScheduledServices(httpMethod: "GET") { MultivaluedMap queryParams ->
    ServiceManager serviceManager = ComponentAccessor.getComponent(ServiceManager)

    Collection<JiraServiceContainer> services = serviceManager.getServices()
    Set<String> sensitiveKeys = ["password", "secret", "token", "credential", "apikey"] as Set<String>

    List<Map<String, Object>> results = services.collect { JiraServiceContainer service ->
        // Collect service properties (filtering out sensitive ones). getProperties()
        // returns a Jira PropertySet — iterate its keys, not key/value pairs.
        Map<String, String> props = [:]
        PropertySet propertySet = service.properties
        (propertySet?.getKeys() as Collection<Object>)?.each { Object keyObj ->
            String key = keyObj.toString()
            boolean isSensitive = sensitiveKeys.any { String s -> key.toLowerCase().contains(s) }
            props[key] = isSensitive ? "***REDACTED***" : propertySet.getAsActualType(key)?.toString()
        }

        Map<String, Object> serviceMap = [
            id              : service.id,
            name            : service.name,
            description     : service.description,
            className       : service.serviceClass,
            delay           : service.delay,
            delayFormatted  : formatDelay(service.delay),
            lastRun         : service.lastRun?.toString(),
            isRunning       : service.isRunning(),
            isUsable        : service.isUsable(),
            properties      : props
        ]
        return serviceMap as Map<String, Object>
    }

    Response.ok(new JsonBuilder([
        services: results,
        count   : results.size()
    ]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Application Links
 *
 * Returns all application links (Confluence, Bitbucket, Bamboo, etc.)
 * with their type, URL, and authentication configuration.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpApplicationLinks
 *
 * Response: { "applicationLinks": [ { "id", "name", "type", "displayUrl", "rpcUrl", "isPrimary", "authType" } ] }
 */
jiraMcpApplicationLinks(httpMethod: "GET") { MultivaluedMap queryParams ->
    ApplicationLinkService appLinkService = ComponentLocator.getComponent(ApplicationLinkService)

    if (!appLinkService) {
        return Response.status(503)
            .entity(new JsonBuilder([error: "ApplicationLinkService not available"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    Iterable<ApplicationLink> links = appLinkService.getApplicationLinks()

    List<Map<String, Object>> results = links.collect { ApplicationLink link ->
        ApplicationType appType = link.type
        String authStatus
        try {
            link.createAuthenticatedRequestFactory()
            authStatus = "configured"
        } catch (Exception e) {
            authStatus = "none"
        }

        String typeName = appType?.i18nKey ?: appType?.class?.simpleName ?: "unknown"
        String system = appType?.class?.simpleName
            ?.replaceAll("ApplicationType", "")
            ?.replaceAll("\\\$.*", "")

        Map<String, Object> linkMap = [
            id          : link.id?.toString(),
            name        : link.name,
            type        : typeName,
            typeClass   : appType?.class?.name,
            displayUrl  : link.displayUrl?.toString(),
            rpcUrl      : link.rpcUrl?.toString(),
            isPrimary   : link.isPrimary(),
            authStatus  : authStatus,
            system      : system
        ]
        return linkMap as Map<String, Object>
    }

    Response.ok(new JsonBuilder([
        applicationLinks: results,
        count           : results.size()
    ]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Effective Permissions
 *
 * Resolves actual effective permissions for a user on a project by walking
 * groups, project roles, and permission grants. Answers "who can actually do X".
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpEffectivePermissions
 * Query params:
 *   projectKey (required) - project to check
 *   username   (optional) - specific user to check (returns all granted permissions for that user)
 *   permission (optional) - specific permission key to check (returns all users/groups that have it)
 *
 * At least one of username or permission must be provided.
 *
 * Response varies by query — see examples in output.
 */
jiraMcpEffectivePermissions(httpMethod: "GET") { MultivaluedMap queryParams ->
    PermissionManager permissionManager = ComponentAccessor.getComponent(PermissionManager)
    ProjectManager projectManager = ComponentAccessor.projectManager
    UserManager userManager = ComponentAccessor.userManager

    String projectKey = queryParams.getFirst("projectKey") as String
    String username = queryParams.getFirst("username") as String
    String permissionKeyParam = queryParams.getFirst("permission") as String

    if (!projectKey) {
        return Response.status(400)
            .entity(new JsonBuilder([error: "projectKey parameter is required"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    if (!username && !permissionKeyParam) {
        return Response.status(400)
            .entity(new JsonBuilder([error: "At least one of 'username' or 'permission' is required"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    Project project = projectManager.getProjectByCurrentKey(projectKey)
    if (!project) {
        return Response.status(404)
            .entity(new JsonBuilder([error: "Project not found: ${projectKey}"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    // Every project permission registered on this instance (system + plugin,
    // e.g. MANAGE_SPRINTS_PERMISSION, VIEW_DEV_TOOLS) — a hardcoded list drifts
    // between Jira versions and mistyped keys silently land in "denied".
    List<String> allPermissions = permissionManager.allProjectPermissions
        .collect { it.key }
        .sort()

    Map<String, Object> result = [project: projectKey] as Map<String, Object>

    if (username) {
        ApplicationUser user = userManager.getUserByName(username)
        if (!user) {
            return Response.status(404)
                .entity(new JsonBuilder([error: "User not found: ${username}"]).toString())
                .header("Content-Type", "application/json")
                .build()
        }

        List<String> granted = []
        List<String> denied = []

        allPermissions.each { String perm ->
            if (permissionManager.hasPermission(new ProjectPermissionKey(perm), project, user)) {
                granted.add(perm)
            } else {
                denied.add(perm)
            }
        }

        result['user'] = username
        result['userDisplayName'] = user.displayName
        result['grantedPermissions'] = granted
        result['deniedPermissions'] = denied
    }

    if (permissionKeyParam) {
        try {
            ProjectPermissionKey permKey = new ProjectPermissionKey(permissionKeyParam)
            Collection<ApplicationUser> usersWithPerm = permissionManager.getAllUsers(permKey, project)

            List<Map<String, Object>> userList = usersWithPerm.collect { ApplicationUser u ->
                [
                    username    : u.username,
                    displayName : u.displayName,
                    emailAddress: u.emailAddress,
                    active      : u.isActive()
                ] as Map<String, Object>
            }

            result['permission'] = permissionKeyParam
            result['usersWithPermission'] = userList
            result['userCount'] = usersWithPerm.size()
        } catch (Exception e) {
            result['error'] = "Failed to resolve permission '${permissionKeyParam}': ${e.message}"
        }
    }

    Response.ok(new JsonBuilder(result).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Export Workflow
 *
 * Returns a workflow's OpenSymphony XML descriptor. Used by get_workflow and
 * search_workflow_rules to parse statuses, transitions and their conditions,
 * validators and post-functions — detail the REST API does not expose.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpExportWorkflow
 * Query params:
 *   workflowName (required) - exact workflow name
 *
 * Requires the Jira Administrators global permission.
 *
 * Response: the workflow descriptor as application/xml
 */
jiraMcpExportWorkflow(httpMethod: "GET") { MultivaluedMap queryParams, String body ->
    Response denied = requireGlobalPermission(GlobalPermissionKey.ADMINISTER)
    if (denied != null) return denied

    final String workflowName = queryParams.getFirst("workflowName")
    final WorkflowManager workflowManager = ComponentAccessor.getWorkflowManager()
    final JiraWorkflow jiraWorkflow = workflowManager.getWorkflow(workflowName)

    String workflowInXML = jiraWorkflow.getDescriptor().asXML()

    return Response.ok(workflowInXML).type("application/xml").build()
}

/**
 * Server Log Access
 *
 * Read-only list/tail/grep over the Jira server's log files, replacing the
 * SSH-and-grep loop during incident investigations. Access is restricted to
 * plain files directly inside the Jira log directory (<jira.home>/log) and the
 * Tomcat log directory (<catalina.base>/logs) — no paths, no traversal.
 * Requires the System Administrators global permission.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpServerLog
 * Query params:
 *   action          - "list" | "tail" | "grep" (default "grep")
 *   file            - log file name without path (default "atlassian-jira.log");
 *                     ".gz" files are decompressed on the fly
 *   lines           - tail: trailing lines to return (default 100, max 1000)
 *   pattern         - grep: Java regex matched against each line (required)
 *   caseInsensitive - grep: "true" for case-insensitive matching
 *   rotations       - grep: also scan <file>.1 .. <file>.N, oldest first, so
 *                     matches come back in chronological order (default 0, max 100)
 *   contextBefore   - grep: context lines before each match (default 0, max 10)
 *   contextAfter    - grep: context lines after each match (default 0, max 10)
 *   maxMatches      - grep: stop after this many matches (default 200, max 1000)
 *   maxLineChars    - tail/grep: truncate longer lines (default 2000, max 10000)
 *
 * Response (grep): { "pattern", "filesScanned", "matchCount", "truncated", "matches": [...] }
 */
jiraMcpServerLog(httpMethod: "GET") { MultivaluedMap queryParams ->
    Response denied = requireGlobalPermission(GlobalPermissionKey.SYSTEM_ADMIN)
    if (denied != null) return denied

    String action = (queryParams.getFirst("action") as String) ?: "grep"

    List<File> logDirs = serverLogDirs()
    if (logDirs.isEmpty()) {
        return Response.status(500)
            .entity(new JsonBuilder([error: "No readable log directory found (jira.home/log, catalina.base/logs)"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    if (action == "list") {
        List<Map<String, Object>> files = []
        logDirs.each { File dir ->
            (dir.listFiles() ?: new File[0]).each { File f ->
                if (f.isFile()) {
                    files.add([
                        name        : f.name,
                        dir         : dir.absolutePath,
                        sizeBytes   : f.length(),
                        lastModified: new Date(f.lastModified()).format("yyyy-MM-dd'T'HH:mm:ssZ")
                    ] as Map<String, Object>)
                }
            }
        }
        files.sort { Map<String, Object> a, Map<String, Object> b ->
            (b.lastModified as String) <=> (a.lastModified as String)
        }
        return Response.ok(new JsonBuilder([
            logDirs: logDirs.collect { File d -> d.absolutePath },
            count  : files.size(),
            files  : files
        ]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    String fileName = (queryParams.getFirst("file") as String) ?: "atlassian-jira.log"
    int maxLineChars = intQueryParam(queryParams, "maxLineChars", 2000, 100, 10000)

    if (action == "tail") {
        File logFile = resolveServerLogFile(logDirs, fileName)
        if (logFile == null) {
            return Response.status(404)
                .entity(new JsonBuilder([error: "Log file not found in log directories: ${fileName}"]).toString())
                .header("Content-Type", "application/json")
                .build()
        }
        int lines = intQueryParam(queryParams, "lines", 100, 1, 1000)

        ArrayDeque<String> tail = new ArrayDeque<String>(lines)
        BufferedReader reader = openServerLog(logFile)
        try {
            String line
            while ((line = reader.readLine()) != null) {
                if (tail.size() >= lines) tail.removeFirst()
                tail.addLast(trimLogLine(line, maxLineChars))
            }
        } finally {
            reader.close()
        }

        return Response.ok(new JsonBuilder([
            file     : logFile.name,
            dir      : logFile.parentFile.absolutePath,
            lineCount: tail.size(),
            lines    : new ArrayList<String>(tail)
        ]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    if (action == "grep") {
        String patternParam = queryParams.getFirst("pattern") as String
        if (!patternParam) {
            return Response.status(400)
                .entity(new JsonBuilder([error: "pattern parameter is required for action=grep"]).toString())
                .header("Content-Type", "application/json")
                .build()
        }
        boolean caseInsensitive = (queryParams.getFirst("caseInsensitive") as String) == "true"
        Pattern pattern
        try {
            pattern = Pattern.compile(patternParam, caseInsensitive ? Pattern.CASE_INSENSITIVE : 0)
        } catch (PatternSyntaxException e) {
            return Response.status(400)
                .entity(new JsonBuilder([error: "Invalid regex: ${e.message}"]).toString())
                .header("Content-Type", "application/json")
                .build()
        }
        int rotations = intQueryParam(queryParams, "rotations", 0, 0, 100)
        int contextBefore = intQueryParam(queryParams, "contextBefore", 0, 0, 10)
        int contextAfter = intQueryParam(queryParams, "contextAfter", 0, 0, 10)
        int maxMatches = intQueryParam(queryParams, "maxMatches", 200, 1, 1000)

        // Highest rotation number first (oldest entries), current file last, so
        // concatenated matches come out in chronological order like `grep | sort`.
        List<File> targets = []
        for (int i = rotations; i >= 1; i--) {
            File rotated = resolveServerLogFile(logDirs, "${fileName}.${i}" as String)
            if (rotated == null) rotated = resolveServerLogFile(logDirs, "${fileName}.${i}.gz" as String)
            if (rotated != null) targets.add(rotated)
        }
        File current = resolveServerLogFile(logDirs, fileName)
        if (current != null) targets.add(current)
        if (targets.isEmpty()) {
            return Response.status(404)
                .entity(new JsonBuilder([error: "Log file not found in log directories: ${fileName}"]).toString())
                .header("Content-Type", "application/json")
                .build()
        }

        List<Map<String, Object>> matches = []
        List<String> filesScanned = []
        boolean truncated = false
        for (File f in targets) {
            filesScanned.add(f.name)
            truncated = grepServerLogFile(f, pattern, contextBefore, contextAfter,
                maxMatches, maxLineChars, matches)
            if (truncated) break
        }

        return Response.ok(new JsonBuilder([
            pattern     : patternParam,
            filesScanned: filesScanned,
            matchCount  : matches.size(),
            truncated   : truncated,
            matches     : matches
        ]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    return Response.status(400)
        .entity(new JsonBuilder([error: "Unknown action: ${action} (expected list, tail, or grep)"]).toString())
        .header("Content-Type", "application/json")
        .build()
}

// ---------------------------------------------------------------------------
// Helper methods (shared by the endpoint closures above)
// ---------------------------------------------------------------------------

/**
 * A 403 response unless the calling user holds the global permission, else null.
 * Checked in code rather than with the endpoint's `groups:` option because the
 * admin group is named differently across instances (jira-administrators,
 * jira-admin, ...), while the global permission is the same everywhere.
 */
Response requireGlobalPermission(GlobalPermissionKey permission) {
    ApplicationUser user = ComponentAccessor.jiraAuthenticationContext.loggedInUser
    if (user != null && ComponentAccessor.globalPermissionManager.hasPermission(permission, user)) {
        return null
    }
    return Response.status(403)
        .entity(new JsonBuilder([error: "Requires the ${permission.key} global permission".toString()]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/** Directories log files may be served from (canonical, existing only). */
List<File> serverLogDirs() {
    List<File> dirs = []
    try {
        JiraHome jiraHome = ComponentAccessor.getComponent(JiraHome)
        File logDir = jiraHome.logDirectory
        if (logDir != null && logDir.isDirectory()) dirs.add(logDir.canonicalFile)
    } catch (Exception ignored) {
    }
    String catalinaBase = System.getProperty("catalina.base")
    if (catalinaBase) {
        File tomcatLogs = new File(catalinaBase, "logs")
        if (tomcatLogs.isDirectory()) dirs.add(tomcatLogs.canonicalFile)
    }
    return dirs
}

/**
 * Resolve a bare file name against the allowed log directories. The name
 * whitelist has no separators, and the canonical parent must be the log
 * directory itself — both checks together make traversal impossible.
 */
File resolveServerLogFile(List<File> logDirs, String name) {
    if (!name || !(name ==~ /[A-Za-z0-9][A-Za-z0-9._-]*/)) return null
    for (File dir in logDirs) {
        File candidate = new File(dir, name)
        if (candidate.isFile() && candidate.canonicalFile.parentFile == dir) return candidate
    }
    return null
}

/** Open a log file as UTF-8 text (malformed bytes replaced), gunzipping *.gz. */
BufferedReader openServerLog(File f) {
    InputStream stream = new FileInputStream(f)
    if (f.name.endsWith(".gz")) stream = new GZIPInputStream(stream)
    return new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))
}

String trimLogLine(String line, int maxChars) {
    return line.length() > maxChars ? line.substring(0, maxChars) + "...[truncated]" : line
}

int intQueryParam(MultivaluedMap queryParams, String name, int defaultValue, int min, int max) {
    String raw = queryParams.getFirst(name) as String
    if (!raw) return defaultValue
    try {
        return Math.max(min, Math.min(max, raw as int))
    } catch (NumberFormatException ignored) {
        return defaultValue
    }
}

/**
 * Scan one file for pattern matches, appending to `matches` with grep-style
 * before/after context. Returns true if maxMatches was hit (scan truncated).
 */
boolean grepServerLogFile(File f, Pattern pattern, int contextBefore, int contextAfter,
                          int maxMatches, int maxLineChars, List<Map<String, Object>> matches) {
    BufferedReader reader = openServerLog(f)
    try {
        ArrayDeque<String> before = new ArrayDeque<String>()
        Map<String, Object> lastMatch = null
        int afterRemaining = 0
        int lineNumber = 0
        String line
        while ((line = reader.readLine()) != null) {
            lineNumber++
            if (pattern.matcher(line).find()) {
                if (matches.size() >= maxMatches) return true
                Map<String, Object> match = [
                    file      : f.name,
                    lineNumber: lineNumber,
                    text      : trimLogLine(line, maxLineChars)
                ] as Map<String, Object>
                if (contextBefore > 0) match['before'] = new ArrayList<String>(before)
                if (contextAfter > 0) {
                    match['after'] = new ArrayList<String>()
                    lastMatch = match
                    afterRemaining = contextAfter
                }
                matches.add(match)
            } else if (afterRemaining > 0 && lastMatch != null) {
                (lastMatch['after'] as List<String>).add(trimLogLine(line, maxLineChars))
                afterRemaining--
            }
            if (contextBefore > 0) {
                if (before.size() >= contextBefore) before.removeFirst()
                before.addLast(trimLogLine(line, maxLineChars))
            }
        }
        return false
    } finally {
        reader.close()
    }
}

Map<String, Object> resolveScreenInfo(FieldScreenScheme scheme, IssueOperation issueOp) {
    FieldScreenSchemeItem schemeItem = scheme.getFieldScreenSchemeItem(issueOp)
    if (schemeItem) {
        FieldScreen screen = schemeItem.fieldScreen
        return [screenId: screen?.id, screenName: screen?.name] as Map<String, Object>
    }
    return null
}

String formatDelay(long delayMs) {
    if (delayMs <= 0) return "manual"
    long seconds = delayMs / 1000 as long
    long minutes = seconds / 60 as long
    long hours = minutes / 60 as long
    if (hours >= 1) return "${hours}h ${minutes % 60}m"
    if (minutes >= 1) return "${minutes}m"
    return "${seconds}s"
}
