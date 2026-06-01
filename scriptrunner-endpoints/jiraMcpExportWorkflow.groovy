/**
 * ScriptRunner REST Endpoint: Export Workflow
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

import groovy.transform.BaseScript

import com.atlassian.jira.workflow.JiraWorkflow
import com.atlassian.jira.workflow.WorkflowManager
import com.atlassian.jira.component.ComponentAccessor
import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate

import javax.ws.rs.core.Response
import javax.ws.rs.core.MultivaluedMap

@BaseScript CustomEndpointDelegate delegate

jiraMcpExportWorkflow(httpMethod: "GET", groups: ["jira-administrators"]) { MultivaluedMap queryParams, String body ->
    final String workflowName = queryParams.getFirst("workflowName")
    final WorkflowManager workflowManager = ComponentAccessor.getWorkflowManager()
    final JiraWorkflow jiraWorkflow = workflowManager.getWorkflow(workflowName)

    String workflowInXML = jiraWorkflow.getDescriptor().asXML()

    return Response.ok(workflowInXML).type("application/xml").build();
}
