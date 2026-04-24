/**
 * ScriptRunner REST Endpoint: Event Listeners
 *
 * Returns all registered event listeners in the Jira instance, including
 * built-in, plugin-provided, and ScriptRunner listeners. Completely invisible
 * to the REST API.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/listeners
 *
 * Response: { "listeners": [ { "name", "className", "events", "source" } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.event.JiraListener
import com.atlassian.jira.event.ListenerManager

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

listeners(httpMethod: "GET") { MultivaluedMap queryParams ->
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
