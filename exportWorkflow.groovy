import groovy.transform.BaseScript

import com.atlassian.jira.workflow.JiraWorkflow
import com.atlassian.jira.workflow.WorkflowManager
import com.atlassian.jira.component.ComponentAccessor
import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate

import javax.ws.rs.core.Response
import javax.ws.rs.core.MultivaluedMap

@BaseScript CustomEndpointDelegate delegate

exportWorkflow(httpMethod: "GET", groups: ["jira-administrators"]) { MultivaluedMap queryParams, String body ->
    final String workflowName = queryParams.getFirst("workflowName")
    final WorkflowManager workflowManager = ComponentAccessor.getWorkflowManager()
    final JiraWorkflow jiraWorkflow = workflowManager.getWorkflow(workflowName)

    String workflowInXML = jiraWorkflow.getDescriptor().asXML()
    
    return Response.ok(workflowInXML).type("application/xml").build();
}