/**
 * ScriptRunner REST Endpoint: Scheduled Services
 *
 * Returns all Jira scheduled services (mail handlers, backup services, etc.).
 * These run on cron schedules and are invisible to the REST API.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/scheduledServices
 *
 * Response: { "services": [ { "id", "name", "className", "delay", "properties" } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.service.JiraServiceContainer
import com.atlassian.jira.service.ServiceManager

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

scheduledServices(httpMethod: "GET") { MultivaluedMap queryParams ->
    ServiceManager serviceManager = ComponentAccessor.getComponent(ServiceManager)

    Collection<JiraServiceContainer> services = serviceManager.getServices()
    Set<String> sensitiveKeys = ["password", "secret", "token", "credential", "apikey"] as Set<String>

    List<Map<String, Object>> results = services.collect { JiraServiceContainer service ->
        // Collect service properties (filtering out sensitive ones)
        Map<String, String> props = [:]
        service.properties?.each { Object key, Object value ->
            String lowerKey = key.toString().toLowerCase()
            boolean isSensitive = sensitiveKeys.any { String s -> lowerKey.contains(s) }
            props[key.toString()] = isSensitive ? "***REDACTED***" : value?.toString()
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
            isLocalService  : service.isLocal(),
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

String formatDelay(long delayMs) {
    if (delayMs <= 0) return "manual"
    long seconds = delayMs / 1000 as long
    long minutes = seconds / 60 as long
    long hours = minutes / 60 as long
    if (hours >= 1) return "${hours}h ${minutes % 60}m"
    if (minutes >= 1) return "${minutes}m"
    return "${seconds}s"
}
