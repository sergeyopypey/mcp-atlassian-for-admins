/**
 * ScriptRunner REST Endpoint: Workflow Transition Details
 *
 * Returns full transition rule configurations including post-function parameters,
 * condition arguments, and validator arguments. The REST API only exposes class names
 * via XML parsing — this endpoint reveals the actual configuration.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/workflowTransitionDetails
 * Query params:
 *   workflowName (required) - exact workflow name
 *   transitionId (optional) - filter to a single transition
 *
 * Response: { "workflow", "transitions": [ { "id", "name", "conditions", "validators", "postFunctions" } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
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

workflowTransitionDetails(httpMethod: "GET") { MultivaluedMap queryParams ->
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

        // Parse validators
        List<Map<String, Object>> validators = restriction?.validators?.collect { ValidatorDescriptor v ->
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
            description   : action.description,
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
