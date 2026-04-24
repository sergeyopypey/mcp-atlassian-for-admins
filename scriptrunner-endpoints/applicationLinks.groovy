/**
 * ScriptRunner REST Endpoint: Application Links
 *
 * Returns all application links (Confluence, Bitbucket, Bamboo, etc.)
 * with their type, URL, and authentication configuration.
 *
 * Endpoint: GET /rest/scriptrunner/latest/custom/applicationLinks
 *
 * Response: { "applicationLinks": [ { "id", "name", "type", "displayUrl", "rpcUrl", "isPrimary", "authType" } ] }
 */

import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonBuilder
import groovy.transform.BaseScript

import com.atlassian.applinks.api.ApplicationLink
import com.atlassian.applinks.api.ApplicationLinkService
import com.atlassian.applinks.api.ApplicationType
import com.atlassian.sal.api.component.ComponentLocator

import javax.ws.rs.core.MultivaluedMap
import javax.ws.rs.core.Response

@BaseScript CustomEndpointDelegate delegate

applicationLinks(httpMethod: "GET") { MultivaluedMap queryParams ->
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
