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
 *   jiraMcpWorkflowTransitionDetails    - full transition rule config (post-function params, condition/validator args)
 *   jiraMcpCustomFieldContexts          - custom field contexts with project/issue type scoping
 *   jiraMcpListeners                    - all registered event listeners
 *   jiraMcpScheduledServices            - Jira scheduled services (mail handlers, etc.)
 *   jiraMcpApplicationLinks             - application links to Confluence, Bitbucket, etc.
 *   jiraMcpEffectivePermissions         - resolved effective permissions for user+project
 *   jiraMcpExportWorkflow               - workflow OpenSymphony XML descriptor
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

import com.atlassian.jira.security.PermissionManager
import com.atlassian.jira.security.plugin.ProjectPermissionKey
import com.atlassian.jira.user.ApplicationUser
import com.atlassian.jira.user.util.UserManager

import com.atlassian.jira.workflow.JiraWorkflow
import com.atlassian.jira.workflow.WorkflowManager
import com.opensymphony.workflow.loader.AbstractDescriptor
import com.opensymphony.workflow.loader.ActionDescriptor
import com.opensymphony.workflow.loader.ConditionDescriptor
import com.opensymphony.workflow.loader.ConditionsDescriptor
import com.opensymphony.workflow.loader.FunctionDescriptor
import com.opensymphony.workflow.loader.RestrictionDescriptor
import com.opensymphony.workflow.loader.ResultDescriptor
import com.opensymphony.workflow.loader.StepDescriptor
import com.opensymphony.workflow.loader.ValidatorDescriptor
import com.opensymphony.workflow.loader.WorkflowDescriptor

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
        return schemeMap
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
        issueTypeScreenSchemeManager.getProjects(scheme).each { gv ->
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
        return schemeMap
    }

    Response.ok(new JsonBuilder([issueTypeScreenSchemes: results]).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Workflow Transition Details
 *
 * Returns full transition rule configurations including post-function parameters,
 * condition arguments, and validator arguments. The REST API only exposes class names
 * via XML parsing — this endpoint reveals the actual configuration.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpWorkflowTransitionDetails
 * Query params:
 *   workflowName (required) - exact workflow name
 *   transitionId (optional) - filter to a single transition
 *
 * Response: { "workflow", "transitions": [ { "id", "name", "conditions", "validators", "postFunctions" } ] }
 */
jiraMcpWorkflowTransitionDetails(httpMethod: "GET") { MultivaluedMap queryParams ->
    WorkflowManager workflowManager = ComponentAccessor.workflowManager

    String workflowName = queryParams.getFirst("workflowName") as String
    if (!workflowName) {
        return Response.status(400)
            .entity(new JsonBuilder([error: "workflowName parameter is required"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    JiraWorkflow workflow = workflowManager.getWorkflow(workflowName)
    if (!workflow) {
        return Response.status(404)
            .entity(new JsonBuilder([error: "Workflow not found: ${workflowName}"]).toString())
            .header("Content-Type", "application/json")
            .build()
    }

    String filterTransitionId = queryParams.getFirst("transitionId") as String
    WorkflowDescriptor descriptor = workflow.descriptor

    // Collect all transitions from global actions and step actions
    List<ActionDescriptor> transitions = []
    transitions.addAll(descriptor.globalActions as List<ActionDescriptor>)
    (descriptor.steps as List<StepDescriptor>).each { StepDescriptor step ->
        transitions.addAll(step.actions as List<ActionDescriptor>)
    }

    if (filterTransitionId) {
        int tid = filterTransitionId as int
        transitions = transitions.findAll { ActionDescriptor it -> it.id == tid }
    }

    // Deduplicate by transition ID
    Set<Integer> seen = [] as Set<Integer>
    transitions = transitions.findAll { ActionDescriptor it -> seen.add(it.id) }

    List<Map<String, Object>> transitionResults = transitions.collect { ActionDescriptor action ->
        RestrictionDescriptor restriction = action.restriction

        // Parse conditions
        List<Map<String, Object>> conditions = []
        if (restriction?.conditionsDescriptor) {
            conditions = [parseCondition(restriction.conditionsDescriptor)]
        }

        // Parse validators — validators live on the action, not the restriction
        List<Map<String, Object>> validators = action.validators?.collect { ValidatorDescriptor v ->
            [
                className : v.args?.get("class.name") ?: v.args?.get("class"),
                type      : v.type == 0 ? "class" : "plugin-module",
                args      : extractArgs(v)
            ] as Map<String, Object>
        } ?: []

        // Parse pre-functions
        List<Map<String, Object>> preFunctions = action.preFunctions?.collect { FunctionDescriptor f ->
            [
                className : f.args?.get("class.name") ?: f.args?.get("class"),
                type      : f.type == 0 ? "class" : "plugin-module",
                args      : extractArgs(f)
            ] as Map<String, Object>
        } ?: []

        // Parse post-functions
        List<Map<String, Object>> postFunctions = action.postFunctions?.collect { FunctionDescriptor f ->
            [
                className : f.args?.get("class.name") ?: f.args?.get("class"),
                type      : f.type == 0 ? "class" : "plugin-module",
                args      : extractArgs(f)
            ] as Map<String, Object>
        } ?: []

        // Get the result step/status
        ResultDescriptor unconditionalResult = action.unconditionalResult
        Map<String, Object> resultStatus = null
        if (unconditionalResult) {
            resultStatus = [
                stepId   : unconditionalResult.step,
                status   : unconditionalResult.status,
                oldStatus: unconditionalResult.oldStatus
            ] as Map<String, Object>
        }

        // Screen ID from the transition's view attribute
        String screenId = action.view ? action.view.replaceAll("[^0-9]", "") : null

        Map<String, Object> transitionMap = [
            id            : action.id,
            name          : action.name,
            screenId      : screenId,
            result        : resultStatus,
            conditions    : conditions,
            validators    : validators,
            preFunctions  : preFunctions,
            postFunctions : postFunctions
        ]
        return transitionMap
    }

    Response.ok(new JsonBuilder([
        workflow    : workflowName,
        transitions: transitionResults
    ]).toString())
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
        def propertySet = service.properties
        propertySet?.getKeys()?.each { Object keyObj ->
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
        return serviceMap
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
        return linkMap
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

    // Known project permission keys
    List<String> allPermissions = [
        "BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "ASSIGN_ISSUES",
        "RESOLVE_ISSUES", "CLOSE_ISSUES", "MODIFY_REPORTER", "DELETE_ISSUES",
        "LINK_ISSUES", "SET_ISSUE_SECURITY", "SCHEDULE_ISSUES",
        "MOVE_ISSUES", "ASSIGNABLE_USER", "MANAGE_WATCHERS",
        "ADD_COMMENTS", "EDIT_ALL_COMMENTS", "EDIT_OWN_COMMENTS",
        "DELETE_ALL_COMMENTS", "DELETE_OWN_COMMENTS",
        "CREATE_ATTACHMENTS", "DELETE_ALL_ATTACHMENTS", "DELETE_OWN_ATTACHMENTS",
        "WORK_ON_ISSUES", "EDIT_OWN_WORKLOGS", "EDIT_ALL_WORKLOGS",
        "DELETE_OWN_WORKLOGS", "DELETE_ALL_WORKLOGS",
        "ADMINISTER_PROJECTS", "TRANSITION_ISSUES",
        "VIEW_WORKFLOW_READONLY", "VIEW_VOTERS_AND_WATCHERS",
        "MANAGE_SPRINTS_PERMISSION"
    ]

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
            try {
                ProjectPermissionKey permKey = new ProjectPermissionKey(perm)
                if (permissionManager.hasPermission(permKey, project, user)) {
                    granted.add(perm)
                } else {
                    denied.add(perm)
                }
            } catch (Exception ignored) {
                // Permission key may not exist in this version
            }
        }

        result.user = username
        result.userDisplayName = user.displayName
        result.grantedPermissions = granted
        result.deniedPermissions = denied
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

            result.permission = permissionKeyParam
            result.usersWithPermission = userList
            result.userCount = usersWithPerm.size()
        } catch (Exception e) {
            result.error = "Failed to resolve permission '${permissionKeyParam}': ${e.message}"
        }
    }

    Response.ok(new JsonBuilder(result).toString())
        .header("Content-Type", "application/json")
        .build()
}

/**
 * Export Workflow
 *
 * Returns a workflow's OpenSymphony XML descriptor. Used by get_workflow_detail
 * to parse transition conditions, validators and post-functions — detail the
 * Workflow Designer API does not expose.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/jiraMcpExportWorkflow
 * Query params:
 *   workflowName (required) - exact workflow name
 *
 * Response: the workflow descriptor as application/xml
 */
jiraMcpExportWorkflow(httpMethod: "GET", groups: ["jira-administrators"]) { MultivaluedMap queryParams, String body ->
    final String workflowName = queryParams.getFirst("workflowName")
    final WorkflowManager workflowManager = ComponentAccessor.getWorkflowManager()
    final JiraWorkflow jiraWorkflow = workflowManager.getWorkflow(workflowName)

    String workflowInXML = jiraWorkflow.getDescriptor().asXML()

    return Response.ok(workflowInXML).type("application/xml").build()
}

// ---------------------------------------------------------------------------
// Helper methods (shared by the endpoint closures above)
// ---------------------------------------------------------------------------

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

Map<String, String> extractArgs(AbstractDescriptor desc) {
    Map<String, String> args = [:]
    if (desc.hasProperty("args") && desc.args) {
        ((Map<String, Object>) desc.args).each { String key, Object value ->
            args[key] = value?.toString()
        }
    }
    if (desc.hasProperty("meta") && desc.meta) {
        ((Map<String, Object>) desc.meta).each { String key, Object value ->
            args["meta.${key}"] = value?.toString()
        }
    }
    return args
}

Map<String, Object> parseCondition(Object conditionDesc) {
    if (conditionDesc instanceof ConditionsDescriptor) {
        ConditionsDescriptor compound = (ConditionsDescriptor) conditionDesc
        return [
            type       : compound.type == 0 ? "AND" : "OR",
            conditions : compound.conditions.collect { Object nested -> parseCondition(nested) }
        ] as Map<String, Object>
    } else if (conditionDesc instanceof ConditionDescriptor) {
        ConditionDescriptor single = (ConditionDescriptor) conditionDesc
        return [
            type      : single.type == 0 ? "class" : "plugin-module",
            className : single.args?.get("class.name") ?: single.args?.get("class"),
            negate    : single.negate,
            args      : extractArgs(single)
        ] as Map<String, Object>
    }
    return [type: "unknown"] as Map<String, Object>
}
